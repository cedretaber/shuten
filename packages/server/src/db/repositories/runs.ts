import type { Range } from "@shuten/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type { ModelInfo } from "../../lmstudio/types.ts";
import type { GenerationSettings } from "../../prompts/types.ts";
import type { RunStatus } from "../../run/status.ts";
import type { AppDatabaseLike } from "../client.ts";
import { createId } from "../ids.ts";
import {
  parseJsonColumn,
  runAllowedWordsSchema,
  runChunkSettingsSchema,
  runGenerationSettingsSchema,
  runModelInfoSchema,
  runPerspectivesSchema,
  runTargetParagraphIdsSchema,
  runTimeoutsSchema,
} from "../json.ts";
import type { RunRecord, RunTargetRecord } from "../records.ts";
import { runs, runTargets } from "../schema.ts";

/** ---------------------------------------------------------------------- */
/** 検査実行 */
/** ---------------------------------------------------------------------- */

/**
 * `insertRun` の入力。`RunRecord` から `id`・`startedAt` を任意にしたもの。
 * `stopRequestedAt` / `recoveryConfirmMs`（マイグレーション `0001`）も、既存の呼び出し・テストを
 * 壊さないよう `id` / `startedAt` と同じ扱いで任意にする。省略時は `stopRequestedAt: null`、
 * `recoveryConfirmMs: 0`（＝従来どおり `checkMs` がハード上限）を使う。
 * `recoveryConfirmedAt`（マイグレーション `0002`）は挿入時に指定する意味がない
 * （新規実行は常に復旧未確認から始まる）ので、この入力からは外して常に null で作る。
 */
export type InsertRunInput = Omit<
  RunRecord,
  "id" | "startedAt" | "stopRequestedAt" | "recoveryConfirmMs" | "recoveryConfirmedAt"
> & {
  readonly id?: string;
  readonly startedAt?: Date;
  readonly stopRequestedAt?: Date | null;
  readonly recoveryConfirmMs?: number;
};

/**
 * 検査実行を 1 件保存する。
 *
 * `id` 省略時は `createId()`、`startedAt` 省略時は現在時刻を使う。
 * API キーを受け取る引数は作らない（決定 10）。モデル ID は `modelId` に持ち、
 * `generationSettings` には `model` を含めない（決定 11）。
 */
export function insertRun(db: AppDatabaseLike, input: InsertRunInput): RunRecord {
  const id = input.id ?? createId();
  const startedAt = input.startedAt ?? new Date();
  const stopRequestedAt = input.stopRequestedAt ?? null;
  const recoveryConfirmMs = input.recoveryConfirmMs ?? 0;
  db.insert(runs)
    .values({
      id,
      manuscriptVersionId: input.manuscriptVersionId,
      modelId: input.modelId,
      modelInfo: input.modelInfo,
      endpointUrl: input.endpointUrl,
      generationSettings: input.generationSettings,
      chunkSettings: input.chunkSettings,
      timeouts: input.timeouts,
      recoveryConfirmMs,
      perspectives: input.perspectives,
      recheckEnabled: input.recheckEnabled,
      allowedWords: input.allowedWords,
      allowedWordRuleVersion: input.allowedWordRuleVersion,
      promptVersion: input.promptVersion,
      diagnosticTransformVersion: input.diagnosticTransformVersion,
      status: input.status,
      stopReason: input.stopReason,
      stopMessage: input.stopMessage,
      generationUnconfirmed: input.generationUnconfirmed,
      startOperationId: input.startOperationId,
      stopRequestedAt,
      startedAt,
      finishedAt: input.finishedAt,
      recoveryConfirmedAt: null,
    })
    .run();
  return {
    id,
    manuscriptVersionId: input.manuscriptVersionId,
    modelId: input.modelId,
    modelInfo: input.modelInfo,
    endpointUrl: input.endpointUrl,
    generationSettings: input.generationSettings,
    chunkSettings: input.chunkSettings,
    timeouts: input.timeouts,
    recoveryConfirmMs,
    perspectives: input.perspectives,
    recheckEnabled: input.recheckEnabled,
    allowedWords: input.allowedWords,
    allowedWordRuleVersion: input.allowedWordRuleVersion,
    promptVersion: input.promptVersion,
    diagnosticTransformVersion: input.diagnosticTransformVersion,
    status: input.status,
    stopReason: input.stopReason,
    stopMessage: input.stopMessage,
    generationUnconfirmed: input.generationUnconfirmed,
    startOperationId: input.startOperationId,
    stopRequestedAt,
    startedAt,
    finishedAt: input.finishedAt,
    recoveryConfirmedAt: null,
  };
}

