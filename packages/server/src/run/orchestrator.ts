/**
 * オーケストレーターの入口（決定 24）。プロセス内に 1 つ作る。
 *
 * 本ファイルで実装するのは `startRun` のみ。単位駆動ループ本体は `run/loop.ts` にあり、
 * ここからは `startLoop` 経由で起動する。`stopRun` / `resumeRun` / `retryFailedUnits` /
 * `reconcileOnStartup` は Task 8・9 で足す。`Orchestrator` インターフェースは決定 24 の全メンバーを一度に生やさず、
 * 現時点で実装できる `startRun` だけを載せる（後続タスクが `interface Orchestrator` を拡張する）。
 * こうすることで、まだ存在しないメソッドへの「とりあえずの throw」を書かずに済み、
 * 呼び出し側が未実装メソッドを呼べば型検査の時点で弾かれる。
 */

import type {
  CheckInput,
  ChunkSettings,
  Paragraph,
  Perspective,
  Range,
  TargetRange,
} from "@shuten/shared";
import {
  ALLOWED_WORD_RULE_VERSION,
  buildCheckInput,
  DIAGNOSTIC_TRANSFORM_VERSION,
  InputTooLongError,
  InvalidChunkSettingsError,
  PROMPT_VERSION,
  planTargets,
  splitParagraphs,
} from "@shuten/shared";

import type { AppDatabase } from "../db/client.ts";
import { isUniqueConstraintViolation } from "../db/errors.ts";
import { createId as createIdDefault } from "../db/ids.ts";
import type {
  ManuscriptVersionRecord,
  RunRecord,
  RunStopReason,
  UnitFailureRecord,
} from "../db/records.ts";
import { insertCheckUnit } from "../db/repositories/check-units.ts";
import { findManuscriptVersion } from "../db/repositories/manuscripts.ts";
import {
  findRun,
  findRunByStartOperationId,
  insertRun,
  insertRunTarget,
} from "../db/repositories/runs.ts";
import type { LmStudioClient } from "../lmstudio/types.ts";
import type { GenerationSettings } from "../prompts/types.ts";
import { splitAllowedWords } from "./allowed-words.ts";
import type { RunEvent } from "./events.ts";
import { runLoop } from "./loop.ts";
import type { RequestQueue } from "./queue.ts";
import { createStopGate } from "./recovery.ts";
import type { RecoveryGate } from "./recovery-gate.ts";
import type { RunStatus } from "./status.ts";

/** `setTimeout` / LM Studio のタイムアウト引数が受け付ける実用上の上限（符号付き 32bit 整数の最大値）。 */
const MAX_TIMEOUT_MS = 2147483647;

/** ---------------------------------------------------------------------- */
/** 公開インターフェース（決定 24） */
/** ---------------------------------------------------------------------- */

export interface OrchestratorDeps {
  readonly db: AppDatabase;
  readonly client: LmStudioClient;
  readonly queue: RequestQueue;
  /** プロセス全体の復旧ゲート（決定 39）。キューと同じく index.ts で 1 個だけ作って渡す。 */
  readonly recoveryGate: RecoveryGate;
  /** `runs.endpoint_url` に保存するだけの値。イベント・結果には出さない。 */
  readonly endpointUrl: string;
  /** config.ts（決定 8）が読む値。復旧確認の待機上限（ミリ秒）。 */
  readonly recoveryConfirmMs: number;
  readonly now?: (() => Date) | undefined;
  readonly createId?: (() => string) | undefined;
  readonly onEvent?: ((event: RunEvent) => void) | undefined;
}

export interface StartRunInput {
  /** 開始操作の識別子。二重送信の防止に使う（決定 12）。 */
  readonly startOperationId: string;
  readonly manuscriptVersionId: string;
  readonly modelId: string;
  /** `model` を除いた生成設定（決定 11。`modelId` と分けて持つ）。 */
  readonly generation: Omit<GenerationSettings, "model">;
  readonly chunkSettings: ChunkSettings;
  readonly timeouts: { readonly checkMs: number; readonly recheckMs: number };
  readonly perspectives: readonly Perspective[];
  readonly recheckEnabled: boolean;
  /** 改行区切りの生の文字列。分割・trim・重複除去はオーケストレーターが行う（決定 7）。 */
  readonly allowedWordsRaw: string;
}

