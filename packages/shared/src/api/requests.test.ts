import { describe, expect, it } from "vitest";

import { MAX_TIMEOUT_MS, RUN_SETTINGS_DEFAULTS } from "./defaults.ts";
import {
  putConnectionRequestSchema,
  retryFailedRequestSchema,
  startRunRequestSchema,
} from "./requests.ts";

function validStartRunRequest(): Record<string, unknown> {
  return {
    startOperationId: "op-1",
    manuscriptVersionId: "mv-1",
    modelId: "model-1",
    generation: { maxTokens: 16000, temperature: 0 },
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
    allowedWordsRaw: "",
  };
}

describe("startRunRequestSchema", () => {
  it("正しい形の値を受け入れる", () => {
    const result = startRunRequestSchema.safeParse(validStartRunRequest());
    expect(result.success).toBe(true);
  });

  it("RUN_SETTINGS_DEFAULTS から組んだ要求を受け入れる", () => {
    const result = startRunRequestSchema.safeParse({
      startOperationId: "op-1",
      manuscriptVersionId: "mv-1",
      modelId: "model-1",
      generation: RUN_SETTINGS_DEFAULTS.generation,
      chunkSettings: RUN_SETTINGS_DEFAULTS.chunkSettings,
      timeouts: RUN_SETTINGS_DEFAULTS.timeouts,
      perspectives: RUN_SETTINGS_DEFAULTS.perspectives,
      recheckEnabled: RUN_SETTINGS_DEFAULTS.recheckEnabled,
      allowedWordsRaw: "",
    });
    expect(result.success).toBe(true);
  });

  it("maxTokens: 0 を拒む（1 以上の安全な整数）", () => {
    const request = validStartRunRequest();
    request.generation = { ...(request.generation as object), maxTokens: 0 };
    expect(startRunRequestSchema.safeParse(request).success).toBe(false);
  });

  it("seed: -1 を拒む（0 以上の安全な整数）", () => {
    const request = validStartRunRequest();
    request.generation = { ...(request.generation as object), seed: -1 };
    expect(startRunRequestSchema.safeParse(request).success).toBe(false);
  });

  it("seed: 2**53 を拒む（z.int() は Number.isSafeInteger に限る）", () => {
    const request = validStartRunRequest();
    request.generation = { ...(request.generation as object), seed: 2 ** 53 };
    expect(startRunRequestSchema.safeParse(request).success).toBe(false);
  });

  it("perspectives: [] を拒む（min(1)）", () => {
    const request = validStartRunRequest();
    request.perspectives = [];
    expect(startRunRequestSchema.safeParse(request).success).toBe(false);
  });

  it("checkMs: MAX_TIMEOUT_MS + 1 を拒む", () => {
    const request = validStartRunRequest();
    request.timeouts = {
      ...(request.timeouts as object),
      checkMs: MAX_TIMEOUT_MS + 1,
    };
    expect(startRunRequestSchema.safeParse(request).success).toBe(false);
  });

  it("checkMs: MAX_TIMEOUT_MS を受け入れる（上限は含む）", () => {
    const request = validStartRunRequest();
    request.timeouts = {
      ...(request.timeouts as object),
      checkMs: MAX_TIMEOUT_MS,
    };
    expect(startRunRequestSchema.safeParse(request).success).toBe(true);
  });
});

describe("retryFailedRequestSchema", () => {
  it("unitIds 省略（全件）を受け入れる", () => {
    expect(retryFailedRequestSchema.safeParse({}).success).toBe(true);
  });

  it("unitIds: [] を拒む（空配列は誤り。PR9b 決定 36）", () => {
    expect(retryFailedRequestSchema.safeParse({ unitIds: [] }).success).toBe(false);
  });

  it('unitIds: ["unit-1"] を受け入れる', () => {
    expect(retryFailedRequestSchema.safeParse({ unitIds: ["unit-1"] }).success).toBe(true);
  });
});

describe("putConnectionRequestSchema", () => {
  it("apiKey 省略（維持）を受け入れる", () => {
    const result = putConnectionRequestSchema.safeParse({
      endpointUrl: "http://127.0.0.1:1234",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("apiKey" in result.data).toBe(false);
    }
  });

  it("apiKey: null（消去）を受け入れる", () => {
    const result = putConnectionRequestSchema.safeParse({
      endpointUrl: "http://127.0.0.1:1234",
      apiKey: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apiKey).toBeNull();
    }
  });

  it("apiKey: 文字列（設定）を受け入れる", () => {
    const result = putConnectionRequestSchema.safeParse({
      endpointUrl: "http://127.0.0.1:1234",
      apiKey: "sk-test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apiKey).toBe("sk-test");
    }
  });
});
