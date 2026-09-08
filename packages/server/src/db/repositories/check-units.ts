import { and, asc, eq, inArray } from "drizzle-orm";

import type { Usage } from "../../lmstudio/types.ts";
import type { UnitStatus } from "../../run/status.ts";
import type { AppDatabaseLike } from "../client.ts";
import { toFailureColumns, toFailureOrNull } from "../failure-columns.ts";
import { createId } from "../ids.ts";
import { parseJsonColumn, unitUsageSchema } from "../json.ts";
import type { CheckUnitRecord, UnitFailureRecord } from "../records.ts";
import { checkUnits } from "../schema.ts";

/** ---------------------------------------------------------------------- */
/** 検査単位 */
/** ---------------------------------------------------------------------- */

/** `insertCheckUnit` の入力。`CheckUnitRecord` から `id` を任意にしたもの。 */
export type InsertCheckUnitInput = Omit<CheckUnitRecord, "id"> & {
  readonly id?: string;
};

/**
 * 検査単位を 1 件保存する。`id` 省略時は `createId()`。
 * 状態遷移や失敗理由は `claimUnit` / `finishCheckUnit` が別途更新する。
 */
export function insertCheckUnit(db: AppDatabaseLike, input: InsertCheckUnitInput): CheckUnitRecord {
  const id = input.id ?? createId();
  const failureColumns = toFailureColumns(input.failure);
  db.insert(checkUnits)
    .values({
      id,
      runId: input.runId,
      targetId: input.targetId,
      perspective: input.perspective,
      status: input.status,
      attempts: input.attempts,
      failureReason: failureColumns.failureReason,
      failureMessage: failureColumns.failureMessage,
      failureFinishReason: failureColumns.failureFinishReason,
      failureOrigin: failureColumns.failureOrigin,
      pendingNote: input.pendingNote,
      usage: input.usage,
      inputGraphemes: input.inputGraphemes,
      elapsedMs: input.elapsedMs,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    })
    .run();
  return {
    id,
    runId: input.runId,
    targetId: input.targetId,
    perspective: input.perspective,
    status: input.status,
    attempts: input.attempts,
    failure: input.failure,
    pendingNote: input.pendingNote,
    usage: input.usage,
    inputGraphemes: input.inputGraphemes,
    elapsedMs: input.elapsedMs,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
}

/** `check_units` の 1 行を `CheckUnitRecord` に変換する。JSON 列は `db/json.ts` のスキーマで検証する。 */
function rowToCheckUnitRecord(row: typeof checkUnits.$inferSelect): CheckUnitRecord {
  return {
    id: row.id,
    runId: row.runId,
    targetId: row.targetId,
    perspective: row.perspective,
    status: row.status,
    attempts: row.attempts,
    failure: toFailureOrNull(row, row.id, "check_units", "検査単位 ID"),
    pendingNote: row.pendingNote,
    usage: parseJsonColumn(unitUsageSchema, row.usage, "usage"),
    inputGraphemes: row.inputGraphemes,
    elapsedMs: row.elapsedMs,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** 検査単位を ID で 1 件探す。見つからなければ null。 */
export function findCheckUnit(db: AppDatabaseLike, id: string): CheckUnitRecord | null {
  const row = db.select().from(checkUnits).where(eq(checkUnits.id, id)).get();
  if (!row) {
    return null;
  }
  return rowToCheckUnitRecord(row);
}

/** 検査実行に属する検査単位を列挙する。`targetId` → `perspective` の順で安定した並びにする。 */
export function listCheckUnits(db: AppDatabaseLike, runId: string): CheckUnitRecord[] {
  const rows = db
    .select()
    .from(checkUnits)
    .where(eq(checkUnits.runId, runId))
    .orderBy(asc(checkUnits.targetId), asc(checkUnits.perspective))
    .all();
  return rows.map(rowToCheckUnitRecord);
}

/**
 * 検査実行に属する未完了（`pending` / `running`）の検査単位を列挙する（PR9 の再開が使う）。
 * `not-applicable` は対象外（対象外なので再開しない）。`done` / `failed` も含めない
 * （失敗単位の個別再試行は PR9 が別の経路で扱う。仕様書 8.2 節）。
 */
export function listUnfinishedCheckUnits(db: AppDatabaseLike, runId: string): CheckUnitRecord[] {
  const rows = db
    .select()
    .from(checkUnits)
    .where(and(eq(checkUnits.runId, runId), inArray(checkUnits.status, ["pending", "running"])))
    .orderBy(asc(checkUnits.targetId), asc(checkUnits.perspective))
    .all();
  return rows.map(rowToCheckUnitRecord);
}

/**
 * 状態の条件付き更新（PR8 必須事項 1・決定 4）。`status` が `from` のときだけ `to` に更新し、
 * 成功したら true を返す。`options.startedAt` を渡すと `started_at` も**同じ 1 文の UPDATE**で
 * 設定する（2 文に分けると、その間にプロセスが落ちた場合に `running` で `started_at` が null の
 * 行が残るため）。`from` に一致しない行は `started_at` を含め 1 列も変わらない。
 */
export function claimUnit(
  db: AppDatabaseLike,
  id: string,
  from: UnitStatus,
  to: UnitStatus,
  options?: { readonly startedAt?: Date | undefined },
): boolean {
  const startedAt = options?.startedAt;
  const result = db
    .update(checkUnits)
    .set(startedAt === undefined ? { status: to } : { status: to, startedAt })
    .where(and(eq(checkUnits.id, id), eq(checkUnits.status, from)))
    .run();
  return result.changes === 1;
}

/** `finishCheckUnit` の入力。 */
export interface FinishCheckUnitInput {
  /** この値のときだけ更新する（決定 5・PR8 必須事項 2）。 */
  readonly expectedStatus: UnitStatus;
  readonly status: UnitStatus;
  readonly attempts: number;
  readonly failure: UnitFailureRecord | null;
  readonly pendingNote: string | null;
  readonly usage: Usage | null;
  readonly inputGraphemes: number | null;
  readonly elapsedMs: number | null;
  readonly finishedAt: Date;
}

/**
 * 検査単位の終了状態を更新する
 * （`status`・`attempts`・`failure`・`pendingNote`・`usage`・`inputGraphemes`・`elapsedMs`・`finishedAt`）。
 *
 * `WHERE id = ? AND status = expectedStatus` の条件付き更新にし、更新できたら true、
 * `status` が `expectedStatus` と一致せず 0 行しか更新できなければ false を返す（決定 5・
 * PR8 必須事項 2）。false は「停止などで先に決着していた」ことを意味し、呼び出し側は
 * 上書きしてはならない。false のとき状態以外の列も一切変わらない。
 */
export function finishCheckUnit(
  db: AppDatabaseLike,
  id: string,
  input: FinishCheckUnitInput,
): boolean {
  const failureColumns = toFailureColumns(input.failure);
  const result = db
    .update(checkUnits)
    .set({
      status: input.status,
      attempts: input.attempts,
      failureReason: failureColumns.failureReason,
      failureMessage: failureColumns.failureMessage,
      failureFinishReason: failureColumns.failureFinishReason,
      failureOrigin: failureColumns.failureOrigin,
      pendingNote: input.pendingNote,
      usage: input.usage,
      inputGraphemes: input.inputGraphemes,
      elapsedMs: input.elapsedMs,
      finishedAt: input.finishedAt,
    })
    .where(and(eq(checkUnits.id, id), eq(checkUnits.status, input.expectedStatus)))
    .run();
  return result.changes === 1;
}