export interface StartRunResult {
  /** 開始（または再開）直後の実行レコード。開始を拒否した場合も終端状態の行を返す。 */
  readonly run: RunRecord;
  /**
   * ループの完了。**決して reject しない**（決定 33）。呼び出し元は待っても捨ててもよい。
   * `running` で始まった実行では単位駆動ループ（`run/loop.ts`）が終端化した `RunRecord`、
   * 開始時点で終端状態になった実行では開始直後の `RunRecord` に解決する。
   */
  readonly done: Promise<RunRecord>;
}

export interface Orchestrator {
  startRun(input: StartRunInput): StartRunResult;
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const now = deps.now ?? ((): Date => new Date());
  const createId = deps.createId ?? createIdDefault;

  /**
   * 実行中の（または開始直後の）`done` を実行 ID で引けるレジストリ（決定 24）。
   * 同じ `startOperationId` の 2 回目が来たとき、ここに登録済みなら同じ `done` を返す。
   * `running` として開始した実行だけを登録する。開始時点で `stopped` になった実行は
   * ループを持たないため登録しない（登録すると、まだ実装していない `stopRun` が
   * 「レジストリにある＝走っているループがある」と誤認しかねない。Task 8 で見直す）。
   */
  const registry = new Map<string, StartRunResult>();

  /** イベント発火を 1 か所にまとめる（決定 42）。`onEvent` の例外はここだけで握る。 */
  const emit = (runId: string, event: RunEvent["event"]): void => {
    const onEvent = deps.onEvent;
    if (onEvent === undefined) {
      return;
    }
    try {
      onEvent({ runId, event });
    } catch {
      // 進捗通知の失敗で実行を止めない（決定 42）。
    }
  };

  /**
   * 単位駆動ループ（`run/loop.ts`）を起動し、`done` になる Promise を返す（決定 24）。
   *
   * **決して reject しない**（決定 33）。想定外の例外の完全な処理（`running` の単位を `pending`
   * に戻し、`internal-error` で終端化する）は Task 8 の仕事だが、ここでも最低限「例外を握って
   * `done` を解決する」「`finally` でレジストリから外し `gate.dispose()` する」ことは行う。
   * 例外で抜けた場合、`run-settled` は出ず、実行は `running` のまま残る（Task 8 で塞ぐ）。
   *
   * 停止ゲートはこの関数が作る。`stopRun`（Task 8）は同じゲートを実行 ID から引く必要があるため、
   * Task 8 でレジストリにゲートを併せて持たせることになる。
   */
  function startLoop(run: RunRecord): Promise<RunRecord> {
    const gate = createStopGate(deps.recoveryConfirmMs);
    return (async (): Promise<RunRecord> => {
      try {
        // ループの最初の書き込み（`claimUnitChecked`）を `startRun` の呼び出しから切り離す。
        // async 関数の本体は最初の `await` まで同期的に走るため、これが無いと `startRun` から
        // 戻る前に 1 単位目が `running` になり、「開始直後の DB の状態」が観測できなくなる
        // （開始トランザクションの結果とループの進行が同じ同期区間に混ざる）。
        await Promise.resolve();
        return await runLoop({
          db: deps.db,
          client: deps.client,
          queue: deps.queue,
          recoveryGate: deps.recoveryGate,
          gate,
          runId: run.id,
          now,
          createId,
          emit: (event) => {
            emit(run.id, event);
          },
        });
      } catch {
        // 決定 24：done は reject しない。DB の現在値（更新できていなければ開始直後の値）を返す。
        return findRun(deps.db, run.id) ?? run;
      } finally {
        registry.delete(run.id);
        gate.dispose();
      }
    })();
  }

