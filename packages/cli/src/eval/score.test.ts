import type { Perspective } from "@shuten/shared";
import { describe, expect, it } from "vitest";

import type { EvaluationResultInput } from "./result-schema.ts";
import { scoreRun } from "./score.ts";
import type { ResolvedTruthEntry } from "./truth.ts";

// 本文は使わない（scoreRun は範囲と引用だけを見る）。引用はすべて合成の文字列。

type FindingInput = EvaluationResultInput["findings"][number];
type RecheckInput = FindingInput["recheck"];
type UnlocatedInput = EvaluationResultInput["unlocated"][number];

function errorEntry(
  id: string,
  perspective: Perspective,
  start: number,
  end: number,
  quote = "誤り",
): ResolvedTruthEntry {
  return {
    entry: {
      kind: "error",
      id,
      perspective,
      paragraphId: 0,
      quote,
      occurrence: 1,
      expected: null,
      note: null,
    },
    range: { start, end },
  };
}

function normalEntry(id: string, start: number, end: number, quote = "口語"): ResolvedTruthEntry {
  return {
    entry: { kind: "normal", id, paragraphId: 0, quote, occurrence: 1, note: null },
    range: { start, end },
  };
}

const KEEP: RecheckInput = {
  status: "done",
  output: {
    reason: "誤りが実在する",
    reasonKind: "error-confirmed",
    verdict: "keep",
    suggestionValid: true,
  },
};
const WITHDRAW: RecheckInput = {
  status: "done",
  output: {
    reason: "意図した表現である",
    reasonKind: "intentional-expression",
    verdict: "withdraw",
    suggestionValid: false,
  },
};
const CONFIRM: RecheckInput = {
  status: "done",
  output: {
    reason: "文脈が足りない",
    reasonKind: "insufficient-context",
    verdict: "confirm-with-author",
    suggestionValid: false,
  },
};

interface FindingOptions {
  readonly perspectives?: readonly Perspective[];
  readonly suppressed?: boolean;
  readonly recheck?: RecheckInput;
}

function finding(
  id: string,
  start: number,
  end: number,
  options: FindingOptions = {},
): FindingInput {
  const perspectives = options.perspectives ?? (["typo"] as const);
  return {
    targetIndex: 0,
    finding: {
      id,
      range: { start, end },
      quote: "引用",
      category: "notation",
      suggestion: null,
      verdict: "likely-error",
      sources: perspectives.map((perspective, index) => ({
        id: `${id}-c${String(index)}`,
        perspective,
        llm: {
          paragraphId: 0,
          quote: "引用",
          before: "",
          after: "",
          category: "notation",
          reason: "理由",
          suggestion: null,
          verdict: "likely-error",
        },
      })),
    },
    suppression: options.suppressed === true ? { word: "許容語", ruleVersion: "1" } : null,
    recheck: options.recheck ?? { status: "disabled" },
  };
}

function unlocated(id: string, quote: string): UnlocatedInput {
  return {
    targetIndex: 0,
    candidate: {
      id,
      perspective: "typo",
      llm: {
        paragraphId: 0,
        quote,
        before: "",
        after: "",
        category: "notation",
        reason: "理由",
        suggestion: null,
        verdict: "likely-error",
      },
      locate: { reason: "not-found" },
    },
  };
}

interface ResultOptions {
  readonly unlocated?: readonly UnlocatedInput[];
  readonly unlocatedTotals?: {
    readonly notFound: number;
    readonly ambiguous: number;
    readonly outsideTarget: number;
  };
  readonly candidates?: number;
  readonly mode?: "split" | "split-recheck" | "full-text";
}

