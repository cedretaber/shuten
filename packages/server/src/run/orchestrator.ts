/**
 * オーケストレーターの入口（決定 24）。プロセス内に 1 つ作る。
 *
 * 本ファイルが持つのは開始（`startRun`）・停止（`stopRun`）・再開（`resumeRun`）・
 * 失敗単位の個別再試行（`retryFailedUnits`）・起動時照合（`reconcileOnStartup`）。単位駆動ループ
 * 本体は `run/loop.ts` にあり、開始・再開・再試行はそこから `launch` 経由で起動する。
 *
 * 責務の分け方（第一の防御は「状態を書く経路を 1 つにする」）：
 *
 * - **実行状態（`runs.status`）を書くのはループと本ファイルの 3 つの入口だけ**。停止要求は
 *   `runs.status` を変えない（決定 21）。`stop_requested_at` を書き、停止ゲートに要求を渡し、
 *   `stop-requested` を通知するだけで、実際に打ち切って終端状態を書くのはループである。
 * - 状態を書くときは必ず `run/transitions.ts`（`claim*Checked` / `finish*Checked`）を通す
 *   （決定 29。`db/repositories` の `claim*` / `finish*` は直接呼ばない。`run/loop.test.ts` の
 *   W3 が静的に検査している）。
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

import { MAX_TIMEOUT_MS } from "../config.ts";
import type { AppDatabase, AppDatabaseLike } from "../db/client.ts";
import { isUniqueConstraintViolation } from "../db/errors.ts";
import { createId as createIdDefault } from "../db/ids.ts";
import type { ManuscriptVersionRecord, RunRecord, UnitFailureRecord } from "../db/records.ts";
import { findCheckUnit, insertCheckUnit, listCheckUnits } from "../db/repositories/check-units.ts";
import { findManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { findRecheckUnit, listRecheckUnits } from "../db/repositories/rechecks.ts";
import {
  findRun,
  findRunByStartOperationId,
  insertRun,
  insertRunTarget,
  listRunsByStatus,
  setStopRequestedAt,
} from "../db/repositories/runs.ts";
import type { LmStudioClient } from "../lmstudio/types.ts";
import type { GenerationSettings } from "../prompts/types.ts";
import { splitAllowedWords } from "./allowed-words.ts";
import type { RunEvent } from "./events.ts";
import { runLoop } from "./loop.ts";
import type { RequestQueue } from "./queue.ts";
import type { StopGate } from "./recovery.ts";
import { createStopGate } from "./recovery.ts";
import type { RecoveryGate } from "./recovery-gate.ts";
import { runStatusForUnconfirmed } from "./state.ts";
import type { RunStatus } from "./status.ts";
import {
  claimRecheckUnitChecked,
  claimRunChecked,
  claimUnitChecked,
  finishCheckUnitChecked,
  finishRecheckUnitChecked,
  finishRunChecked,
} from "./transitions.ts";

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

/**
 * 再開・再試行の結果。`StartRunResult` に「受け付けたか」を足したもの。
 *
 * `accepted` が false なら**状態を 1 つも変えていない**（決定 36 の「拒否。現在のレコードを
 * 返す（例外にしない）」）。`run` は拒否した時点の DB の値で、`done`：
 *
 * - 実行中の実行への再開・再試行要求（O11）では、走っているループの `done` をそのまま返す
 *   （二重にループを起こさない）。
 * - それ以外の拒否（`completed` など）では、返した `run` で即座に解決する Promise。
 */
export interface RunLaunchResult extends StartRunResult {
  readonly accepted: boolean;
}

/** `stopRun` の結果。 */
export interface StopRunResult {
  /**
   * 停止要求を受け付けたか。走っているループが無い（レジストリに無い）実行では false になり、
   * **DB を 1 行も変えない**。
   */
  readonly accepted: boolean;
  /** 呼び出し後の実行レコード。実行が存在しなければ null。 */
  readonly run: RunRecord | null;
}

/** `retryFailedUnits` の任意引数。 */
export interface RetryFailedUnitsOptions {
  /**
   * 戻す単位の ID。`check_units` と `recheck_units` の ID を混ぜて渡してよい（決定 36）。
   * 省略するとその実行の `failed` な単位を全件戻す。**空配列は誤り**（省略が「全件」なので、
   * 空配列を全件と読むと取り違えが静かに通る）。
   */
  readonly unitIds?: readonly string[] | undefined;
}

/**
 * `retryFailedUnits` の対象指定が決定 36 の条件を満たさないときの例外。
 * 実行の状態も単位も 1 つも変えずに拒否したことを表す（PR10 は 400 に写す）。
 * メッセージには単位 ID しか入れない（接続先 URL・API キー・原稿の断片を入れない）。
 */
export class RetryTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryTargetError";
  }
}

