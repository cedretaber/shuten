import type { Range } from "@shuten/shared";
import { and, asc, eq } from "drizzle-orm";

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
 */
export type InsertRunInput = Omit<
  RunRecord,
  "id" | "startedAt" | "stopRequestedAt" | "recoveryConfirmMs"
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
 */
export function claimRun(db: AppDatabaseLike, id: string, from: RunStatus, to: RunStatus): boolean {
  const result = db
    .update(runs)
    .set({ status: to })
    .where(and(eq(runs.id, id), eq(runs.status, from)))
    .run();
  return result.changes === 1;
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
