import { LmStudioError } from "../lmstudio/errors.ts";
import { isGenerationCapable } from "../lmstudio/models.ts";
import type {
  ChatRequest,
  ChatResult,
  LmStudioClient,
  ModelInfo,
  Usage,
} from "../lmstudio/types.ts";
import type { RequestQueue } from "./queue.ts";
import type { RunStop, StopReason, UnitFailure } from "./result.ts";

export type ExecOutcome<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly attempts: number;
      readonly usage: Usage | null;
      readonly elapsedMs: number;
    }
  | {
      readonly ok: false;
      readonly attempts: number;
      readonly failure: UnitFailure;
      /** 取れたときだけ（truncated では非 null になりうる）。 */
      readonly usage: Usage | null;
      readonly elapsedMs: number;
      /** 非 null なら実行全体を止める。 */
      readonly halt: RunStop | null;
    };

export interface Executor {
  /** request.model で ensureLoaded を呼んでから chat を送り、parse に通す。同時実行は 1。 */
  execute<T>(
    request: ChatRequest,
    parse: (result: ChatResult) => T,
    timeoutMs: number,
  ): Promise<ExecOutcome<T>>;
  /** 送信した生成要求の総数（再試行を含む）。 */
  readonly requestCount: number;
  /** 最初に成功した ensureLoaded の結果。成功前は null。 */
  readonly modelInfo: ModelInfo | null;
}

export interface ExecutorOptions {
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * 渡すとバックエンド全体で共有する 1 本のキューに `runOne`（ensureLoaded → chat → parse →
   * 再試行 1 回まで）全体を 1 ジョブとして投入する。複数の executor（＝複数の実行）をまたいで
   * 同時実行数を 1 にするための仕組み（仕様書 2 節）。省略時は従来どおり `tail` による
   * この executor 内だけの直列化になる（`runPipeline` は渡さない）。
   */
  readonly queue?: RequestQueue | undefined;
}

/**
 * `signal.aborted` を読むだけの関数呼び出しにする。直接 `signal?.aborted === true` を
 * 分岐に使うと、TypeScript がその後の `await` を挟んだ分岐でも「常に false」と誤って
 * 絞り込んでしまうため（`lmstudio/client.ts` と同じ理由）。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted);
}

function toFailure(error: LmStudioError, origin: "ensure-loaded" | "chat" | "local"): UnitFailure {
  return {
    reason: error.kind,
    message: error.message,
    finishReason: error.finishReason,
    origin,
  };
}

function makeStop(
  reason: StopReason,
  message: string,
  failure: UnitFailure | null,
  generationUnconfirmed: boolean,
): RunStop {
  return { reason, message, failure, generationUnconfirmed };
}

/** `chat` 由来の失敗が再試行の対象か（決定 5(a)）。各 execute で 1 回だけ再試行する。 */
function isRetryable(error: LmStudioError): boolean {
  if (error.kind === "malformed" || error.kind === "truncated") {
    return true;
  }
  // HTTP 応答（非 2xx）を受け取った connection だけ再試行できる。応答を受け取れなかった
  // （status が null）場合は、本文の読み取り中に切れた可能性を否定できないので再試行しない。
  return error.kind === "connection" && error.status !== null;
}

/**
 * 再試行を使い切った（あるいは再試行しない）`chat` 由来の失敗から停止理由を決める（決定 5(a)）。
 * null を返したら実行は続く（当該単位だけ failed）。
 */