export interface Orchestrator {
  startRun(input: StartRunInput): StartRunResult;
  /**
   * 停止要求（決定 6・21）。`runs.status` は `running` のまま変えず、`stop_requested_at` を
   * 書いて停止ゲートに要求を渡すだけ。実行中の 1 要求は `recoveryConfirmMs` まで自然な完了を
   * 待つ（待ち時間の管理は `run/recovery.ts` の `StopGate`）。冪等（2 回目以降は
   * `stop_requested_at` を書き直さない）。
   */
  stopRun(runId: string): StopRunResult;
  /**
   * 再開（決定 36・39）。`stopped` / `recovery-waiting` の実行だけを受け付ける
   * （`stop_reason` が `settings` のものは除く）。
   */
  resumeRun(runId: string): RunLaunchResult;
  /** 失敗単位の個別再試行（決定 36）。`partially-failed` / `stopped` の実行だけを受け付ける。 */
  retryFailedUnits(runId: string, options?: RetryFailedUnitsOptions): RunLaunchResult;
  /**
   * 起動時照合（決定 13・39・40）。マイグレーション適用後、API 受付前に `index.ts` から 1 度だけ
   * 呼ぶ。自動では再開しない（プロセスが落ちた時点で LM Studio 側の生成が走っていた可能性を
   * 否定できないため）。想定外の例外はそのまま投げる（`index.ts` の非ゼロ終了に委ねる）。
   */
  reconcileOnStartup(): void;
}

/** 決定 33：想定外の例外で終端化した実行の `stop_message`。定型文のみ（例外のメッセージを転記しない）。 */
const INTERNAL_ERROR_RUN_MESSAGE = "想定外のエラーで実行を停止しました";

/** 決定 33：想定外の例外で `pending` に戻した単位の `pending_note`。同じく定型文のみ。 */
const INTERNAL_ERROR_UNIT_NOTE = "想定外のエラーで実行が中断した";

/** 決定 13：起動時照合で `pending` に戻した単位の `pending_note`。 */
const RECONCILE_UNIT_NOTE = "バックエンドが終了したため未完了のまま残った";

/** 決定 13：起動時照合で `recovery-waiting` にした実行の `stop_message`。 */
const RECONCILE_RECOVERY_MESSAGE =
  "バックエンドが終了しました。LM Studio 側を確認して再開してください";

/** 決定 13：起動時照合で `stopped` にした実行の `stop_message`（`running` の単位が無かった場合）。 */
const RECONCILE_STOPPED_MESSAGE = "バックエンドが終了しました";

/** レジストリの 1 件。走っているループの `done` と、その実行の停止ゲートを対で持つ。 */
interface RegisteredRun {
  readonly gate: StopGate;
  readonly result: StartRunResult;
}

/** `retryFailedUnits` が `failed → pending` に戻す単位の ID（表ごとに分ける）。 */
interface RetryTargets {
  readonly checkUnitIds: readonly string[];
  readonly recheckUnitIds: readonly string[];
}

/**
 * `input-too-long` で失敗した検査単位か（決定 36）。**この単位は再試行の対象から外す。**
 *
 * 理由は 2 つ。(1) 分割設定は実行ごとに固定（`runs.chunk_settings`）なので、同じ実行の中で
 * 再試行しても必ず同じ上限超過になる。(2) より危険なのは、`startRun` が上限超過の対象について
 * `run_targets.input` に**実際に試みた範囲を保存できない**ことである（`buildCheckInput` は失敗時に
 * 試みた範囲を返さないため、暫定値として検査対象そのものの範囲を入れている）。この行から
 * `checkInputFromTargetRecord`（`run/persist.ts`）で入力を組み直すと、参考文脈のない**本来より
 * 狭い入力**ができ、上限検査を素通りして検査が「成功」してしまう。仕様 7 節「入力上限超過時に
 * 本文を黙って切り捨てない」に反する。守りは入力を組み立てる側ではなく、ここ（消費側）に置く。
 */
function isInputTooLong(unit: { readonly failure: UnitFailureRecord | null }): boolean {
  return unit.failure?.reason === "input-too-long";
}

/**
 * 保存済みの版が現行の定数と食い違っているか（決定 45-1。仕様 8.2）。
 *
 * 仕様 8.2 は「再開では原稿版・モデル・設定（許容語を含む）・**プロンプト版**を変更できない。
 * 変更する場合は新規検査として開始する」と定めている。原稿版・モデル・生成設定・分割設定・
 * 許容語一覧は `runs` の行から読み直すので実行の途中で変わりようがないが、
 * `prompt_version` / `allowed_word_rule_version` / `diagnostic_transform_version` の 3 つだけは
 * **コード内の定数**に由来する。アプリを更新すると、同じ実行の続きに別の版の結果が混ざり、
 * 記録は旧版のまま残ってしまう。
 *
 * そこで再開（`resumeRun`）と再試行（`retryFailedUnits`）の**両方**が、`claimRunChecked` を
 * 呼ぶ前（DB を 1 行も書かない位置）でこれを見て、true なら `rejected(existing)` を返す。
 * 旧版を再現する仕組みは持たない（MVP の範囲外）。利用者への案内は
 * 「アプリの更新でプロンプト版が変わったため再開できない。新しい実行を開始してください」。
 * 3 つのうちどれが食い違ったかは案内し分けない（対処は 1 つしかない）ので、判定もここに 1 つだけ置く。
 */
function hasStaleVersions(run: RunRecord): boolean {
  return (
    run.promptVersion !== PROMPT_VERSION ||
    run.allowedWordRuleVersion !== ALLOWED_WORD_RULE_VERSION ||
    run.diagnosticTransformVersion !== DIAGNOSTIC_TRANSFORM_VERSION
  );
}