function makeResult(
  findings: readonly FindingInput[],
  options: ResultOptions = {},
): EvaluationResultInput {
  return {
    status: "completed",
    stop: null,
    conditions: {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:10:00.000Z",
      mode: options.mode ?? "split-recheck",
      perspectives: ["typo", "naturalness"],
      generation: { model: "test-model", maxTokens: 1024, temperature: 0 },
      model: null,
      chunkSettings: {
        targetGraphemes: 1500,
        contextGraphemes: 1000,
        recheckContextGraphemes: 3000,
        roundingTolerance: 0.2,
        maxInputGraphemes: 6000,
      },
      timeouts: { checkMs: 1000, recheckMs: 1000 },
      allowedWords: [],
      versions: {
        result: "1",
        prompt: "1",
        allowedWordRule: "1",
        diagnosticTransform: "1",
      },
      manuscript: {
        utf16Length: 100,
        graphemeCount: 100,
        paragraphCount: 1,
        targetCount: 1,
        bodyHash: "a".repeat(64),
      },
    },
    findings,
    unlocated: options.unlocated ?? [],
    totals: {
      targets: 1,
      checkUnits: { done: 2, failed: 1, pending: 3 },
      requests: 7,
      candidates: options.candidates ?? 10,
      located: 5,
      unlocated: options.unlocatedTotals ?? { notFound: 0, ambiguous: 0, outsideTarget: 0 },
      findings: findings.length,
      suppressed: findings.filter((item) => item.suppression !== null).length,
      rechecks: { done: 0, failed: 0, pending: 0, suppressed: 0, disabled: 0 },
      elapsedMs: 12_345,
    },
  };
}

// --- T5 検出と誤検出（決定 5） -----------------------------------------------------------------

describe("T5 検出と誤検出", () => {
  it("重なりの有無で検出が決まり、境界（e.end === f.start）は重ならない", () => {
    // 変異：重なり判定を閉区間（<=）にすると f2 が e2 を検出してしまい落ちる。
    const entries = [errorEntry("e1", "typo", 10, 14), errorEntry("e2", "typo", 20, 24)];
    const metrics = scoreRun(entries, makeResult([finding("f1", 13, 18), finding("f2", 24, 28)]));

    expect(metrics.beforeRecheck.detection.detected).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
    expect(metrics.beforeRecheck.matchedPairs).toEqual([
      { entryId: "e1", findingId: "f1", overlapKind: "partial" },
    ]);
    expect(metrics.beforeRecheck.missedEntryIds).toEqual(["e2"]);
    expect(metrics.beforeRecheck.falsePositive.falsePositives).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
    expect(metrics.beforeRecheck.falsePositiveFindings).toEqual([
      { findingId: "f2", kind: "other" },
    ]);
  });

  it("error と normal の両方に重なる指摘は検出として数え、誤検出に数えない", () => {
    // 変異：優先順位を逆にして「normal に重なれば誤検出」にすると落ちる。
    const entries = [normalEntry("n1", 10, 14), errorEntry("e1", "typo", 14, 18)];
    const metrics = scoreRun(entries, makeResult([finding("f1", 12, 16)]));

    expect(metrics.beforeRecheck.detection.detected.numerator).toBe(1);
    expect(metrics.beforeRecheck.falsePositive).toEqual({
      falsePositives: { numerator: 0, denominator: 1, rate: 0 },
      onNormal: 0,
      other: 0,
    });
    expect(metrics.beforeRecheck.falsePositiveFindings).toEqual([]);
  });

  it("normal だけに重なる指摘は on-normal、どちらにも重ならない指摘は other", () => {
    const entries = [normalEntry("n1", 10, 14), errorEntry("e1", "typo", 30, 34)];
    const metrics = scoreRun(entries, makeResult([finding("f1", 10, 14), finding("f2", 50, 54)]));

    expect(metrics.beforeRecheck.falsePositive).toEqual({
      falsePositives: { numerator: 2, denominator: 2, rate: 1 },
      onNormal: 1,
      other: 1,
    });
    expect(metrics.beforeRecheck.falsePositiveFindings).toEqual([
      { findingId: "f1", kind: "on-normal" },
      { findingId: "f2", kind: "other" },
    ]);
  });

  it("1 つの項目に 2 件重なっても検出は 1 件ぶんで、余剰は duplicateFindings に出る", () => {
    // 変異：duplicateFindings を引かずに重なり件数そのものにすると 2 になって落ちる。
    // （検出を項目単位でなく指摘単位で数える変異は、T18 の「段落まるごと」の固定データで落ちる。）
    const entries = [errorEntry("e1", "typo", 10, 14)];
    const metrics = scoreRun(entries, makeResult([finding("f1", 10, 14), finding("f2", 12, 20)]));

    expect(metrics.beforeRecheck.detection).toEqual({
      detected: { numerator: 1, denominator: 1, rate: 1 },
      detectedLoose: { numerator: 1, denominator: 1, rate: 1 },
      duplicateFindings: 1,
    });
    // 重なっているので誤検出ではない（マッチで負けた側も誤検出にしない。決定 5）。
    expect(metrics.beforeRecheck.falsePositive.falsePositives.numerator).toBe(0);
  });

  it("truthEntryCounts は error と normal を分けて数える", () => {
    const entries = [
      errorEntry("e1", "typo", 10, 14),
      errorEntry("e2", "naturalness", 20, 24),
      normalEntry("n1", 30, 34),
    ];
    expect(scoreRun(entries, makeResult([])).truthEntryCounts).toEqual({ error: 2, normal: 1 });
  });
});

