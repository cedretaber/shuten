import { describe, expect, it } from "vitest";
import { isGenerationCapable, LOADED_STATE } from "./model-capability.ts";

describe("LOADED_STATE", () => {
  it("値は loaded", () => {
    expect(LOADED_STATE).toBe("loaded");
  });
});

describe("isGenerationCapable", () => {
  it("state が loaded、type が llm なら true", () => {
    expect(isGenerationCapable({ state: "loaded", type: "llm" })).toBe(true);
  });

  it("state が loaded、type が vlm なら true", () => {
    expect(isGenerationCapable({ state: "loaded", type: "vlm" })).toBe(true);
  });

  it("state が loaded でも type が embeddings なら false", () => {
    expect(isGenerationCapable({ state: "loaded", type: "embeddings" })).toBe(false);
  });

  it("type が llm でも state が not-loaded なら false", () => {
    expect(isGenerationCapable({ state: "not-loaded", type: "llm" })).toBe(false);
  });

  it("state が null なら false", () => {
    expect(isGenerationCapable({ state: null, type: "llm" })).toBe(false);
  });

  it("type が null なら false", () => {
    expect(isGenerationCapable({ state: "loaded", type: null })).toBe(false);
  });

  it("未知の state（loading）なら false", () => {
    expect(isGenerationCapable({ state: "loading", type: "llm" })).toBe(false);
  });
});