/**
 * `running` の検査単位・再確認単位を `pending` に戻す（決定 33・40 で共通の規則）。
 * **呼び出し元のトランザクションの中で呼ぶこと**（実行の終端化と同じ 1 トランザクションにする）。
 *
 * 戻さないと `resumeRun` が拾えない（`claimUnitChecked(pending → running)` が 0 行になり、
 * 起動時照合は起動時にしか走らない）。処理状態（次に何をするか）だけを戻し、直前に何が
 * 起きたか（`attempts` / `failure` / `usage` / `inputGraphemes` / `elapsedMs`）は保つ
 * （決定 20 と同じ考え方）。
 *
 * 戻り値は「戻す前に `running` の単位が 1 件でもあったか」。**この判定は書き換えより先に
 * 確定させる**：先に `pending` に書き換えてから同じ行を読み直すと `running` が 0 件になり、
 * 「単位を持っていなかった」と誤判定する（決定 40 が警告している誤分類そのもの）。
 * 呼び出し元はこれを「生成が LM Studio 側で走り続けている可能性があるか」の判断に使う。
 *
 * @param note `pending` に戻した単位に残す `pending_note`（呼び出し元ごとの定型文）。
 */
function resetRunningUnits(
  tx: AppDatabaseLike,
  runId: string,
  note: string,
  finishedAt: Date,
): boolean {
  const checkUnits = listCheckUnits(tx, runId);
  const recheckUnits = listRecheckUnits(tx, runId);
  const hadRunning =
    checkUnits.some((unit) => unit.status === "running") ||
    recheckUnits.some((unit) => unit.status === "running");

  for (const unit of checkUnits) {
    if (unit.status !== "running") {
      continue;
    }
    finishCheckUnitChecked(tx, unit.id, {
      expectedStatus: "running",
      status: "pending",
      attempts: unit.attempts,
      failure: unit.failure,
      pendingNote: note,
      usage: unit.usage,
      inputGraphemes: unit.inputGraphemes,
      elapsedMs: unit.elapsedMs,
      finishedAt,
    });
  }
  for (const unit of recheckUnits) {
    if (unit.status !== "running") {
      continue;
    }
    finishRecheckUnitChecked(tx, unit.id, {
      expectedStatus: "running",
      status: "pending",
      attempts: unit.attempts,
      failure: unit.failure,
      pendingNote: note,
      notApplicableReason: null,
      verdict: unit.verdict,
      reasonKind: unit.reasonKind,
      reason: unit.reason,
      suggestionValid: unit.suggestionValid,
      usage: unit.usage,
      inputGraphemes: unit.inputGraphemes,
      elapsedMs: unit.elapsedMs,
      finishedAt,
    });
  }
  return hadRunning;
}

/**
 * `retryFailedUnits` が戻す単位を決める（決定 36）。**状態を 1 つも変える前に**、呼び出し元の
 * トランザクションの中で全件を検証する。1 件でも違反したら `RetryTargetError` を投げ、
 * トランザクションごとロールバックさせる。
 *
 * `unitIds` を省略した場合は、その実行の `failed` な単位を全件戻す（`input-too-long` は除く）。
 * 明示指定の場合は ID ごとに次を確かめる。ID だけで `claimUnitChecked` を呼ぶと、
 * **別の実行に属する失敗単位を書き換えられてしまう**ため、2 番目の検証は特に落とせない。
 *
 * 1. `check_units` と `recheck_units` のちょうど一方に存在すること
 * 2. その行の `run_id` が引数の `runId` と一致すること
 * 3. その行の現在の状態が `failed` であること
 * 4. `input-too-long` の検査単位でないこと
 *
 * `unitIds` が空配列なら誤り（省略が「全件」なので、空配列を全件と読むと取り違えが静かに通る）。
 */