  function startRun(input: StartRunInput): StartRunResult {
    const manuscript = findManuscriptVersion(deps.db, input.manuscriptVersionId);
    if (manuscript === null) {
      // 呼び出し側の誤り（存在しない原稿版 ID）。実行を作らずに例外にする。PR10 が 404 にする。
      throw new Error(
        `原稿版が見つかりません（manuscriptVersionId: ${input.manuscriptVersionId}）`,
      );
    }
    if (input.perspectives.length === 0) {
      // 呼び出し側の誤り（観点が 1 つも無い）。作れば「running かつ検査単位 0 件」の実行になり、
      // 決定 18 が 1 トランザクションで防ごうとしている状態（再開が「やることなし」を返して
      // 復旧できない実行）に、例外ではなく入力経由で到達してしまう。実行を作らずに例外にする。
      throw new Error("perspectives が空です（観点を 1 つ以上指定すること）");
    }

    const plan = planStart(manuscript, input, deps.recoveryConfirmMs);
    const startedAt = now();

    try {
      const written = deps.db.transaction((tx) => {
        const run = insertRun(tx, {
          id: createId(),
          manuscriptVersionId: input.manuscriptVersionId,
          modelId: input.modelId,
          // 最初の ensureLoaded 成功まで null（決定 30）。startRun は生成要求を送らない。
          modelInfo: null,
          endpointUrl: deps.endpointUrl,
          generationSettings: input.generation,
          chunkSettings: input.chunkSettings,
          timeouts: input.timeouts,
          recoveryConfirmMs: deps.recoveryConfirmMs,
          perspectives: input.perspectives,
          recheckEnabled: input.recheckEnabled,
          allowedWords: plan.allowedWords,
          allowedWordRuleVersion: ALLOWED_WORD_RULE_VERSION,
          promptVersion: PROMPT_VERSION,
          diagnosticTransformVersion: DIAGNOSTIC_TRANSFORM_VERSION,
          status: plan.runStatus,
          stopReason: plan.stop?.reason ?? null,
          stopMessage: plan.stop?.message ?? null,
          generationUnconfirmed: false,
          startOperationId: input.startOperationId,
          startedAt,
          finishedAt: plan.runStatus === "running" ? null : startedAt,
        });

        const plannedTargets: PlannedTargetEvent[] = [];

        for (const planned of plan.targets) {
          const targetRecord = insertRunTarget(tx, {
            id: createId(),
            runId: run.id,
            targetIndex: planned.target.index,
            target: planned.target.range,
            contextBefore: planned.input?.context.before ?? null,
            contextAfter: planned.input?.context.after ?? null,
            // 上限超過（tooLong）のときは実際の入力を組み立てられていないので、
            // 検査対象そのものの範囲を仮の値として保存する。この値は生成要求の送信には
            // 使ってはならない（対象の単位はすべて failed（input-too-long）で、生成要求を
            // 一度も送らない）。Task 8 の再試行がこの run_targets 行から CheckInput を
            // 組み立て直す経路を作る場合は、この仮の値をそのまま使わないよう要検討。
            input: planned.input?.inputRange ?? planned.target.range,
            paragraphIds: planned.target.paragraphIds,
          });

          plannedTargets.push({
            targetIndex: targetRecord.targetIndex,
            target: targetRecord.target,
            input: targetRecord.input,
          });

          for (const perspective of input.perspectives) {
            if (planned.tooLong !== null) {
              insertCheckUnit(tx, {
                id: createId(),
                runId: run.id,
                targetId: targetRecord.id,
                perspective,
                status: "failed",
                attempts: 0,
                failure: toInputTooLongFailure(planned.tooLong.message),
                pendingNote: null,
                usage: null,
                inputGraphemes: planned.tooLong.required,
                elapsedMs: 0,
                startedAt: null,
                finishedAt: startedAt,
              });
            } else {
              insertCheckUnit(tx, {
                id: createId(),
                runId: run.id,
                targetId: targetRecord.id,
                perspective,
                status: "pending",
                attempts: 0,
                failure: null,
                pendingNote: null,
                usage: null,
                inputGraphemes: null,
                elapsedMs: null,
                startedAt: null,
                finishedAt: null,
              });
            }
          }
        }

        return { run, plannedTargets };
      });

      // target-planned はコミット後に対象ごとに出す（決定 42）。トランザクション内で出すと、
      // ロールバックした場合に存在しない対象を通知したことになる。
      for (const planned of written.plannedTargets) {
        emit(written.run.id, { type: "target-planned", ...planned });
      }

      // 開始時点で終端状態になった実行は、ここでオーケストレーターの終了を通知する
      // （決定 16・`run/events.ts` の「開始・終了は target-planned と run-settled で表す」。
      // レビュー対応 M-2）。target-planned の後に出す：対象の存在を先に伝えてから終了を伝える。
      // ループが走る「running」では、終了は Task 7 のループ自身が出す。
      if (written.run.status !== "running") {
        if (plan.stop === null) {
          // runStatus が "running" 以外なら plan.stop は必ず非 null（StartPlan の不変条件）。
          throw new Error("到達しないはず：非 running な実行に stop 情報が無い");
        }
        emit(written.run.id, {
          type: "run-settled",
          status: written.run.status,
          stop: {
            reason: plan.stop.reason,
            message: plan.stop.message,
            failure: plan.stop.failure,
            generationUnconfirmed: false,
          },
        });
      }

      if (written.run.status !== "running") {
        // ループを持たない実行（開始時点で終端化済み）。レジストリにも登録しない。
        return { run: written.run, done: Promise.resolve(written.run) };
      }

      const result: StartRunResult = { run: written.run, done: startLoop(written.run) };
      registry.set(written.run.id, result);
      return result;
    } catch (error) {
      if (!isUniqueConstraintViolation(error, "start_operation_id")) {
        throw error;
      }
      // 二重送信（決定 12）：既存の実行を引き直して返す。原稿版・設定の一致は判定に使わない。
      const existing = findRunByStartOperationId(deps.db, input.startOperationId);
      if (existing === null) {
        // 一意制約違反が起きた以上、該当行は存在するはず。理論上到達しない防御的分岐。
        throw error;
      }
      const registered = registry.get(existing.id);
      if (registered !== undefined) {
        return registered;
      }
      return { run: existing, done: Promise.resolve(existing) };
    }
  }