// --- T6 観点（決定 6） -------------------------------------------------------------------------

describe("T6 観点", () => {
  it("観点違いで拾った指摘は全体には入り、観点一致には入らない", () => {
    // 変異：観点一致の判定を落として全体と同じ部分グラフを使うと typo の検出が 1 になって落ちる。
    const entries = [errorEntry("e1", "typo", 10, 14)];
    const metrics = scoreRun(
      entries,
      makeResult([finding("f1", 10, 14, { perspectives: ["naturalness"] })]),
    );

    expect(metrics.beforeRecheck.detection.detected.numerator).toBe(1);
    expect(metrics.beforeRecheck.detectionByPerspective.typo.detected).toEqual({
      numerator: 0,
      denominator: 1,
      rate: 0,
    });
  });

  it("誤検出は指摘側の観点で分類する（正解項目の観点ではない）", () => {
    // 変異：観点別の誤検出の分母を指摘側の観点で絞らず全指摘にすると、typo の分母が 0 でなくなって落ちる。
    const entries = [errorEntry("e1", "typo", 10, 14)];
    const metrics = scoreRun(
      entries,
      makeResult([
        finding("f1", 10, 14, { perspectives: ["naturalness"] }),
        finding("f2", 50, 54, { perspectives: ["naturalness"] }),
      ]),
    );

    expect(metrics.beforeRecheck.falsePositiveByPerspective.naturalness.falsePositives).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
    expect(metrics.beforeRecheck.falsePositiveByPerspective.typo.falsePositives).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
    });
  });

  it("2 観点を持つ指摘は両方の観点に数えられ、観点別の分母の合計は指摘件数を超えうる", () => {
    // 変異：sources[0] の観点だけを見ると、どちらか一方の分母が 0 になって落ちる。
    const metrics = scoreRun(
      [],
      makeResult([finding("f1", 50, 54, { perspectives: ["typo", "naturalness"] })]),
    );

    expect(metrics.beforeRecheck.findingCount).toBe(1);
    expect(metrics.beforeRecheck.falsePositiveByPerspective.typo.falsePositives.denominator).toBe(
      1,
    );
    expect(
      metrics.beforeRecheck.falsePositiveByPerspective.naturalness.falsePositives.denominator,
    ).toBe(1);
  });

  it("観点一致の判定は sources[] のいずれかと一致すればよい", () => {
    const entries = [errorEntry("e1", "typo", 10, 14)];
    const metrics = scoreRun(
      entries,
      makeResult([finding("f1", 10, 14, { perspectives: ["naturalness", "typo"] })]),
    );
    expect(metrics.beforeRecheck.detectionByPerspective.typo.detected.numerator).toBe(1);
  });
});

// --- T7 再確認の前後（決定 7） -----------------------------------------------------------------

