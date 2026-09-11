import type { ModelInfo } from "@shuten/server/lmstudio/types.ts";
import type { RunConditions } from "@shuten/server/run/result.ts";
import { describe, expect, it } from "vitest";

import { aggregateRuns } from "./aggregate.ts";
import type { EvaluationResultInput } from "./result-schema.ts";
import type { EvaluationMetrics, FindingSetMetrics, Rate } from "./score.ts";

// すべて合成のテキスト・合成の JSON（実原稿の断片を含まない）。
// このファイルは aggregateRuns（純粋関数）を直接叩く。scoreRun は通さない
// （率が null になる組み合わせなど、scoreRun からは作りにくい状態を直接作るため）。

// --- 条件（RunConditions）のビルダー ------------------------------------------------------------

function baseConditions(overrides: Partial<RunConditions> = {}): RunConditions {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:10:00.000Z",
    mode: "split-recheck",
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
    versions: { result: "1", prompt: "1", allowedWordRule: "1", diagnosticTransform: "1" },
    manuscript: {
      utf16Length: 100,
      graphemeCount: 100,
      paragraphCount: 1,
      targetCount: 1,
      bodyHash: "a".repeat(64),
    },
    ...overrides,
  };
}

function modelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "model-a",
    type: "llm",
    state: "loaded",
    quantization: "Q4_K_M",
    maxContextLength: 8192,
    loadedContextLength: 4096,
    ...overrides,
  };
}

// --- EvaluationResultInput のビルダー ------------------------------------------------------------

function baseResult(
  overrides: { conditions?: RunConditions; status?: EvaluationResultInput["status"] } = {},
): EvaluationResultInput {
  return {
    status: overrides.status ?? "completed",
    stop: null,
    conditions: overrides.conditions ?? baseConditions(),
    findings: [],
    unlocated: [],
    totals: {
      targets: 1,
      checkUnits: { done: 1, failed: 0, pending: 0 },
      requests: 1,
      candidates: 1,
      located: 1,
      unlocated: { notFound: 0, ambiguous: 0, outsideTarget: 0 },
      findings: 0,
      suppressed: 0,
      rechecks: { done: 0, failed: 0, pending: 0, suppressed: 0, disabled: 0 },
      elapsedMs: 100,
    },
  };
}

// --- EvaluationMetrics のビルダー ----------------------------------------------------------------

function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}

function emptyFindingSet(
  overrides: {
    findingCount?: number;
    detected?: Rate;
    detectedLoose?: Rate;
    duplicateFindings?: number;
    falsePositives?: Rate;
    matchedPairs?: FindingSetMetrics["matchedPairs"];
    missedEntryIds?: readonly string[];
  } = {},
): FindingSetMetrics {
  return {
    findingCount: overrides.findingCount ?? 0,
    detection: {
      detected: overrides.detected ?? rate(0, 0),
      detectedLoose: overrides.detectedLoose ?? rate(0, 0),
      duplicateFindings: overrides.duplicateFindings ?? 0,
    },
    detectionByPerspective: {
      typo: { detected: rate(0, 0), detectedLoose: rate(0, 0), duplicateFindings: 0 },
      naturalness: { detected: rate(0, 0), detectedLoose: rate(0, 0), duplicateFindings: 0 },
    },
    falsePositive: {
      falsePositives: overrides.falsePositives ?? rate(0, 0),
      onNormal: 0,
      other: 0,
    },
    falsePositiveByPerspective: {
      typo: { falsePositives: rate(0, 0), onNormal: 0, other: 0 },
      naturalness: { falsePositives: rate(0, 0), onNormal: 0, other: 0 },
    },
    overlapKinds: { exact: 0, containsTruth: 0, containedInTruth: 0, partial: 0 },
    findingsOverlappingMultipleErrors: [],
    missedEntryIds: overrides.missedEntryIds ?? [],
    falsePositiveFindings: [],
    matchedPairs: overrides.matchedPairs ?? [],
  };
}

