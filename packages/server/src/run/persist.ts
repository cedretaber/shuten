/**
 * 保存の直前に行う境界検証（決定 17）と、パイプラインの値を DB レコードにする変換の一部
 * （決定 18）を 1 箇所に集める。
 *
 * 永続化層（`../db/`）自体にはランタイム検査がない（`not-found` の指摘に `mergeKey` を渡せる、
 * 段落 ID を本文から導くのは呼び出し側の責務）ため、ここが最後の砦になる。呼び出し側
 * （PR9b のオーケストレーター、`run/merge-store.ts`）は DB へ書く直前に必ずこれを通す。
 */

import type {
  CheckInput,
  ContextWindow,
  LlmFinding,
  LocatedCandidate,
  MergedFinding,
  Paragraph,
  Perspective,
  TargetRange,
} from "@shuten/shared";

import { assertWellFormedBody } from "../db/errors.ts";
import type { CandidateRecord, FindingRecord, RunTargetRecord } from "../db/records.ts";

/**
 * 境界検証違反（決定 17）。接続先 URL・API キー・本文全体はメッセージに含めない
 * （引用の一部を出すのは可）。
 */
export class PersistBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistBoundaryError";
  }
}

/** エラーメッセージに載せる引用の長さ上限（書記素ではなく UTF-16 コード単位。デバッグ用の目印なので厳密でなくてよい）。 */
const QUOTE_PREVIEW_LENGTH = 20;

function previewQuote(quote: string): string {
  return quote.length > QUOTE_PREVIEW_LENGTH ? `${quote.slice(0, QUOTE_PREVIEW_LENGTH)}…` : quote;
}

/**
 * `range.start` を含む段落を段落表から探し、その `id` を返す（仕様書 6.1 節の段落定義：
 * 範囲は `[start, end)`、区切りの改行列は直前の段落に含まれる）。見つからなければ
 * `PersistBoundaryError`（段落表と本文の不整合。黙って丸めない）。
 */
export function deriveParagraphId(paragraphs: readonly Paragraph[], offset: number): number {
  const paragraph = paragraphs.find((p) => p.range.start <= offset && offset < p.range.end);
  if (paragraph === undefined) {
    throw new PersistBoundaryError(
      `段落表に含まれない位置（offset: ${offset}）から段落 ID を導けません`,
    );
  }
  return paragraph.id;
}

/** `assertFindingBoundary` の検査対象。`FindingRecord` のうち検査に要る項目だけを取り出す。 */
export type FindingBoundaryInput = Pick<
  FindingRecord,
  | "locateStatus"
  | "range"
  | "paragraphId"
  | "quote"
  | "suggestion"
  | "category"
  | "mergeKey"
  | "suppression"
>;

/**
 * 指摘を保存する直前の境界検査（決定 17）。違反は `PersistBoundaryError`（孤立サロゲートだけは
 * `db/errors.ts` の `MalformedBodyError`）。
 *
 * 1. `mergeKey` は `locateStatus === "located"` の指摘にだけ入れてよい
 * 2. 抑制（`suppression`）は `category === "notation"` かつ `suggestion !== null` かつ
 *    位置確定済み（`locateStatus === "located"`）のときだけ非 null（`@shuten/shared` の
 *    `findSuppression` が満たすべき前提。判定ロジックはここでは再実装しない）
 * 3. 位置確定済みの `paragraphId` は、保存本文と段落表から `range.start` を含む段落として
 *    導いた値と一致すること
 * 4. 引用・修正案・本文に孤立サロゲートを含まないこと
 */
export function assertFindingBoundary(
  finding: FindingBoundaryInput,
  body: string,
  paragraphs: readonly Paragraph[],
): void {
  assertWellFormedBody(body);
  assertWellFormedBody(finding.quote);
  if (finding.suggestion !== null) {
    assertWellFormedBody(finding.suggestion);
  }

  if (finding.mergeKey !== null && finding.locateStatus !== "located") {
    throw new PersistBoundaryError(
      `位置未確定（locateStatus: "${finding.locateStatus}"）の指摘に mergeKey は付けられません` +
        `（引用: "${previewQuote(finding.quote)}"）`,
    );
  }

  if (finding.suppression !== null) {
    const eligible =
      finding.category === "notation" &&
      finding.suggestion !== null &&
      finding.locateStatus === "located";
    if (!eligible) {
      throw new PersistBoundaryError(
        '抑制の前提（category === "notation" かつ suggestion !== null かつ位置確定済み）を' +
          `満たさない指摘に抑制が付いています（category: "${finding.category}", ` +
          `suggestion: ${finding.suggestion === null ? "null" : "非 null"}, ` +
          `locateStatus: "${finding.locateStatus}"）`,
      );
    }
  }

  if (finding.locateStatus === "located") {
    if (finding.range === null) {
      throw new PersistBoundaryError(
        `位置確定済み（located）の指摘に range がありません（引用: "${previewQuote(finding.quote)}"）`,
      );
    }
    const derived = deriveParagraphId(paragraphs, finding.range.start);
    if (derived !== finding.paragraphId) {
      throw new PersistBoundaryError(
        `位置確定済みの paragraphId（${finding.paragraphId}）が本文から導いた値（${derived}）と` +
          `一致しません（引用: "${previewQuote(finding.quote)}"）`,
      );
    }
  }
}