describe("T7 再確認の前後", () => {
  const entries = [errorEntry("e1", "typo", 10, 14), errorEntry("e2", "typo", 30, 34)];
  const findings = [
    finding("f1", 10, 14, { recheck: WITHDRAW }), // error に重なる・撤回
    finding("f2", 30, 34, { recheck: KEEP }), // error に重なる・維持
    finding("f3", 50, 54, { recheck: WITHDRAW }), // error に重ならない・撤回
    finding("f4", 60, 64, { recheck: KEEP }), // error に重ならない・維持
    finding("f5", 70, 74, { recheck: { status: "failed" } }),
    finding("f6", 80, 84, { recheck: { status: "pending" } }),
    finding("f7", 90, 94, { recheck: { status: "disabled" } }),
  ];

  it("done かつ withdraw の指摘だけが再確認後の集合から消える", () => {
    const metrics = scoreRun(entries, makeResult(findings));
    expect(metrics.beforeRecheck.findingCount).toBe(7);
    expect(metrics.afterRecheck.findingCount).toBe(5);
    expect(metrics.afterRecheck.falsePositiveFindings.map((item) => item.findingId)).toEqual([
      "f4",
      "f5",
      "f6",
      "f7",
    ]);
    // 撤回された f1 が拾っていた e1 が、再確認後は未検出になる（見逃しの増加の正本）。
    expect(metrics.beforeRecheck.detection.detected.numerator).toBe(2);
    expect(metrics.afterRecheck.detection.detected.numerator).toBe(1);
    expect(metrics.afterRecheck.missedEntryIds).toEqual(["e1"]);
  });

  it("failed / pending の指摘は再確認後にも残り、4 区分には入らない", () => {
    // 変異：failed を keptTruePositive（または keptFalsePositive）に数える → 4 区分が 1 ずつずれて落ちる。
    // 変異：failed / pending を再確認後の集合から除く → findingCount が 3 になって落ちる。
    const metrics = scoreRun(entries, makeResult(findings));
    const afterIds = [
      ...metrics.afterRecheck.matchedPairs.map((pair) => pair.findingId),
      ...metrics.afterRecheck.falsePositiveFindings.map((item) => item.findingId),
    ];
    expect(afterIds).toContain("f5");
    expect(afterIds).toContain("f6");
    expect(metrics.afterRecheck.findingCount).toBe(5);
    expect(metrics.recheckEffect).toEqual({
      withdrewTruePositive: 1,
      keptTruePositive: 1,
      withdrewFalsePositive: 1,
      keptFalsePositive: 1,
    });
  });

  it("withdrewTruePositive と withdrewFalsePositive を取り違えない", () => {
    // 変異：true positive / false positive の判定を反転する → 落ちる。
    const metrics = scoreRun(
      entries,
      makeResult([
        finding("f1", 10, 14, { recheck: WITHDRAW }),
        finding("f2", 50, 54, { recheck: WITHDRAW }),
      ]),
    );
    expect(metrics.recheckEffect.withdrewTruePositive).toBe(1);
    expect(metrics.recheckEffect.withdrewFalsePositive).toBe(1);
  });

  it("confirm-with-author は撤回ではない", () => {
    // 変異：confirm-with-author を撤回として扱う → 再確認後の件数と keptTruePositive が落ちる。
    const metrics = scoreRun(entries, makeResult([finding("f1", 10, 14, { recheck: CONFIRM })]));
    expect(metrics.afterRecheck.findingCount).toBe(1);
    expect(metrics.recheckEffect.keptTruePositive).toBe(1);
    expect(metrics.recheckEffect.withdrewTruePositive).toBe(0);
  });

  it("recheckFailed / recheckPending / recheckDisabled はそれぞれ独立に動く", () => {
    const metrics = scoreRun(entries, makeResult(findings));
    expect(metrics.recheckFailed).toBe(1);
    expect(metrics.recheckPending).toBe(1);
    expect(metrics.recheckDisabled).toBe(1);

    const more = scoreRun(
      entries,
      makeResult([
        finding("g1", 50, 54, { recheck: { status: "failed" } }),
        finding("g2", 60, 64, { recheck: { status: "failed" } }),
        finding("g3", 70, 74, { recheck: { status: "pending" } }),
      ]),
    );
    expect(more.recheckFailed).toBe(2);
    expect(more.recheckPending).toBe(1);
    expect(more.recheckDisabled).toBe(0);
  });

  it('mode: "split" の結果では 4 区分が全 0 で recheckDisabled が指摘の総数', () => {
    const metrics = scoreRun(
      entries,
      makeResult([finding("f1", 10, 14), finding("f2", 50, 54), finding("f3", 60, 64)], {
        mode: "split",
      }),
    );
    expect(metrics.recheckEffect).toEqual({
      withdrewTruePositive: 0,
      keptTruePositive: 0,
      withdrewFalsePositive: 0,
      keptFalsePositive: 0,
    });
    expect(metrics.recheckDisabled).toBe(3);
    expect(metrics.afterRecheck).toEqual(metrics.beforeRecheck);
  });
});