/** `runs` の 1 行を `RunRecord` に変換する。JSON 列は `db/json.ts` のスキーマで検証する。 */
function rowToRunRecord(row: typeof runs.$inferSelect): RunRecord {
  return {
    id: row.id,
    manuscriptVersionId: row.manuscriptVersionId,
    modelId: row.modelId,
    modelInfo: parseJsonColumn(runModelInfoSchema, row.modelInfo, "model_info"),
    endpointUrl: row.endpointUrl,
    generationSettings: parseJsonColumn(
      runGenerationSettingsSchema,
      row.generationSettings,
      "generation_settings",
    ),
    chunkSettings: parseJsonColumn(runChunkSettingsSchema, row.chunkSettings, "chunk_settings"),
    timeouts: parseJsonColumn(runTimeoutsSchema, row.timeouts, "timeouts"),
    perspectives: parseJsonColumn(runPerspectivesSchema, row.perspectives, "perspectives"),
    recheckEnabled: row.recheckEnabled,
    allowedWords: parseJsonColumn(runAllowedWordsSchema, row.allowedWords, "allowed_words"),
    allowedWordRuleVersion: row.allowedWordRuleVersion,
    promptVersion: row.promptVersion,
    diagnosticTransformVersion: row.diagnosticTransformVersion,
    status: row.status,
    stopReason: row.stopReason ?? null,
    stopMessage: row.stopMessage ?? null,
    generationUnconfirmed: row.generationUnconfirmed,
    startOperationId: row.startOperationId ?? null,
    stopRequestedAt: row.stopRequestedAt ?? null,
    recoveryConfirmMs: row.recoveryConfirmMs,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? null,
    recoveryConfirmedAt: row.recoveryConfirmedAt ?? null,
  };
}

/** 検査実行を ID で 1 件探す。見つからなければ null。JSON 列の検証に失敗したら例外を投げる。 */
export function findRun(db: AppDatabaseLike, id: string): RunRecord | null {
  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  if (!row) {
    return null;
  }
  return rowToRunRecord(row);
}

/**
 * 検査実行を `start_operation_id` で 1 件探す。見つからなければ null（決定 12）。
 * `start_operation_id` に一意制約があるため高々 1 件。二重送信の検出（`UNIQUE` 違反を捕まえた後、
 * 既存の実行を返して冪等にする）に使う。
 */
export function findRunByStartOperationId(
  db: AppDatabaseLike,
  startOperationId: string,
): RunRecord | null {
  const row = db.select().from(runs).where(eq(runs.startOperationId, startOperationId)).get();
  if (!row) {
    return null;
  }
  return rowToRunRecord(row);
}

/**
 * `generationSettings` に `modelId` を足し、完全な `GenerationSettings` を組み立てる（決定 11）。
 */
export function toGenerationSettings(record: RunRecord): GenerationSettings {
  return { ...record.generationSettings, model: record.modelId };
}

/**
 * 状態の条件付き更新（決定 14）。`status` が `from` のときだけ `to` に更新し、成功したら true を返す。
 * 状態以外の列は変えない。同一処理の同時取得・実行を防ぐために使う。
 *
 * `options.clearStopState` が true のとき、状態の更新と**同じ 1 文の UPDATE** で次の 5 列を
 * null（`generationUnconfirmed` は false）にする（決定 36）。2 文に分けないのは、途中でプロセスが
 * 落ちた場合に「実行中なのに停止済みに見える」行が残るため（`check-units.ts` の `claimUnit` が
 * `started_at` を同じ 1 文で設定するのと同じ理由）。再開・再試行（`run/transitions.ts` の
 * `claimRunChecked`）が使う。`from` に一致しない行はこれらの列も含め 1 列も変わらない。
 *
 * - `stop_requested_at` → null（決定 21）
 * - `generation_unconfirmed` → false
 * - `finished_at` → null
 * - `stop_reason` / `stop_message` → null（前回の停止の記録）
 * - `recovery_confirmed_at` → null（マイグレーション `0002`。再開したら前回の復旧確認は無効）
 */
