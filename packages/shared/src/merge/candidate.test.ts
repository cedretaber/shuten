import { describe, expect, it } from "vitest";
import type { FindingCategory, InitialVerdict, Perspective } from "../llm/schema.ts";
import type { Candidate, LocatedCandidate, UnlocatedCandidate } from "./candidate.ts";
import { partitionCandidates } from "./candidate.ts";

function located(
  id: string,
  perspective: Perspective,
  start: number,
  end: number,
  quote: string,
  suggestion: string | null,
  category: FindingCategory,
  verdict: InitialVerdict,
): LocatedCandidate {
  return {
    id,
    perspective,
    llm: {
      paragraphId: 0,
      quote,
      before: "",
      after: "",
      category,
      reason: "理由",
      suggestion,
      verdict,
    },
    locate: { status: "located", range: { start, end } },
  };
}
function unlocated(id: string, perspective: Perspective, quote: string): UnlocatedCandidate {
  return {
    id,
    perspective,
    llm: {
      paragraphId: 0,
      quote,
      before: "",
      after: "",
      category: "unclear",
      reason: "理由",
      suggestion: null,
      verdict: "confirm-with-author",
    },
    locate: { status: "failed", reason: "not-found", exactMatches: [], diagnostic: null },
  };
}

describe("partitionCandidates", () => {
  it("位置確定済みと失敗を入力順のまま振り分ける（P1）", () => {
    const a = located("a", "typo", 3, 5, "リュシア", "ルシア", "notation", "likely-error");
    const b = located("b", "naturalness", 10, 12, "太郎", "太朗", "notation", "likely-error");
    const u1 = unlocated("u1", "typo", "x");
    const u2 = unlocated("u2", "naturalness", "y");
    const input: Candidate[] = [a, u1, b, u2];
    const result = partitionCandidates(input);
    expect(result.located).toEqual([a, b]);
    expect(result.unlocated).toEqual([u1, u2]);
  });

  it("空配列は両方とも空になる（P2）", () => {
    const result = partitionCandidates([]);
    expect(result.located).toEqual([]);
    expect(result.unlocated).toEqual([]);
  });

  it("失敗候補だけなら located は空になる（P3）", () => {
    const u1 = unlocated("u1", "typo", "x");
    const result = partitionCandidates([u1]);
    expect(result.located).toEqual([]);
    expect(result.unlocated).toEqual([u1]);
  });
});
