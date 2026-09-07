import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  checkOutputJsonSchema,
  FINDING_CATEGORIES,
  INITIAL_VERDICTS,
  llmCheckOutputSchema,
  llmRecheckOutputSchema,
  RECHECK_REASON_KINDS,
  RECHECK_VERDICTS,
  recheckOutputJsonSchema,
} from "./schema.ts";

type JsonObject = Record<string, unknown>;

// 生成された JSON Schema をキー辿りで安全に読むためのヘルパー（any を使わない）。
function obj(value: unknown, ...path: string[]): JsonObject {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null)
      throw new Error(`オブジェクトではありません: ${path.join(".")}`);
    current = (current as JsonObject)[key];
  }
  if (typeof current !== "object" || current === null)
    throw new Error(`オブジェクトではありません: ${path.join(".")}`);
  return current as JsonObject;
}

// safeParse の data は if (result.success) の中でしか絞り込まれないための補助。
function parseOk<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

const V = {
  paragraphId: 0,
  quote: "吉野家",
  before: "",
  after: "へ",
  category: "notation",
  reason: "誤変換",
  suggestion: "吉野屋",
  verdict: "likely-error",
};

describe("llmCheckOutputSchema", () => {
  it("T1: 有効な指摘1件は成功しそのまま返る", () => {
    expect(parseOk(llmCheckOutputSchema, { findings: [V] })).toEqual({ findings: [V] });
  });

  it("T2: 空配列は成功する", () => {
    expect(parseOk(llmCheckOutputSchema, { findings: [] }).findings).toEqual([]);
  });

  it("T3: category が許可されていない値だと失敗する", () => {
    const result = llmCheckOutputSchema.safeParse({ findings: [{ ...V, category: "typo" }] });
    expect(result.success).toBe(false);
  });

  it("T4: quote が空文字だと失敗する", () => {
    const result = llmCheckOutputSchema.safeParse({ findings: [{ ...V, quote: "" }] });
    expect(result.success).toBe(false);
  });

  it("T5a: paragraphId が負数だと失敗する", () => {
    const result = llmCheckOutputSchema.safeParse({ findings: [{ ...V, paragraphId: -1 }] });
    expect(result.success).toBe(false);
  });

  it("T5b: paragraphId が小数だと失敗する", () => {
    const result = llmCheckOutputSchema.safeParse({ findings: [{ ...V, paragraphId: 1.5 }] });
    expect(result.success).toBe(false);
  });

  it("T5c: paragraphId が文字列だと失敗する", () => {
    const result = llmCheckOutputSchema.safeParse({ findings: [{ ...V, paragraphId: "1" }] });
    expect(result.success).toBe(false);
  });

  it("T6a: before キーがないと失敗する", () => {
    const { before: _before, ...rest } = V;
    const result = llmCheckOutputSchema.safeParse({ findings: [rest] });
    expect(result.success).toBe(false);
  });

  it("T6b: suggestion キーがないと失敗する（null は明示が必要）", () => {
    const { suggestion: _suggestion, ...rest } = V;
    const result = llmCheckOutputSchema.safeParse({ findings: [rest] });
    expect(result.success).toBe(false);
  });

  it("T7a: suggestion が空文字だと null に正規化される", () => {
    const result = parseOk(llmCheckOutputSchema, { findings: [{ ...V, suggestion: "" }] });
    expect(result.findings).toEqual([{ ...V, suggestion: null }]);
  });

  it("T7b: suggestion が null だとそのまま null になる", () => {
    const result = parseOk(llmCheckOutputSchema, { findings: [{ ...V, suggestion: null }] });
    expect(result.findings).toEqual([{ ...V, suggestion: null }]);
  });

  it("T7c: suggestion が半角空白のみだと null に正規化される", () => {
    const result = parseOk(llmCheckOutputSchema, { findings: [{ ...V, suggestion: " " }] });
    expect(result.findings).toEqual([{ ...V, suggestion: null }]);
  });

  it("T7d: suggestion が全角空白のみだと null に正規化される", () => {
    const result = parseOk(llmCheckOutputSchema, { findings: [{ ...V, suggestion: "　" }] });
    expect(result.findings).toEqual([{ ...V, suggestion: null }]);
  });

  it("T7e: suggestion の前後に空白があってもトリムされない", () => {
    const result = parseOk(llmCheckOutputSchema, { findings: [{ ...V, suggestion: " 吉野屋 " }] });
    expect(result.findings).toEqual([{ ...V, suggestion: " 吉野屋 " }]);
  });

  it("T8: 未知のキーは捨てられる", () => {
    const result = parseOk(llmCheckOutputSchema, { findings: [{ ...V, confidence: 0.9 }] });
    expect(result.findings).toEqual([V]);
    expect(Object.keys(result.findings[0] ?? {})).not.toContain("confidence");
  });

  it("T9a: JSON 文字列そのものは失敗する（パースされない）", () => {
    const result = llmCheckOutputSchema.safeParse('{"findings":[]}');
    expect(result.success).toBe(false);
  });

  it("T9b: null は失敗する", () => {
    const result = llmCheckOutputSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("T9c: findings が配列でないと失敗する", () => {
    const result = llmCheckOutputSchema.safeParse({ findings: "x" });
    expect(result.success).toBe(false);
  });

  it("T10: verdict が許可されていない値だと失敗する", () => {
    const result = llmCheckOutputSchema.safeParse({ findings: [{ ...V, verdict: "maybe" }] });
    expect(result.success).toBe(false);
  });

  it("T11: before と after が両方空文字でも成功する", () => {
    const result = llmCheckOutputSchema.safeParse({ findings: [{ ...V, before: "", after: "" }] });
    expect(result.success).toBe(true);
  });
});

describe("llmRecheckOutputSchema", () => {
  const R = {
    reason: "文脈上成立している",
    reasonKind: "intentional-expression",
    verdict: "withdraw",
    suggestionValid: false,
  };

  it("R1: 有効な応答は成功しそのまま返る", () => {
    expect(parseOk(llmRecheckOutputSchema, R)).toEqual(R);
  });

  it("R2: suggestion-inappropriate で suggestionValid が true だと失敗する", () => {
    const result = llmRecheckOutputSchema.safeParse({
      ...R,
      reasonKind: "suggestion-inappropriate",
      verdict: "confirm-with-author",
      suggestionValid: true,
    });
    expect(result.success).toBe(false);
  });

  it("R3: suggestion-inappropriate で suggestionValid が false かつ confirm-with-author なら成功する", () => {
    const result = llmRecheckOutputSchema.safeParse({
      ...R,
      reasonKind: "suggestion-inappropriate",
      verdict: "confirm-with-author",
      suggestionValid: false,
    });
    expect(result.success).toBe(true);
  });

  it("R4: reasonKind が許可されていない値だと失敗する", () => {
    const result = llmRecheckOutputSchema.safeParse({ ...R, reasonKind: "other" });
    expect(result.success).toBe(false);
  });

  it("R5: suggestionValid キーがないと失敗する", () => {
    const { suggestionValid: _suggestionValid, ...rest } = R;
    const result = llmRecheckOutputSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("R6: 未知のキーは捨てられる", () => {
    const result = parseOk(llmRecheckOutputSchema, { ...R, note: "x" });
    expect(Object.keys(result)).not.toContain("note");
  });

  it("R7: keep と error-confirmed の組は成功する", () => {
    const result = llmRecheckOutputSchema.safeParse({
      ...R,
      verdict: "keep",
      reasonKind: "error-confirmed",
      suggestionValid: true,
    });
    expect(result.success).toBe(true);
  });

  it("R8: suggestion-inappropriate で verdict が keep だと失敗する", () => {
    const result = llmRecheckOutputSchema.safeParse({
      ...R,
      reasonKind: "suggestion-inappropriate",
      verdict: "keep",
      suggestionValid: false,
    });
    expect(result.success).toBe(false);
  });

  it("R9: insufficient-context で verdict が confirm-with-author 以外だと失敗する", () => {
    const result = llmRecheckOutputSchema.safeParse({
      ...R,
      reasonKind: "insufficient-context",
      verdict: "withdraw",
      suggestionValid: true,
    });
    expect(result.success).toBe(false);
  });

  it("R10: insufficient-context で verdict が confirm-with-author なら成功する", () => {
    const result = llmRecheckOutputSchema.safeParse({
      ...R,
      reasonKind: "insufficient-context",
      verdict: "confirm-with-author",
      suggestionValid: true,
    });
    expect(result.success).toBe(true);
  });

  it("R11: intentional-expression は verdict との組み合わせを制約されない", () => {
    const result = llmRecheckOutputSchema.safeParse({
      ...R,
      reasonKind: "intentional-expression",
      verdict: "keep",
      suggestionValid: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("checkOutputJsonSchema", () => {
  const s = checkOutputJsonSchema();
  const items = obj(s, "properties", "findings", "items");

  it("J1: $schema を含まない", () => {
    expect("$schema" in s).toBe(false);
  });

  it("J1: トップレベルの型・additionalProperties・required が仕様通り", () => {
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["findings"]);
  });

  it("J1: findings プロパティは配列型", () => {
    expect(obj(s, "properties", "findings").type).toBe("array");
  });

  it("J1: items の additionalProperties は false", () => {
    expect(items.additionalProperties).toBe(false);
  });

  it("J1: items の required はキー順を保った全項目", () => {
    expect(items.required).toEqual([
      "paragraphId",
      "quote",
      "before",
      "after",
      "category",
      "reason",
      "suggestion",
      "verdict",
    ]);
  });

  it("J1: properties のキー順が required と一致する", () => {
    expect(Object.keys(obj(items, "properties"))).toEqual([
      "paragraphId",
      "quote",
      "before",
      "after",
      "category",
      "reason",
      "suggestion",
      "verdict",
    ]);
  });

  it("J1: paragraphId は maximum を持たない整数", () => {
    expect(obj(items, "properties", "paragraphId")).toEqual({ type: "integer", minimum: 0 });
  });

  it("J1: quote は minLength 1 の文字列", () => {
    expect(obj(items, "properties", "quote")).toEqual({ type: "string", minLength: 1 });
  });

  it("J1: suggestion は string または null", () => {
    expect(obj(items, "properties", "suggestion")).toEqual({ type: ["string", "null"] });
  });

  it("J1: category の enum が FINDING_CATEGORIES と一致する", () => {
    expect(obj(items, "properties", "category").enum).toEqual([...FINDING_CATEGORIES]);
  });

  it("J1: verdict の enum が INITIAL_VERDICTS と一致する", () => {
    expect(obj(items, "properties", "verdict").enum).toEqual([...INITIAL_VERDICTS]);
  });

  it("J1: before は素の文字列型", () => {
    expect(obj(items, "properties", "before")).toEqual({ type: "string" });
  });

  it("J2: JSON テキストへの往復で内容が変わらない", () => {
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("J4: JSON テキストを経由した入力も検証を通る", () => {
    const roundTripped = JSON.parse(JSON.stringify({ findings: [V] }));
    expect(llmCheckOutputSchema.safeParse(roundTripped).success).toBe(true);
  });
});

describe("recheckOutputJsonSchema", () => {
  const r = recheckOutputJsonSchema();

  it("J3: $schema を含まず additionalProperties は false", () => {
    expect("$schema" in r).toBe(false);
    expect(r.additionalProperties).toBe(false);
  });

  it("J3: required と properties のキー順が仕様通り", () => {
    const expected = ["reason", "reasonKind", "verdict", "suggestionValid"];
    expect(r.required).toEqual(expected);
    expect(Object.keys(obj(r, "properties"))).toEqual(expected);
  });

  it("J3: reasonKind の enum が RECHECK_REASON_KINDS と一致する", () => {
    expect(obj(r, "properties", "reasonKind").enum).toEqual([...RECHECK_REASON_KINDS]);
  });

  it("J3: verdict の enum が RECHECK_VERDICTS と一致する", () => {
    expect(obj(r, "properties", "verdict").enum).toEqual([...RECHECK_VERDICTS]);
  });

  it("J3: suggestionValid は boolean 型", () => {
    expect(obj(r, "properties", "suggestionValid")).toEqual({ type: "boolean" });
  });
});
