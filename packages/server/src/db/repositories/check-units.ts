import { and, asc, eq, inArray } from "drizzle-orm";

import type { Usage } from "../../lmstudio/types.ts";
import type { UnitStatus } from "../../run/status.ts";
import type { AppDatabase } from "../client.ts";
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
 * `UnitFailureRecord` を `check_units` の `failure_*` 4 列に分解する。
 * `failure` が null なら 4 列とも null にする。
 */
function toRowFailureColumns(failure: UnitFailureRecord | null): {
  readonly failureReason: UnitFailureRecord["reason"] | null;
  readonly failureMessage: string | null;
  readonly failureFinishReason: string | null;
  readonly failureOrigin: UnitFailureRecord["origin"] | null;
} {
  if (failure === null) {
    return {
      failureReason: null,
      failureMessage: null,
      failureFinishReason: null,
      failureOrigin: null,
    };
  }
  return {
    failureReason: failure.reason,
    failureMessage: failure.message,
    failureFinishReason: failure.finishReason,
    failureOrigin: failure.origin,
  };
}

/**
 * `failure_*` 4 列から `UnitFailureRecord | null` を組み立てる。
 *
 * `failure_reason` が null なら他の 3 列も null のはずで、それ以外は保存時の不変条件が
 * 壊れているということなので、既定値に丸めず例外にする
 * （`docs/reference/invariants.md`「失敗・形式不正を正常な値に置き換えない」、
 * `repositories/runs.ts` の `toRangeOrNull` と同じ姿勢）。
 * `failure_reason` が非 null なら `failure_message` / `failure_origin` は必ず埋まっている
 * （`failure_finish_reason` だけは LM Studio から取れないことがあるので null を許す）。
 */
function toFailureOrNull(
  row: {
    readonly failureReason: UnitFailureRecord["reason"] | null;
    readonly failureMessage: string | null;
    readonly failureFinishReason: string | null;
    readonly failureOrigin: UnitFailureRecord["origin"] | null;
  },
  unitId: string,
): UnitFailureRecord | null {
  if (row.failureReason === null) {
    if (
      row.failureMessage !== null ||
      row.failureFinishReason !== null ||
      row.failureOrigin !== null
    ) {
      throw new Error(
        `check_units の failure_* が failure_reason なしで部分的に埋まっています（検査単位 ID: ${unitId}）`,
      );
    }
    return null;
  }
  if (row.failureMessage === null || row.failureOrigin === null) {
    throw new Error(
      `check_units の failure_message / failure_origin が failure_reason ありで null です（検査単位 ID: ${unitId}）`,
    );
  }
  return {
    reason: row.failureReason,
    message: row.failureMessage,
    finishReason: row.failureFinishReason,
    origin: row.failureOrigin,
  };
}

/**
 * 検査単位を 1 件保存する。`id` 省略時は `createId()`。
 * 状態遷移や失敗理由は `claimUnit` / `finishCheckUnit` が別途更新する。
 */
export function insertCheckUnit(db: AppDatabase, input: InsertCheckUnitInput): CheckUnitRecord {
  const id = input.id ?? createId();
  const failureColumns = toRowFailureColumns(input.failure);
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
    failure: toFailureOrNull(row, row.id),
    pendingNote: row.pendingNote,
    usage: parseJsonColumn(unitUsageSchema, row.usage, "usage"),
    inputGraphemes: row.inputGraphemes,
    elapsedMs: row.elapsedMs,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** 検査単位を ID で 1 件探す。見つからなければ null。 */
export function findCheckUnit(db: AppDatabase, id: string): CheckUnitRecord | null {
  const row = db.select().from(checkUnits).where(eq(checkUnits.id, id)).get();
  if (!row) {
    return null;
  }
  return rowToCheckUnitRecord(row);
}

/** 検査実行に属する検査単位を列挙する。`targetId` → `perspective` の順で安定した並びにする。 */
export function listCheckUnits(db: AppDatabase, runId: string): CheckUnitRecord[] {
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
export function listUnfinishedCheckUnits(db: AppDatabase, runId: string): CheckUnitRecord[] {
  const rows = db
    .select()
    .from(checkUnits)
    .where(and(eq(checkUnits.runId, runId), inArray(checkUnits.status, ["pending", "running"])))
    .orderBy(asc(checkUnits.targetId), asc(checkUnits.perspective))
    .all();
  return rows.map(rowToCheckUnitRecord);
}

/**
 * 状態の条件付き更新（決定 14）。`status` が `from` のときだけ `to` に更新し、成功したら true を返す。
 * 状態以外の列は変えない。同時取得の防止に使う。
 */
export function claimUnit(db: AppDatabase, id: string, from: UnitStatus, to: UnitStatus): boolean {
  const result = db
    .update(checkUnits)
    .set({ status: to })
    .where(and(eq(checkUnits.id, id), eq(checkUnits.status, from)))
    .run();
  return result.changes === 1;
}

/** `finishCheckUnit` の入力。 */
export interface FinishCheckUnitInput {
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
 */
export function finishCheckUnit(db: AppDatabase, id: string, input: FinishCheckUnitInput): void {
  const failureColumns = toRowFailureColumns(input.failure);
  db.update(checkUnits)
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
    .where(eq(checkUnits.id, id))
    .run();
}
