import type {
  FindingCategory,
  InitialVerdict,
  LlmFinding,
  LocateResult,
  Perspective,
  Range,
} from "@shuten/shared";
import { and, asc, eq, sql } from "drizzle-orm";

import type { AppDatabaseLike } from "../client.ts";
import { createId } from "../ids.ts";
import { candidateLlmSchema, parseJsonColumn } from "../json.ts";
import type { CandidateRecord, DiagnosticRecord, FindingRecord } from "../records.ts";
import { candidates, checkUnits, diagnostics, findings, judgments } from "../schema.ts";

/**
 * 指摘・元候補の永続化（仕様書 6.3 / 6.4 / 8.1 節）。
 *
 * `located` は重複統合（`mergeCandidates`）が先に来るため、1 候補 → 1 指摘の関数にはできない。
 * `insertFinding` / `insertCandidate` / `attachCandidateToFinding` は素直に 1 行を書くだけの部品
 * で、統合後の指摘を書いてから（あるいは候補を先に書いてから後で紐づける形で）候補を書く、という
 * 組み立ては呼び出し側（PR9）が行う。
 *
 * 一方、決定 4 の表の下 3 行（`not-found` / `ambiguous` / `outside-target`）は 1 候補につき
 * 高々 1 指摘・1 診断で完結し、統合を経ないため、`saveUnlocatedCandidate` にその振り分けを
 * まとめて実装する（本タスクの中心）。
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
export function insertFinding(db: AppDatabaseLike, input: InsertFindingInput): FindingRecord {
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
function listReasons(db: AppDatabaseLike, findingId: string): readonly FindingReason[] {
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
  db: AppDatabaseLike,
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
export function listFindings(db: AppDatabaseLike, runId: string): FindingWithReasons[] {
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

/**
 * 検査対象に属する指摘を列挙する（決定 38）。`listFindings` と同じ並び（`start` が null のものを
 * 最後に、`start` 昇順、同順位は `created_at` → `id`）を `target_id` で絞ったもの。
 * `listFindings` と異なり `reasons` は含まない（再確認の起票が `FindingRecord` だけを要る。決定 34）。
 */
export function listFindingsForTarget(db: AppDatabaseLike, targetId: string): FindingRecord[] {
  const rows = db
    .select()
    .from(findings)
    .where(eq(findings.targetId, targetId))
    .orderBy(
      sql`${findings.start} is null`,
      asc(findings.start),
      asc(findings.createdAt),
      asc(findings.id),
    )
    .all();
  return rows.map(rowToFindingRecord);
}

/** 指摘を ID で 1 件探す。見つからなければ null。 */
export function findFinding(db: AppDatabaseLike, id: string): FindingWithReasons | null {
  const row = db.select().from(findings).where(eq(findings.id, id)).get();
  if (!row) {
    return null;
  }
  return toFindingWithReasons(db, row);
}

/**
 * 同じ検査実行内で `merge_key` が一致する指摘を探す（仕様 6.4「重複統合は同一の検査実行内に
 * 限定する」）。`run/merge-store.ts` が候補 1 件ずつの統合の照合に使う唯一の経路（決定 9）。
 * `(run_id, merge_key)` の部分一意索引（`merge_key` が非 null の行だけ。PR8 決定 6）がそのまま
 * 索引になるので、`run_id` と `merge_key` の両方で絞る。見つからなければ null。
 */
