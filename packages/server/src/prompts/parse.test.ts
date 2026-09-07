import { describe, expect, it } from "vitest";

import { LmStudioError } from "../lmstudio/errors.ts";
import type { ChatResult, Usage } from "../lmstudio/types.ts";
import { parseCheckResponse, parseRecheckResponse } from "./parse.ts";

/** 有効な指摘 1 件（schema.test.ts の V と同じ形）。 */
const VALID_FINDING = {
  paragraphId: 0,
  quote: "吉野家",
  before: "",
  after: "へ",
  category: "notation",
  reason: "誤変換",
  suggestion: "吉野屋",
  verdict: "likely-error",
};

const VALID_USAGE: Usage = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  reasoningTokens: null,
};

/** テスト用に ChatResult を組み立てる。content 以外は既定値を持つ。 */
function makeResult(content: string, overrides?: Partial<ChatResult>): ChatResult {
  return {
    content,
    reasoningContent: null,
    finishReason: "stop",
    usage: VALID_USAGE,
    raw: { id: "chatcmpl-1" },
    ...overrides,
  };
}

function expectMalformed(fn: () => unknown): LmStudioError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LmStudioError);
    const error = err as LmStudioError;
    expect(error.kind).toBe("malformed");
    return error;
  }
  throw new Error("例外が投げられなかった");
}

describe("parseCheckResponse", () => {
  it("P1: 正常な JSON が LlmCheckOutput になる", () => {
    const result = makeResult(JSON.stringify({ findings: [VALID_FINDING] }));
    expect(parseCheckResponse(result)).toEqual({ findings: [VALID_FINDING] });
  });

  it("P2: suggestion の空文字・空白のみが null になる", () => {
    const result = makeResult(
      JSON.stringify({
        findings: [
          { ...VALID_FINDING, suggestion: "" },
          { ...VALID_FINDING, suggestion: "　 " },
        ],
      }),
    );
    const output = parseCheckResponse(result);
    expect(output.findings[0]?.suggestion).toBeNull();
    expect(output.findings[1]?.suggestion).toBeNull();
  });

  it("P3: 未知のキーが捨てられる", () => {
    const result = makeResult(
      JSON.stringify({ findings: [{ ...VALID_FINDING, extra: "unexpected" }] }),
    );
    const output = parseCheckResponse(result);
    expect(output.findings[0]).not.toHaveProperty("extra");
  });

  it("P4: 不正 JSON で LmStudioError（malformed）", () => {
    const result = makeResult("{not json");
    expectMalformed(() => parseCheckResponse(result));
  });

  it("P5: content が空文字で malformed（正常な空配列と混同しない）", () => {
    const result = makeResult("");
    expectMalformed(() => parseCheckResponse(result));
  });

  it("P6: トップレベルが配列で malformed", () => {
    const result = makeResult(JSON.stringify([VALID_FINDING]));
    expectMalformed(() => parseCheckResponse(result));
  });

  it("P7: 未知の category で malformed", () => {
    const result = makeResult(
      JSON.stringify({ findings: [{ ...VALID_FINDING, category: "typo" }] }),
    );
    expectMalformed(() => parseCheckResponse(result));
  });

  it("P8: 空引用（quote: ''）で malformed", () => {
    const result = makeResult(JSON.stringify({ findings: [{ ...VALID_FINDING, quote: "" }] }));
    expectMalformed(() => parseCheckResponse(result));
  });

  it("P8: 負の paragraphId で malformed", () => {
    const result = makeResult(
      JSON.stringify({ findings: [{ ...VALID_FINDING, paragraphId: -1 }] }),
    );
    expectMalformed(() => parseCheckResponse(result));
  });

  it("P8: 非整数の paragraphId で malformed", () => {
    const result = makeResult(
      JSON.stringify({ findings: [{ ...VALID_FINDING, paragraphId: 1.5 }] }),
    );
    expectMalformed(() => parseCheckResponse(result));
  });

  it("P9: JSON の前後に散文がある content（<think>…</think> を含む）は malformed。剥がさない", () => {
    const result = makeResult(
      `<think>考え中</think>${JSON.stringify({ findings: [VALID_FINDING] })} 以上です。`,
    );
    expectMalformed(() => parseCheckResponse(result));
  });

  it("P10: 例外に usage・finishReason・raw が載り、status が null", () => {
    const result = makeResult("{not json", {
      usage: VALID_USAGE,
      finishReason: "stop",
      raw: { marker: "P10-raw" },
    });
    const error = expectMalformed(() => parseCheckResponse(result));
    expect(error.usage).toEqual(VALID_USAGE);
    expect(error.finishReason).toBe("stop");
    expect(error.raw).toEqual({ marker: "P10-raw" });
    expect(error.status).toBeNull();
  });

  it("P11: 例外のメッセージに応答本文の断片が入らない（cause には入っていてよい）", () => {
    // JSON.parse の SyntaxError は不正な字句を含む位置からメッセージに切り出すことがある
    // （V8: `Unexpected token … "<断片>" is not valid JSON`）。断片が確実に出るよう、
    // 目印を JSON として無効な字句の先頭に置く。
    const marker = "SECRETMARK";
    const result = makeResult(`${marker} は正しい JSON ではない`);
    const error = expectMalformed(() => parseCheckResponse(result));
    expect(error.message).not.toContain(marker);
    expect(String(error.cause)).toContain(marker);
  });

  it("P16: findings: []（該当なし）は正常。空配列を失敗にしない", () => {
    const result = makeResult(JSON.stringify({ findings: [] }));
    expect(parseCheckResponse(result)).toEqual({ findings: [] });
  });

  it("スキーマ検証で失敗したときも、例外のメッセージに応答本文の値そのものは入らない", () => {
    // zod 4.5.4 の invalid_value メッセージは「期待する選択肢の列挙」であり、実際に渡した値は
    // 含まない（実測で確認済み）。ここではその前提を固定し、経路（path）だけがメッセージに
    // 現れることを確かめる。
    const marker = "LEAKMARKER";
    const result = makeResult(
      JSON.stringify({ findings: [{ ...VALID_FINDING, category: marker }] }),
    );
    const error = expectMalformed(() => parseCheckResponse(result));
    expect(error.message).not.toContain(marker);
    expect(error.message).toContain("findings.0.category");
  });
});

