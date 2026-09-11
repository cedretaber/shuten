import { describe, expect, it } from "vitest";

import type { AggregateResult } from "./aggregate.ts";
import { formatAggregateReport } from "./aggregate-report.ts";

// すべて合成のテキスト（実原稿の断片を含まない）。

function rateAggregate(min: number | null, median: number | null, max: number | null) {
  return {
    availableRuns: min === null ? 0 : 2,
    unavailableRuns: min === null ? 2 : 0,
    min,
    median,
    max,
  };
}

function numberAggregate(min: number, median: number, max: number) {
  return { min, median, max };
}

function baseAggregateResult(
  overrides: { notices?: readonly string[]; detected?: ReturnType<typeof rateAggregate> } = {},
): AggregateResult {
  const rate = overrides.detected ?? rateAggregate(0.2, 0.5, 0.8);
  const findingSet = {
    detected: rate,
    detectedLoose: rate,
    falsePositives: rate,
    findingCount: numberAggregate(1, 2, 3),
    duplicateFindings: numberAggregate(0, 0, 0),
    detectionByPerspective: {
      typo: { detected: rate },
      naturalness: { detected: rate },
    },
  };
  return {
    formatVersion: "1",
    runCount: 2,
    notices: overrides.notices ?? [],
    metrics: {
      beforeRecheck: findingSet,
      afterRecheck: findingSet,
      recheckEffect: {
        withdrewTruePositive: numberAggregate(0, 0, 0),
        keptTruePositive: numberAggregate(0, 0, 0),
        withdrewFalsePositive: numberAggregate(0, 0, 0),
        keptFalsePositive: numberAggregate(0, 0, 0),
      },
      recheckFailed: numberAggregate(0, 0, 0),
      recheckPending: numberAggregate(0, 0, 0),
      recheckDisabled: numberAggregate(0, 0, 0),
      suppression: {
        suppressedTruth: numberAggregate(0, 0, 0),
        suppressedNormal: numberAggregate(0, 0, 0),
        suppressedOther: numberAggregate(0, 0, 0),
      },
      unlocated: {
        failureRate: rateAggregate(0, 0, 0),
        notFound: numberAggregate(0, 0, 0),
        ambiguous: numberAggregate(0, 0, 0),
        outsideTarget: numberAggregate(0, 0, 0),
        unlocatedQuotingTruth: numberAggregate(0, 0, 0),
      },
      performance: {
        requests: numberAggregate(1, 1, 1),
        checkUnitsFailed: numberAggregate(0, 0, 0),
        checkUnitsPending: numberAggregate(0, 0, 0),
        elapsedMs: numberAggregate(100, 100, 100),
      },
    },
    detectionFrequency: [{ entryId: "e1", detectedRuns: 2, totalRuns: 2 }],
  };
}

describe("formatAggregateReport", () => {
  it("notices は「## 指標」より前（先頭の注意）に出る", () => {
    const result = baseAggregateResult({
      notices: ["実行2は完走していません（status: partially-failed）"],
    });
    const report = formatAggregateReport(result);
    const noticeIndex = report.indexOf("実行2は完走していません");
    const metricsIndex = report.indexOf("## 指標");
    expect(noticeIndex).toBeGreaterThan(-1);
    expect(metricsIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeLessThan(metricsIndex);
  });

  it("notices が無ければ「（なし）」と出る", () => {
    const report = formatAggregateReport(baseAggregateResult({ notices: [] }));
    expect(report).toContain("（なし）");
  });

  it("全実行が null（availableRuns:0）の率は — で示し、パーセント表示にしない", () => {
    const result = baseAggregateResult({ detected: rateAggregate(null, null, null) });
    const report = formatAggregateReport(result);
    expect(report).toContain("—（有効な実行なし。unavailableRuns=2）");
  });
});
