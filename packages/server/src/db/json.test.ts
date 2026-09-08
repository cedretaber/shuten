import { describe, expect, it } from "vitest";
import { candidateLlmSchema, parseJsonColumn } from "./json.ts";

describe("parseJsonColumn", () => {
  it("J1: 未知のキーを含む JSON を読み戻すと、未知キーは捨てられる（llm）", () => {
    const raw = JSON.stringify({
      paragraphId: 0,
      quote: "誤字",
      before: "",
      after: "",
      category: "notation",
      reason: "テスト用の理由",
      suggestion: "修正案",
      verdict: "likely-error",
      // モデルの応答に含まれうる、スキーマにない余分なキー。
      extra: "unexpected",
    });

    const parsed = parseJsonColumn(candidateLlmSchema, raw, "candidates.llm");

    expect(parsed).toStrictEqual({
      paragraphId: 0,
      quote: "誤字",
      before: "",
      after: "",
      category: "notation",
      reason: "テスト用の理由",
      suggestion: "修正案",
      verdict: "likely-error",
    });
    expect(parsed).not.toHaveProperty("extra");
  });

  it("J2: 列挙にない category の JSON を読むと例外になる（黙って通さない）", () => {
    const raw = JSON.stringify({
      paragraphId: 0,
      quote: "誤字",
      before: "",
      after: "",
      category: "not-a-real-category",
      reason: "テスト用の理由",
      suggestion: null,
      verdict: "likely-error",
    });

    expect(() => parseJsonColumn(candidateLlmSchema, raw, "candidates.llm")).toThrow();
  });

  it("J3: 壊れた JSON 文字列を読むと例外になる", () => {
    const broken = "{not valid json";

    expect(() => parseJsonColumn(candidateLlmSchema, broken, "candidates.llm")).toThrow();
  });

  it("J4: 値が既に解析済み（drizzle の mode: json 由来）でも検証して返す", () => {
    const value = {
      paragraphId: 1,
      quote: "誤字",
      before: "",
      after: "",
      category: "grammar",
      reason: "テスト用の理由",
      suggestion: null,
      verdict: "confirm-with-author",
    };

    const parsed = parseJsonColumn(candidateLlmSchema, value, "candidates.llm");

    expect(parsed).toStrictEqual(value);
  });

  it("J5: 例外メッセージに列名が含まれる（どの列で落ちたか分かる）", () => {
    const broken = "{not valid json";

    expect(() => parseJsonColumn(candidateLlmSchema, broken, "candidates.llm")).toThrow(
      /candidates\.llm/,
    );
  });
});