function baseMetrics(
  overrides: {
    beforeRecheck?: FindingSetMetrics;
    afterRecheck?: FindingSetMetrics;
    status?: EvaluationResultInput["status"];
    elapsedMs?: number;
  } = {},
): EvaluationMetrics {
  return {
    formatVersion: "1",
    truthEntryCounts: { error: 0, normal: 0 },
    beforeRecheck: overrides.beforeRecheck ?? emptyFindingSet(),
    afterRecheck: overrides.afterRecheck ?? emptyFindingSet(),
    recheckEffect: {
      withdrewTruePositive: 0,
      keptTruePositive: 0,
      withdrewFalsePositive: 0,
      keptFalsePositive: 0,
    },
    recheckFailed: 0,
    recheckPending: 0,
    recheckDisabled: 0,
    suppression: {
      suppressedTruth: 0,
      suppressedNormal: 0,
      suppressedOther: 0,
      suppressedFindingIds: [],
    },
    unlocated: {
      notFound: 0,
      ambiguous: 0,
      outsideTarget: 0,
      failureRate: rate(0, 0),
      unlocatedQuotingTruth: 0,
    },
    performance: {
      status: overrides.status ?? "completed",
      stopReason: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      requests: 0,
      checkUnitsFailed: 0,
      checkUnitsPending: 0,
      elapsedMs: overrides.elapsedMs ?? 0,
    },
  };
}

// --- 正常系（土台。以降の不一致テストと対比するための基準） --------------------------------------

describe("aggregateRuns: 条件がすべて一致していれば集計できる", () => {
  it("2 本とも同じ条件なら ok:true", () => {
    const results = [baseResult(), baseResult()];
    const metrics = [baseMetrics(), baseMetrics()];
    const outcome = aggregateRuns(metrics, results);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.runCount).toBe(2);
    expect(outcome.value.formatVersion).toBe("1");
  });
});

// --- 条件の一致検査（決定12）：項目ごとに1例ずつ ------------------------------------------------

