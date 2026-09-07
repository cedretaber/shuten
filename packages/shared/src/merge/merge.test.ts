import { describe, expect, it } from "vitest";
import type { FindingCategory, InitialVerdict, Perspective } from "../llm/schema.ts";
import type { Candidate, LocatedCandidate, UnlocatedCandidate } from "./candidate.ts";
import type { MergedFinding } from "./merge.ts";
import { mergeCandidates, mergeKey } from "./merge.ts";

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
function _unlocated(id: string, perspective: Perspective, quote: string): UnlocatedCandidate {
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

function ids(): () => string {
  let n = 0;
  return () => `f${++n}`;
}
function F(
  id: string,
  start: number,
  end: number,
  quote: string,
  category: FindingCategory,
  suggestion: string | null,
  verdict: InitialVerdict,
  sources: readonly LocatedCandidate[],
): MergedFinding {
  return { id, range: { start, end }, quote, category, suggestion, verdict, sources };
}

const a = located("a", "typo", 3, 5, "リュシア", "ルシア", "notation", "likely-error");
const a2 = located("a2", "typo", 3, 5, "リュシア", "ルシア", "notation", "likely-error");
const b = located("b", "naturalness", 3, 5, "リュシア", "ルシア", "notation", "likely-error");
const c = located(
  "c",
  "naturalness",
  3,
  5,
  "リュシア",
  "ルシア",
  "context-misuse",
  "confirm-with-author",
);
const d = located("d", "typo", 3, 5, "リュシア", "リュシヤ", "notation", "likely-error");
const e = located("e", "typo", 3, 5, "リュシア", null, "unclear", "confirm-with-author");
const f = located("f", "naturalness", 3, 5, "リュシア", null, "unclear", "confirm-with-author");
const g = located("g", "typo", 4, 6, "ュシア", "ュシヤ", "notation", "likely-error");
const h = located("h", "typo", 10, 12, "太郎", "太朗", "notation", "likely-error");

describe("mergeKey", () => {
  it("範囲・引用・修正案から鍵を作る（MK1）", () => {
    expect(mergeKey(a)).toBe('3:5:"リュシア":"ルシア"');
    expect(mergeKey(a)).toBe(mergeKey(b));
    expect(mergeKey(e)).toBeNull();
    expect(mergeKey(a)).not.toBe(mergeKey(d));
  });
});

describe("mergeCandidates", () => {
  it("鍵が同じ候補は観点が違っても統合する（M1）", () => {
    expect(mergeCandidates([a, b], ids())).toEqual([
      F("f1", 3, 5, "リュシア", "notation", "ルシア", "likely-error", [a, b]),
    ]);
  });

  it("分類が食い違うと unclear になる（M2）", () => {
    expect(mergeCandidates([a, c], ids())).toEqual([
      F("f1", 3, 5, "リュシア", "unclear", "ルシア", "confirm-with-author", [a, c]),
    ]);
  });

  it("修正案が違えば別の指摘のまま（M3）", () => {
    expect(mergeCandidates([a, d], ids())).toEqual([
      F("f1", 3, 5, "リュシア", "notation", "ルシア", "likely-error", [a]),
      F("f2", 3, 5, "リュシア", "notation", "リュシヤ", "likely-error", [d]),
    ]);
  });

  it("修正案が null の候補は互いに統合しない（M4）", () => {
    expect(mergeCandidates([e, f], ids())).toEqual([
      F("f1", 3, 5, "リュシア", "unclear", null, "confirm-with-author", [e]),
      F("f2", 3, 5, "リュシア", "unclear", null, "confirm-with-author", [f]),
    ]);
  });

  it("範囲が違えば別の指摘のまま（M5）", () => {
    expect(mergeCandidates([a, g], ids())).toEqual([
      F("f1", 3, 5, "リュシア", "notation", "ルシア", "likely-error", [a]),
      F("f2", 4, 6, "ュシア", "notation", "ュシヤ", "likely-error", [g]),
    ]);
  });

  it("出力は range.start 昇順に並ぶ（M6）", () => {
    expect(mergeCandidates([h, a], ids())).toEqual([
      F("f1", 3, 5, "リュシア", "notation", "ルシア", "likely-error", [a]),
      F("f2", 10, 12, "太郎", "notation", "太朗", "likely-error", [h]),
    ]);
  });

  it("完全に同じ鍵の候補は 1 件に統合する（M7）", () => {
    expect(mergeCandidates([a, a2], ids())).toEqual([
      F("f1", 3, 5, "リュシア", "notation", "ルシア", "likely-error", [a, a2]),
    ]);
  });

  it("空配列は空配列を返す（M8）", () => {
    expect(mergeCandidates([], ids())).toEqual([]);
  });

  it("同じ範囲の統合と別範囲が混在しても正しく並ぶ（M9）", () => {
    expect(mergeCandidates([h, a, b], ids())).toEqual([
      F("f1", 3, 5, "リュシア", "notation", "ルシア", "likely-error", [a, b]),
      F("f2", 10, 12, "太郎", "notation", "太朗", "likely-error", [h]),
    ]);
  });

  it("同じ範囲でも修正案が違えば別の指摘のまま並ぶ（M10）", () => {
    expect(mergeCandidates([a, e], ids())).toEqual([
      F("f1", 3, 5, "リュシア", "notation", "ルシア", "likely-error", [a]),
      F("f2", 3, 5, "リュシア", "unclear", null, "confirm-with-author", [e]),
    ]);
  });

  it("同じ範囲は最初の入力順（firstIndex）で並ぶ（M11）", () => {
    expect(mergeCandidates([d, a], ids())).toEqual([
      F("f1", 3, 5, "リュシア", "notation", "リュシヤ", "likely-error", [d]),
      F("f2", 3, 5, "リュシア", "notation", "ルシア", "likely-error", [a]),
    ]);
  });

  it("入力配列を変更しない（MI1）", () => {
    const input = [h, a, b];
    const copy = [...input];
    mergeCandidates(input, ids());
    expect(input).toEqual(copy);
  });

  it("位置特定失敗の候補を含む配列は型で受け付けない", () => {
    // 呼び出さない関数の中に置き、型検査だけを行う（実行時には失敗候補を渡さない）。
    const call = (mixed: readonly Candidate[]) =>
      // @ts-expect-error 位置特定失敗の候補は統合に渡せない
      mergeCandidates(mixed, ids());
    expect(typeof call).toBe("function");
  });
});