function haltForChatError(error: LmStudioError, failure: UnitFailure): RunStop | null {
  switch (error.kind) {
    case "malformed":
    case "truncated":
      // 2 回目も失敗しても実行は続ける。
      return null;
    case "connection":
      return error.status !== null
        ? makeStop(
            "connection-lost",
            "LM Studio が要求を拒否した（HTTP 応答あり）ため実行を停止した",
            failure,
            false,
          )
        : makeStop(
            "connection-lost",
            "LM Studio との通信が応答を受け取れずに切れたため実行を停止した",
            failure,
            true,
          );
    case "timeout":
      return makeStop(
        "recovery-needed",
        "生成要求がタイムアウトしたため実行を停止した",
        failure,
        true,
      );
    case "aborted":
      return makeStop("aborted", "生成要求が中断されたため実行を停止した", failure, true);
    case "model-not-loaded":
      return makeStop(
        "model-not-loaded",
        "モデルがロードされていないため実行を停止した",
        failure,
        false,
      );
    case "input-too-long":
      // 初回検査なら実行を停止し、再確認ならその単位だけ失敗にする（決定 5(c)）。
      // executor は初回検査と再確認を区別できないので、停止の判断は呼び出し元に委ねる。
      // HTTP 400 で返る（status 非 null）ため生成は走っておらず、門を閉じる必要もない。
      return null;
    default: {
      // `FailureReason` に値が増えたらここで型エラーにする。default で黙って null（＝停止しない）に
      // 落ちると、新しい失敗理由が停止すべき場合でも実行が続いてしまう。
      const _exhaustive: never = error.kind;
      return _exhaustive;
    }
  }
}

/** `ensureLoaded` 由来の失敗から停止理由を決める（決定 5(b)）。必ず停止する。 */
function haltForEnsureLoadedError(error: LmStudioError, failure: UnitFailure): RunStop {
  if (error.kind === "model-not-loaded") {
    return makeStop(
      "model-not-loaded",
      "モデルのロード状態を確認できず（未ロード）実行を停止した",
      failure,
      false,
    );
  }
  if (error.kind === "aborted") {
    return makeStop("aborted", "モデル一覧の取得中に中断されたため実行を停止した", failure, false);
  }
  // connection / timeout / malformed など。一覧が取れない＝ロード状態を確認できない状態では
  // 生成要求を送らない（仕様書 7 節）。生成は送っていないので generationUnconfirmed は false。
  return makeStop(
    "connection-lost",
    "モデル一覧を取得できなかったため実行を停止した",
    failure,
    false,
  );
}