// --- T8 抑制（決定 8） -------------------------------------------------------------------------

describe("T8 抑制", () => {
  it("抑制された指摘は検出・誤検出の集合にも 4 区分にも入らず、3 つに分かれる", () => {
    // 変異：抑制を誤検出に数える → falsePositives が 1/1 でなくなって落ちる。
    // 変異：抑制を検出の集合に入れる → detected が 1/1 になって落ちる。
    const entries = [errorEntry("e1", "typo", 10, 14), normalEntry("n1", 30, 34)];
    const metrics = scoreRun(
      entries,
      makeResult([
        finding("s1", 10, 14, { suppressed: true, recheck: { status: "suppressed" } }),
        finding("s2", 30, 34, { suppressed: true, recheck: { status: "suppressed" } }),
        finding("s3", 50, 54, { suppressed: true, recheck: { status: "suppressed" } }),
        finding("f1", 60, 64, { recheck: KEEP }),
      ]),
    );

    expect(metrics.beforeRecheck.findingCount).toBe(1);
    expect(metrics.beforeRecheck.detection.detected).toEqual({
      numerator: 0,
      denominator: 1,
      rate: 0,
    });
    expect(metrics.beforeRecheck.falsePositive.falsePositives).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
    });
    expect(metrics.suppression).toEqual({
      suppressedTruth: 1,
      suppressedNormal: 1,
      suppressedOther: 1,
      suppressedFindingIds: ["s1", "s2", "s3"],
    });
    expect(metrics.recheckEffect).toEqual({
      withdrewTruePositive: 0,
      keptTruePositive: 0,
      withdrewFalsePositive: 0,
      keptFalsePositive: 1,
    });
  });

  it('抑制された指摘の recheck.status === "suppressed" は recheckFailed などに数えない', () => {
    // 変異：recheckFailed などを totals.rechecks から転記する → 抑制ぶんを含む別勘定になって落ちる。
    const metrics = scoreRun(
      [],
      makeResult([
        finding("s1", 10, 14, { suppressed: true, recheck: { status: "suppressed" } }),
        finding("f1", 30, 34, { recheck: { status: "disabled" } }),
      ]),
    );
    expect(metrics.recheckFailed).toBe(0);
    expect(metrics.recheckPending).toBe(0);
    expect(metrics.recheckDisabled).toBe(1);
  });
});

// --- T9 位置特定失敗と実行性能（決定 8） -------------------------------------------------------

