import type { ConnectionCheckDto, ModelInfoDto } from "@shuten/shared";
import { describe, expect, it } from "vitest";
import { canStartWithModel, nextSelectedModelId } from "./model-selection.ts";

/**
 * 決定 6 の表（5 行）と、`models` に該当 ID が無い場合の `canStartWithModel` を検証する
 * （計画書 W4 節、W4-5〜10）。
 */

function makeModel(overrides: Partial<ModelInfoDto> = {}): ModelInfoDto {
  return {
    id: "model-1",
    type: "llm",
    state: "loaded",
    quantization: null,
    maxContextLength: null,
    loadedContextLength: null,
    ...overrides,
  };
}

function makeCheck(overrides: Partial<ConnectionCheckDto> = {}): ConnectionCheckDto {
  return {
    reachable: true,
    error: null,
    models: [],
    model: null,
    ...overrides,
  };
}

describe("nextSelectedModelId", () => {
  it("W4-5: 接続に失敗した（reachable: false）→ 保存済みの選択を維持する", () => {
    const check = makeCheck({ reachable: false, error: { reason: "connection", message: "x" } });
    expect(nextSelectedModelId(check, "model-1")).toBe("model-1");
  });

  it("W4-6: 一覧は取れたが ID が無い → 選択を解除する", () => {
    const check = makeCheck({ models: [makeModel({ id: "other" })] });
    expect(nextSelectedModelId(check, "model-1")).toBeNull();
  });

  it("W4-7: ID はあるが種別が embeddings → 選択を解除する", () => {
    const check = makeCheck({ models: [makeModel({ id: "model-1", type: "embeddings" })] });
    expect(nextSelectedModelId(check, "model-1")).toBeNull();
  });

  it("W4-8: llm だが未ロード → 選択を維持する", () => {
    const check = makeCheck({
      models: [makeModel({ id: "model-1", type: "llm", state: "not-loaded" })],
    });
    expect(nextSelectedModelId(check, "model-1")).toBe("model-1");
  });

  it("W4-9: ロード済みの llm → 選択を維持する", () => {
    const check = makeCheck({
      models: [makeModel({ id: "model-1", type: "llm", state: "loaded" })],
    });
    expect(nextSelectedModelId(check, "model-1")).toBe("model-1");
  });

  it("保存済みの選択が無ければ null のまま", () => {
    const check = makeCheck({ models: [makeModel({ id: "model-1" })] });
    expect(nextSelectedModelId(check, null)).toBeNull();
  });

  it("ロード済みの vlm も維持する", () => {
    const check = makeCheck({
      models: [makeModel({ id: "model-1", type: "vlm", state: "loaded" })],
    });
    expect(nextSelectedModelId(check, "model-1")).toBe("model-1");
  });
});

describe("canStartWithModel", () => {
  it("W4-10: models に該当 ID が無いとき false（find の undefined で落ちない）", () => {
    const check = makeCheck({
      reachable: true,
      model: { id: "model-1", found: true, state: "loaded", loaded: true },
      models: [],
    });
    expect(canStartWithModel(check, "model-1")).toBe(false);
  });

  it("modelId が null なら false", () => {
    const check = makeCheck();
    expect(canStartWithModel(check, null)).toBe(false);
  });

  it("reachable が false なら false", () => {
    const check = makeCheck({
      reachable: false,
      error: { reason: "connection", message: "x" },
      model: { id: "model-1", found: true, state: "loaded", loaded: true },
      models: [makeModel({ id: "model-1", type: "llm", state: "loaded" })],
    });
    expect(canStartWithModel(check, "model-1")).toBe(false);
  });

  it("check.model.found が false なら false", () => {
    const check = makeCheck({
      model: { id: "model-1", found: false, state: null, loaded: false },
      models: [makeModel({ id: "model-1", type: "llm", state: "loaded" })],
    });
    expect(canStartWithModel(check, "model-1")).toBe(false);
  });

  it("種別が embeddings（ロード済みでも）なら false", () => {
    const check = makeCheck({
      model: { id: "model-1", found: true, state: "loaded", loaded: true },
      models: [makeModel({ id: "model-1", type: "embeddings", state: "loaded" })],
    });
    expect(canStartWithModel(check, "model-1")).toBe(false);
  });

  it("llm かつロード済みで、すべての条件を満たせば true", () => {
    const check = makeCheck({
      model: { id: "model-1", found: true, state: "loaded", loaded: true },
      models: [makeModel({ id: "model-1", type: "llm", state: "loaded" })],
    });
    expect(canStartWithModel(check, "model-1")).toBe(true);
  });
});
