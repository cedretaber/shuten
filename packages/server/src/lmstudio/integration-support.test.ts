import { describe, expect, it } from "vitest";

import { isGenerationCapable, selectGenerationModelId } from "./integration-support.ts";
import type { ModelInfo } from "./types.ts";

/** テスト用に ModelInfo を組み立てる。id・type・state 以外は使わないので null で埋める。 */
function makeModel(id: string, type: string | null, state: string | null): ModelInfo {
  return {
    id,
    type,
    state,
    quantization: null,
    maxContextLength: null,
    loadedContextLength: null,
  };
}

describe("isGenerationCapable", () => {
  it("ロード済みの llm は true", () => {
    expect(isGenerationCapable(makeModel("m1", "llm", "loaded"))).toBe(true);
  });

  it("ロード済みの vlm は true", () => {
    expect(isGenerationCapable(makeModel("m1", "vlm", "loaded"))).toBe(true);
  });

  it("ロード済みの embeddings は false（生成に使えない種別）", () => {
    expect(isGenerationCapable(makeModel("m1", "embeddings", "loaded"))).toBe(false);
  });

  it("未ロードの llm は false", () => {
    expect(isGenerationCapable(makeModel("m1", "llm", "not-loaded"))).toBe(false);
  });

  it("state が null（欠けている）の llm は false", () => {
    expect(isGenerationCapable(makeModel("m1", "llm", null))).toBe(false);
  });
});

describe("selectGenerationModelId", () => {
  it("明示指定したモデルが未ロードなら null", () => {
    const models = [makeModel("m1", "llm", "not-loaded")];
    expect(selectGenerationModelId(models, "m1")).toBeNull();
  });

  it("明示指定したモデルが embeddings（生成に使えない種別）なら null", () => {
    const models = [makeModel("m1", "embeddings", "loaded")];
    expect(selectGenerationModelId(models, "m1")).toBeNull();
  });

  it("明示指定したモデルがロード済みの llm ならその ID", () => {
    const models = [makeModel("other", "llm", "loaded"), makeModel("m1", "llm", "loaded")];
    expect(selectGenerationModelId(models, "m1")).toBe("m1");
  });

  it("未指定で、ロード済みの llm・vlm が一覧にあれば先頭のその ID", () => {
    const models = [
      makeModel("embed-1", "embeddings", "loaded"),
      makeModel("llm-1", "llm", "loaded"),
      makeModel("vlm-1", "vlm", "loaded"),
    ];
    expect(selectGenerationModelId(models, undefined)).toBe("llm-1");
  });

  it("未指定で、生成に使えるモデルがなければ null", () => {
    const models = [
      makeModel("embed-1", "embeddings", "loaded"),
      makeModel("llm-1", "llm", "not-loaded"),
    ];
    expect(selectGenerationModelId(models, undefined)).toBeNull();
  });

  it("明示指定が空文字なら未指定と同じ扱いで自動選択に倒す", () => {
    const models = [makeModel("llm-1", "llm", "loaded")];
    expect(selectGenerationModelId(models, "")).toBe("llm-1");
  });

  it("明示指定したモデルが一覧に存在しなければ null", () => {
    const models = [makeModel("llm-1", "llm", "loaded")];
    expect(selectGenerationModelId(models, "not-in-list")).toBeNull();
  });
});
