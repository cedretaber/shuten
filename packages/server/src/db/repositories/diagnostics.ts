import { asc, eq } from "drizzle-orm";

import type { AppDatabase } from "../client.ts";
import {
  diagnosticExactMatchesSchema,
  diagnosticTransformCandidatesSchema,
  parseJsonColumn,
} from "../json.ts";
import type { DiagnosticRecord } from "../records.ts";
import { diagnostics } from "../schema.ts";

/** ---------------------------------------------------------------------- */
/** 位置診断 */
/** ---------------------------------------------------------------------- */

/**
 * 位置診断を 1 件保存する。`candidate_id` が主キーで、候補と 1 対 1（呼び出し元が確定させる）。
 *
 * `transformVersion` / `transformCandidates` / `omitted` / `tied` は `not-found` のときだけ非 null。
 * `ambiguous` と `outside-target` では null にする（PR3 の `LocateResult.diagnostic` が
 * `not-found` のときだけ非 null だから）。この振り分けは呼び出し側（PR9）が
 * `LocateResult` から組み立てて渡す値であり、ここではそのまま保存する。
 */
export function insertDiagnostic(db: AppDatabase, input: DiagnosticRecord): DiagnosticRecord {
  db.insert(diagnostics)
    .values({
      candidateId: input.candidateId,
      runId: input.runId,
      quote: input.quote,
      reason: input.reason,
      searchStart: input.searchRange.start,
      searchEnd: input.searchRange.end,
      exactMatches: input.exactMatches,
      transformVersion: input.transformVersion,
      transformCandidates: input.transformCandidates,
      omitted: input.omitted,
      tied: input.tied,
    })
    .run();
  return { ...input };
}

/**
 * `transform_version` / `transform_candidates` / `omitted` / `tied` の 4 列がそろって null か、
 * そろって非 null かを確かめる。片方だけ埋まった行は保存時の不変条件が壊れているということなので、
 * 既定値に丸めず例外にする（`docs/reference/invariants.md`「失敗・形式不正を正常な値に置き換えない」、
 * `findings.ts` の `toDiagnosticColumns` が書き込み側で守っている対称の読み出し側の防御）。
 *
 * `omitted: 0`・`tied: false`・`transformCandidates: []` はいずれも非 null の正当な値なので、
 * 真偽値としてではなく `=== null` で数える。
 */
function assertDiagnosticColumnsConsistent(
  row: Pick<
    typeof diagnostics.$inferSelect,
    "candidateId" | "transformVersion" | "transformCandidates" | "omitted" | "tied"
  >,
): void {
  const nullCount = [
    row.transformVersion === null,
    row.transformCandidates === null,
    row.omitted === null,
    row.tied === null,
  ].filter(Boolean).length;
  if (nullCount !== 0 && nullCount !== 4) {
    throw new Error(
      `diagnostics の transform_version / transform_candidates / omitted / tied が一部だけ null です（候補 ID: ${row.candidateId}）`,
    );
  }
}

/** `diagnostics` の 1 行を `DiagnosticRecord` に変換する。JSON 列は `db/json.ts` のスキーマで検証する。 */
function rowToDiagnosticRecord(row: typeof diagnostics.$inferSelect): DiagnosticRecord {
  assertDiagnosticColumnsConsistent(row);
  return {
    candidateId: row.candidateId,
    runId: row.runId,
    quote: row.quote,
    reason: row.reason,
    searchRange: { start: row.searchStart, end: row.searchEnd },
    exactMatches: parseJsonColumn(diagnosticExactMatchesSchema, row.exactMatches, "exact_matches"),
    transformVersion: row.transformVersion,
    transformCandidates: parseJsonColumn(
      diagnosticTransformCandidatesSchema,
      row.transformCandidates,
      "transform_candidates",
    ),
    omitted: row.omitted,
    tied: row.tied,
  };
}

/** 位置診断を候補 ID で 1 件探す。見つからなければ null。 */
export function findDiagnostic(db: AppDatabase, candidateId: string): DiagnosticRecord | null {
  const row = db.select().from(diagnostics).where(eq(diagnostics.candidateId, candidateId)).get();
  if (!row) {
    return null;
  }
  return rowToDiagnosticRecord(row);
}

/** 検査実行に属する位置診断を `candidate_id` の昇順で列挙する。 */
export function listDiagnostics(db: AppDatabase, runId: string): DiagnosticRecord[] {
  const rows = db
    .select()
    .from(diagnostics)
    .where(eq(diagnostics.runId, runId))
    .orderBy(asc(diagnostics.candidateId))
    .all();
  return rows.map(rowToDiagnosticRecord);
}