/** `assertUnlocatedFindingBoundary` の検査対象。`LlmFinding` のうち検査に要る項目だけを取り出す。 */
export type UnlocatedFindingBoundaryInput = Pick<LlmFinding, "quote" | "suggestion">;

/**
 * 位置特定に失敗した候補（`not-found` / `ambiguous` / `outside-target`。決定 4 の表の下 3 行）を
 * 保存する直前の境界検証。`db/repositories/findings.ts` の `saveUnlocatedCandidate` は、モデルの
 * 応答（引用・修正案）を未検証のまま `candidates` / `findings` / `diagnostics` に書けてしまう
 * （JSON 中の孤立サロゲートは zod の通常の文字列検証を素通りする）ため、`assertFindingBoundary`
 * と対になるこの関数を、位置未確定の経路専用に用意する。
 *
 * 位置確定済みの経路（`assertFindingBoundary`）と異なり、この経路には `range` も `paragraphId` の
 * 整合も存在しない（位置が確定していないため）。検査できるのは well-formed 性だけになる。
 *
 * 1. 保存本文（原稿全文）に孤立サロゲートを含まないこと
 * 2. 引用（`quote`）に孤立サロゲートを含まないこと
 * 3. 修正案（`suggestion`）が非 null なら孤立サロゲートを含まないこと
 *
 * 違反は `db/errors.ts` の `MalformedBodyError`。
 *
 * **呼び出しは PR9b のオーケストレーターが行う**（`saveUnlocatedCandidate` を呼ぶ直前）。
 * このタスク（PR9a）では関数とテストだけを用意する。
 */
export function assertUnlocatedFindingBoundary(
  finding: UnlocatedFindingBoundaryInput,
  body: string,
): void {
  assertWellFormedBody(body);
  assertWellFormedBody(finding.quote);
  if (finding.suggestion !== null) {
    assertWellFormedBody(finding.suggestion);
  }
}

/**
 * `RunTargetRecord` → `CheckInput` の変換（決定 18）。`paragraphIds` は `TargetRange` へ、
 * `contextBefore` / `contextAfter` は `ContextWindow` へ、`input` は `inputRange` へ写す。
 */
export function checkInputFromTargetRecord(record: RunTargetRecord): CheckInput {
  const target: TargetRange = {
    index: record.targetIndex,
    range: record.target,
    paragraphIds: record.paragraphIds,
  };
  const context: ContextWindow = {
    before: record.contextBefore,
    after: record.contextAfter,
  };
  return { target, context, inputRange: record.input };
}

/**
 * `listCandidateSourcesForFinding`（決定 38）の 1 件を `LocatedCandidate` にする。
 * 統合先が `located` の指摘に紐づく候補は必ず位置確定済みのはず（`mergeCandidates` は位置確定済み
 * 候補だけを統合する。仕様書 6.4）だが、DB から読み直した値を無条件に信用せず、`range` が
 * null の行（不変条件が壊れている）は `PersistBoundaryError` にする
 * （`docs/reference/invariants.md`「失敗・形式不正を正常な値に置き換えない」）。
 */
function toLocatedCandidate(source: {
  readonly candidate: CandidateRecord;
  readonly perspective: Perspective;
}): LocatedCandidate {
  const { candidate, perspective } = source;
  if (candidate.range === null) {
    throw new PersistBoundaryError(
      `位置未確定の候補は MergedFinding の sources に含められません（候補 ID: ${candidate.id}）`,
    );
  }
  return {
    id: candidate.id,
    perspective,
    llm: candidate.llm,
    locate: { status: "located", range: candidate.range },
  };
}

/**
 * 保存済みの `FindingRecord` と候補（`listCandidateSourcesForFinding`）から `MergedFinding` を
 * 組み立てる（決定 38）。再確認要求（`buildRecheckRequest` → `renderFindingBlock`）が要求する形に
 * するだけで、保存済みの集約値（`category`・`initialVerdict`・`quote`・`suggestion`・`range`）は
 * そのまま使い、再計算しない（再確認は保存された指摘を見るのであって、統合をやり直さない）。
 *
 * `finding.locateStatus !== "located"` または `finding.range === null`（位置未確定）の指摘には
 * 使えない。再確認は位置確定済みの指摘だけを対象にするため（仕様書 6.5・8.1 節）、
 * `PersistBoundaryError` を投げる。
 */
export function mergedFindingFromRecords(
  finding: FindingRecord,
  sources: ReadonlyArray<{
    readonly candidate: CandidateRecord;
    readonly perspective: Perspective;
  }>,
): MergedFinding {
  if (finding.locateStatus !== "located" || finding.range === null) {
    throw new PersistBoundaryError(
      `位置未確定の指摘（locateStatus: "${finding.locateStatus}"）から MergedFinding は組み立てられません` +
        `（指摘 ID: ${finding.id}）`,
    );
  }
  return {
    id: finding.id,
    range: finding.range,
    quote: finding.quote,
    category: finding.category,
    suggestion: finding.suggestion,
    verdict: finding.initialVerdict,
    sources: sources.map(toLocatedCandidate),
  };
}
