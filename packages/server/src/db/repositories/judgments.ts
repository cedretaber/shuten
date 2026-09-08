import { asc, eq } from "drizzle-orm";

import type { JudgmentStatus } from "../../run/judgment.ts";
import type { AppDatabase } from "../client.ts";
import type { JudgmentRecord } from "../records.ts";
import { findings, judgments } from "../schema.ts";

/**
 * 作者の判断の永続化（仕様書 5.3 / 8.1 節）。
 *
 * 行は指摘の作成時（`findings.ts` の `insertFinding` / `saveUnlocatedCandidate`）に
 * 必ず `undecided` で 1 行作られる（決定 5）。このリポジトリはその行の更新と取得だけを行う。
 * 採否の変更は本文・指摘・再確認の行に一切触れない
 * （`docs/reference/invariants.md`「採用予定・却下・保留は評価の記録であり、本文への修正適用ではない」）。
 */

/** `judgments` の 1 行を `JudgmentRecord` に変換する。 */
function toJudgmentRecord(row: {
  readonly findingId: string;
  readonly status: JudgmentStatus;
  readonly note: string | null;
  readonly updatedAt: Date;
}): JudgmentRecord {
  return { findingId: row.findingId, status: row.status, note: row.note, updatedAt: row.updatedAt };
}

/** 判断を指摘 ID で 1 件探す。見つからなければ null。 */
export function findJudgment(db: AppDatabase, findingId: string): JudgmentRecord | null {
  const row = db.select().from(judgments).where(eq(judgments.findingId, findingId)).get();
  if (!row) {
    return null;
  }
  return toJudgmentRecord(row);
}

/**
 * 検査実行に属する判断を `finding_id` の昇順で列挙する。
 * `judgments` は検査実行への直接の参照を持たないため、`findings` と結合して実行で絞る。
 */
export function listJudgments(db: AppDatabase, runId: string): JudgmentRecord[] {
  const rows = db
    .select({
      findingId: judgments.findingId,
      status: judgments.status,
      note: judgments.note,
      updatedAt: judgments.updatedAt,
    })
    .from(judgments)
    .innerJoin(findings, eq(judgments.findingId, findings.id))
    .where(eq(findings.runId, runId))
    .orderBy(asc(judgments.findingId))
    .all();
  return rows.map(toJudgmentRecord);
}

/** `setJudgment` の入力。 */
export interface SetJudgmentInput {
  readonly status: JudgmentStatus;
  readonly note?: string | null;
  readonly updatedAt?: Date;
}

/**
 * 指摘の採否を更新する。
 *
 * `judgments` の行は指摘の作成時に必ず存在する（決定 5）ので、通常はこの関数は更新のみを行う。
 * 万一行がなければ作る（`onConflictDoUpdate`。防御的な扱いで、正常経路では起こらない）。
 * `undecided` に戻す操作でも行は消さない（決定 5）。`updatedAt` は必ず更新する（省略時は現在時刻）。
 */
export function setJudgment(
  db: AppDatabase,
  findingId: string,
  input: SetJudgmentInput,
): JudgmentRecord {
  const note = input.note ?? null;
  const updatedAt = input.updatedAt ?? new Date();
  db.insert(judgments)
    .values({ findingId, status: input.status, note, updatedAt })
    .onConflictDoUpdate({
      target: judgments.findingId,
      set: { status: input.status, note, updatedAt },
    })
    .run();
  return { findingId, status: input.status, note, updatedAt };
}