  return { startRun };
}

/** ---------------------------------------------------------------------- */
/** 開始時の計算（DB に触れない純粋関数） */
/** ---------------------------------------------------------------------- */

interface PlannedTargetEvent {
  readonly targetIndex: number;
  readonly target: Range;
  readonly input: Range;
}

interface PlannedTarget {
  readonly target: TargetRange;
  /** `buildCheckInput` に成功していれば、実際に組み立てた入力。 */
  readonly input: CheckInput | null;
  /** 上限超過で `buildCheckInput` が失敗した場合の記録。超えていなければ null。 */
  readonly tooLong: { readonly message: string; readonly required: number } | null;
}

/**
 * 実行が開始時点で終端状態になる場合の記録。`runs.stop_reason` / `runs.stop_message` に
 * 保存する値であると同時に、`run-settled` イベント（決定 42・M-2 レビュー対応）を組み立てる
 * ための材料でもある。`failure` は「代表的な失敗」（`InputTooLongError` が複数対象で起きた
 * 場合は最初に見つかった対象のもの）。設定値そのものの検証エラー（タイムアウト・
 * `InvalidChunkSettingsError`）では null。
 */
interface StartStop {
  readonly reason: RunStopReason;
  readonly message: string;
  readonly failure: UnitFailureRecord | null;
}

interface StartPlan {
  readonly runStatus: RunStatus;
  /** `runStatus === "running"` のときだけ null。それ以外は必ず非 null（不変条件）。 */
  readonly stop: StartStop | null;
  readonly allowedWords: readonly string[];
  readonly targets: readonly PlannedTarget[];
}

/** `UnitFailure`（`input-too-long`）を DB の `UnitFailureRecord` に写す。送信前の例外なので origin は "local"。 */
function toInputTooLongFailure(message: string): UnitFailureRecord {
  return { reason: "input-too-long", message, finishReason: null, origin: "local" };
}

/**
 * `checkMs` / `recheckMs` が 1 以上の安全な整数であり、`recoveryConfirmMs` を加算した値が
 * 32bit 符号付き整数の上限を超えないことを検証する（決定 44）。違反したらエラーメッセージを、
 * 問題なければ null を返す。`stopMessage` に使うため、接続先 URL・API キーを含めない定型文。
 */
