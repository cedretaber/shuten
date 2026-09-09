import { LmStudioError } from "../lmstudio/errors.ts";
import { isGenerationCapable } from "../lmstudio/models.ts";
import type {
  ChatRequest,
  ChatResult,
  LmStudioClient,
  ModelInfo,
  Usage,
} from "../lmstudio/types.ts";
import { QueueCancelledError, type RequestQueue } from "./queue.ts";
import type { RecoveryGate } from "./recovery-gate.ts";
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

/**
 * 遅延通知（決定 27）・停止ゲート（決定 26）の起点を「実際に生成要求を送った時点」に
 * 揃えるためのフック。`runOne` の `client.chat` 呼び出しちょうどを挟む。
 */
export interface ExecuteHooks {
  /** client.chat を呼ぶ直前に呼ぶ。再試行のたびに呼ぶ（1 回の execute で最大 2 回）。 */
  readonly onSend?: (() => void) | undefined;
  /** client.chat の finally で呼ぶ。成功・失敗・例外のいずれでも必ず呼ぶ。onSend と同数。 */
  readonly onSettled?: (() => void) | undefined;
}

export interface Executor {
  /**
   * request.model で ensureLoaded を呼んでから chat を送り、parse に通す。同時実行は 1。
   * `hooks` は任意（決定 27）。既存のテストにある `execute(request, parse, timeoutMs)` だけを
   * 実装したモックも、引数の少ない関数として代入できる。
   */
  execute<T>(
    request: ChatRequest,
    parse: (result: ChatResult) => T,
    timeoutMs: number,
    hooks?: ExecuteHooks,
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
  /**
   * 渡すと `runOne` の先頭（キューの順番が回ってきた時点。既存の `halt` 検査と同じ場所）で
   * `gate.blocked` を見る。真なら `ensureLoaded` も `chat` も呼ばずに、停止理由
   * `recovery-blocked`（決定 39）で止める。省略時は従来どおり動く（`runPipeline` / CLI は渡さない）。
   */
  readonly recoveryGate?: RecoveryGate | undefined;
  /**
   * `generationUnconfirmed: true` の `halt` を返す直前に同期的に呼ぶ（決定 39）。
   * オーケストレーターはここで `recoveryGate.block(runId)` する。共有キューは前のジョブの
   * Promise が解決した直後に次のジョブを始めるため、非同期に閉じると次の実行の要求が
   * すり抜けるので、必ず同期的に呼ぶ。
   */
  readonly onRecoveryRequired?: (() => void) | undefined;
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
  const recoveryGate = options.recoveryGate;
  const onRecoveryRequired = options.onRecoveryRequired;

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

  /**
   * `runOne` の戻り値を返す直前に必ず通す。決定 39：`generationUnconfirmed: true` の `halt` を
   * 返そうとしているときだけ、同期的に `onRecoveryRequired` を呼ぶ。呼び出し元の `block` は
   * 冪等なので、複数の返り値がこの条件を満たしても害はない。
   */
  function finish<T>(outcome: ExecOutcome<T>): ExecOutcome<T> {
    if (!outcome.ok && outcome.halt !== null && outcome.halt.generationUnconfirmed) {
      onRecoveryRequired?.();
    }
    return outcome;
  }

  async function runOne<T>(
    request: ChatRequest,
    parse: (result: ChatResult) => T,
    timeoutMs: number,
    hooks: ExecuteHooks | undefined,
  ): Promise<ExecOutcome<T>> {
    const startedAt = now();

    // 順番が回ってきた時点で門を確認する。保持している halt は上書きしない。
    if (halt !== null) {
      return finish(blocked(halt, "実行が停止済みのため生成要求を送らなかった", startedAt));
    }
    if (isAborted(signal)) {
      halt = makeStop("aborted", "停止要求により実行を停止した", null, false);
      return finish(blocked(halt, "停止要求により生成要求を送らなかった", startedAt));
    }
    if (recoveryGate?.blocked === true) {
      // 決定 39：別の実行が復旧待ちの間は、この実行も含めてプロセス全体で新しい生成要求を
      // 送らない。ensureLoaded も chat も呼ばない。この実行自体は 1 度も送っていないので
      // generationUnconfirmed は false のまま（単位は pending に残り、復旧が確認できれば
      // ゲートが開いて再開できる）。
      // RunStop.failure は「停止の原因になった失敗」（result.ts）で、設定値の検証エラーや
      // 停止要求（aborted）と同じく null にする。原因はこの実行自身の失敗ではなく別の実行が
      // 復旧待ちであることなので、失敗の記録を run 全体の停止理由に載せると「この実行が
      // aborted で失敗した」と読める余地が残ってしまう。単位側（blocked() が作る
      // outcome.failure）は「送らなかった」という単位の事実なので、そちらは非 null のまま。
      halt = makeStop("recovery-blocked", "別の実行が復旧待ちのため実行を停止した", null, false);
      return finish(blocked(halt, "別の実行が復旧待ちのため生成要求を送らなかった", startedAt));
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
        return finish({
          ok: false,
          attempts,
          failure,
          usage: lastUsage,
          elapsedMs: now() - startedAt,
          halt,
        });
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
        return finish({
          ok: false,
          attempts,
          failure,
          usage: lastUsage,
          elapsedMs: now() - startedAt,
          halt,
        });
      }

      // ensureLoaded を待つ間に中断されていたら送らない（送っていないので未確認にしない）。
      if (isAborted(signal)) {
        halt ??= makeStop("aborted", "停止要求により実行を停止した", null, false);
        return finish({
          ok: false,
          attempts,
          failure: notSentFailure("停止要求により生成要求を送らなかった"),
          usage: lastUsage,
          elapsedMs: now() - startedAt,
          halt,
        });
      }

      let error: LmStudioError;
      try {
        // 送った回数は例外でも数える。
        attempts += 1;
        requestCount += 1;
        hooks?.onSend?.();
        let result: ChatResult;
        try {
          result = await client.chat(request, {
            timeoutMs,
            ...(signal !== undefined ? { signal } : {}),
          });
        } finally {
          // 決定 27：成功・失敗・例外のいずれでも必ず呼ぶ（onSend と同数にする）。
          // ensureLoaded は挟まないので、ここが「実際に送信中」の区間そのものになる。
          hooks?.onSettled?.();
        }
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
        // 決定 27：再試行の手前で signal を再確認する。ここで isAborted(signal) を見ずに
        // continue すると、次の周回の ensureLoaded は当然 isAborted を見て chat を送らずに
        // 抜けるので、2 回目の chat 自体は結局送らない。それでも先に確認する意味は、
        // ensureLoaded 経由で抜けると、届いていた応答の失敗内容（malformed など）が
        // 「モデル一覧の取得中に中断された」（ensure-loaded 由来の aborted）に置き換わって
        // しまう点にある。ここで確認して直接返すことで、その失敗内容を保ったまま
        // 「停止要求により再試行を送らなかった」という halt にできる。
        if (isAborted(signal)) {
          const failure = toFailure(error, "chat");
          halt ??= makeStop("aborted", "停止要求により再試行を送らなかった", failure, false);
          return finish({
            ok: false,
            attempts,
            failure,
            usage: lastUsage,
            elapsedMs: now() - startedAt,
            halt,
          });
        }
        retried = true;
        continue;
      }
      const failure = toFailure(error, "chat");
      const stop = haltForChatError(error, failure);
      if (stop !== null) {
        halt ??= stop;
      }
      return finish({
        ok: false,
        attempts,
        failure,
        usage: lastUsage,
        elapsedMs: now() - startedAt,
        halt,
      });
    }
  }