function collectRetryTargets(
  db: AppDatabaseLike,
  runId: string,
  unitIds: readonly string[] | undefined,
): RetryTargets {
  if (unitIds === undefined) {
    const checkUnitIds = listCheckUnits(db, runId)
      .filter((unit) => unit.status === "failed" && !isInputTooLong(unit))
      .map((unit) => unit.id);
    const recheckUnitIds = listRecheckUnits(db, runId)
      .filter((unit) => unit.status === "failed")
      .map((unit) => unit.id);
    if (checkUnitIds.length === 0 && recheckUnitIds.length === 0) {
      // 戻す単位が 1 件も無いのに実行だけ `running` にすると、`retryFailedUnits` が
      // 実質 `resumeRun` になってしまう（`pending` のまま残っていた単位に生成要求を送り、
      // 前回の停止理由も消える）。何も変えずに拒否する。
      throw new RetryTargetError(
        `再試行できる失敗単位がありません（実行 ID: ${runId}）。` +
          "入力上限を超えた単位は分割設定を見直して新しい実行を開始すること",
      );
    }
    return { checkUnitIds, recheckUnitIds };
  }

  if (unitIds.length === 0) {
    throw new RetryTargetError(
      "再試行の対象 ID が空です（全件を対象にする場合は unitIds を省略すること）",
    );
  }

  const checkUnitIds: string[] = [];
  const recheckUnitIds: string[] = [];
  const seen = new Set<string>();
  for (const id of unitIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);

    const checkUnit = findCheckUnit(db, id);
    const recheckUnit = findRecheckUnit(db, id);
    if (checkUnit !== null && recheckUnit !== null) {
      throw new RetryTargetError(
        `単位 ID が検査単位と再確認単位の両方に存在します（単位 ID: ${id}）`,
      );
    }
    if (checkUnit === null && recheckUnit === null) {
      throw new RetryTargetError(`再試行の対象が見つかりません（単位 ID: ${id}）`);
    }

    const unit = checkUnit ?? recheckUnit;
    if (unit === null) {
      throw new Error("到達しないはず：両方 null は上で弾いている");
    }
    if (unit.runId !== runId) {
      throw new RetryTargetError(
        `再試行の対象が別の実行に属しています（単位 ID: ${id}, 実行 ID: ${runId}）`,
      );
    }
    if (unit.status !== "failed") {
      throw new RetryTargetError(
        `再試行できるのは failed の単位だけです（単位 ID: ${id}, 状態: ${unit.status}）`,
      );
    }

    if (checkUnit !== null) {
      if (isInputTooLong(checkUnit)) {
        throw new RetryTargetError(
          `入力上限を超えて失敗した検査単位は再試行できません（単位 ID: ${id}）。` +
            "分割設定を見直して新しい実行を開始すること",
        );
      }
      checkUnitIds.push(id);
    } else {
      // 再確認単位は `input-too-long` でも除外しない（検査単位との**意図的な非対称**）。
      // 除外の理由は「上限超過だから」ではなく「`run_targets.input` が暫定値なので、そこから
      // 入力を組み直すと参考文脈のない狭い入力になり、上限検査を素通りする」ことにある。
      // 再確認の入力は毎回 `buildRecheckInput` で組み直す（保存された暫定値を使わない）ので、
      // この危険が無い。再試行しても同じ上限超過を繰り返すだけで、黙って切り詰めた入力を
      // 送ることにはならない。
      recheckUnitIds.push(id);
    }
  }
  return { checkUnitIds, recheckUnitIds };
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const now = deps.now ?? ((): Date => new Date());
  const createId = deps.createId ?? createIdDefault;

  /**
   * 走っているループを実行 ID で引けるレジストリ（決定 24）。**ここにある＝このプロセスで
   * ループが走っている**、が不変条件（`launch` で登録し、ループの `finally` で必ず外す）。
   *
   * `done` だけでなく**停止ゲートも持つ**。停止要求（`stopRun`）はループのローカル変数には
   * 届かないため、ゲートを実行 ID から引ける場所に置く必要がある。
   *
   * 同じ `startOperationId` の 2 回目が来たとき、ここに登録済みなら同じ `done` を返す。
   * 開始時点で終端状態になった実行はループを持たないため登録しない（登録すると `stopRun` が
   * 「走っているループがある」と誤認する）。
   */
  const registry = new Map<string, RegisteredRun>();

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
   * 単位駆動ループ（`run/loop.ts`）を起動し、レジストリに登録した結果を返す（決定 24）。
   * 開始・再開・再試行の 3 つの入口がすべてここを通る（ループは初回と再開を区別しない）。
   *
   * 停止ゲートの上限には、プロセス設定（`deps.recoveryConfirmMs`）ではなく**実行ごとの値**
   * （`runs.recovery_confirm_ms`）を使う。ループが `executeCheckUnit` に渡すハード上限
   * （`checkMs + recoveryConfirmMs`）も、打ち切った単位の `pending_note` の分岐（決定 20・32）も
   * `run.recoveryConfirmMs` を見ており、ゲートだけ別の値にすると、同じ実行の中で
   * 「上限まで待つ時間」と「上限超過の扱い」が食い違う。`startRun` の直後は `insertRun` が
   * `deps.recoveryConfirmMs` を書いた直後なので両者は必ず一致し、食い違いうるのは
   * 設定を変えて再起動した後の `resumeRun` / `retryFailedUnits` だけである。
   */
  function launch(run: RunRecord): StartRunResult {
    const gate = createStopGate(run.recoveryConfirmMs);
    const done = startLoop(run, gate);
    const result: StartRunResult = { run, done };
    // `startLoop` の本体は最初の `await Promise.resolve()` までしか同期に走らず、
    // レジストリを触るのはその後の `finally` なので、ここで登録しても取りこぼさない。
    registry.set(run.id, { gate, result });
    return result;
  }

  /**
   * ループを回し、`done` になる Promise を返す。**決して reject しない**（決定 24・33）。
   *
   * 想定外の例外（`LmStudioError` でも `InputTooLongError` でもないもの）はここで握り、
   * `settleInternalError` が `running` の単位を `pending` に戻して実行を終端化する。
   * レジストリからの削除と `gate.dispose()` は `finally` で必ず行う。
   */
  function startLoop(run: RunRecord, gate: StopGate): Promise<RunRecord> {
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
        // 決定 33：例外の中身は見ない（`stop_message` にも `pending_note` にも転記しない）。
        return settleInternalError(run);
      } finally {
        registry.delete(run.id);
        gate.dispose();
      }
    })();
  }

  /**
   * 決定 33：想定外の例外で抜けた実行の後始末。
   *
   * 1. その時点で `running` の検査単位・再確認単位を `pending` に戻す（`resetRunningUnits`。
   *    起動時照合と同じ規則で、`pending_note` の定型文だけが違う）。**戻さないと
   *    `resumeRun` が拾えない**（`claimUnitChecked(pending → running)` が 0 行になり、
   *    起動時照合は起動時にしか走らない）。
   * 2. 実行を終端化する。`stop_reason` は `internal-error`、`stop_message` は定型文のみ。
   *    例外のメッセージには接続先 URL・API キーだけでなく**原稿の断片**が混ざりうる
   *    （`run/persist.ts` の `PersistBoundaryError` は違反した引用の先頭 20 コード単位を持つ）。
   *
   *    終了状態は決定 23 の規則そのままで、**復旧ゲートがこの実行を掴んでいれば
   *    `recovery-waiting`（`generation_unconfirmed = true`）**、そうでなければ `stopped` にする。
   *    ゲートが閉じているのは executor が「生成が LM Studio 側で走り続けている可能性がある」と
   *    判断した後だけで、その事実は後から起きた例外とは無関係に真である。ここで `stopped` に
   *    してしまうと、ゲートを開けられるのは `recovery-waiting` の実行を claim できたときだけ
   *    （決定 39）なので、**プロセス全体の送信が再起動まで止まる**。
   *    「ゲートが閉じている ⟹ その実行は `recovery-waiting`」を不変条件として保つ。ここで使うのは
   *    この向きだけである。逆向き（`recovery-waiting` ならゲートが閉じている）は決定 45-1 の
   *    拒否経路（版が変わった `recovery-waiting` の実行を、DB は `recovery-waiting` のまま
   *    ゲートだけ開けて拒否する）で成り立たない。再起動時は `reconcileOnStartup` が
   *    `recovery-waiting` を全件閉じ直すので、その実行のゲートはまた閉じる
   *    （持ち越しの「復旧を確認した操作（PR10）」がこの往復を無くす）。
   * 3. 単位の差し戻しと終端化は 1 トランザクションにする（片方だけ書けた状態を残さない）。
   * 4. **この後始末自体が失敗することもある**（DB が原因の例外なら 1・2 も、その後の読み直しも
   *    失敗する）。その場合も握り、`done` は最後に読めた `RunRecord`（読めなければ引数）で
   *    解決する。ここで例外を漏らすと `startLoop` の `catch` の中で投げることになり、
   *    **`done` が reject する**（決定 24 の不変条件が破れる）。
   */
  function settleInternalError(run: RunRecord): RunRecord {
    // 決定 39：ゲートがこの実行を掴んでいるか。DB に触れないので例外にならない。
    const unconfirmed = deps.recoveryGate.blockedRunIds.has(run.id);
    try {
      const finishedAt = now();
      deps.db.transaction((tx) => {
        resetRunningUnits(tx, run.id, INTERNAL_ERROR_UNIT_NOTE, finishedAt);
        finishRunChecked(tx, run.id, {
          expectedStatus: "running",
          status: runStatusForUnconfirmed(unconfirmed),
          stopReason: "internal-error",
          stopMessage: INTERNAL_ERROR_RUN_MESSAGE,
          generationUnconfirmed: unconfirmed,
          finishedAt,
        });
      });
    } catch {
      // 決定 33 の 5：後始末の失敗も握る。`done` は下で読み直した値（読めなければ引数）で解決する。
    }

    // 読み直しも try の中に入れる。`findRun` は「行が無い」を null で返すが、**DB そのものが
    // 壊れていれば例外を投げる**。決定 33 の 5 が想定しているのはまさにその場合で、ここで
    // 例外が漏れると `startLoop` の `catch` の中で投げることになり `done` が reject する。
    let current = run;
    try {
      current = findRun(deps.db, run.id) ?? run;
    } catch {
      // 読み直せなければ、ループに入る前に読めた値（引数）をそのまま返す。
    }

    // 決定 33 の 4：例外は `done` に載せず、`run-settled` で通知する。状態は DB の実際の値を
    // 載せる（後始末に失敗していれば `running` のままでありうる。嘘を通知しない）。
    emit(run.id, {
      type: "run-settled",
      status: current.status,
      stop: {
        reason: "internal-error",
        message: INTERNAL_ERROR_RUN_MESSAGE,
        failure: null,
        generationUnconfirmed: unconfirmed,
      },
    });
    return current;
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

      return launch(written.run);
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
        return registered.result;
      }
      return { run: existing, done: Promise.resolve(existing) };
    }
  }

  /**
   * 停止要求（決定 6・21・26）。**`runs.status` は変えない。**
   *
   * 書くのは `stop_requested_at` だけで、実際に打ち切って終端状態（`stopped` /
   * `recovery-waiting`）を書くのはループである。停止から終了状態への写像を停止操作の側に
   * 持たせない（決定 23・26）ための形で、こうしておくと「停止要求を受けたが実行中の要求の
   * 終了を待っている」状態（仕様 8.2 が表示を求めている状態）がそのまま DB に現れる。
   *
   * 走っているループが無ければ（レジストリに無ければ）**DB を 1 行も変えずに**
   * `{ accepted: false }` を返す。停止ゲートに届かない停止要求で `stop_requested_at` だけが
   * 残ると、終端状態の実行が「停止要求中」に見えてしまう。
   */
  function stopRun(runId: string): StopRunResult {
    const registered = registry.get(runId);
    if (registered === undefined) {
      return { accepted: false, run: findRun(deps.db, runId) };
    }
    if (registered.gate.stopRequested) {
      // 2 回目以降。ゲートは冪等（タイマーを 2 本立てない）なので、こちらも
      // `stop_requested_at` を書き直さない（表示するのは最初に要求を受けた時刻）。
      return { accepted: true, run: findRun(deps.db, runId) };
    }
    setStopRequestedAt(deps.db, runId, now());
    registered.gate.requestStop();
    emit(runId, { type: "stop-requested" });
    return { accepted: true, run: findRun(deps.db, runId) };
  }

  /** 受け付けなかった要求の戻り値。状態を 1 つも変えていないことを表す。 */
  function rejected(run: RunRecord): RunLaunchResult {
    return { run, done: Promise.resolve(run), accepted: false };
  }

  /**
   * 再開（決定 36・39）。受け付けるのは `stopped` と `recovery-waiting` だけで、
   * そのうち **`stop_reason` が `settings` のものは受け付けない**。
   *
   * `claimRunChecked(..., { clearStopState: true })` で `running` にしてからループを起動する。
   * ループは初回実行と再開を区別しないので、`pending` の単位を拾って続きから進む
   * （`failed` の単位は拾わない。それは `retryFailedUnits` の仕事）。
   *
   * `recovery-waiting` の実行の claim に成功したときだけ復旧ゲートを開ける（決定 39）。
   * **ここがプロセス全体の送信ゲートを開ける唯一の口**である。時間が経ったことを
   * 「生成が終わった証拠」にはできないので、開けてよいのは利用者が復旧を確認して
   * 再開を指示したときだけ、という形にしてある。
   */
  function resumeRun(runId: string): RunLaunchResult {
    const existing = findRun(deps.db, runId);
    if (existing === null) {
      // 呼び出し側の誤り（存在しない実行 ID）。PR10 が 404 にする。
      throw new Error(`検査実行が見つかりません（実行 ID: ${runId}）`);
    }
    const registered = registry.get(runId);
    if (registered !== undefined) {
      // 実行中（O11）。ループを二重に起こさず、走っているループの `done` をそのまま返す。
      return { ...registered.result, accepted: false };
    }
    if (existing.status !== "stopped" && existing.status !== "recovery-waiting") {
      // `running`（このプロセスにループが無い）・`completed`・`partially-failed` は拒否。
      // `partially-failed` からの再開は「やることなし」で即 `partially-failed` に戻るだけなので、
      // 失敗単位の個別再試行（`retryFailedUnits`）に案内する（決定 36 の表）。
      return rejected(existing);
    }
    if (existing.stopReason === "settings") {
      // 決定 36：設定エラーで止まった実行は再開できない。`startRun` が決定 18・44 で作る
      // `stopped`（`settings`）の実行は、検査単位が 0 件か、上限を超えた対象の単位が
      // `failed`（`input-too-long`）になっている。そのまま受け付けると、上限を超えた対象を
      // 検査しないまま `completed` / `partially-failed` になり（対象がすべて超過していれば
      // **生成要求を 1 件も送らずに**）、
      // しかも `clearStopState` が停止理由まで消してしまう。1 度も検査していない実行が
      // 「完了・指摘 0 件」として残るのは `docs/reference/invariants.md` の
      // 「失敗を指摘ゼロと誤表示しない」に反する。利用者への案内は「設定を見直して
      // 新しい実行を開始する」。実行中に出る `settings`（モデル種別が生成に使えない、
      // `chat` が返す入力上限超過）も同じ扱いでよい。どちらもメッセージ自体が
      // 「設定を見直せ」という意味だからである。
      //
      // **判別子を「`pending` の単位が 0 件」に置いてはならない**：最後の検査単位を保存した直後、
      // 対象の決着処理（決定 34 の再確認の起票）の前に停止した実行は、`pending` の単位が 0 件でも
      // 「起票して再確認を走らせる」という正当な仕事が残っており、弾くと復旧できなくなる。
      return rejected(existing);
    }
    if (hasStaleVersions(existing)) {
      // 決定 45-1：アプリの更新で版が変わった実行は再開できない。DB は 1 行も変えない。
      if (existing.status === "recovery-waiting") {
        // ただし復旧ゲートだけは開ける。決定 39 のとおり、ゲートを開ける行為の意味は
        // 「利用者が LM Studio 側の生成終了を確認した」であって「この実行を続ける」ではない。
        // 再開を指示した時点で確認は済んでおり、その実行を続けられるかどうかとは独立している。
        // ここで開けないと、版が変わった `recovery-waiting` の実行がプロセス全体の送信ゲートを
        // 永久に閉じたままにする（`reconcileOnStartup` が起動のたびに閉じ直すので再起動でも
        // 解けず、案内どおり新しい実行を始めても `recovery-blocked` で止まる）。
        // `unblock` はメモリ上のゲートを触るだけで、DB は 1 行も書かない。
        deps.recoveryGate.unblock(runId);
      }
      return rejected(existing);
    }
    if (!claimRunChecked(deps.db, runId, existing.status, "running", { clearStopState: true })) {
      return rejected(findRun(deps.db, runId) ?? existing);
    }
    if (existing.status === "recovery-waiting") {
      deps.recoveryGate.unblock(runId);
    }
    const claimed = findRun(deps.db, runId);
    if (claimed === null) {
      // claim に成功した以上、行は存在するはず。理論上到達しない防御的分岐。
      throw new Error(`再開した検査実行が見つかりません（実行 ID: ${runId}）`);
    }
    return { ...launch(claimed), accepted: true };
  }

  /**
   * 失敗単位の個別再試行（決定 36）。受け付けるのは `partially-failed` と `stopped` だけ
   * （`recovery-waiting` は受け付けない。復旧ゲートを開けられるのは `resumeRun` だけなので、
   * 先に再開して生成終了を確認する必要がある）。
   *
   * **実行の claim と単位の差し戻しは同じ 1 トランザクション**で行う（実行だけ `running` に
   * なって単位が `failed` のまま残ると、ループがやることを見つけられずにすぐ戻ってしまう）。
   * 対象 ID の検証は**状態を 1 つも変える前に**、同じトランザクションの中で全件行う。
   */
  function retryFailedUnits(runId: string, options?: RetryFailedUnitsOptions): RunLaunchResult {
    const existing = findRun(deps.db, runId);
    if (existing === null) {
      throw new Error(`検査実行が見つかりません（実行 ID: ${runId}）`);
    }
    const registered = registry.get(runId);
    if (registered !== undefined) {
      return { ...registered.result, accepted: false };
    }
    if (existing.status !== "partially-failed" && existing.status !== "stopped") {
      return rejected(existing);
    }
    if (hasStaleVersions(existing)) {
      // 決定 45-1：再開と同じ理由で再試行も受け付けない。トランザクションに入る前に返すので、
      // 実行の状態も単位も 1 行も変わらない。
      return rejected(existing);
    }
    // `resumeRun` にある `stopReason === "settings"` のガードが、ここには**無い**。これは
    // `settings` の実行を一律に弾かないという意図的な差である。
    //
    // 弾かなければならないのは「**開始前の設定検証で止まった実行**」＝検査単位が 1 件も無いか、
    // `input-too-long` **以外の** `failed` を 1 件も持たない実行である。上限を超えた対象が
    // 1 件でもあると `planStart` は超えていない対象も含めて全対象を返すので、
    // `pending` の単位と `input-too-long` の `failed` が同居する形も実在する
    // （`failed` の内訳で言い切ること。「`input-too-long` の `failed` しか無い」では
    // この形を取りこぼす）。いずれも `collectRetryTargets` が `!isInputTooLong(unit)` で
    // 対象から除くため対象 0 件になり、`RetryTargetError` が投げられて下のトランザクション
    // ごとロールバックされる（実行の状態も単位も 1 行も変わらない）。
    // **このフィルタを緩めるときは、ここに「単位が 0 件、または `input-too-long` 以外の
    // `failed` を持たない実行を拒否する」ガードを足すこと。** 緩めたままだと `clearStopState` が停止理由を消したうえで「1 度も検査して
    // いない実行が completed・指摘 0 件」に見える経路が開き、`resumeRun` が明示的に塞いだ穴
    // （`docs/reference/invariants.md`「失敗を指摘ゼロと誤表示しない」）がこちら側から復活する。
    //
    // 一方、実行の**途中**で `input-too-long` により `settings` 停止した実行に、それとは無関係な
    // `failed`（`malformed` など）の単位が残っている場合は、**再試行を許してよい**。
    // `input-too-long` の単位は対象から除かれて `failed` のまま残るので、再試行が終わっても
    // 実行は `partially-failed` になり、「失敗を指摘ゼロと誤表示しない」には反しない。
    // ただし `clearStopState` で `stop_reason` / `stop_message` は消える（停止理由は
    // 単位ごとの `failure` に残る）。
    const from = existing.status;
    const unitIds = options?.unitIds;

    const claimed = deps.db.transaction((tx): RunRecord | null => {
      // 決定 36：ここで違反が見つかれば `RetryTargetError` が投げられ、トランザクションごと
      // ロールバックされる（実行の状態も単位も 1 つも変わらない）。
      const targets = collectRetryTargets(tx, runId, unitIds);
      if (!claimRunChecked(tx, runId, from, "running", { clearStopState: true })) {
        return null;
      }
      // 同じトランザクションの中で `failed` であることを確かめた直後なので、条件付き更新が
      // 0 行になることはない。0 行のまま進むと「実行は running だが単位は failed のまま」が
      // 静かに残るので、防御的に例外にしてロールバックする。
      for (const id of targets.checkUnitIds) {
        if (!claimUnitChecked(tx, id, "failed", "pending")) {
          throw new Error(`検査単位を pending に戻せませんでした（単位 ID: ${id}）`);
        }
      }
      for (const id of targets.recheckUnitIds) {
        if (!claimRecheckUnitChecked(tx, id, "failed", "pending")) {
          throw new Error(`再確認単位を pending に戻せませんでした（単位 ID: ${id}）`);
        }
      }
      return findRun(tx, runId);
    });

    if (claimed === null) {
      return rejected(findRun(deps.db, runId) ?? existing);
    }
    return { ...launch(claimed), accepted: true };
  }

  /**
   * `running` の実行を 1 件、決定 40 の 3 段階で片づける。**1 実行につき 1 トランザクション**
   * （決定 40。複数の実行をまたいで 1 つのトランザクションにしない。1 実行の失敗で他の実行の
   * 照合まで巻き戻さないため）。
   *
   * 1・2. `resetRunningUnits` が、更新前に `running` の単位の有無（`hadRunning`）を確定してから
   *    それらを `pending` に戻す（判定を書き換えより先に行う理由はその関数の説明にある）。
   *    `pending_note` は定型文で、`failure` / `attempts` / `usage` / `elapsedMs` は保つ
   *    （`settleInternalError` と同じ規則を共有している）。
   * 3. 1 の判定に基づいて実行の状態を更新する：`running` の単位を持っていたら
   *    `recovery-waiting`（`generationUnconfirmed: true`）、持っていなければ `stopped`
   *    （`generationUnconfirmed: false`）。決定 23 のこの規則は `runStatusForUnconfirmed` に寄せてある。
   *
   * トランザクションが失敗したら（`finishRunChecked` が false を返す場合を含め）例外を投げて
   * 抜ける。ここで握りつぶさない：`index.ts` の「例外は捕まえずに非ゼロ終了させる」方針に委ね、
   * 中途半端な状態のまま起動を続けさせない（決定 40 の「1 実行の失敗で全実行の照合が巻き戻る」
   * ことを避ける代わりに、その 1 実行の不整合を握りつぶして起動を続けることもしない）。
   *
   * **`recoveryGate.block` はここでは呼ばない**（呼び出し元の `reconcileOnStartup` がコミット後に
   * まとめて行う）。ここで呼んでトランザクションがロールバックすると、ゲートだけ閉じて実行は
   * `running` のまま残り、`resumeRun` は `running` を受け付けないためゲートを二度と開けなくなる
   * （プロセス全体の送信が起動し直すまで止まる）。
   */
  function reconcileRun(runId: string): void {
    const finishedAt = now();
    deps.db.transaction((tx) => {
      const hadRunning = resetRunningUnits(tx, runId, RECONCILE_UNIT_NOTE, finishedAt);

      // stop_reason はレビュー裁定（R-1）どおり、両分岐とも専用の "backend-restarted" を使う。
      // "internal-error" は「想定外の例外」の意味（決定 14）なので、正常な起動処理である
      // 起動時照合の結果に流用しない。"recovery-needed" は決定 23 の表で「生成のハード上限超過」
      // という発生源にすでに割り当て済みで、混ぜると発生源の手がかりが失われる。
      // recovery-waiting 側と stopped 側の区別は status・generationUnconfirmed・stopMessage が
      // すでに担っているので、stop_reason は 1 つで足りる。
      const ok = finishRunChecked(tx, runId, {
        expectedStatus: "running",
        status: runStatusForUnconfirmed(hadRunning),
        stopReason: "backend-restarted",
        stopMessage: hadRunning ? RECONCILE_RECOVERY_MESSAGE : RECONCILE_STOPPED_MESSAGE,
        generationUnconfirmed: hadRunning,
        finishedAt,
      });
      if (!ok) {
        // `running` の実行を対象に `listRunsByStatus` で読んだ直後なので、通常は起こらない
        // （このプロセス以外に書き手はいない）。防御的に例外にしてこの実行の照合を丸ごと戻す。
        throw new Error(`起動時照合で実行を終端化できませんでした（実行 ID: ${runId}）`);
      }
    });
  }

  /**
   * 起動時照合（決定 13・39・40）。`running` の実行を実行ごとに 1 トランザクションで
   * `reconcileRun` に渡し、コミット後にまとめて復旧ゲートを復元する。
   *
   * ゲートの復元（決定 39）は、今回新しく `recovery-waiting` にした実行と、**すでに
   * `recovery-waiting` だった既存の実行**（前回の起動時照合やその後の運用で残っていたもの）の
   * 両方を対象にする。これが無いと、再起動しただけで未確認の生成に後続を送ってしまう。
   * 1 度 `listRunsByStatus(["recovery-waiting"])` を読み直すだけで両方を拾える
   * （新しく遷移させた行もこの時点ではもう `recovery-waiting` になっている）。
   */
  function reconcileOnStartup(): void {
    for (const run of listRunsByStatus(deps.db, ["running"])) {
      reconcileRun(run.id);
    }
    for (const run of listRunsByStatus(deps.db, ["recovery-waiting"])) {
      deps.recoveryGate.block(run.id);
    }
  }

  return { startRun, stopRun, resumeRun, retryFailedUnits, reconcileOnStartup };
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
  // planStart（開始時の計算）が作る停止理由は "settings" だけ（決定 18・44）。RunStopReason 全体
  // ではなく実際に使う値だけに絞る：`RunStopReason` に起動時照合専用の値（"backend-restarted"）を
  // 足したときに、この型を経由する run-settled イベントの `stop.reason`（`StopReason`）との
  // 互換性が壊れないようにするため。
  readonly reason: "settings";
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
