import { describe, expect, it } from "vitest";

import type { ChatRequest } from "./types.ts";
import { findErrorMarker, parseChatCompletion, parseModelList, toWireChatBody } from "./wire.ts";

const baseRequest: ChatRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
  maxTokens: 16000,
  temperature: 0,
};

describe("toWireChatBody", () => {
  it("stream: false を常に入れる", () => {
    const body = toWireChatBody(baseRequest);
    expect(body.stream).toBe(false);
  });

  it("model・messages・max_tokens・temperature をそのまま写す", () => {
    const body = toWireChatBody(baseRequest);
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body.max_tokens).toBe(16000);
    expect(body.temperature).toBe(0);
  });

  it("seed: 0 と temperature: 0 でもキーが出る（falsy 判定にしない）", () => {
    const body = toWireChatBody({ ...baseRequest, temperature: 0, seed: 0 });
    expect(body).toHaveProperty("seed", 0);
    expect(body).toHaveProperty("temperature", 0);
  });

  it("未指定なら seed・reasoning_effort・response_format のキーが出ない", () => {
    const body = toWireChatBody(baseRequest);
    expect(body).not.toHaveProperty("seed");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("response_format");
  });

  it("reasoning_effort がトップレベルに出る", () => {
    const body = toWireChatBody({ ...baseRequest, reasoningEffort: "none" });
    expect(body.reasoning_effort).toBe("none");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("response_format.json_schema.strict が true になる", () => {
    const body = toWireChatBody({
      ...baseRequest,
      responseFormat: { name: "findings", schema: { type: "object" } },
    });
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "findings",
        strict: true,
        schema: { type: "object" },
      },
    });
  });
});

describe("parseModelList", () => {
  it("data の各要素を ModelInfo に変換する", () => {
    const models = parseModelList({
      data: [
        {
          id: "model-a",
          type: "llm",
          state: "loaded",
          quantization: "Q4_K_M",
          max_context_length: 8192,
          loaded_context_length: 4096,
        },
      ],
    });
    expect(models).toEqual([
      {
        id: "model-a",
        type: "llm",
        state: "loaded",
        quantization: "Q4_K_M",
        maxContextLength: 8192,
        loadedContextLength: 4096,
      },
    ]);
  });

  it("欠けた項目は null にする", () => {
    const models = parseModelList({ data: [{ id: "model-a" }] });
    expect(models).toEqual([
      {
        id: "model-a",
        type: null,
        state: null,
        quantization: null,
        maxContextLength: null,
        loadedContextLength: null,
      },
    ]);
  });

  it("id が文字列でない要素はその要素だけ捨てる", () => {
    const models = parseModelList({
      data: [{ id: "ok" }, { id: 123 }, { id: "ok-2" }],
    });
    expect(models?.map((m) => m.id)).toEqual(["ok", "ok-2"]);
  });

  it("data が配列でなければ null", () => {
    expect(parseModelList({ data: "not-array" })).toBeNull();
    expect(parseModelList({})).toBeNull();
    expect(parseModelList(null)).toBeNull();
    expect(parseModelList("not-object")).toBeNull();
  });
});

const validCompletion = {
  choices: [
    {
      finish_reason: "stop",
      message: { content: "answer", reasoning_content: "thinking" },
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    completion_tokens_details: { reasoning_tokens: 3 },
  },
};

describe("parseChatCompletion", () => {
  it("正常な応答を解析する", () => {
    const parsed = parseChatCompletion(validCompletion);
    expect(parsed).toEqual({
      finishReason: "stop",
      content: "answer",
      reasoningContent: "thinking",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        reasoningTokens: 3,
      },
    });
  });

  it("usage が欠落していれば usage: null（解析自体は成功する）", () => {
    const parsed = parseChatCompletion({
      choices: [{ finish_reason: "stop", message: { content: "answer" } }],
    });
    expect(parsed?.usage).toBeNull();
  });

  it("usage の一部が欠落・非数値なら usage: null", () => {
    const missingField = parseChatCompletion({
      choices: [{ finish_reason: "stop", message: { content: "a" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    expect(missingField?.usage).toBeNull();

    const nonNumeric = parseChatCompletion({
      choices: [{ finish_reason: "stop", message: { content: "a" } }],
      usage: { prompt_tokens: "1", completion_tokens: 2, total_tokens: 3 },
    });
    expect(nonNumeric?.usage).toBeNull();
  });

  it("completion_tokens_details が欠落していれば reasoningTokens は null", () => {
    const parsed = parseChatCompletion({
      choices: [{ finish_reason: "stop", message: { content: "a" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(parsed?.usage?.reasoningTokens).toBeNull();
  });

  it("reasoning_content が欠落していれば reasoningContent は null", () => {
    const parsed = parseChatCompletion({
      choices: [{ finish_reason: "stop", message: { content: "a" } }],
    });
    expect(parsed?.reasoningContent).toBeNull();
  });

  it("reasoning_content が空文字ならそのまま空文字（null にしない）", () => {
    const parsed = parseChatCompletion({
      choices: [{ finish_reason: "stop", message: { content: "a", reasoning_content: "" } }],
    });
    expect(parsed?.reasoningContent).toBe("");
  });

  it("choices が空配列なら null", () => {
    expect(parseChatCompletion({ choices: [] })).toBeNull();
  });

  it("choices[0].message が欠落していれば null", () => {
    expect(parseChatCompletion({ choices: [{ finish_reason: "stop" }] })).toBeNull();
  });

  it("finish_reason が欠落・null なら null", () => {
    expect(parseChatCompletion({ choices: [{ message: { content: "a" } }] })).toBeNull();
    expect(
      parseChatCompletion({ choices: [{ finish_reason: null, message: { content: "a" } }] }),
    ).toBeNull();
  });

  it("content が null でも ParsedCompletion は返る", () => {
    const parsed = parseChatCompletion({
      choices: [{ finish_reason: "stop", message: { content: null } }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.content).toBeNull();
  });

  it("choices が 2 件あれば [0] を使う", () => {
    const parsed = parseChatCompletion({
      choices: [
        { finish_reason: "stop", message: { content: "first" } },
        { finish_reason: "length", message: { content: "second" } },
      ],
    });
    expect(parsed?.content).toBe("first");
    expect(parsed?.finishReason).toBe("stop");
  });

  it("finish_reason が length でもそのまま返す（truncated への分類は client.ts の責務）", () => {
    const parsed = parseChatCompletion({
      choices: [{ finish_reason: "length", message: { content: "cut off" } }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.finishReason).toBe("length");
  });
});

describe("findErrorMarker", () => {
  it.each([
    ["No models loaded", "model-not-loaded"],
    ["Model unloaded by user or API request.", "model-not-loaded"],
    ["maximum context length", "input-too-long"],
  ] as const)("%s から %s を検出する", (text, expected) => {
    expect(findErrorMarker(text)).toBe(expected);
  });

  it("大文字小文字を無視する", () => {
    expect(findErrorMarker("NO MODELS LOADED")).toBe("model-not-loaded");
    expect(findErrorMarker("MAXIMUM CONTEXT LENGTH EXCEEDED")).toBe("input-too-long");
  });

  it("両方の印が一致した場合は model-not-loaded を優先する", () => {
    expect(findErrorMarker("unloaded: maximum context length exceeded")).toBe("model-not-loaded");
  });

  it("印がなければ null", () => {
    expect(findErrorMarker("internal server error")).toBeNull();
  });
});
