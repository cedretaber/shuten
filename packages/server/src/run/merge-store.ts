/**
 * 増分マージ（決定 9）。重複統合（仕様書 6.4「重複統合は同一の検査実行内に限定する」）を、
 * 位置確定済みの候補 1 件ずつに適用できる形にする。
 *
 * `@shuten/shared` の `mergeCandidates` は候補列を一括で受け取り、統合後の指摘に新しい ID を
 * 振り直す。初回検査ではそれでよいが、再開時に DB へ保存済みの指摘へ候補を追加するときは
 * 使えない。指摘 ID は `judgments.finding_id` の参照先で、統合をやり直して ID が変わると
 * 作者の採否（決定 5）が壊れるからである。
 *
 * そこでここでは、「保存済みの指摘を `merge_key` で引き直す」ことで 1 本の経路に統合する。
 * PR9b のオーケストレーターは初回実行でも再開でもこの `mergeCandidateIntoRun` だけを使い、
 * `mergeCandidates` を呼び直すことはない。
 *
 * 集約規則（`category` / `initialVerdict`）は `mergeCandidates`（`packages/shared/src/merge/merge.ts`）
 * と同一でなければならない。`mergeCandidates` は次を計算する：
 *   - `category`: グループの全メンバーの `llm.category` が一致すればその値、不一致なら `unclear`
 *   - `initialVerdict`: 全メンバーが `likely-error` のときだけ `likely-error`、
 *     1 件でも `confirm-with-author` があれば `confirm-with-author`
 * どちらの規則も「グループの中の誰が最初か」に依存しない（全員一致なら全員が同じ値を持つので、
 * どれを代表にしても同じ値になる。不一致ならどう並べても不一致）。したがって、統合先の指摘に
 * 既に何件の候補が付いているか、その到着順がどうだったかによらず、**候補を 1 件追加するたびに
 * 統合先へ現在紐づいている全候補を読み直して畳み込めば**、`mergeCandidates` を一括で呼んだ場合
 * と同じ結果になる。指摘の `category` / `initialVerdict` 列（1 スカラー値）だけを頼りに次の値を
 * 計算しようとすると、「不一致で `unclear`」と「全員が本当に `unclear`」を区別できず情報が失われる
 * ため、必ず `listCandidatesForFinding` で読み直す。
 *
 * `range` / `quote` / `suggestion` はグループ内で常に一致する（`mergeKey` 自体がこの 3 つを
 * 含めて作られるため。`packages/shared/src/merge/merge.ts` の `mergeKey` を参照）。よって統合先の
 * 指摘が既に持つ `range` / `quote` / `suggestion` は候補を追加しても変わらない。
 *
 * 抑制（`findSuppression`）は統合後の指摘（`category` / `quote` / `suggestion`）に対して判定する。
 * `category` が `notation` から外れる（`unclear` になる）と抑制の前提が崩れるため、統合のたびに
 * 再判定して保存し直す（一度抑制されても、後から加わった候補で `category` が一致しなくなれば
 * 抑制は解除される）。判定ロジック自体は `@shuten/shared` の `findSuppression` を使い、
 * ここでは再実装しない。
 */

import {
  mergeKey as computeMergeKey,
  type FindingCategory,
  findSuppression,
  type InitialVerdict,
  type LocatedCandidate,
  type Paragraph,
} from "@shuten/shared";

import type { AppDatabaseLike } from "../db/client.ts";
import type { FindingRecord } from "../db/records.ts";
import {
  findFindingByMergeKey,
  insertCandidate,
  insertFinding,
  listCandidatesForFinding,
  updateFindingAggregate,
  updateFindingSuppression,
} from "../db/repositories/findings.ts";
import { assertFindingBoundary, type FindingBoundaryInput } from "./persist.ts";

