import type { Range, RecheckReasonKind, RecheckVerdict } from "@shuten/shared";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Usage } from "../../lmstudio/types.ts";
import type { UnitStatus } from "../../run/status.ts";
import type { AppDatabase } from "../client.ts";
import { createId } from "../ids.ts";
import { parseJsonColumn, unitUsageSchema } from "../json.ts";
import type {
  RecheckNotApplicableReason,
  RecheckUnitRecord,
  UnitFailureRecord,
} from "../records.ts";
import { recheckUnits } from "../schema.ts";

/**
 * 再確認単位の永続化（仕様書 6.5 / 8.1 節）。
 *
 * `check-units.ts` の書き方（`claimUnit` / `finishCheckUnit` / `toFailureOrNull` の姿勢）にそのまま揃える。
 * `reasonKind` が `suggestion-inappropriate` のとき `suggestionValid` が false であること、
 * `suggestion-inappropriate` / `insufficient-context` のとき `verdict` が `confirm-with-author` であること
 * （仕様 6.5 の MUST）は、ここでは検証しない。LLM 応答の検証（PR4 の zod スキーマ、
 * `llmRecheckOutputSchema`）の責務であり、永続化層で二重に検査すると責務が滲むため、保存するだけにする。
 */

/** ---------------------------------------------------------------------- */
/** 再確認単位 */
/** ---------------------------------------------------------------------- */

/** `insertRecheckUnit` の入力。`RecheckUnitRecord` から `id` を任意にしたもの。 */
export type InsertRecheckUnitInput = Omit<RecheckUnitRecord, "id"> & {
  readonly id?: string;
};

/**
 * `UnitFailureRecord` を `recheck_units` の `failure_*` 4 列に分解する。
 * `failure` が null なら 4 列とも null にする（`check-units.ts` の `toRowFailureColumns` と同じ形）。
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
 * `check-units.ts` の `toFailureOrNull` と同じ姿勢：`failure_reason` が null なのに他の列が
 * 埋まっている、あるいは `failure_reason` が非 null なのに `failure_message` / `failure_origin` が
 * 埋まっていない行は、保存時の不変条件が壊れているということなので、既定値に丸めず例外にする
 * （`docs/reference/invariants.md`「失敗・形式不正を正常な値に置き換えない」）。
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
        `recheck_units の failure_* が failure_reason なしで部分的に埋まっています（再確認単位 ID: ${unitId}）`,
      );
    }
    return null;
  }
  if (row.failureMessage === null || row.failureOrigin === null) {
    throw new Error(
      `recheck_units の failure_message / failure_origin が failure_reason ありで null です（再確認単位 ID: ${unitId}）`,
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
 * `input_start` / `input_end` の対から `Range | null` を組み立てる。両方 null なら
 * 「入力を組み立てる前に終わった」として null を返すが、片方だけ null の行は
 * 保存時の不変条件が壊れているということなので、既定値に丸めず例外にする
 * （`docs/reference/invariants.md`「失敗・形式不正を正常な値に置き換えない」、
 * `repositories/runs.ts` の `toRangeOrNull` と同じ姿勢）。
 */
function toInputRangeOrNull(
  start: number | null,
  end: number | null,
  unitId: string,
): Range | null {
  if (start === null && end === null) {
    return null;
  }
  if (start === null || end === null) {
    throw new Error(
      `recheck_units の input_start / input_end が片方だけ null です（再確認単位 ID: ${unitId}）`,
    );
  }
  return { start, end };
}

/**
 * 再確認単位を 1 件保存する。`id` 省略時は `createId()`。
 * `finding_id` に一意制約があるため 1 指摘に 1 件しか作れない。
 * 状態遷移や再確認結果は `claimRecheckUnit` / `finishRecheckUnit` が別途更新する。
 */
