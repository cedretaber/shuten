/**
 * オーケストレーターの入口（決定 24）。プロセス内に 1 つ作る。
 *
 * 本ファイル（PR9b Task 6）で実装するのは `startRun` のみ。単位駆動ループ本体は Task 7 で
 * `run/loop.ts` に置き、`stopRun` / `resumeRun` / `retryFailedUnits` / `reconcileOnStartup` は
 * Task 8・9 で足す。`Orchestrator` インターフェースは決定 24 の全メンバーを一度に生やさず、
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
import { findRunByStartOperationId, insertRun, insertRunTarget } from "../db/repositories/runs.ts";
import type { LmStudioClient } from "../lmstudio/types.ts";
import type { GenerationSettings } from "../prompts/types.ts";
import { splitAllowedWords } from "./allowed-words.ts";
import type { RunEvent } from "./events.ts";
import type { RequestQueue } from "./queue.ts";
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
   * 本タスク（Task 6）の実装では、単位駆動ループがまだ無いため、開始直後の `RunRecord` を
   * そのまま解決する Promise を返す（仮実装。Task 7 でループの完了に置き換える）。
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

  function startRun(input: StartRunInput): StartRunResult {
    const manuscript = findManuscriptVersion(deps.db, input.manuscriptVersionId);
    if (manuscript === null) {
      // 呼び出し側の誤り（存在しない原稿版 ID）。実行を作らずに例外にする。PR10 が 404 にする。
      throw new Error(
        `原稿版が見つかりません（manuscriptVersionId: ${input.manuscriptVersionId}）`,
      );
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
          stopReason: plan.stopReason,
          stopMessage: plan.stopMessage,
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

      const result: StartRunResult = { run: written.run, done: Promise.resolve(written.run) };
      if (written.run.status === "running") {
        registry.set(written.run.id, result);
      }
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

interface StartPlan {
  readonly runStatus: RunStatus;
  readonly stopReason: RunStopReason | null;
  readonly stopMessage: string | null;
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
      stopReason: "settings",
      stopMessage: timeoutError,
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
      stopReason: "settings",
      stopMessage: `分割設定が不正なため実行を開始できなかった: ${error.message}`,
      allowedWords,
      targets: [],
    };
  }

  let hasTooLong = false;
  const targets: PlannedTarget[] = targetRanges.map((target) => {
    try {
      const checkInput = buildCheckInput(manuscript.body, paragraphs, target, input.chunkSettings);
      return { target, input: checkInput, tooLong: null };
    } catch (error) {
      if (!(error instanceof InputTooLongError)) {
        throw error;
      }
      hasTooLong = true;
      return {
        target,
        input: null,
        tooLong: { message: error.message, required: error.required },
      };
    }
  });

  if (hasTooLong) {
    return {
      runStatus: "stopped",
      stopReason: "settings",
      stopMessage: "検査対象の入力が上限を超えたため実行を停止した。設定を見直すこと。",
      allowedWords,
      targets,
    };
  }

  return { runStatus: "running", stopReason: null, stopMessage: null, allowedWords, targets };
}