/** `mergeCandidateIntoRun` の入力。 */
export interface MergeCandidateInput {
  readonly runId: string;
  readonly manuscriptVersionId: string;
  readonly targetId: string;
  readonly checkUnitId: string;
  /** 実行内で 0 始まりの生成順（決定 19）。呼び出し元が `nextCandidateIndex` で採番する。 */
  readonly candidateIndex: number;
  readonly candidate: LocatedCandidate;
  /** `persist.ts` の `deriveParagraphId` が本文から導いた値。 */
  readonly paragraphId: number;
  readonly allowedWords: readonly string[];
  readonly now: Date;
  /**
   * `assertFindingBoundary` に渡す保存本文と段落表（決定 17「保存の直前の境界検査」）。
   * `MergeCandidateInput` の元のブリーフには無いが、この検査を再実装せずに通すには必須のため追加した
   * （呼び出し元の PR9b は元々 `deriveParagraphId` のために両方を持っている）。
   */
  readonly body: string;
  readonly paragraphs: readonly Paragraph[];
}

/** `mergeCandidateIntoRun` の返り値。 */
export interface MergeCandidateResult {
  /** 統合先の指摘（新規作成、または既存指摘に統合した後の最新の内容）。 */
  readonly finding: FindingRecord;
  /** 新しい指摘を作った（`true`）か、既存の指摘に統合した（`false`）か。 */
  readonly created: boolean;
}

/**
 * グループの `category` 集約：全メンバーの値が先頭と一致すればその値、不一致なら `unclear`。
 * `mergeCandidates`（`merge.ts`）の `group.members.every((m) => m.llm.category ===
 * group.first.llm.category) ? group.first.llm.category : "unclear"` と同じ形にして、
 * 同一規則であることを目視で照合できるようにしている。
 */
function aggregateCategory(categories: readonly FindingCategory[]): FindingCategory {
  const first = categories[0];
  if (first === undefined) {
    throw new Error("集約対象の候補が1件もありません（呼び出し側の組み立てミス）");
  }
  return categories.every((c) => c === first) ? first : "unclear";
}

/** グループの `initialVerdict` 集約：全メンバーが `likely-error` のときだけ `likely-error`。 */
function aggregateVerdict(verdicts: readonly InitialVerdict[]): InitialVerdict {
  return verdicts.every((v) => v === "likely-error") ? "likely-error" : "confirm-with-author";
}

/**
 * 候補 1 件を保存し、統合先の指摘を返す。トランザクションハンドルを受け取る（自分では開かない。
 * 呼び出し元が「1 検査単位ぶんの保存」を 1 つのトランザクションに包む設計のため）。
 *
 * - `mergeKey(candidate)` が null（修正案なし）→ 常に新しい指摘を作る（仕様書 6.4）。
 * - 非 null → 同じ `run_id` の `findings` を `merge_key` で引く（`findFindingByMergeKey`。
 *   照合は必ず同じ実行 ID の中だけ）。
 *   - 見つかれば、候補をその指摘に紐づけ、統合先に紐づく全候補を読み直して集約・抑制を
 *     再計算する。`judgments` には一切触れない（仕様 5.4「再確認や統合は作者の採否を
 *     上書きしない」）。
 *   - 見つからなければ、この 1 候補だけを内容とする新しい指摘を作る
 *     （`insertFinding` が `judgments` の `undecided` 行も同じ呼び出しで作る）。
 */
export function mergeCandidateIntoRun(
  db: AppDatabaseLike,
  input: MergeCandidateInput,
): MergeCandidateResult {
  const key = computeMergeKey(input.candidate);
  if (key === null) {
    return createFinding(db, input, null);
  }
  const existing = findFindingByMergeKey(db, input.runId, key);
  if (existing === null) {
    return createFinding(db, input, key);
  }
  return attachToFinding(db, input, key, existing);
}