export function insertRecheckUnit(
  db: AppDatabase,
  input: InsertRecheckUnitInput,
): RecheckUnitRecord {
  const id = input.id ?? createId();
  const failureColumns = toRowFailureColumns(input.failure);
  db.insert(recheckUnits)
    .values({
      id,
      runId: input.runId,
      findingId: input.findingId,
      inputStart: input.inputRange?.start ?? null,
      inputEnd: input.inputRange?.end ?? null,
      status: input.status,
      notApplicableReason: input.notApplicableReason,
      attempts: input.attempts,
      failureReason: failureColumns.failureReason,
      failureMessage: failureColumns.failureMessage,
      failureFinishReason: failureColumns.failureFinishReason,
      failureOrigin: failureColumns.failureOrigin,
      pendingNote: input.pendingNote,
      verdict: input.verdict,
      reasonKind: input.reasonKind,
      reason: input.reason,
      suggestionValid: input.suggestionValid,
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
    findingId: input.findingId,
    inputRange: input.inputRange,
    status: input.status,
    notApplicableReason: input.notApplicableReason,
    attempts: input.attempts,
    failure: input.failure,
    pendingNote: input.pendingNote,
    verdict: input.verdict,
    reasonKind: input.reasonKind,
    reason: input.reason,
    suggestionValid: input.suggestionValid,
    usage: input.usage,
    inputGraphemes: input.inputGraphemes,
    elapsedMs: input.elapsedMs,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
}

/** `recheck_units` の 1 行を `RecheckUnitRecord` に変換する。JSON 列は `db/json.ts` のスキーマで検証する。 */
function rowToRecheckUnitRecord(row: typeof recheckUnits.$inferSelect): RecheckUnitRecord {
  return {
    id: row.id,
    runId: row.runId,
    findingId: row.findingId,
    inputRange: toInputRangeOrNull(row.inputStart, row.inputEnd, row.id),
    status: row.status,
    notApplicableReason: row.notApplicableReason,
    attempts: row.attempts,
    failure: toFailureOrNull(row, row.id),
    pendingNote: row.pendingNote,
    verdict: row.verdict,
    reasonKind: row.reasonKind,
    reason: row.reason,
    suggestionValid: row.suggestionValid,
    usage: parseJsonColumn(unitUsageSchema, row.usage, "usage"),
    inputGraphemes: row.inputGraphemes,
    elapsedMs: row.elapsedMs,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** 再確認単位を指摘 ID で 1 件探す。`finding_id` に一意制約があるため高々 1 件。見つからなければ null。 */
export function findRecheckUnitByFinding(
  db: AppDatabase,
  findingId: string,
): RecheckUnitRecord | null {
  const row = db.select().from(recheckUnits).where(eq(recheckUnits.findingId, findingId)).get();
  if (!row) {
    return null;
  }
  return rowToRecheckUnitRecord(row);
}

/** 検査実行に属する再確認単位を `finding_id` の昇順で列挙する。 */
export function listRecheckUnits(db: AppDatabase, runId: string): RecheckUnitRecord[] {
  const rows = db
    .select()
    .from(recheckUnits)
    .where(eq(recheckUnits.runId, runId))
    .orderBy(asc(recheckUnits.findingId))
    .all();
  return rows.map(rowToRecheckUnitRecord);
}

/**
 * 検査実行に属する未完了（`pending` / `running`）の再確認単位を列挙する（PR9 の再開が使う）。
 * `not-applicable` は対象外（対象外なので再開しない）。`done` / `failed` も含めない
 * （失敗単位の個別再試行は PR9 が別の経路で扱う。仕様書 8.2 節）。
 */
export function listUnfinishedRecheckUnits(db: AppDatabase, runId: string): RecheckUnitRecord[] {
  const rows = db
    .select()
    .from(recheckUnits)
    .where(and(eq(recheckUnits.runId, runId), inArray(recheckUnits.status, ["pending", "running"])))
    .orderBy(asc(recheckUnits.findingId))
    .all();
  return rows.map(rowToRecheckUnitRecord);
}

/**
 * 状態の条件付き更新（決定 14）。`status` が `from` のときだけ `to` に更新し、成功したら true を返す。
 * 状態以外の列は変えない。同時取得の防止に使う（`check-units.ts` の `claimUnit` と同じ形）。
 */
export function claimRecheckUnit(
  db: AppDatabase,
  id: string,
  from: UnitStatus,
  to: UnitStatus,
): boolean {
  const result = db
    .update(recheckUnits)
    .set({ status: to })
    .where(and(eq(recheckUnits.id, id), eq(recheckUnits.status, from)))
    .run();
  return result.changes === 1;
}

/** `finishRecheckUnit` の入力。 */
export interface FinishRecheckUnitInput {
  readonly status: UnitStatus;
  readonly attempts: number;
  readonly failure: UnitFailureRecord | null;
  readonly pendingNote: string | null;
  /** `not-applicable` のときだけ非 null（仕様 6.5）。 */
  readonly notApplicableReason: RecheckNotApplicableReason | null;
  readonly verdict: RecheckVerdict | null;
  readonly reasonKind: RecheckReasonKind | null;
  readonly reason: string | null;
  /** 修正案を有効な修正案として表示してよいか。 */
  readonly suggestionValid: boolean | null;
  readonly usage: Usage | null;
  readonly inputGraphemes: number | null;
  readonly elapsedMs: number | null;
  readonly finishedAt: Date;
}

/**
 * 再確認単位の終了状態を更新する
 * （`status`・`attempts`・`failure`・`pendingNote`・`notApplicableReason`・`verdict`・`reasonKind`・
 * `reason`・`suggestionValid`・`usage`・`inputGraphemes`・`elapsedMs`・`finishedAt`）。
 *
 * `reasonKind` と `verdict` の整合はここでは検証しない（保存するだけ。ファイル先頭のコメント参照）。
 * `judgments` の行には一切触れない（仕様 5.4「再確認は作者の採否を上書きしない」）。
 */
export function finishRecheckUnit(
  db: AppDatabase,
  id: string,
  input: FinishRecheckUnitInput,
): void {
  const failureColumns = toRowFailureColumns(input.failure);
  db.update(recheckUnits)
    .set({
      status: input.status,
      attempts: input.attempts,
      failureReason: failureColumns.failureReason,
      failureMessage: failureColumns.failureMessage,
      failureFinishReason: failureColumns.failureFinishReason,
      failureOrigin: failureColumns.failureOrigin,
      pendingNote: input.pendingNote,
      notApplicableReason: input.notApplicableReason,
      verdict: input.verdict,
      reasonKind: input.reasonKind,
      reason: input.reason,
      suggestionValid: input.suggestionValid,
      usage: input.usage,
      inputGraphemes: input.inputGraphemes,
      elapsedMs: input.elapsedMs,
      finishedAt: input.finishedAt,
    })
    .where(eq(recheckUnits.id, id))
    .run();
}
