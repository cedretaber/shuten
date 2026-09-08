import type { Perspective, Range } from "@shuten/shared";
import { asc, eq, sql } from "drizzle-orm";

import type { AppDatabase } from "../client.ts";
import { createId } from "../ids.ts";
import { candidateLlmSchema, parseJsonColumn } from "../json.ts";
import type { CandidateRecord, FindingRecord } from "../records.ts";
import { candidates, checkUnits, findings, judgments } from "../schema.ts";

/**
 * 指摘・元候補の永続化（仕様書 6.3 / 6.4 / 8.1 節）。
 *
 * 位置特定失敗の振り分け（決定 4）はここでは行わない。`insertFinding` / `insertCandidate` /
 * `attachCandidateToFinding` は素直に 1 行を書くだけの部品で、`locateStatus` ごとにどれを
 * 呼ぶか（`outside-target` では `insertFinding` を呼ばない、など）は呼び出し側（PR9）が決める。
 * この形にしておけば「`outside-target` の候補には `findings` の行を作らない」という決定 4 の表が
 * 自然に守られる（`insertCandidate` は `candidates` 表にしか書かないため）。
 */

/** ---------------------------------------------------------------------- */
/** 指摘 */
/** ---------------------------------------------------------------------- */

/** `insertFinding` の入力。`FindingRecord` から `id`・`createdAt` を任意にしたもの。 */
export type InsertFindingInput = Omit<FindingRecord, "id" | "createdAt"> & {
  readonly id?: string;
  readonly createdAt?: Date;
};

/**
 * 指摘を 1 件保存する。
 *
 * **指摘を作ると同時に `judgments` に `undecided` の行を必ず作る**（決定 5）。
 * 1 指摘 1 判断行を保つため、`findings` への insert と同一トランザクションで行う。
 * `judgments` 用のリポジトリはまだ無いので（次のタスクが判断の更新・取得を作る）、
 * ここでは `schema.ts` の `judgments` テーブルへ直接 insert する。
 */
export function insertFinding(db: AppDatabase, input: InsertFindingInput): FindingRecord {
  const id = input.id ?? createId();
  const createdAt = input.createdAt ?? new Date();
  db.transaction((tx) => {
    tx.insert(findings)
      .values({
        id,
        runId: input.runId,
        manuscriptVersionId: input.manuscriptVersionId,
        targetId: input.targetId,
        locateStatus: input.locateStatus,
        start: input.range?.start ?? null,
        end: input.range?.end ?? null,
        paragraphId: input.paragraphId,
        quote: input.quote,
        suggestion: input.suggestion,
        category: input.category,
        initialVerdict: input.initialVerdict,
        mergeKey: input.mergeKey,
        suppressionWord: input.suppression?.word ?? null,
        suppressionRuleVersion: input.suppression?.ruleVersion ?? null,
        createdAt,
      })
      .run();
    tx.insert(judgments)
      .values({
        findingId: id,
        status: "undecided",
        note: null,
        updatedAt: createdAt,
      })
      .run();
  });
  return {
    id,
    runId: input.runId,
    manuscriptVersionId: input.manuscriptVersionId,
    targetId: input.targetId,
    locateStatus: input.locateStatus,
    range: input.range,
    paragraphId: input.paragraphId,
    quote: input.quote,
    suggestion: input.suggestion,
    category: input.category,
    initialVerdict: input.initialVerdict,
    mergeKey: input.mergeKey,
    suppression: input.suppression,
    createdAt,
  };
}

/**
 * `start` / `end` の対から `Range | null` を組み立てる。両方 null なら位置特定失敗として null を返すが、
 * 片方だけ null の行は保存時の不変条件が壊れているということなので、既定値に丸めず例外にする
 * （`docs/reference/invariants.md`「失敗・形式不正を正常な値に置き換えない」、
 * `repositories/runs.ts` の `toRangeOrNull` と同じ姿勢）。
 */
function toRangeOrNull(start: number | null, end: number | null, findingId: string): Range | null {
  if (start === null && end === null) {
    return null;
  }
  if (start === null || end === null) {
    throw new Error(`findings の start / end が片方だけ null です（指摘 ID: ${findingId}）`);
  }
  return { start, end };
}

/** `suppression_word` / `suppression_rule_version` の対から抑制理由を組み立てる。片方だけ null は例外にする。 */
function toSuppressionOrNull(
  word: string | null,
  ruleVersion: string | null,
  findingId: string,
): { readonly word: string; readonly ruleVersion: string } | null {
  if (word === null && ruleVersion === null) {
    return null;
  }
  if (word === null || ruleVersion === null) {
    throw new Error(
      `findings の suppression_word / suppression_rule_version が片方だけ null です（指摘 ID: ${findingId}）`,
    );
  }
  return { word, ruleVersion };
}

