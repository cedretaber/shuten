import type { FindingDto } from "@shuten/shared";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FINDING_FILTER,
  type FindingFilter,
  matchesFilter,
  recheckStateOf,
  toggleFilterValue,
  toHighlights,
  visibleFindings,
} from "./finding-filter.ts";

/**
 * 指摘一覧の絞り込み（Task 6、決定 7・8・10。R3）。
 *
 * `results-page.test.tsx`（DOM）とは分ける——ここは純関数だけを検査する（`.ts` のテストで
 * DOM を描画しない）。
 */

function makeFinding(overrides: Partial<FindingDto> = {}): FindingDto {
  return {
    id: "finding-1",
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
      findingId: "finding-1",
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
    createdAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function withRecheck(overrides: Partial<FindingDto["recheck"]> = {}): FindingDto["recheck"] {
  return {
    id: "recheck-1",
    status: "done",
    notApplicableReason: null,
    verdict: null,
    reasonKind: null,
    reason: null,
    suggestionValid: null,
    failure: null,
    ...overrides,
  };
}

describe("recheckStateOf", () => {
  it("recheck が null なら none", () => {
    expect(recheckStateOf(makeFinding({ recheck: null }))).toBe("none");
  });

  it("status が pending なら waiting", () => {
    expect(recheckStateOf(makeFinding({ recheck: withRecheck({ status: "pending" }) }))).toBe(
      "waiting",
    );
  });

  it("status が running なら waiting", () => {
    expect(recheckStateOf(makeFinding({ recheck: withRecheck({ status: "running" }) }))).toBe(
      "waiting",
    );
  });

  it("status が done なら done", () => {
    expect(recheckStateOf(makeFinding({ recheck: withRecheck({ status: "done" }) }))).toBe("done");
  });

  it("status が failed なら failed", () => {
    expect(recheckStateOf(makeFinding({ recheck: withRecheck({ status: "failed" }) }))).toBe(
      "failed",
    );
  });

  it("status が not-applicable なら not-applicable", () => {
    expect(
      recheckStateOf(makeFinding({ recheck: withRecheck({ status: "not-applicable" }) })),
    ).toBe("not-applicable");
  });
});

describe("matchesFilter: 既定で抑制候補・撤回候補が隠れる", () => {
  it("既定の絞り込みでは suppression !== null の指摘を除く", () => {
    const suppressed = makeFinding({ suppression: { word: "こと", ruleVersion: "1" } });
    expect(matchesFilter(suppressed, DEFAULT_FINDING_FILTER)).toBe(false);
  });

  it("showSuppressed: true なら suppression !== null の指摘も含める", () => {
    const suppressed = makeFinding({ suppression: { word: "こと", ruleVersion: "1" } });
    const filter: FindingFilter = { ...DEFAULT_FINDING_FILTER, showSuppressed: true };
    expect(matchesFilter(suppressed, filter)).toBe(true);
  });

  it("既定の絞り込みでは recheck.verdict === 'withdraw' の指摘を除く", () => {
    const withdrawn = makeFinding({ recheck: withRecheck({ verdict: "withdraw" }) });
    expect(matchesFilter(withdrawn, DEFAULT_FINDING_FILTER)).toBe(false);
  });

  it("showWithdrawn: true なら recheck.verdict === 'withdraw' の指摘も含める", () => {
    const withdrawn = makeFinding({ recheck: withRecheck({ verdict: "withdraw" }) });
    const filter: FindingFilter = { ...DEFAULT_FINDING_FILTER, showWithdrawn: true };
    expect(matchesFilter(withdrawn, filter)).toBe(true);
  });
});

describe("matchesFilter: 各項目の述語", () => {
  it("categories: 含まれない分類を除く", () => {
    const finding = makeFinding({ category: "grammar" });
    const filter: FindingFilter = { ...DEFAULT_FINDING_FILTER, categories: ["notation"] };
    expect(matchesFilter(finding, filter)).toBe(false);
  });

  it("categories: 含まれる分類は通す", () => {
    const finding = makeFinding({ category: "grammar" });
    const filter: FindingFilter = { ...DEFAULT_FINDING_FILTER, categories: ["grammar"] };
    expect(matchesFilter(finding, filter)).toBe(true);
  });

  it("categories: null は絞り込まない（すべて通す）", () => {
    const finding = makeFinding({ category: "unclear" });
    expect(matchesFilter(finding, DEFAULT_FINDING_FILTER)).toBe(true);
  });

  it("categories: 空配列は 0 件（何も通さない）", () => {
    const finding = makeFinding({ category: "notation" });
    const filter: FindingFilter = { ...DEFAULT_FINDING_FILTER, categories: [] };
    expect(matchesFilter(finding, filter)).toBe(false);
  });

  it("judgments: 含まれない採否を除く", () => {
    const finding = makeFinding({
      judgment: {
        findingId: "finding-1",
        status: "rejected",
        note: null,
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    });
    const filter: FindingFilter = { ...DEFAULT_FINDING_FILTER, judgments: ["undecided"] };
    expect(matchesFilter(finding, filter)).toBe(false);
  });

  it("judgments: 含まれる採否は通す", () => {
    const finding = makeFinding({
      judgment: {
        findingId: "finding-1",
        status: "rejected",
        note: null,
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    });
    const filter: FindingFilter = { ...DEFAULT_FINDING_FILTER, judgments: ["rejected"] };
    expect(matchesFilter(finding, filter)).toBe(true);
  });

  it("recheckStates: 含まれない再確認状態を除く", () => {
    const finding = makeFinding({ recheck: withRecheck({ status: "failed" }) });
    const filter: FindingFilter = { ...DEFAULT_FINDING_FILTER, recheckStates: ["done"] };
    expect(matchesFilter(finding, filter)).toBe(false);
  });

  it("recheckStates: 含まれる再確認状態は通す", () => {
    const finding = makeFinding({ recheck: withRecheck({ status: "failed" }) });
    const filter: FindingFilter = { ...DEFAULT_FINDING_FILTER, recheckStates: ["failed"] };
    expect(matchesFilter(finding, filter)).toBe(true);
  });

  it("locateStates: located は 'located' として絞り込む", () => {
    const finding = makeFinding({ locateStatus: "located", range: { start: 0, end: 1 } });
    const filterLocated: FindingFilter = { ...DEFAULT_FINDING_FILTER, locateStates: ["located"] };
    const filterUnlocated: FindingFilter = {
      ...DEFAULT_FINDING_FILTER,
      locateStates: ["unlocated"],
    };
    expect(matchesFilter(finding, filterLocated)).toBe(true);
    expect(matchesFilter(finding, filterUnlocated)).toBe(false);
  });

  it("locateStates: not-found・ambiguous はどちらも 'unlocated' として絞り込む", () => {
    const notFound = makeFinding({ locateStatus: "not-found", range: null });
    const ambiguous = makeFinding({ locateStatus: "ambiguous", range: null });
    const filter: FindingFilter = { ...DEFAULT_FINDING_FILTER, locateStates: ["unlocated"] };
    expect(matchesFilter(notFound, filter)).toBe(true);
    expect(matchesFilter(ambiguous, filter)).toBe(true);
  });
});

describe("visibleFindings", () => {
  it("述語を満たす指摘だけを、元の順序のまま返す", () => {
    const a = makeFinding({ id: "a", category: "notation" });
    const b = makeFinding({ id: "b", category: "grammar" });
    const c = makeFinding({ id: "c", category: "notation" });
    const filter: FindingFilter = { ...DEFAULT_FINDING_FILTER, categories: ["notation"] };
    expect(visibleFindings([a, b, c], filter).map((f) => f.id)).toEqual(["a", "c"]);
  });
});

describe("toHighlights", () => {
  it("locateStatus が not-found の指摘を落とす", () => {
    const finding = makeFinding({ locateStatus: "not-found", range: null });
    expect(toHighlights([finding])).toEqual([]);
  });

  it("locateStatus が ambiguous の指摘を落とす", () => {
    const finding = makeFinding({ locateStatus: "ambiguous", range: null });
    expect(toHighlights([finding])).toEqual([]);
  });

  it("locateStatus が located でも range が null なら落とす", () => {
    const finding = makeFinding({ locateStatus: "located", range: null });
    expect(toHighlights([finding])).toEqual([]);
  });

  it("located かつ range !== null の指摘だけを Highlight にする", () => {
    const finding = makeFinding({ id: "f1", locateStatus: "located", range: { start: 2, end: 5 } });
    expect(toHighlights([finding])).toEqual([{ id: "f1", range: { start: 2, end: 5 } }]);
  });
});

describe("visibleFindings → toHighlights の合成: 隠れている指摘は強調に渡らない", () => {
  it("絞り込みで除かれた located な指摘は toHighlights に現れない", () => {
    const visible = makeFinding({ id: "visible", category: "notation", locateStatus: "located" });
    const hidden = makeFinding({ id: "hidden", category: "grammar", locateStatus: "located" });
    const filter: FindingFilter = { ...DEFAULT_FINDING_FILTER, categories: ["notation"] };

    const highlights = toHighlights(visibleFindings([visible, hidden], filter));

    expect(highlights.map((h) => h.id)).toEqual(["visible"]);
  });
});

describe("toggleFilterValue", () => {
  const all = ["a", "b", "c"] as const;

  it("null（すべて選択）から 1 つ外すと、残りの配列（all の順序）になる", () => {
    expect(toggleFilterValue<(typeof all)[number]>(null, all, "b")).toEqual(["a", "c"]);
  });

  it("外した値をもう一度渡すと、全選択（null）に正規化される", () => {
    const once = toggleFilterValue<(typeof all)[number]>(null, all, "b");
    expect(toggleFilterValue(once, all, "b")).toBeNull();
  });

  it("最後の 1 つを外すと空配列（0 件）になる", () => {
    let current: readonly (typeof all)[number][] | null = null;
    for (const value of all) {
      current = toggleFilterValue(current, all, value);
    }
    expect(current).toEqual([]);
  });

  it("空配列に 1 つ足すとその 1 要素の配列になる", () => {
    const empty: readonly (typeof all)[number][] = [];
    expect(toggleFilterValue(empty, all, "a")).toEqual(["a"]);
  });
});
