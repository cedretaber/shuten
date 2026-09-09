import { describe, expect, it } from "vitest";

import {
  candidateDtoSchema,
  connectionCheckDtoSchema,
  findingDetailDtoSchema,
  findingDtoSchema,
  generationSettingsDtoSchema,
  runDtoSchema,
} from "./dto.ts";

const NOW = "2026-09-09T00:00:00.000Z";

function validRunDto(): Record<string, unknown> {
  return {
    id: "run-1",
    manuscriptVersionId: "mv-1",
    modelId: "model-1",
    modelInfo: null,
    generationSettings: { maxTokens: 16000, temperature: 0 },
    chunkSettings: {
      targetGraphemes: 1500,
      contextGraphemes: 1000,
      recheckContextGraphemes: 3000,
      roundingTolerance: 0.2,
      maxInputGraphemes: 12000,
    },
    timeouts: { checkMs: 300000, recheckMs: 300000 },
    perspectives: ["typo", "naturalness"],
    recheckEnabled: false,
    allowedWords: [],
    allowedWordRuleVersion: "v1",
    promptVersion: "v1",
    diagnosticTransformVersion: "v1",
    status: "running",
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    stopRequestedAt: null,
    recoveryConfirmedAt: null,
    recoveryConfirmMs: 0,
    startedAt: NOW,
    finishedAt: null,
  };
}

function validFindingDto(): Record<string, unknown> {
  return {
    id: "finding-1",
    runId: "run-1",
    targetId: "target-1",
    locateStatus: "located",
    range: { start: 0, end: 5 },
    paragraphId: 0,
    quote: "誤字",
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
      updatedAt: NOW,
    },
    createdAt: NOW,
  };
}

describe("runDtoSchema", () => {
  it("正しい形の値を受け入れる", () => {
    const result = runDtoSchema.safeParse(validRunDto());
    expect(result.success).toBe(true);
  });

  it("endpointUrl を含む値を拒む（.strict()。接続先 URL を RunDto に出さない）", () => {
    const result = runDtoSchema.safeParse({
      ...validRunDto(),
      endpointUrl: "http://127.0.0.1:1234",
    });
    expect(result.success).toBe(false);
  });

  it("startOperationId を含む値を拒む", () => {
    const result = runDtoSchema.safeParse({ ...validRunDto(), startOperationId: "op-1" });
    expect(result.success).toBe(false);
  });
});

describe("findingDtoSchema", () => {
  it("正しい形の値を受け入れる", () => {
    const result = findingDtoSchema.safeParse(validFindingDto());
    expect(result.success).toBe(true);
  });

  it("judgment: null を拒む（行が無ければ DB 不整合として 500。.nullable() を付けない）", () => {
    const result = findingDtoSchema.safeParse({ ...validFindingDto(), judgment: null });
    expect(result.success).toBe(false);
  });

  it("judgment 自体の欠落も拒む", () => {
    const { judgment: _judgment, ...rest } = validFindingDto() as Record<string, unknown>;
    const result = findingDtoSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe("findingDetailDtoSchema", () => {
  it("FindingDto に candidates / diagnostics を足した形を受け入れる", () => {
    const result = findingDetailDtoSchema.safeParse({
      ...validFindingDto(),
      candidates: [],
      diagnostics: [],
    });
    expect(result.success).toBe(true);
  });

  it("余分なキーを拒む（.extend() 後も .strict() のまま）", () => {
    const result = findingDetailDtoSchema.safeParse({
      ...validFindingDto(),
      candidates: [],
      diagnostics: [],
      extra: "unexpected",
    });
    expect(result.success).toBe(false);
  });
});

describe("candidateDtoSchema", () => {
  it("llm フィールドは llmFindingSchema（llm/schema.ts）と同じ形を受け入れる", () => {
    const result = candidateDtoSchema.safeParse({
      id: "candidate-1",
      checkUnitId: "unit-1",
      perspective: "typo",
      candidateIndex: 0,
      llm: {
        paragraphId: 0,
        quote: "誤字",
        before: "",
        after: "",
        category: "notation",
        reason: "テスト用の理由",
        suggestion: "修正案",
        verdict: "likely-error",
      },
      locateStatus: "located",
      range: { start: 0, end: 5 },
    });
    expect(result.success).toBe(true);
  });
});

describe("connectionCheckDtoSchema", () => {
  it("到達不能・model なしの形を受け入れる（決定 8）", () => {
    const result = connectionCheckDtoSchema.safeParse({
      reachable: false,
      error: { reason: "connection", message: "接続できませんでした" },
      models: [],
      model: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("generationSettingsDtoSchema", () => {
  it("seed / reasoningEffort を省略した形を受け入れる", () => {
    const result = generationSettingsDtoSchema.safeParse({ maxTokens: 16000, temperature: 0 });
    expect(result.success).toBe(true);
  });

  it("未知の reasoningEffort を拒む", () => {
    const result = generationSettingsDtoSchema.safeParse({
      maxTokens: 16000,
      temperature: 0,
      reasoningEffort: "extreme",
    });
    expect(result.success).toBe(false);
  });
});