/** `findings` の 1 行を `FindingRecord` に変換する（`reasons` は含まない）。 */
function rowToFindingRecord(row: typeof findings.$inferSelect): FindingRecord {
  return {
    id: row.id,
    runId: row.runId,
    manuscriptVersionId: row.manuscriptVersionId,
    targetId: row.targetId,
    locateStatus: row.locateStatus,
    range: toRangeOrNull(row.start, row.end, row.id),
    paragraphId: row.paragraphId,
    quote: row.quote,
    suggestion: row.suggestion,
    category: row.category,
    initialVerdict: row.initialVerdict,
    mergeKey: row.mergeKey,
    suppression: toSuppressionOrNull(row.suppressionWord, row.suppressionRuleVersion, row.id),
    createdAt: row.createdAt,
  };
}

/** `listFindings` / `findFinding` が返す 1 件の理由（決定 18）。 */
export interface FindingReason {
  readonly candidateId: string;
  readonly perspective: Perspective;
  readonly reason: string;
}

/** `FindingRecord` に `reasons` を足したもの（決定 18）。 */
export type FindingWithReasons = FindingRecord & {
  readonly reasons: readonly FindingReason[];
};

/**
 * 指摘に統合された元候補から `reasons` を組み立てる（決定 18）。
 * `candidates` を `check_units` と結合して観点を導き（候補側に観点の列はない。決定 19）、
 * `candidate_index` の昇順に並べる。
 */
function listReasons(db: AppDatabase, findingId: string): readonly FindingReason[] {
  const rows = db
    .select({
      candidateId: candidates.id,
      perspective: checkUnits.perspective,
      llm: candidates.llm,
    })
    .from(candidates)
    .innerJoin(checkUnits, eq(candidates.checkUnitId, checkUnits.id))
    .where(eq(candidates.findingId, findingId))
    .orderBy(asc(candidates.candidateIndex))
    .all();
  return rows.map((row) => ({
    candidateId: row.candidateId,
    perspective: row.perspective,
    reason: parseJsonColumn(candidateLlmSchema, row.llm, "llm").reason,
  }));
}

function toFindingWithReasons(
  db: AppDatabase,
  row: typeof findings.$inferSelect,
): FindingWithReasons {
  return { ...rowToFindingRecord(row), reasons: listReasons(db, row.id) };
}

/**
 * 検査実行に属する指摘を列挙する。
 *
 * 並びは `start` の昇順、位置特定失敗（`start` が null）のものは最後にする。
 * 同順位（`start` が等しい、または両方 null）は `created_at` → `id` の順で安定させる
 * （安定していればよく、表示上の意味は持たせない）。
 */
export function listFindings(db: AppDatabase, runId: string): FindingWithReasons[] {
  const rows = db
    .select()
    .from(findings)
    .where(eq(findings.runId, runId))
    .orderBy(
      sql`${findings.start} is null`,
      asc(findings.start),
      asc(findings.createdAt),
      asc(findings.id),
    )
    .all();
  return rows.map((row) => toFindingWithReasons(db, row));
}

/** 指摘を ID で 1 件探す。見つからなければ null。 */
export function findFinding(db: AppDatabase, id: string): FindingWithReasons | null {
  const row = db.select().from(findings).where(eq(findings.id, id)).get();
  if (!row) {
    return null;
  }
  return toFindingWithReasons(db, row);
}

/** ---------------------------------------------------------------------- */
/** 元候補 */
/** ---------------------------------------------------------------------- */

/** `insertCandidate` の入力。`CandidateRecord` から `id`・`createdAt` を任意にしたもの。 */
export type InsertCandidateInput = Omit<CandidateRecord, "id" | "createdAt"> & {
  readonly id?: string;
  readonly createdAt?: Date;
};

/**
 * 元候補を 1 件保存する。`candidateIndex` は呼び出し元が渡す（決定 19。
 * `mergeCandidates` が候補を作った順そのものを入れる）。
 * `llm`（`LlmFinding`）は一切加工せず、引用（`quote`）を破壊しない。
 */
export function insertCandidate(db: AppDatabase, input: InsertCandidateInput): CandidateRecord {
  const id = input.id ?? createId();
  const createdAt = input.createdAt ?? new Date();
  db.insert(candidates)
    .values({
      id,
      runId: input.runId,
      checkUnitId: input.checkUnitId,
      findingId: input.findingId,
      candidateIndex: input.candidateIndex,
      llm: input.llm,
      locateStatus: input.locateStatus,
      start: input.range?.start ?? null,
      end: input.range?.end ?? null,
      mergeKey: input.mergeKey,
      createdAt,
    })
    .run();
  return {
    id,
    runId: input.runId,
    checkUnitId: input.checkUnitId,
    findingId: input.findingId,
    candidateIndex: input.candidateIndex,
    llm: input.llm,
    locateStatus: input.locateStatus,
    range: input.range,
    mergeKey: input.mergeKey,
    createdAt,
  };
}

/**
 * 候補を指摘に紐づける（候補を先に書いて後から `finding_id` を更新する経路のため。決定 16）。
 * `locate_status` など他の列は変えない。
 */
export function attachCandidateToFinding(
  db: AppDatabase,
  candidateId: string,
  findingId: string,
): void {
  db.update(candidates).set({ findingId }).where(eq(candidates.id, candidateId)).run();
}