export function createExecutor(client: LmStudioClient, options: ExecutorOptions): Executor {
  const signal = options.signal;
  const now = options.now ?? Date.now;
  const queue = options.queue;

  let halt: RunStop | null = null;
  let requestCount = 0;
  let firstModelInfo: ModelInfo | null = null;
  // 直列化（同時実行 1）のための待ち行列。失敗しても後続を止めない。
  let tail: Promise<void> = Promise.resolve();

  /** 停止済み・停止要求で送信しなかった単位の失敗記録。停止理由そのものとは別に作る。 */
  function notSentFailure(message: string): UnitFailure {
    return { reason: "aborted", message, finishReason: null, origin: "local" };
  }

  function blocked<T>(stop: RunStop, message: string, startedAt: number): ExecOutcome<T> {
    return {
      ok: false,
      attempts: 0,
      failure: notSentFailure(message),
      usage: null,
      elapsedMs: now() - startedAt,
      halt: stop,
    };
  }

  async function runOne<T>(
    request: ChatRequest,
    parse: (result: ChatResult) => T,
    timeoutMs: number,
  ): Promise<ExecOutcome<T>> {
    const startedAt = now();

    // 順番が回ってきた時点で門を確認する。保持している halt は上書きしない。
    if (halt !== null) {
      return blocked(halt, "実行が停止済みのため生成要求を送らなかった", startedAt);
    }
    if (isAborted(signal)) {
      halt = makeStop("aborted", "停止要求により実行を停止した", null, false);
      return blocked(halt, "停止要求により生成要求を送らなかった", startedAt);
    }

    let attempts = 0;
    let lastUsage: Usage | null = null;
    let retried = false;

    for (;;) {
      // 再試行のときも ensureLoaded からやり直す（未ロードのモデルに送らない）。
      let modelInfo: ModelInfo;
      try {
        modelInfo = await client.ensureLoaded(
          request.model,
          signal !== undefined ? { signal } : undefined,
        );
      } catch (error) {
        if (!(error instanceof LmStudioError)) {
          throw error;
        }
        const failure = toFailure(error, "ensure-loaded");
        const stop = haltForEnsureLoadedError(error, failure);
        halt ??= stop;
        return {
          ok: false,
          attempts,
          failure,
          usage: lastUsage,
          elapsedMs: now() - startedAt,
          halt,
        };
      }
      firstModelInfo ??= modelInfo;

      // 仕様書 7 節：モデル種別で生成に使えるモデルを絞る。ensureLoaded は種別を見ない。
      if (!isGenerationCapable(modelInfo)) {
        const failure: UnitFailure = {
          reason: "model-not-loaded",
          message: `モデル種別が生成に使えない（llm / vlm 以外、または種別欠落）: ${
            modelInfo.type ?? "(欠落)"
          }`,
          finishReason: null,
          origin: "ensure-loaded",
        };
        halt ??= makeStop(
          "settings",
          "指定されたモデルが生成に使えない種別のため実行を停止した",
          failure,
          false,
        );
        return {
          ok: false,
          attempts,
          failure,
          usage: lastUsage,
          elapsedMs: now() - startedAt,
          halt,
        };
      }

      // ensureLoaded を待つ間に中断されていたら送らない（送っていないので未確認にしない）。
      if (isAborted(signal)) {
        halt ??= makeStop("aborted", "停止要求により実行を停止した", null, false);
        return {
          ok: false,
          attempts,
          failure: notSentFailure("停止要求により生成要求を送らなかった"),
          usage: lastUsage,
          elapsedMs: now() - startedAt,
          halt,
        };
      }

      let error: LmStudioError;
      try {
        // 送った回数は例外でも数える。
        attempts += 1;
        requestCount += 1;
        const result = await client.chat(request, {
          timeoutMs,
          ...(signal !== undefined ? { signal } : {}),
        });
        lastUsage = result.usage;
        if (result.finishReason !== "stop") {
          // 決定 6：stop 以外の終了理由は成功にせず truncated として扱う。
          error = new LmStudioError(
            "truncated",
            `生成が通常どおり終わらなかった（finish_reason: ${result.finishReason}）`,
            { usage: result.usage, finishReason: result.finishReason, raw: result.raw },
          );
        } else {
          const value = parse(result);
          return { ok: true, value, attempts, usage: result.usage, elapsedMs: now() - startedAt };
        }
      } catch (caught) {
        if (!(caught instanceof LmStudioError)) {
          throw caught;
        }
        // parse の失敗（malformed）も応答由来なので chat と同じ経路で扱う。
        lastUsage = caught.usage ?? lastUsage;
        error = caught;
      }

      if (isRetryable(error) && !retried) {
        retried = true;
        continue;
      }
      const failure = toFailure(error, "chat");
      const stop = haltForChatError(error, failure);
      if (stop !== null) {
        halt ??= stop;
      }
      return {
        ok: false,
        attempts,
        failure,
        usage: lastUsage,
        elapsedMs: now() - startedAt,
        halt,
      };
    }
  }

  function execute<T>(
    request: ChatRequest,
    parse: (result: ChatResult) => T,
    timeoutMs: number,
  ): Promise<ExecOutcome<T>> {
    // queue が渡されていれば runOne 全体（ensureLoaded → chat → parse → 再試行）を
    // 1 ジョブとして共有キューに投入し、他の executor（＝他の実行）とも直列化する。
    // 下の tail による直列化はキューを渡さない経路（runPipeline）の挙動を変えないために
    // そのまま残す。二重に直列化されても正しさは損なわれない。
    const runJob = (): Promise<ExecOutcome<T>> =>
      queue !== undefined
        ? queue.enqueue(() => runOne(request, parse, timeoutMs))
        : runOne(request, parse, timeoutMs);
    const started = tail.then(runJob);
    tail = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }

  return {
    execute,
    get requestCount(): number {
      return requestCount;
    },
    get modelInfo(): ModelInfo | null {
      return firstModelInfo;
    },
  };
}