describe("T9 位置特定失敗", () => {
  it("totals.unlocated を転記し、失敗率は失敗候補数 / 候補数", () => {
    const metrics = scoreRun(
      [],
      makeResult([], {
        unlocatedTotals: { notFound: 2, ambiguous: 1, outsideTarget: 1 },
        candidates: 8,
      }),
    );
    expect(metrics.unlocated.notFound).toBe(2);
    expect(metrics.unlocated.ambiguous).toBe(1);
    expect(metrics.unlocated.outsideTarget).toBe(1);
    expect(metrics.unlocated.failureRate).toEqual({ numerator: 4, denominator: 8, rate: 0.5 });
  });

  it("unlocatedQuotingTruth は相互に部分文字列の関係にある件数で、検出率には算入しない", () => {
    // 変異：unlocatedQuotingTruth を detected の分子に足す → detected が 1/1 になって落ちる。
    const entries = [errorEntry("e1", "typo", 10, 14, "歩きはじじめた")];
    const metrics = scoreRun(
      entries,
      makeResult([], {
        unlocated: [
          unlocated("u1", "彼は歩きはじじめた"), // 正解の引用を含む
          unlocated("u2", "はじじめ"), // 正解の引用に含まれる
          unlocated("u3", "まったく別の語"), // どちらでもない
        ],
        unlocatedTotals: { notFound: 3, ambiguous: 0, outsideTarget: 0 },
        candidates: 3,
      }),
    );
    expect(metrics.unlocated.unlocatedQuotingTruth).toBe(2);
    expect(metrics.beforeRecheck.detection.detected).toEqual({
      numerator: 0,
      denominator: 1,
      rate: 0,
    });
    expect(metrics.beforeRecheck.detection.detectedLoose.numerator).toBe(0);
  });

  it("実行性能は conditions と totals からの転記だけ", () => {
    // 変異：checkUnits の failed と pending を取り違える → 落ちる。
    const metrics = scoreRun([], makeResult([]));
    expect(metrics.performance).toEqual({
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:10:00.000Z",
      requests: 7,
      checkUnitsFailed: 1,
      checkUnitsPending: 3,
      elapsedMs: 12_345,
    });
  });
});

// --- T17 分母 0（決定 19） ---------------------------------------------------------------------

describe("T17 分母 0", () => {
  /** JSON 化する前に直接見る。JSON.stringify を通すと NaN も正しい null も同じ null になる。 */
  function expectNullRate(rate: number | null): void {
    expect(rate).toBeNull();
    expect(Number.isNaN(rate)).toBe(false);
  }

  it("error 項目が 0 件なら検出率は null", () => {
    // 変異：0 / 0 を 0 に丸める、または NaN をそのまま入れる → 落ちる。
    const metrics = scoreRun([normalEntry("n1", 10, 14)], makeResult([finding("f1", 50, 54)]));
    expect(metrics.beforeRecheck.detection.detected).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
    });
    expectNullRate(metrics.beforeRecheck.detection.detected.rate);
    expectNullRate(metrics.beforeRecheck.detection.detectedLoose.rate);
  });

  it("指摘が 0 件なら誤検出率は null", () => {
    const metrics = scoreRun([errorEntry("e1", "typo", 10, 14)], makeResult([]));
    expect(metrics.beforeRecheck.falsePositive.falsePositives).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
    });
    expectNullRate(metrics.beforeRecheck.falsePositive.falsePositives.rate);
  });

  it("候補が 0 件なら位置特定失敗率は null", () => {
    const metrics = scoreRun([], makeResult([], { candidates: 0 }));
    expect(metrics.unlocated.failureRate).toEqual({ numerator: 0, denominator: 0, rate: null });
    expectNullRate(metrics.unlocated.failureRate.rate);
  });

  it("その観点の error 項目が 0 件なら観点別の検出率は null", () => {
    const metrics = scoreRun(
      [errorEntry("e1", "typo", 10, 14)],
      makeResult([finding("f1", 10, 14)]),
    );
    expect(metrics.beforeRecheck.detectionByPerspective.naturalness.detected).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
    });
    expectNullRate(metrics.beforeRecheck.detectionByPerspective.naturalness.detected.rate);
  });

  it("その観点を持つ指摘が 0 件なら観点別の誤検出率は null", () => {
    const metrics = scoreRun(
      [errorEntry("e1", "typo", 10, 14)],
      makeResult([finding("f1", 50, 54, { perspectives: ["typo"] })]),
    );
    expect(metrics.beforeRecheck.falsePositiveByPerspective.naturalness.falsePositives).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
    });
    expectNullRate(
      metrics.beforeRecheck.falsePositiveByPerspective.naturalness.falsePositives.rate,
    );
  });
});