  async function execute<T>(
    request: ChatRequest,
    parse: (result: ChatResult) => T,
    timeoutMs: number,
    hooks?: ExecuteHooks,
  ): Promise<ExecOutcome<T>> {
    if (queue !== undefined) {
      // queue が渡されているときは、この executor 固有の tail を経由せず、execute の
      // 呼び出し順そのままで共有キューに投入する。tail を経由すると、この executor が
      // 前のジョブの完了を待ってから投入するのに対し、他の executor（＝他の実行）は
      // 即座に投入できてしまい、共有キューへの投入順（＝実行順）が execute の呼び出し順と
      // ずれる（例：A1 → A2 → B1 の順で呼んでも A1 → B1 → A2 の順で実行されてしまう）。
      //
      // runOne は executor 内の可変状態（halt / requestCount / firstModelInfo）を書き換えるが、
      // 共有キューが同時実行数を 1 に保つ（FIFO で前のジョブが解決してから次を始める）ため、
      // 複数 executor 間でこの状態が競合することはない。
      //
      // 決定 45-2：signal を一緒に渡すことで、順番が来る前に停止された場合は前のジョブの
      // 解決を待たずにその場で決着する（待たないと、この実行は他の実行の生成が終わるまで
      // running のまま止まらない）。enqueue の呼び出し自体はここで同期的に行うので、
      // 共有キューへの投入順は execute の呼び出し順のままである。
      const startedAt = now();
      try {
        return await queue.enqueue(
          () => runOne(request, parse, timeoutMs, hooks),
          signal !== undefined ? { signal } : undefined,
        );
      } catch (error) {
        if (!(error instanceof QueueCancelledError)) {
          throw error;
        }
        // キュー待ち中に停止した。生成要求は 1 件も送っていないので generationUnconfirmed は
        // false のまま（単位は pending に残り、再開できる）。文言は runOne 冒頭の 2 分岐
        // （halt 保持済み ／ この単位で初めて停止を見た）とそのまま同じにする。
        //
        // **この catch は共有 halt を書かない。** ここはキューの直列化の**外**で走る唯一の
        // 経路であり（取り消しは順番を待たずに決着する。それが決定 45-2 の要点そのもの）、
        // ここで halt を書くと、同じ executor で送信中だった単位より先に
        // `aborted / generationUnconfirmed: false` が halt を占領してしまう。すると送信中
        // だった単位が中断を処理しても `halt ??= stop` で自分の halt を反映できず、
        // `finish()` が `onRecoveryRequired` を呼ばないため復旧ゲートが開いたままになる
        // （決定 39 が閉じるはずの門が開く）。halt を**書く**のは `runOne` の中だけ
        // ＝キューの直列化の下だけ、という元の性質を保つ。読むだけなら競合しない。
        if (halt !== null) {
          // すでに別の理由（settings / recovery-blocked など）で止まっている。保持している
          // halt は上書きせず、単位の失敗も「停止要求により」ではなくそちらの文言にする。
          return finish(blocked(halt, "実行が停止済みのため生成要求を送らなかった", startedAt));
        }
        // 局所的に作って返すだけ。ループはこの stop を見て break するので、実行の結末は
        // 変わらない（共有 halt が null のままでも、後続の execute はキュー投入の時点で
        // 同じ signal により取り消される）。
        const stop = makeStop("aborted", "停止要求により実行を停止した", null, false);
        return finish(blocked(stop, "停止要求により生成要求を送らなかった", startedAt));
      }
    }
    // キューなしの経路（runPipeline / CLI）は従来どおり、この executor 内の tail で直列化する。
    const started = tail.then(() => runOne(request, parse, timeoutMs, hooks));
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