describe("aggregateRuns: 条件の不一致（決定12。項目ごとに1例ずつ）", () => {
  it("manuscript.bodyHash が食い違うとエラー", () => {
    const a = baseResult({
      conditions: baseConditions({
        manuscript: { ...baseConditions().manuscript, bodyHash: "a".repeat(64) },
      }),
    });
    const b = baseResult({
      conditions: baseConditions({
        manuscript: { ...baseConditions().manuscript, bodyHash: "b".repeat(64) },
      }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("bodyHash") || e.includes("ハッシュ"))).toBe(true);
  });

  it("mode が食い違うとエラー", () => {
    const a = baseResult({ conditions: baseConditions({ mode: "split" }) });
    const b = baseResult({ conditions: baseConditions({ mode: "full-text" }) });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("mode"))).toBe(true);
  });

  it("perspectives が食い違うとエラー", () => {
    const a = baseResult({ conditions: baseConditions({ perspectives: ["typo"] }) });
    const b = baseResult({ conditions: baseConditions({ perspectives: ["typo", "naturalness"] }) });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("perspectives") || e.includes("観点"))).toBe(true);
  });

  it("generation.model が食い違うとエラー", () => {
    const a = baseResult({
      conditions: baseConditions({
        generation: { model: "model-x", maxTokens: 1024, temperature: 0 },
      }),
    });
    const b = baseResult({
      conditions: baseConditions({
        generation: { model: "model-y", maxTokens: 1024, temperature: 0 },
      }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("generation.model"))).toBe(true);
  });

  it("generation.maxTokens が食い違うとエラー", () => {
    const a = baseResult({
      conditions: baseConditions({
        generation: { model: "test-model", maxTokens: 1024, temperature: 0 },
      }),
    });
    const b = baseResult({
      conditions: baseConditions({
        generation: { model: "test-model", maxTokens: 2048, temperature: 0 },
      }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("generation.maxTokens"))).toBe(true);
  });

  it("generation.temperature が食い違うとエラー", () => {
    const a = baseResult({
      conditions: baseConditions({
        generation: { model: "test-model", maxTokens: 1024, temperature: 0 },
      }),
    });
    const b = baseResult({
      conditions: baseConditions({
        generation: { model: "test-model", maxTokens: 1024, temperature: 0.7 },
      }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("generation.temperature"))).toBe(true);
  });

  it("generation.seed が食い違うとエラー（未指定どうしは一致とみなす）", () => {
    const a = baseResult({
      conditions: baseConditions({
        generation: { model: "test-model", maxTokens: 1024, temperature: 0, seed: 1 },
      }),
    });
    const b = baseResult({
      conditions: baseConditions({
        generation: { model: "test-model", maxTokens: 1024, temperature: 0 },
      }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("generation.seed"))).toBe(true);

    // 未指定どうしは一致（決定12）。
    const c = baseResult({ conditions: baseConditions() });
    const d = baseResult({ conditions: baseConditions() });
    const okOutcome = aggregateRuns([baseMetrics(), baseMetrics()], [c, d]);
    expect(okOutcome.ok).toBe(true);
  });

  it("generation.reasoningEffort が食い違うとエラー", () => {
    const a = baseResult({
      conditions: baseConditions({
        generation: {
          model: "test-model",
          maxTokens: 1024,
          temperature: 0,
          reasoningEffort: "low",
        },
      }),
    });
    const b = baseResult({
      conditions: baseConditions({
        generation: {
          model: "test-model",
          maxTokens: 1024,
          temperature: 0,
          reasoningEffort: "high",
        },
      }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("generation.reasoningEffort"))).toBe(true);
  });

  it("chunkSettings が食い違うとエラー", () => {
    const a = baseResult({ conditions: baseConditions() });
    const b = baseResult({
      conditions: baseConditions({
        chunkSettings: {
          targetGraphemes: 2000,
          contextGraphemes: 1000,
          recheckContextGraphemes: 3000,
          roundingTolerance: 0.2,
          maxInputGraphemes: 6000,
        },
      }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("chunkSettings"))).toBe(true);
  });

  it("timeouts が食い違うとエラー", () => {
    const a = baseResult({ conditions: baseConditions() });
    const b = baseResult({
      conditions: baseConditions({ timeouts: { checkMs: 2000, recheckMs: 1000 } }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("timeouts"))).toBe(true);
  });

  it("allowedWords が食い違う（順序違いも含む）とエラーで、中身はエラーメッセージに出さない", () => {
    const a = baseResult({ conditions: baseConditions({ allowedWords: ["ほげ", "ふが"] }) });
    const b = baseResult({ conditions: baseConditions({ allowedWords: ["ふが", "ほげ"] }) });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("許容語") || e.includes("allowedWords"))).toBe(
      true,
    );
    const joined = outcome.errors.join("\n");
    expect(joined).not.toContain("ほげ");
    expect(joined).not.toContain("ふが");
  });

  it("versions.result が食い違うとエラー", () => {
    const a = baseResult({
      conditions: baseConditions({
        versions: { result: "1", prompt: "1", allowedWordRule: "1", diagnosticTransform: "1" },
      }),
    });
    const b = baseResult({
      conditions: baseConditions({
        versions: { result: "2", prompt: "1", allowedWordRule: "1", diagnosticTransform: "1" },
      }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("versions.result"))).toBe(true);
  });

  it("versions.prompt が食い違うとエラー", () => {
    const a = baseResult({
      conditions: baseConditions({
        versions: { result: "1", prompt: "1", allowedWordRule: "1", diagnosticTransform: "1" },
      }),
    });
    const b = baseResult({
      conditions: baseConditions({
        versions: { result: "1", prompt: "2", allowedWordRule: "1", diagnosticTransform: "1" },
      }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("versions.prompt"))).toBe(true);
  });

  it("versions.allowedWordRule が食い違うとエラー", () => {
    const a = baseResult({
      conditions: baseConditions({
        versions: { result: "1", prompt: "1", allowedWordRule: "1", diagnosticTransform: "1" },
      }),
    });
    const b = baseResult({
      conditions: baseConditions({
        versions: { result: "1", prompt: "1", allowedWordRule: "2", diagnosticTransform: "1" },
      }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("versions.allowedWordRule"))).toBe(true);
  });

  it("versions.diagnosticTransform が食い違うとエラー", () => {
    const a = baseResult({
      conditions: baseConditions({
        versions: { result: "1", prompt: "1", allowedWordRule: "1", diagnosticTransform: "1" },
      }),
    });
    const b = baseResult({
      conditions: baseConditions({
        versions: { result: "1", prompt: "1", allowedWordRule: "1", diagnosticTransform: "2" },
      }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("versions.diagnosticTransform"))).toBe(true);
  });
});

// --- model（ModelInfo）の扱い：id・quantization・state・loadedContextLength ----------------------

describe("aggregateRuns: model の扱い（決定12）", () => {
  it("quantization が両方取れていて食い違えばエラー（変異：警告にすると落ちる）", () => {
    const a = baseResult({
      conditions: baseConditions({ model: modelInfo({ quantization: "Q4_K_M" }) }),
    });
    const b = baseResult({
      conditions: baseConditions({ model: modelInfo({ quantization: "Q8_0" }) }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("quantization"))).toBe(true);
  });

  it("model.id が両方取れていて食い違えばエラー", () => {
    const a = baseResult({ conditions: baseConditions({ model: modelInfo({ id: "model-a" }) }) });
    const b = baseResult({ conditions: baseConditions({ model: modelInfo({ id: "model-b" }) }) });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.some((e) => e.includes("model.id"))).toBe(true);
  });

  it("quantization が片方 null ならエラーにならず notices に出る", () => {
    const a = baseResult({
      conditions: baseConditions({ model: modelInfo({ quantization: "Q4_K_M" }) }),
    });
    const b = baseResult({
      conditions: baseConditions({ model: modelInfo({ quantization: null }) }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.notices.some((n) => n.includes("量子化"))).toBe(true);
  });

  it("model が両方 null（未取得）ならエラーにならず notices に出る", () => {
    const a = baseResult({ conditions: baseConditions({ model: null }) });
    const b = baseResult({ conditions: baseConditions({ model: null }) });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.notices.some((n) => n.includes("量子化"))).toBe(true);
  });

  it("state が食い違ってもエラーにならない（比較しない）", () => {
    const a = baseResult({ conditions: baseConditions({ model: modelInfo({ state: "loaded" }) }) });
    const b = baseResult({
      conditions: baseConditions({ model: modelInfo({ state: "not-loaded" }) }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(true);
  });

  it("loadedContextLength が実行間で違ってもエラーにならず、値そのものが notices に出る（比較はしない）", () => {
    const a = baseResult({
      conditions: baseConditions({ model: modelInfo({ loadedContextLength: 4096 }) }),
    });
    const b = baseResult({
      conditions: baseConditions({ model: modelInfo({ loadedContextLength: 8192 }) }),
    });
    const outcome = aggregateRuns([baseMetrics(), baseMetrics()], [a, b]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const notice = outcome.value.notices.find((n) => n.includes("loadedContextLength"));
    expect(notice).toBeDefined();
    expect(notice).toContain("4096");
    expect(notice).toContain("8192");
  });
});

// --- 率の集計：rate が null の実行が混ざる場合（決定12） ------------------------------------------

describe("aggregateRuns: rate が null の実行が混ざる場合（決定12）", () => {
  it("3本のうち1本だけ null なら availableRuns:2 / unavailableRuns:1 で、3値は残り2本から出る", () => {
    // falsePositives（findingCount 0 → 分母 0 → rate null）を使う。
    const withRate = (r: Rate) =>
      baseMetrics({ afterRecheck: emptyFindingSet({ falsePositives: r }) });
    const metrics = [withRate(rate(1, 4)), withRate(rate(0, 0)), withRate(rate(3, 4))];
    const results = [baseResult(), baseResult(), baseResult()];
    const outcome = aggregateRuns(metrics, results);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const fp = outcome.value.metrics.afterRecheck.falsePositives;
    expect(fp.availableRuns).toBe(2);
    expect(fp.unavailableRuns).toBe(1);
    expect(fp.min).toBe(0.25);
    expect(fp.max).toBe(0.75);
    expect(fp.median).toBe(0.5);
  });

  it("全実行が null なら3値とも null で availableRuns:0", () => {
    const withNullRate = baseMetrics({
      afterRecheck: emptyFindingSet({ falsePositives: rate(0, 0) }),
    });
    const metrics = [withNullRate, withNullRate, withNullRate];
    const results = [baseResult(), baseResult(), baseResult()];
    const outcome = aggregateRuns(metrics, results);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const fp = outcome.value.metrics.afterRecheck.falsePositives;
    expect(fp.availableRuns).toBe(0);
    expect(fp.unavailableRuns).toBe(3);
    expect(fp.min).toBeNull();
    expect(fp.median).toBeNull();
    expect(fp.max).toBeNull();
  });
});

// --- 中央値：本数が偶数なら中央2値の算術平均 ------------------------------------------------------

describe("aggregateRuns: 中央値（本数が偶数。決定12。変異：下側を採ると落ちる）", () => {
  it("NumberAggregate（elapsedMs）：4本で2番目と3番目が違う値", () => {
    const metrics = [100, 200, 300, 400].map((elapsedMs) => baseMetrics({ elapsedMs }));
    const results = [baseResult(), baseResult(), baseResult(), baseResult()];
    const outcome = aggregateRuns(metrics, results);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const performance = outcome.value.metrics.performance.elapsedMs;
    expect(performance.min).toBe(100);
    expect(performance.max).toBe(400);
    // (200+300)/2 = 250。下側（200）を採る変異だと落ちる。
    expect(performance.median).toBe(250);
  });

  it("RateAggregate（detected）：4本で2番目と3番目が違う値", () => {
    const metrics = [0.2, 0.4, 0.6, 0.8].map((r) =>
      baseMetrics({ afterRecheck: emptyFindingSet({ detected: rate(r * 10, 10) }) }),
    );
    const results = [baseResult(), baseResult(), baseResult(), baseResult()];
    const outcome = aggregateRuns(metrics, results);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const detected = outcome.value.metrics.afterRecheck.detected;
    expect(detected.min).toBe(0.2);
    expect(detected.max).toBe(0.8);
    // (0.4+0.6)/2 = 0.5。下側（0.4）を採る変異だと落ちる。
    expect(detected.median).toBeCloseTo(0.5);
  });
});

// --- 正解項目ごとの検出頻度 k/N -------------------------------------------------------------------

describe("aggregateRuns: 検出頻度 k/N（決定12）", () => {
  it("正解項目ごとに検出された実行の本数を正しく数える", () => {
    // e1: 3本中3本で検出、e2: 3本中1本だけ検出、e3: 3本中0本で検出（missed）。
    const run1 = emptyFindingSet({
      matchedPairs: [
        { entryId: "e1", findingId: "f1", overlapKind: "exact" },
        { entryId: "e2", findingId: "f2", overlapKind: "exact" },
      ],
      missedEntryIds: ["e3"],
    });
    const run2 = emptyFindingSet({
      matchedPairs: [{ entryId: "e1", findingId: "f1", overlapKind: "exact" }],
      missedEntryIds: ["e2", "e3"],
    });
    const run3 = emptyFindingSet({
      matchedPairs: [{ entryId: "e1", findingId: "f1", overlapKind: "exact" }],
      missedEntryIds: ["e2", "e3"],
    });
    const metrics = [run1, run2, run3].map((afterRecheck) => baseMetrics({ afterRecheck }));
    const results = [baseResult(), baseResult(), baseResult()];
    const outcome = aggregateRuns(metrics, results);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.detectionFrequency).toEqual([
      { entryId: "e1", detectedRuns: 3, totalRuns: 3 },
      { entryId: "e2", detectedRuns: 1, totalRuns: 3 },
      { entryId: "e3", detectedRuns: 0, totalRuns: 3 },
    ]);
  });
});

// --- 実行の状態（私の裁定。決定12に無い追加） -----------------------------------------------------

describe("aggregateRuns: completed でない実行が混ざると notices に出る", () => {
  it("status が partially-failed の実行があれば notices にその旨が出る（変異：notice を削ると落ちる）", () => {
    const metrics = [
      baseMetrics({ status: "completed" }),
      baseMetrics({ status: "partially-failed" }),
    ];
    const results = [
      baseResult({ status: "completed" }),
      baseResult({ status: "partially-failed" }),
    ];
    const outcome = aggregateRuns(metrics, results);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.notices.some((n) => n.includes("partially-failed"))).toBe(true);
  });

  it("全実行が completed なら状態に関する notice は出ない", () => {
    const metrics = [baseMetrics({ status: "completed" }), baseMetrics({ status: "completed" })];
    const results = [baseResult({ status: "completed" }), baseResult({ status: "completed" })];
    const outcome = aggregateRuns(metrics, results);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.notices.some((n) => n.includes("完走していません"))).toBe(false);
  });
});

// --- 呼び出し側のバグ（長さ不一致） ---------------------------------------------------------------

describe("aggregateRuns: metricsList と resultsList の長さが違えば例外", () => {
  it("長さが違うと例外を投げる（丸めない）", () => {
    expect(() => aggregateRuns([baseMetrics()], [baseResult(), baseResult()])).toThrow();
  });
});