// --- T18 対応付け（決定 20） -------------------------------------------------------------------

describe("T18 対応付け", () => {
  it("段落まるごとを引用した 1 件の指摘が 3 項目に重なっても検出は 1 件", () => {
    // 変異：1 対 1 を外して「重なれば検出」にする → detected が 3 になって落ちる。
    const entries = [
      errorEntry("e1", "typo", 10, 14),
      errorEntry("e2", "typo", 20, 24),
      errorEntry("e3", "typo", 30, 34),
    ];
    const metrics = scoreRun(entries, makeResult([finding("f1", 5, 40)]));

    expect(metrics.beforeRecheck.detection.detected).toEqual({
      numerator: 1,
      denominator: 3,
      rate: 1 / 3,
    });
    expect(metrics.beforeRecheck.detection.detectedLoose).toEqual({
      numerator: 3,
      denominator: 3,
      rate: 1,
    });
    expect(metrics.beforeRecheck.findingsOverlappingMultipleErrors).toEqual(["f1"]);
    expect(metrics.beforeRecheck.missedEntryIds).toEqual(["e2", "e3"]);
  });

  it("貪欲では数え落とす配置でも検出は 2 件", () => {
    // f1 は e1（重なり 8）と e2（重なり 5）に、f2 は e1（重なり 2）だけに重なる。
    // 「長い順に確定する貪欲」だと f1→e1 で止まり 1 件になるが、増加路なら f1→e2・f2→e1 で 2 件。
    // 変異：maximumMatching を貪欲に戻す → 1 件になって落ちる。
    const entries = [errorEntry("e1", "typo", 10, 20), errorEntry("e2", "typo", 30, 40)];
    const metrics = scoreRun(entries, makeResult([finding("f1", 12, 35), finding("f2", 18, 22)]));

    expect(metrics.beforeRecheck.detection.detected.numerator).toBe(2);
    expect(metrics.beforeRecheck.matchedPairs).toEqual([
      { entryId: "e1", findingId: "f2", overlapKind: "partial" },
      { entryId: "e2", findingId: "f1", overlapKind: "partial" },
    ]);
    expect(metrics.beforeRecheck.missedEntryIds).toEqual([]);
  });

  it("観点一致の検出率は部分グラフで解き直す", () => {
    // 全体のマッチでは e1 が観点違いの f1（重なり 10）に取られ、typo の f2（重なり 4）が余る。
    // 全体の結果から観点違いを後で除くと typo の検出は 1/2 になるが、観点一致の部分グラフで
    // 解き直せば f2→e1・f3→e2 で 2/2 になる。
    // 変異：全体のマッチ結果から観点違いの組を後で取り除く → 1/2 になって落ちる。
    const entries = [errorEntry("e1", "typo", 10, 20), errorEntry("e2", "typo", 30, 40)];
    const metrics = scoreRun(
      entries,
      makeResult([
        finding("f1", 10, 20, { perspectives: ["naturalness"] }),
        finding("f2", 12, 16, { perspectives: ["typo"] }),
        finding("f3", 30, 40, { perspectives: ["typo"] }),
      ]),
    );

    // 全体のマッチでは e1 の相手が観点違いの f1 になっている（前提の確認）。
    expect(metrics.beforeRecheck.matchedPairs).toEqual([
      { entryId: "e1", findingId: "f1", overlapKind: "exact" },
      { entryId: "e2", findingId: "f3", overlapKind: "exact" },
    ]);
    expect(metrics.beforeRecheck.detectionByPerspective.typo.detected).toEqual({
      numerator: 2,
      denominator: 2,
      rate: 1,
    });
  });

  it("観点別の duplicateFindings と detectedLoose は部分グラフの中で数える", () => {
    // 変異：観点別の duplicateFindings を全体の重なりで数える → 1 になって落ちる。
    const entries = [errorEntry("e1", "typo", 10, 20)];
    const metrics = scoreRun(
      entries,
      makeResult([
        finding("f1", 10, 20, { perspectives: ["typo"] }),
        finding("f2", 12, 16, { perspectives: ["naturalness"] }),
      ]),
    );
    expect(metrics.beforeRecheck.detection.duplicateFindings).toBe(1);
    expect(metrics.beforeRecheck.detectionByPerspective.typo.duplicateFindings).toBe(0);
    expect(metrics.beforeRecheck.detectionByPerspective.naturalness.detectedLoose).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
    });
  });

  it("重なりの長さが同じ組でも対応が一意に決まる", () => {
    // 4 本の辺がすべて重なり 4 で同点。並べ替えの規則（項目 range.start の昇順 → 項目 id の
    // 辞書順 → 指摘の出現順）で辺の順序が一意に決まり、対応も一意になる。
    // 先に現れる f1 が e1 を取り、次の f2 が増加路で f1 を e2 に押し出して e1 を取る。
    // 変異：range.start の並びを降順にする → 対応が入れ替わって落ちる。
    const entries = [errorEntry("e1", "typo", 10, 14), errorEntry("e2", "typo", 16, 20)];
    const metrics = scoreRun(entries, makeResult([finding("f1", 10, 20), finding("f2", 10, 20)]));

    expect(metrics.beforeRecheck.detection.detected.numerator).toBe(2);
    expect(metrics.beforeRecheck.matchedPairs).toEqual([
      { entryId: "e1", findingId: "f2", overlapKind: "containsTruth" },
      { entryId: "e2", findingId: "f1", overlapKind: "containsTruth" },
    ]);
  });

  it("range.start が同じ項目同士は id の辞書順で並べる", () => {
    // 重なりの長さも range.start も同じ 2 項目を、配列の並びとは逆の辞書順（a1 < b1）で置く。
    // 辺は a1 の組が先に来るので、f1 が a1 を取り、f2 が増加路で f1 を b1 に押し出して a1 を取る。
    // 変異：id の比較を落とす → 辺が配列の並びのまま（b1 が先）になり、対応が入れ替わって落ちる。
    const entries = [errorEntry("b1", "typo", 10, 14), errorEntry("a1", "typo", 10, 14)];
    const metrics = scoreRun(entries, makeResult([finding("f1", 10, 14), finding("f2", 10, 14)]));

    expect(metrics.beforeRecheck.matchedPairs).toEqual([
      { entryId: "b1", findingId: "f1", overlapKind: "exact" },
      { entryId: "a1", findingId: "f2", overlapKind: "exact" },
    ]);
  });

  it("overlapKinds は 1 対 1 で対応した組だけを数え、合計は detected.numerator と等しい", () => {
    // 不変条件。変異：重なり全部を数える、またはどれか 1 つの分類を落とす → 合計が合わずに落ちる。
    const entries = [
      errorEntry("e1", "typo", 10, 14),
      errorEntry("e2", "typo", 20, 24),
      errorEntry("e3", "typo", 30, 40),
      errorEntry("e4", "typo", 50, 60),
      errorEntry("e5", "typo", 70, 74),
    ];
    const metrics = scoreRun(
      entries,
      makeResult([
        finding("f1", 10, 14), // exact
        finding("f2", 18, 26), // containsTruth
        finding("f3", 32, 36), // containedInTruth
        finding("f4", 55, 65), // partial
        finding("f5", 70, 74), // e5 に重なるが、下の f6 と合わせて重複指摘になる
        finding("f6", 71, 73),
      ]),
    );

    expect(metrics.beforeRecheck.overlapKinds).toEqual({
      exact: 2,
      containsTruth: 1,
      containedInTruth: 1,
      partial: 1,
    });
    const total = Object.values(metrics.beforeRecheck.overlapKinds).reduce((a, b) => a + b, 0);
    expect(total).toBe(metrics.beforeRecheck.detection.detected.numerator);
    expect(total).toBe(5);
  });
});