const VALID_RECHECK = {
  reason: "文法的に問題ない",
  reasonKind: "intentional-expression",
  verdict: "withdraw",
  suggestionValid: false,
};

describe("parseRecheckResponse", () => {
  it("P12: parseRecheckResponse の正常系", () => {
    const result = makeResult(JSON.stringify(VALID_RECHECK));
    expect(parseRecheckResponse(result)).toEqual(VALID_RECHECK);
  });

  it("P13: 未知の reasonKind で malformed", () => {
    const result = makeResult(JSON.stringify({ ...VALID_RECHECK, reasonKind: "other-reason" }));
    expectMalformed(() => parseRecheckResponse(result));
  });

  it("P14: suggestion-inappropriate かつ suggestionValid: true で malformed", () => {
    const result = makeResult(
      JSON.stringify({
        reason: "修正案が不適切",
        reasonKind: "suggestion-inappropriate",
        verdict: "confirm-with-author",
        suggestionValid: true,
      }),
    );
    expectMalformed(() => parseRecheckResponse(result));
  });

  it("P15: insufficient-context かつ verdict: 'keep' で malformed", () => {
    const result = makeResult(
      JSON.stringify({
        reason: "文脈が不足",
        reasonKind: "insufficient-context",
        verdict: "keep",
        suggestionValid: false,
      }),
    );
    expectMalformed(() => parseRecheckResponse(result));
  });
});