function validateHardTimeouts(
  timeouts: { readonly checkMs: number; readonly recheckMs: number },
  recoveryConfirmMs: number,
): string | null {
  if (!Number.isSafeInteger(timeouts.checkMs) || timeouts.checkMs < 1) {
    return "タイムアウト設定が不正なため実行を開始できなかった（checkMs は 1 以上の整数である必要がある）";
  }
  if (!Number.isSafeInteger(timeouts.recheckMs) || timeouts.recheckMs < 1) {
    return "タイムアウト設定が不正なため実行を開始できなかった（recheckMs は 1 以上の整数である必要がある）";
  }
  if (timeouts.checkMs + recoveryConfirmMs > MAX_TIMEOUT_MS) {
    return "タイムアウト設定が不正なため実行を開始できなかった（checkMs + recoveryConfirmMs が上限を超えている）";
  }
  if (timeouts.recheckMs + recoveryConfirmMs > MAX_TIMEOUT_MS) {
    return "タイムアウト設定が不正なため実行を開始できなかった（recheckMs + recoveryConfirmMs が上限を超えている）";
  }
  return null;
}

/**
 * 開始時に書く内容を DB に触れずに計算する（決定 18・44）。
 *
 * 1. 決定 44 のタイムアウト検証（`validateChunkSettings` と同じ位置）。違反したら対象を
 *    1 件も作らず `stopped`（`settings`）。
 * 2. `planTargets`（内部で `validateChunkSettings` を呼ぶ）。`InvalidChunkSettingsError` は
 *    同じく対象を 1 件も作らず `stopped`（`settings`）。
 * 3. 各対象に `buildCheckInput`。`InputTooLongError` が 1 件でもあれば、その対象の単位を
 *    `failed`（`input-too-long`）で作りつつ実行全体を `stopped`（`settings`）にする（決定 18）。
 *    全対象が成功すれば `running`。
 */
function planStart(
  manuscript: ManuscriptVersionRecord,
  input: StartRunInput,
  recoveryConfirmMs: number,
): StartPlan {
  const allowedWords = splitAllowedWords(input.allowedWordsRaw);

  const timeoutError = validateHardTimeouts(input.timeouts, recoveryConfirmMs);
  if (timeoutError !== null) {
    return {
      runStatus: "stopped",
      stop: { reason: "settings", message: timeoutError, failure: null },
      allowedWords,
      targets: [],
    };
  }

  const paragraphs: readonly Paragraph[] = splitParagraphs(manuscript.body);

  let targetRanges: readonly TargetRange[];
  try {
    targetRanges = planTargets(manuscript.body, paragraphs, input.chunkSettings);
  } catch (error) {
    if (!(error instanceof InvalidChunkSettingsError)) {
      throw error;
    }
    return {
      runStatus: "stopped",
      stop: {
        reason: "settings",
        message: `分割設定が不正なため実行を開始できなかった: ${error.message}`,
        failure: null,
      },
      allowedWords,
      targets: [],
    };
  }

  let firstTooLong: { readonly message: string; readonly required: number } | null = null;
  const targets: PlannedTarget[] = [];
  for (const target of targetRanges) {
    try {
      const checkInput = buildCheckInput(manuscript.body, paragraphs, target, input.chunkSettings);
      targets.push({ target, input: checkInput, tooLong: null });
    } catch (error) {
      if (!(error instanceof InputTooLongError)) {
        throw error;
      }
      const tooLong = { message: error.message, required: error.required };
      if (firstTooLong === null) {
        firstTooLong = tooLong;
      }
      targets.push({ target, input: null, tooLong });
    }
  }

  if (firstTooLong !== null) {
    return {
      runStatus: "stopped",
      stop: {
        reason: "settings",
        message: "検査対象の入力が上限を超えたため実行を停止した。設定を見直すこと。",
        // 代表として最初に見つかった対象の失敗を run-settled イベントに載せる（複数対象が
        // 同時に超過することもあるため、どれか 1 つを選ぶ。DB 側は各対象の check_units に
        // それぞれの failure を個別に保存済み。ここはイベント用の要約）。
        failure: toInputTooLongFailure(firstTooLong.message),
      },
      allowedWords,
      targets,
    };
  }

  return { runStatus: "running", stop: null, allowedWords, targets };
}