export function claimRun(
  db: AppDatabaseLike,
  id: string,
  from: RunStatus,
  to: RunStatus,
  options?: { readonly clearStopState?: boolean },
): boolean {
  const result = db
    .update(runs)
    .set(
      options?.clearStopState
        ? {
            status: to,
            stopRequestedAt: null,
            generationUnconfirmed: false,
            finishedAt: null,
            stopReason: null,
            stopMessage: null,
            recoveryConfirmedAt: null,
          }
        : { status: to },
    )
    .where(and(eq(runs.id, id), eq(runs.status, from)))
    .run();
  return result.changes === 1;
}

/**
 * 復旧確認の時刻を書く（マイグレーション `0002`）。`recovery-waiting` かどうかの確認は
 * 呼び出し側（PR10 Task 3 の復旧確認 API）の責務で、ここでは無条件に上書きする。
 */
export function setRecoveryConfirmedAt(db: AppDatabaseLike, id: string, at: Date): void {
  db.update(runs).set({ recoveryConfirmedAt: at }).where(eq(runs.id, id)).run();
}

/**
 * 停止要求を受けた時刻を記録する（決定 21・決定 36）。`runs.status` には触れない
 * （停止要求を受けた時点でも実行は `running` のまま。実際に打ち切るのはループ側）。
 */
export function setStopRequestedAt(db: AppDatabaseLike, id: string, at: Date): void {
  db.update(runs).set({ stopRequestedAt: at }).where(eq(runs.id, id)).run();
}

/**
 * `model_info` が null の行だけを更新する条件付き UPDATE（決定 30）。
 *
 * `RunRecord.modelInfo` は「最初の `ensureLoaded` 成功で 1 度だけ書く」対象なので、2 度目以降の
 * 呼び出し（すでに `model_info` が非 null の行）では何も更新しない。`WHERE model_info IS NULL`
 * を条件に含めることで、呼び出し側が「初回かどうか」を別途判定しなくても安全に呼べる。
 */
export function updateRunModelInfo(db: AppDatabaseLike, id: string, info: ModelInfo): void {
  db.update(runs)
    .set({ modelInfo: info })
    .where(and(eq(runs.id, id), isNull(runs.modelInfo)))
    .run();
}

/**
 * 指定した状態のいずれかに一致する検査実行を列挙する（決定 39・40）。
 * 起動時照合は `running` を、復旧ゲートの復元は `recovery-waiting` を読む。
 * 並びは `started_at` の昇順、同順位は `id` で安定させる。
 */
export function listRunsByStatus(db: AppDatabaseLike, statuses: readonly RunStatus[]): RunRecord[] {
  const rows = db
    .select()
    .from(runs)
    .where(inArray(runs.status, statuses))
    .orderBy(asc(runs.startedAt), asc(runs.id))
    .all();
  return rows.map(rowToRunRecord);
}

/** `finishRun` の入力。 */
export interface FinishRunInput {
  /** この値のときだけ更新する（決定 5・PR8 必須事項 2）。 */
  readonly expectedStatus: RunStatus;
  readonly status: RunStatus;
  readonly stopReason: RunRecord["stopReason"];
  readonly stopMessage: string | null;
  readonly generationUnconfirmed: boolean;
  readonly finishedAt: Date;
}

/**
 * 検査実行の終了状態を更新する（`status`・`stopReason`・`stopMessage`・`generationUnconfirmed`・`finishedAt`）。
 *
 * `WHERE id = ? AND status = expectedStatus` の条件付き更新にし、更新できたら true、
 * `status` が `expectedStatus` と一致せず 0 行しか更新できなければ false を返す（決定 5・
 * PR8 必須事項 2）。false は「停止などで先に決着していた」ことを意味し、呼び出し側は
 * 上書きしてはならない。false のとき状態以外の列も一切変わらない。
 *
 * `status` が `recovery-waiting` になるときだけ `recovery_confirmed_at` を null にする
 * （マイグレーション `0002`）。それ以外の遷移では触れない（既存の値を保つ）。
 */
