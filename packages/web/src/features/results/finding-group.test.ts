import type { FindingDto } from "@shuten/shared";
import { describe, expect, it } from "vitest";
import {
  type FindingGroup,
  groupContaining,
  groupFindings,
  hiddenSameRangeCount,
  nextSelection,
  overlappingGroups,
  sameRangeKey,
  summarizeCategories,
  summarizeJudgments,
  summarizeRecheckStates,
} from "./finding-group.ts";

/**
 * 同じ範囲の指摘のまとめ（PR14b。UI の見直し 2 節）の純関数。DOM は描かない。
 */

function makeFinding(overrides: Partial<FindingDto> = {}): FindingDto {
  const id = overrides.id ?? "finding-1";
  return {
    id,
    runId: "run-1",
    targetId: "target-1",
    locateStatus: "located",
    range: { start: 0, end: 1 },
    paragraphId: 0,
    quote: "あ",
    suggestion: null,
    category: "notation",
    initialVerdict: "likely-error",
    suppression: null,
    reasons: [],
    recheck: null,
    judgment: {
      findingId: id,
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
    createdAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function at(id: string, start: number, end: number, overrides: Partial<FindingDto> = {}) {
  return makeFinding({ id, range: { start, end }, ...overrides });
}

function withJudgment(finding: FindingDto, status: FindingDto["judgment"]["status"]): FindingDto {
  return { ...finding, judgment: { ...finding.judgment, status } };
}

function ids(groups: readonly FindingGroup[]): string[][] {
  return groups.map((group) => group.members.map((member) => member.id));
}

describe("sameRangeKey", () => {
  it("位置が確定していれば開始と終了からキーを作る", () => {
    expect(sameRangeKey(at("a", 3, 7))).toBe("3:7");
  });

  it("位置が特定できなかった指摘は null（まとめない）", () => {
    expect(sameRangeKey(makeFinding({ locateStatus: "not-found", range: null }))).toBeNull();
    expect(sameRangeKey(makeFinding({ locateStatus: "ambiguous", range: null }))).toBeNull();
  });

  it("located でも range が null なら null（toHighlights と同じく両方を見る）", () => {
    expect(sameRangeKey(makeFinding({ locateStatus: "located", range: null }))).toBeNull();
  });
});

describe("groupFindings", () => {
  it("範囲が完全に一致する指摘だけをまとめる", () => {
    expect(ids(groupFindings([at("a", 0, 5), at("b", 0, 5)]))).toEqual([["a", "b"]]);
  });

  it("一部だけ重なる指摘はまとめない", () => {
    expect(ids(groupFindings([at("a", 0, 5), at("b", 3, 8)]))).toEqual([["a"], ["b"]]);
  });

  it("開始だけ同じ・終了だけ同じ指摘はまとめない", () => {
    expect(ids(groupFindings([at("a", 0, 5), at("b", 0, 6), at("c", 1, 6)]))).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });

  it("隣り合うだけの指摘はまとめない", () => {
    expect(ids(groupFindings([at("a", 0, 5), at("b", 5, 10)]))).toEqual([["a"], ["b"]]);
  });

  it("位置が特定できなかった指摘は、引用が同じでもまとめない", () => {
    const a = makeFinding({ id: "a", locateStatus: "not-found", range: null, quote: "同じ" });
    const b = makeFinding({ id: "b", locateStatus: "not-found", range: null, quote: "同じ" });
    expect(ids(groupFindings([a, b]))).toEqual([["a"], ["b"]]);
  });

  it("渡された順を保ち、まとめは先頭の指摘の位置に置く（間に別の指摘が挟まっても）", () => {
    // サーバーの順は start 昇順なので、同じ start で end の違う指摘が間に入りうる。
    const groups = groupFindings([at("a", 0, 5), at("b", 0, 9), at("c", 0, 5), at("d", 6, 7)]);
    expect(ids(groups)).toEqual([["a", "c"], ["b"], ["d"]]);
    expect(groups[0]?.head.id).toBe("a");
  });

  it("空の配列なら空の配列", () => {
    expect(groupFindings([])).toEqual([]);
  });
});

describe("groupContaining", () => {
  const groups = groupFindings([at("a", 0, 5), at("b", 0, 5), at("c", 6, 7)]);

  it("先頭でない指摘の ID からも、その指摘を含むまとめを返す", () => {
    expect(groupContaining(groups, "b")?.head.id).toBe("a");
    expect(groupContaining(groups, "c")?.head.id).toBe("c");
  });

  it("どのまとめにも無ければ null", () => {
    expect(groupContaining(groups, "x")).toBeNull();
  });
});

describe("nextSelection（選択の引き継ぎ。UI の見直し 2 節）", () => {
  it("null なら null", () => {
    expect(nextSelection(null, [], [])).toBeNull();
  });

  it("表示中のまとめの先頭なら、そのまま", () => {
    const all = [at("a", 0, 5), at("b", 0, 5)];
    expect(nextSelection("a", all, groupFindings(all))).toBe("a");
  });

  it("表示中のまとめの先頭でない指摘なら、先頭にそろえる", () => {
    const all = [at("a", 0, 5), at("b", 0, 5)];
    expect(nextSelection("b", all, groupFindings(all))).toBe("a");
  });

  it("絞り込みから外れても、同じ範囲で表示中の指摘が残っていれば、そのまとめの先頭へ移る", () => {
    const a = at("a", 0, 5);
    const b = at("b", 0, 5);
    const c = at("c", 0, 5);
    // a が外れ、b と c が残る。
    expect(nextSelection("a", [a, b, c], groupFindings([b, c]))).toBe("b");
  });

  it("同じ範囲で表示中の指摘が残っていなければ null", () => {
    const a = at("a", 0, 5);
    const other = at("x", 6, 7);
    expect(nextSelection("a", [a, other], groupFindings([other]))).toBeNull();
  });

  it("一部だけ重なる指摘が残っていても、引き継がない", () => {
    const a = at("a", 0, 5);
    const overlapping = at("b", 3, 8);
    expect(nextSelection("a", [a, overlapping], groupFindings([overlapping]))).toBeNull();
  });

  it("位置が特定できなかった指摘が外れたら null", () => {
    const a = makeFinding({ id: "a", locateStatus: "not-found", range: null });
    expect(nextSelection("a", [a], [])).toBeNull();
  });

  it("再取得で指摘そのものが無くなったら null", () => {
    const b = at("b", 0, 5);
    expect(nextSelection("a", [b], groupFindings([b]))).toBeNull();
  });
});

describe("hiddenSameRangeCount", () => {
  it("同じ範囲で、まとめに入っていない（絞り込みで隠れた）指摘の数", () => {
    const a = at("a", 0, 5);
    const b = at("b", 0, 5);
    const c = at("c", 0, 5);
    const other = at("x", 0, 6);
    const [group] = groupFindings([a]);
    if (group === undefined) throw new Error("まとめが無い");
    expect(hiddenSameRangeCount(group, [a, b, c, other])).toBe(2);
  });

  it("隠れた指摘が無ければ 0", () => {
    const all = [at("a", 0, 5), at("b", 0, 5)];
    const [group] = groupFindings(all);
    if (group === undefined) throw new Error("まとめが無い");
    expect(hiddenSameRangeCount(group, all)).toBe(0);
  });

  it("位置が特定できなかった指摘のまとめは 0", () => {
    const a = makeFinding({ id: "a", locateStatus: "not-found", range: null });
    const b = makeFinding({ id: "b", locateStatus: "not-found", range: null });
    const [group] = groupFindings([a]);
    if (group === undefined) throw new Error("まとめが無い");
    expect(hiddenSameRangeCount(group, [a, b])).toBe(0);
  });
});

describe("overlappingGroups", () => {
  it("範囲が一部だけ重なるまとめを返し、自分・隣接・離れたもの・位置未確定は含めない", () => {
    const visible = [
      at("self", 5, 10),
      at("left", 3, 6),
      at("right-1", 9, 12),
      at("right-2", 9, 12),
      at("adjacent", 10, 11),
      at("far", 20, 21),
      makeFinding({ id: "unlocated", locateStatus: "not-found", range: null }),
    ];
    const groups = groupFindings(visible);
    const self = groupContaining(groups, "self");
    if (self === null) throw new Error("まとめが無い");
    expect(ids(overlappingGroups(self, groups))).toEqual([["left"], ["right-1", "right-2"]]);
  });

  it("位置が特定できなかった指摘のまとめなら空", () => {
    const unlocated = makeFinding({ id: "u", locateStatus: "not-found", range: null });
    const groups = groupFindings([unlocated, at("a", 0, 5)]);
    const self = groupContaining(groups, "u");
    if (self === null) throw new Error("まとめが無い");
    expect(overlappingGroups(self, groups)).toEqual([]);
  });
});

describe("要約（一覧の行と詳細の見出し）", () => {
  it("分類は重複を除き、並びの順に「／」でつなぐ", () => {
    expect(
      summarizeCategories([
        at("a", 0, 5, { category: "grammar" }),
        at("b", 0, 5, { category: "particle" }),
        at("c", 0, 5, { category: "grammar" }),
      ]),
    ).toBe("文法／助詞");
  });

  it("分類が 1 つなら、そのラベルだけ（「・」を含むラベルもそのまま）", () => {
    expect(summarizeCategories([at("a", 0, 5), at("b", 0, 5)])).toBe("誤字・表記");
  });

  it("採否が全員同じなら、そのラベルだけ", () => {
    expect(summarizeJudgments([at("a", 0, 5), at("b", 0, 5)])).toBe("未判断");
  });

  it("採否が違えば、採否の定義順に件数を添えて「・」でつなぐ", () => {
    expect(
      summarizeJudgments([
        withJudgment(at("a", 0, 5), "rejected"),
        at("b", 0, 5),
        withJudgment(at("c", 0, 5), "rejected"),
      ]),
    ).toBe("未判断 1・却下 2");
  });

  it("再確認の状態も同じ規則で要約する", () => {
    const done = {
      id: "r",
      status: "done",
      notApplicableReason: null,
      verdict: "keep",
      reasonKind: null,
      reason: null,
      suggestionValid: null,
      failure: null,
    } as const;
    expect(summarizeRecheckStates([at("a", 0, 5), at("b", 0, 5)])).toBe("再確認なし");
    expect(summarizeRecheckStates([at("a", 0, 5, { recheck: done }), at("b", 0, 5)])).toBe(
      "再確認なし 1・再確認済み 1",
    );
  });

  it("1 件だけなら、そのラベルだけ", () => {
    const one = [withJudgment(at("a", 0, 5), "held")];
    expect(summarizeJudgments(one)).toBe("保留");
    expect(summarizeCategories(one)).toBe("誤字・表記");
  });
});