export function findFindingByMergeKey(
  db: AppDatabaseLike,
  runId: string,
  mergeKey: string,
): FindingRecord | null {
  const row = db
    .select()
    .from(findings)
    .where(and(eq(findings.runId, runId), eq(findings.mergeKey, mergeKey)))
    .get();
  if (!row) {
    return null;
  }
  return rowToFindingRecord(row);
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
export function insertCandidate(db: AppDatabaseLike, input: InsertCandidateInput): CandidateRecord {
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
 * `candidates.start` / `end` の対から `Range | null` を組み立てる。両方 null なら `located` 以外
 * として null を返すが、片方だけ null の行は保存時の不変条件が壊れているということなので、
 * 既定値に丸めず例外にする（`toRangeOrNull`・`runs.ts` の同名関数と同じ姿勢）。
 */
function toCandidateRangeOrNull(
  start: number | null,
  end: number | null,
  candidateId: string,
): Range | null {
  if (start === null && end === null) {
    return null;
  }
  if (start === null || end === null) {
    throw new Error(`candidates の start / end が片方だけ null です（候補 ID: ${candidateId}）`);
  }
  return { start, end };
}

/** `candidates` の 1 行を `CandidateRecord` に変換する。`llm`（JSON 列）は `db/json.ts` のスキーマで検証する。 */
function rowToCandidateRecord(row: typeof candidates.$inferSelect): CandidateRecord {
  return {
    id: row.id,
    runId: row.runId,
    checkUnitId: row.checkUnitId,
    findingId: row.findingId,
    candidateIndex: row.candidateIndex,
    llm: parseJsonColumn(candidateLlmSchema, row.llm, "llm"),
    locateStatus: row.locateStatus,
    range: toCandidateRangeOrNull(row.start, row.end, row.id),
    mergeKey: row.mergeKey,
    createdAt: row.createdAt,
  };
}

/** 元候補を ID で 1 件探す。見つからなければ null。 */
export function findCandidate(db: AppDatabaseLike, id: string): CandidateRecord | null {
  const row = db.select().from(candidates).where(eq(candidates.id, id)).get();
  if (!row) {
    return null;
  }
  return rowToCandidateRecord(row);
}

/** 検査実行に属する元候補を `candidate_index` の昇順で列挙する。 */
export function listCandidates(db: AppDatabaseLike, runId: string): CandidateRecord[] {
  const rows = db
    .select()
    .from(candidates)
    .where(eq(candidates.runId, runId))
    .orderBy(asc(candidates.candidateIndex))
    .all();
  return rows.map(rowToCandidateRecord);
}

/**
 * 1 件の指摘に統合された元候補を `candidate_index` の昇順で列挙する。
 * `run/merge-store.ts` が統合のたびに `category` / `initialVerdict` の集約を再計算するのに使う
 * （`mergeCandidates` と同じ規則を候補 1 件ずつ適用しても同じ結果になるよう、統合先の全候補を
 * 読み直してから畳み込む。決定 9）。
 */
export function listCandidatesForFinding(
  db: AppDatabaseLike,
  findingId: string,
): CandidateRecord[] {
  const rows = db
    .select()
    .from(candidates)
    .where(eq(candidates.findingId, findingId))
    .orderBy(asc(candidates.candidateIndex))
    .all();
  return rows.map(rowToCandidateRecord);
}

/**
 * 指摘に紐づく元候補を、観点（`check_units.perspective`）を添えて `candidate_index` の昇順で返す
 * （決定 38）。`candidates` 表は観点を持たない（`check_unit_id` しか持たない）ため、
 * `check_units` と結合して観点を導く（`listReasons` と同じ結合）。
 * `run/persist.ts` の `mergedFindingFromRecords` が `MergedFinding.sources`（`LocatedCandidate[]`。
 * 各候補の観点が要る）を組み立てるのに使う。
 */
export function listCandidateSourcesForFinding(
  db: AppDatabaseLike,
  findingId: string,
): ReadonlyArray<{ readonly candidate: CandidateRecord; readonly perspective: Perspective }> {
  const rows = db
    .select({
      id: candidates.id,
      runId: candidates.runId,
      checkUnitId: candidates.checkUnitId,
      findingId: candidates.findingId,
      candidateIndex: candidates.candidateIndex,
      llm: candidates.llm,
      locateStatus: candidates.locateStatus,
      start: candidates.start,
      end: candidates.end,
      mergeKey: candidates.mergeKey,
      createdAt: candidates.createdAt,
      perspective: checkUnits.perspective,
    })
    .from(candidates)
    .innerJoin(checkUnits, eq(candidates.checkUnitId, checkUnits.id))
    .where(eq(candidates.findingId, findingId))
    .orderBy(asc(candidates.candidateIndex))
    .all();
  return rows.map((row) => ({
    candidate: rowToCandidateRecord(row),
    perspective: row.perspective,
  }));
}

/**
 * 実行内で次に使う `candidate_index` を返す（決定 22）。
 *
 * `SELECT COALESCE(MAX(candidate_index), -1) + 1 FROM candidates WHERE run_id = ?` そのもの。
 * まだ候補が 1 件もない実行では 0 を返す。呼び出し側（PR9 オーケストレーター）は
 * 決定 15 の保存トランザクションの中でこれを読み、その応答の候補に LLM が返した順で連番を振る。
 * 同じトランザクション内で読んで書くため、番号の決定と使用の間に別の書き込みが挟まらない
 * （better-sqlite3 は同期 API、書き込みは単一プロセス内で直列）。ロールバックすれば採番ごと
 * 消える。万一の二重採番は `(run_id, candidate_index)` の一意制約（PR8 決定 19）が検出する。
 */
export function nextCandidateIndex(db: AppDatabaseLike, runId: string): number {
  const row = db
    .select({ next: sql<number>`coalesce(max(${candidates.candidateIndex}), -1) + 1` })
    .from(candidates)
    .where(eq(candidates.runId, runId))
    .get();
  return row?.next ?? 0;
}

/**
 * 候補を指摘に紐づける（候補を先に書いて後から `finding_id` を更新する経路のため。決定 16）。
 * `locate_status` など他の列は変えない。
 */
export function attachCandidateToFinding(
  db: AppDatabaseLike,
  candidateId: string,
  findingId: string,
): void {
  db.update(candidates).set({ findingId }).where(eq(candidates.id, candidateId)).run();
}

/**
 * 指摘の集約（`category` / `initialVerdict`）を更新する（決定 9）。
 *
 * 統合を「保存済み指摘への `mergeKey` 照合」に一本化したことに伴い、`mergeCandidates` と同じ
 * 集約規則（`category` は元候補が一致すればその値、不一致なら `unclear`。`initialVerdict` は
 * 全候補が `likely-error` のときだけ `likely-error`）を、候補を 1 件統合するたびに呼び出し側
 * （PR9 オーケストレーター）が再計算してここに渡す。集約の計算そのものはここでは行わない
 * （`attachCandidateToFinding` と同じく素直に列を書き換えるだけの部品）。
 *
 * `initialVerdict` は「再確認で上書きしない」（決定 5）対象だが、これは元候補の統合による
 * 更新であり再確認とは別の経路なので、この関数が上書きしてよい。
 */
export function updateFindingAggregate(
  db: AppDatabaseLike,
  findingId: string,
  input: { readonly category: FindingCategory; readonly initialVerdict: InitialVerdict },
): void {
  db.update(findings)
    .set({ category: input.category, initialVerdict: input.initialVerdict })
    .where(eq(findings.id, findingId))
    .run();
}

/**
 * 指摘の抑制（許容語による自動抑制。仕様書 6.4）を更新する。
 *
 * 統合で候補が増えて `category` が `notation` から外れる（`unclear` になる）と、抑制の前提
 * （`category === "notation"`）が崩れるため、`run/merge-store.ts` は集約を再計算するたびに
 * 抑制も再計算してここに渡す。判定ロジック（`findSuppression`）はここでは再実装しない。
 */
export function updateFindingSuppression(
  db: AppDatabaseLike,
  findingId: string,
  suppression: { readonly word: string; readonly ruleVersion: string } | null,
): void {
  db.update(findings)
    .set({
      suppressionWord: suppression?.word ?? null,
      suppressionRuleVersion: suppression?.ruleVersion ?? null,
    })
    .where(eq(findings.id, findingId))
    .run();
}

/** ---------------------------------------------------------------------- */
/** 位置特定失敗の振り分け（決定 4） */
/** ---------------------------------------------------------------------- */

/** `LocateResult` の失敗側だけを取り出した型。位置特定に失敗した 1 候補の内容。 */
export type UnlocatedLocateResult = Extract<LocateResult, { readonly status: "failed" }>;

/** `saveUnlocatedCandidate` の入力。 */
export interface SaveUnlocatedCandidateInput {
  readonly runId: string;
  readonly checkUnitId: string;
  /** 実行内で 0 始まりの生成順（決定 19）。 */
  readonly candidateIndex: number;
  /** LLM の応答をそのまま。引用を破壊しない。 */
  readonly llm: LlmFinding;
  /** `not-found` / `ambiguous` で `findings` の行を作るときに使う。 */
  readonly manuscriptVersionId: string;
  readonly targetId: string;
  /** 位置診断の検索範囲（要求の入力範囲）。 */
  readonly searchRange: Range;
  /** `locateQuote`（`@shuten/shared`）の失敗側の結果をそのまま渡す。 */
  readonly locate: UnlocatedLocateResult;
  readonly candidateId?: string;
  /** `not-found` / `ambiguous` のときの指摘 ID。省略時は `createId()`。 */
  readonly findingId?: string;
  readonly createdAt?: Date;
}

/** `saveUnlocatedCandidate` の返り値。 */
export interface SaveUnlocatedCandidateResult {
  readonly candidate: CandidateRecord;
  /** `outside-target` では作らないので null。 */
  readonly finding: FindingRecord | null;
  readonly diagnostic: DiagnosticRecord;
}

/**
 * `not-found` / `transformCandidates` などの位置診断 4 列を `Diagnostic | null` から組み立てる。
 * `Diagnostic` は 4 列がひとまとまりなので、null かそろって非 null かのどちらかにしかならない。
 */
function toDiagnosticColumns(diagnostic: UnlocatedLocateResult["diagnostic"]): {
  readonly transformVersion: string | null;
  readonly transformCandidates: DiagnosticRecord["transformCandidates"];
  readonly omitted: number | null;
  readonly tied: boolean | null;
} {
  if (diagnostic === null) {
    return { transformVersion: null, transformCandidates: null, omitted: null, tied: null };
  }
  return {
    transformVersion: diagnostic.transformVersion,
    transformCandidates: diagnostic.candidates,
    omitted: diagnostic.omitted,
    tied: diagnostic.tied,
  };
}

/**
 * 位置特定に失敗した 1 候補を、決定 4 の表（下 3 行）どおりに保存する。
 *
 * | `locate.reason` | `candidates` | `findings` | `diagnostics` |
 * | --- | --- | --- | --- |
 * | `not-found` | 1 行（`findingId` あり） | 1 行（位置は null） | 1 行（変換候補あり） |
 * | `ambiguous` | 1 行（`findingId` あり） | 1 行（位置は null） | 1 行（変換候補は null） |
 * | `outside-target` | 1 行（`findingId` は null） | 作らない | 1 行（変換候補は null） |
 *
 * - `findings` を作るときは `mergeKey` / `suppression` を null にし、`judgments` に `undecided` の
 *   行も同一トランザクションで作る（決定 5）。`paragraphId` は位置が確定していないので候補の
 *   申告値（`llm.paragraphId`）を使う（決定 15）。
 * - `transformVersion` / `transformCandidates` / `omitted` / `tied` は `not-found` のときだけ
 *   非 null にできる。`ambiguous` / `outside-target` で `locate.diagnostic` が非 null なら、
 *   黙って捨てずに例外にする（`docs/reference/invariants.md`「失敗・形式不正を正常な値に
 *   置き換えない」）。`LocateResult`（PR3）は元々この規則を満たすはずなので、ここでの例外は
 *   呼び出し側の組み立てミスを検出するための防御。
 * - すべて 1 トランザクションで書く。
 */
export function saveUnlocatedCandidate(
  db: AppDatabaseLike,
  input: SaveUnlocatedCandidateInput,
): SaveUnlocatedCandidateResult {
  if (input.locate.reason !== "not-found" && input.locate.diagnostic !== null) {
    throw new Error(
      `位置診断の変換候補は not-found のときだけ持てます（locate.reason: ${input.locate.reason}）`,
    );
  }

  const candidateId = input.candidateId ?? createId();
  const createdAt = input.createdAt ?? new Date();
  const diagnosticColumns = toDiagnosticColumns(input.locate.diagnostic);

  // `finding` はトランザクションのコールバックの戻り値として受け取る（`let` を外側で
  // 書き換える形にすると、クロージャ越しの再代入を TypeScript の制御フロー解析が正しく
  // 追えず、コールバック後の型が `never` に潰れることがあるため）。
  const finding: FindingRecord | null = db.transaction((tx): FindingRecord | null => {
    let createdFinding: FindingRecord | null = null;
    if (input.locate.reason === "not-found" || input.locate.reason === "ambiguous") {
      const findingId = input.findingId ?? createId();
      tx.insert(findings)
        .values({
          id: findingId,
          runId: input.runId,
          manuscriptVersionId: input.manuscriptVersionId,
          targetId: input.targetId,
          locateStatus: input.locate.reason,
          start: null,
          end: null,
          paragraphId: input.llm.paragraphId,
          quote: input.llm.quote,
          suggestion: input.llm.suggestion,
          category: input.llm.category,
          initialVerdict: input.llm.verdict,
          mergeKey: null,
          suppressionWord: null,
          suppressionRuleVersion: null,
          createdAt,
        })
        .run();
      tx.insert(judgments)
        .values({ findingId, status: "undecided", note: null, updatedAt: createdAt })
        .run();
      createdFinding = {
        id: findingId,
        runId: input.runId,
        manuscriptVersionId: input.manuscriptVersionId,
        targetId: input.targetId,
        locateStatus: input.locate.reason,
        range: null,
        paragraphId: input.llm.paragraphId,
        quote: input.llm.quote,
        suggestion: input.llm.suggestion,
        category: input.llm.category,
        initialVerdict: input.llm.verdict,
        mergeKey: null,
        suppression: null,
        createdAt,
      };
    }

    tx.insert(candidates)
      .values({
        id: candidateId,
        runId: input.runId,
        checkUnitId: input.checkUnitId,
        // outside-target は統合先を持たない（決定 4）。
        findingId: createdFinding?.id ?? null,
        candidateIndex: input.candidateIndex,
        llm: input.llm,
        locateStatus: input.locate.reason,
        start: null,
        end: null,
        mergeKey: null,
        createdAt,
      })
      .run();

    tx.insert(diagnostics)
      .values({
        candidateId,
        runId: input.runId,
        quote: input.llm.quote,
        reason: input.locate.reason,
        searchStart: input.searchRange.start,
        searchEnd: input.searchRange.end,
        exactMatches: input.locate.exactMatches,
        ...diagnosticColumns,
      })
      .run();

    return createdFinding;
  });

  return {
    candidate: {
      id: candidateId,
      runId: input.runId,
      checkUnitId: input.checkUnitId,
      findingId: finding?.id ?? null,
      candidateIndex: input.candidateIndex,
      llm: input.llm,
      locateStatus: input.locate.reason,
      range: null,
      mergeKey: null,
      createdAt,
    },
    finding,
    diagnostic: {
      candidateId,
      runId: input.runId,
      quote: input.llm.quote,
      reason: input.locate.reason,
      searchRange: input.searchRange,
      exactMatches: input.locate.exactMatches,
      ...diagnosticColumns,
    },
  };
}