export function finishRun(db: AppDatabaseLike, id: string, input: FinishRunInput): boolean {
  const result = db
    .update(runs)
    .set({
      status: input.status,
      stopReason: input.stopReason,
      stopMessage: input.stopMessage,
      generationUnconfirmed: input.generationUnconfirmed,
      finishedAt: input.finishedAt,
      ...(input.status === "recovery-waiting" ? { recoveryConfirmedAt: null } : {}),
    })
    .where(and(eq(runs.id, id), eq(runs.status, input.expectedStatus)))
    .run();
  return result.changes === 1;
}

/** ---------------------------------------------------------------------- */
/** 検査対象 */
/** ---------------------------------------------------------------------- */

/** `insertRunTarget` の入力。`id` は省略可能。 */
export type InsertRunTargetInput = Omit<RunTargetRecord, "id"> & {
  readonly id?: string;
};

/**
 * 検査対象を 1 件保存する。
 *
 * 参考文脈（`contextBefore` / `contextAfter`）が null のときは、対応する
 * `context_before_start` / `context_before_end`（または after 側）の両方を null にする。
 */
export function insertRunTarget(db: AppDatabaseLike, input: InsertRunTargetInput): RunTargetRecord {
  const id = input.id ?? createId();
  db.insert(runTargets)
    .values({
      id,
      runId: input.runId,
      targetIndex: input.targetIndex,
      targetStart: input.target.start,
      targetEnd: input.target.end,
      contextBeforeStart: input.contextBefore?.start ?? null,
      contextBeforeEnd: input.contextBefore?.end ?? null,
      contextAfterStart: input.contextAfter?.start ?? null,
      contextAfterEnd: input.contextAfter?.end ?? null,
      inputStart: input.input.start,
      inputEnd: input.input.end,
      paragraphIds: input.paragraphIds,
    })
    .run();
  return {
    id,
    runId: input.runId,
    targetIndex: input.targetIndex,
    target: input.target,
    contextBefore: input.contextBefore,
    contextAfter: input.contextAfter,
    input: input.input,
    paragraphIds: input.paragraphIds,
  };
}

/**
 * `context_before_start` / `context_before_end`（または after 側）の対から `Range | null` を
 * 組み立てる。両方 null なら「参考文脈なし」として null を返すが、片方だけ null の行は
 * 保存時の不変条件が壊れているということなので、既定値に丸めず例外にする
 * （`docs/reference/invariants.md`「失敗・形式不正を正常な値に置き換えない」）。
 */
function toRangeOrNull(
  start: number | null,
  end: number | null,
  label: string,
  targetId: string,
): Range | null {
  if (start === null && end === null) {
    return null;
  }
  if (start === null || end === null) {
    throw new Error(`run_targets の ${label} が片方だけ null です（検査対象 ID: ${targetId}）`);
  }
  return { start, end };
}

/** `run_targets` の 1 行を `RunTargetRecord` に変換する。 */
function rowToRunTargetRecord(row: typeof runTargets.$inferSelect): RunTargetRecord {
  return {
    id: row.id,
    runId: row.runId,
    targetIndex: row.targetIndex,
    target: { start: row.targetStart, end: row.targetEnd },
    contextBefore: toRangeOrNull(
      row.contextBeforeStart,
      row.contextBeforeEnd,
      "context_before_start / context_before_end",
      row.id,
    ),
    contextAfter: toRangeOrNull(
      row.contextAfterStart,
      row.contextAfterEnd,
      "context_after_start / context_after_end",
      row.id,
    ),
    input: { start: row.inputStart, end: row.inputEnd },
    paragraphIds: parseJsonColumn(runTargetParagraphIdsSchema, row.paragraphIds, "paragraph_ids"),
  };
}

/** 検査実行に属する検査対象を `targetIndex` の昇順で列挙する。 */
export function listRunTargets(db: AppDatabaseLike, runId: string): RunTargetRecord[] {
  const rows = db
    .select()
    .from(runTargets)
    .where(eq(runTargets.runId, runId))
    .orderBy(asc(runTargets.targetIndex))
    .all();
  return rows.map(rowToRunTargetRecord);
}