/** 統合先が見つからなかったとき：この 1 候補だけを内容とする新しい指摘を作る。 */
function createFinding(
  db: AppDatabaseLike,
  input: MergeCandidateInput,
  key: string | null,
): MergeCandidateResult {
  const { candidate } = input;
  const range = candidate.locate.range;
  const { category, verdict: initialVerdict, quote, suggestion } = candidate.llm;
  const suppression = findSuppression({ category, quote, suggestion }, input.allowedWords);

  const boundary: FindingBoundaryInput = {
    locateStatus: "located",
    range,
    paragraphId: input.paragraphId,
    quote,
    suggestion,
    category,
    mergeKey: key,
    suppression,
  };
  assertFindingBoundary(boundary, input.body, input.paragraphs);

  const finding = insertFinding(db, {
    runId: input.runId,
    manuscriptVersionId: input.manuscriptVersionId,
    targetId: input.targetId,
    locateStatus: "located",
    range,
    paragraphId: input.paragraphId,
    quote,
    suggestion,
    category,
    initialVerdict,
    mergeKey: key,
    suppression,
    createdAt: input.now,
  });

  insertCandidate(db, {
    id: candidate.id,
    runId: input.runId,
    checkUnitId: input.checkUnitId,
    findingId: finding.id,
    candidateIndex: input.candidateIndex,
    llm: candidate.llm,
    locateStatus: "located",
    range,
    mergeKey: key,
    createdAt: input.now,
  });

  return { finding, created: true };
}

/**
 * 統合先が見つかったとき：候補を紐づけ、集約・抑制を再計算する。
 *
 * `createFinding` と同じく「検査 → 書き込み」の順序を守る（`assertFindingBoundary` を通す前に
 * 候補の行を書かない）。そのため、統合先に**既に**紐づく候補（`listCandidatesForFinding`）と、
 * まだ書き込んでいない今回の候補を合わせて先に集約・抑制を計算し、境界検査を通してから
 * `insertCandidate` する。DB 往復は増えない（元々「挿入 → 読み直し」だった 2 回のアクセスが
 * 「読み出し → 挿入」の順に入れ替わるだけ）。
 */
function attachToFinding(
  db: AppDatabaseLike,
  input: MergeCandidateInput,
  key: string,
  existing: FindingRecord,
): MergeCandidateResult {
  const { candidate } = input;
  const range = candidate.locate.range;

  // 到着順や既存の集約値（DB に保存された 1 スカラー値）には依存しない（モジュール先頭の
  // コメント参照）。まだ書き込んでいない今回の候補も加えて畳み込む。
  const existingMembers = listCandidatesForFinding(db, existing.id);
  const category = aggregateCategory([
    ...existingMembers.map((m) => m.llm.category),
    candidate.llm.category,
  ]);
  const initialVerdict = aggregateVerdict([
    ...existingMembers.map((m) => m.llm.verdict),
    candidate.llm.verdict,
  ]);
  const suppression = findSuppression(
    { category, quote: existing.quote, suggestion: existing.suggestion },
    input.allowedWords,
  );

  // `range` / `quote` / `suggestion` はグループ内で不変（mergeKey がそれらを含んで作られるため）。
  // `paragraphId` は呼び出し元がこの候補について導いた値を検査する（統合先が既に持つ値を
  // そのまま信用すると、呼び出し側の組み立てミスを検出できなくなる）。
  const boundary: FindingBoundaryInput = {
    locateStatus: existing.locateStatus,
    range: existing.range,
    paragraphId: input.paragraphId,
    quote: existing.quote,
    suggestion: existing.suggestion,
    category,
    mergeKey: key,
    suppression,
  };
  assertFindingBoundary(boundary, input.body, input.paragraphs);

  insertCandidate(db, {
    id: candidate.id,
    runId: input.runId,
    checkUnitId: input.checkUnitId,
    findingId: existing.id,
    candidateIndex: input.candidateIndex,
    llm: candidate.llm,
    locateStatus: "located",
    range,
    mergeKey: key,
    createdAt: input.now,
  });

  updateFindingAggregate(db, existing.id, { category, initialVerdict });
  updateFindingSuppression(db, existing.id, suppression);

  const finding: FindingRecord = { ...existing, category, initialVerdict, suppression };
  return { finding, created: false };
}
