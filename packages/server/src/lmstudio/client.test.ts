import { createServer, type Server } from "node:http";

import { Agent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLmStudioClient, DEFAULT_MODEL_LIST_TIMEOUT_MS } from "./client.ts";
import { LmStudioError } from "./errors.ts";
import type { ChatRequest } from "./types.ts";
import { LOADED_STATE } from "./types.ts";

const BASE_URL = "http://lmstudio.test:1234";
const SECRET_API_KEY = "sk-this-is-a-secret-token";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function makeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const resolvedInit = init ?? {};
    calls.push({ url, init: resolvedInit });
    return handler(url, resolvedInit);
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

/** 呼び出し元が中断するかタイムアウトするまで一切解決しない `fetch`（共通レシピ）。 */
const hangingFetch = ((_input: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(init.signal?.reason);
    });
  })) as unknown as typeof globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

/** `response.text()` が reject する疑似 Response（C16d・L4 用）。 */
function rejectingTextResponse(status: number): Response {
  const response = new Response("", { status });
  vi.spyOn(response, "text").mockRejectedValue(new Error("body stream broken"));
  return response;
}

/**
 * 応答ヘッダーはすぐ返るが、`text()` は呼び出し元に渡された `AbortSignal`（`sendRequest` 内の
 * 内部コントローラ）が中断されるまで解決しない疑似 Response（L2 用）。
 * タイムアウトで `fetch` 自体が中断される C19 とは異なり、本文読み取り中の中断を再現する。
 */
function hangingBodyResponse(status: number, signal: AbortSignal | undefined): Response {
  const response = new Response("", { status });
  vi.spyOn(response, "text").mockImplementation(
    () =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(signal.reason);
        });
      }),
  );
  return response;
}

const baseChatRequest: ChatRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
  maxTokens: 100,
  temperature: 0.5,
};

function successBody(
  overrides?: Partial<{
    finishReason: string | null | undefined;
    content: unknown;
    usage: unknown;
    omitMessage: boolean;
    omitFinishReason: boolean;
    extraChoice: boolean;
  }>,
): Record<string, unknown> {
  // `??` は null も置き換えてしまうため、"content" in overrides で明示的に指定されたかどうかを見る
  // （C12 の content: null、C34b の finishReason: null を「未指定」と誤認しないため）。
  const hasOwn = (key: string): boolean => overrides !== undefined && key in overrides;

  const message: Record<string, unknown> = {
    content: hasOwn("content") ? overrides?.content : "hi",
    reasoning_content: "thinking",
  };

  const firstChoice: Record<string, unknown> = {};
  if (overrides?.omitFinishReason !== true) {
    firstChoice.finish_reason = hasOwn("finishReason") ? overrides?.finishReason : "stop";
  }
  if (overrides?.omitMessage !== true) {
    firstChoice.message = message;
  }

  const choices: unknown[] = [firstChoice];
  if (overrides?.extraChoice === true) {
    choices.push({ finish_reason: "other", message: { content: "second" } });
  }

  return {
    choices,
    usage: hasOwn("usage")
      ? overrides?.usage
      : {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 5 },
        },
  };
}

async function catchLmStudioError(promise: Promise<unknown>): Promise<LmStudioError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof LmStudioError) {
      return err;
    }
    throw err;
  }
  throw new Error("例外が発生しなかった");
}

function firstCall(calls: FetchCall[]): FetchCall {
  const call = calls[0];
  if (call === undefined) {
    throw new Error("fetch が呼ばれていない");
  }
  return call;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("chat: 送信先・ヘッダー", () => {
  it("C1 API キーなしなら authorization ヘッダーを付けない", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, successBody()));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    await client.chat(baseChatRequest, { timeoutMs: 1000 });

    const call = firstCall(calls);
    expect(call.url).toBe(`${BASE_URL}/v1/chat/completions`);
    const headers = new Headers(call.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBeNull();
  });

  it("C2 API キーありなら authorization: Bearer k が 1 つだけ付く", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, successBody()));
    const client = createLmStudioClient({ baseUrl: BASE_URL, apiKey: "k", fetch: fetchImpl });
    await client.chat(baseChatRequest, { timeoutMs: 1000 });

    const headers = new Headers(firstCall(calls).init.headers);
    expect(headers.get("authorization")).toBe("Bearer k");
  });

  it("C3 baseUrl の末尾スラッシュを 1 個・2 個とも除去する", async () => {
    for (const baseUrl of [`${BASE_URL}/`, `${BASE_URL}//`]) {
      const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, successBody()));
      const client = createLmStudioClient({ baseUrl, fetch: fetchImpl });
      await client.chat(baseChatRequest, { timeoutMs: 1000 });
      expect(firstCall(calls).url).toBe(`${BASE_URL}/v1/chat/completions`);
    }
  });

  it("C45 API キーが空白のみなら authorization を付けない", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, successBody()));
    const client = createLmStudioClient({ baseUrl: BASE_URL, apiKey: "   ", fetch: fetchImpl });
    await client.chat(baseChatRequest, { timeoutMs: 1000 });

    const headers = new Headers(firstCall(calls).init.headers);
    expect(headers.get("authorization")).toBeNull();
  });
});

describe("chat: 送信本文（toWireChatBody との橋渡し）", () => {
  it("C4 最小要求は stream:false のみで seed・reasoning_effort・response_format を含まない", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, successBody()));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    await client.chat(baseChatRequest, { timeoutMs: 1000 });

    const body = JSON.parse(String(firstCall(calls).init.body)) as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body).not.toHaveProperty("seed");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("response_format");
  });

  it("C5 全項目指定で reasoning_effort がトップレベル、response_format.json_schema.strict が true", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, successBody()));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const request: ChatRequest = {
      ...baseChatRequest,
      seed: 42,
      reasoningEffort: "high",
      responseFormat: { name: "findings", schema: { type: "object" } },
    };
    await client.chat(request, { timeoutMs: 1000 });

    const body = JSON.parse(String(firstCall(calls).init.body)) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("high");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "findings", strict: true, schema: { type: "object" } },
    });
  });

  it("C31 seed: 0 と temperature: 0 でもキーが出る（falsy 判定にしない）", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, successBody()));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const request: ChatRequest = { ...baseChatRequest, seed: 0, temperature: 0 };
    await client.chat(request, { timeoutMs: 1000 });

    const body = JSON.parse(String(firstCall(calls).init.body)) as Record<string, unknown>;
    expect(Object.hasOwn(body, "seed")).toBe(true);
    expect(body.seed).toBe(0);
    expect(body.temperature).toBe(0);
  });
});

describe("chat: 正常応答の解析", () => {
  it("C6 content・reasoningContent・finishReason・usage・raw を返す", async () => {
    const body = successBody();
    const { fetchImpl } = makeFetch(() => jsonResponse(200, body));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const result = await client.chat(baseChatRequest, { timeoutMs: 1000 });

    expect(result.content).toBe("hi");
    expect(result.reasoningContent).toBe("thinking");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      reasoningTokens: 5,
    });
    expect(result.raw).toEqual(body);
  });

  it("C7 usage が欠けても成功として usage: null を返す", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(200, successBody({ usage: undefined })));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const result = await client.chat(baseChatRequest, { timeoutMs: 1000 });
    expect(result.usage).toBeNull();
  });

  it("C8 completion_tokens_details が欠けても usage は非 null で reasoningTokens が null", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(
        200,
        successBody({
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      ),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const result = await client.chat(baseChatRequest, { timeoutMs: 1000 });
    expect(result.usage).not.toBeNull();
    expect(result.usage?.reasoningTokens).toBeNull();
  });

  it("C33 reasoning_content がない応答は reasoningContent が null（空文字と区別する）", async () => {
    const body = successBody();
    const choices = body.choices as Array<Record<string, unknown>>;
    const message = choices[0]?.message as Record<string, unknown>;
    delete message.reasoning_content;
    const { fetchImpl } = makeFetch(() => jsonResponse(200, body));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const result = await client.chat(baseChatRequest, { timeoutMs: 1000 });
    expect(result.reasoningContent).toBeNull();
  });

  it("C37 choices が 2 件あれば [0] を使う", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(200, successBody({ extraChoice: true })));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const result = await client.chat(baseChatRequest, { timeoutMs: 1000 });
    expect(result.content).toBe("hi");
    expect(result.finishReason).toBe("stop");
  });
});

describe("chat: truncated（finish_reason: length）", () => {
  it("C9 finish_reason が length なら truncated。usage と raw は非 null", async () => {
    const body = successBody({ finishReason: "length" });
    const { fetchImpl } = makeFetch(() => jsonResponse(200, body));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("truncated");
    expect(error.usage).not.toBeNull();
    expect(error.raw).not.toBeNull();
  });

  it("C38 finish_reason が length で content が null でも truncated（malformed にしない）", async () => {
    const body = successBody({ finishReason: "length", content: null });
    const { fetchImpl } = makeFetch(() => jsonResponse(200, body));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("truncated");
  });

  it("C47 finish_reason が length で message ごと欠落していても truncated。usage は非 null（決定 6）", async () => {
    const body = successBody({ finishReason: "length", omitMessage: true });
    const { fetchImpl } = makeFetch(() => jsonResponse(200, body));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("truncated");
    expect(error.usage).not.toBeNull();
  });
});

describe("chat: malformed", () => {
  it("C10 本文が JSON でないなら malformed", async () => {
    const { fetchImpl } = makeFetch(() => textResponse(200, "not json"));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("malformed");
  });

  it("L3 truncateRaw は JSON として解析できない長い本文を raw の先頭 2,000 文字に切り詰める", async () => {
    const longText = "あ".repeat(2500);
    const { fetchImpl } = makeFetch(() => textResponse(200, longText));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("malformed");
    expect(error.raw).toBe(longText.slice(0, 2000));
    expect(typeof error.raw).toBe("string");
    expect((error.raw as string).length).toBe(2000);
  });

  it("C11 choices が空配列なら malformed", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(200, { choices: [] }));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("malformed");
  });

  it("C12 message.content が null なら malformed", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(200, successBody({ content: null })));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("malformed");
  });

  it("C34a finish_reason がない 200 応答は malformed", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(200, successBody({ omitFinishReason: true })),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("malformed");
  });

  it("C34b finish_reason が null の 200 応答は malformed", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(200, successBody({ finishReason: null })));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("malformed");
  });

  it("C35a usage の total_tokens が欠けていれば usage は null（成功応答としては malformed にしない）", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(200, successBody({ usage: { prompt_tokens: 1, completion_tokens: 2 } })),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const result = await client.chat(baseChatRequest, { timeoutMs: 1000 });
    expect(result.usage).toBeNull();
  });

  it("C35b usage の total_tokens が数値でなければ usage は null", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(
        200,
        successBody({
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: "3" },
        }),
      ),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const result = await client.chat(baseChatRequest, { timeoutMs: 1000 });
    expect(result.usage).toBeNull();
  });

  it("C36 choices[0].message がなければ malformed", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(200, successBody({ omitMessage: true })));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("malformed");
  });

  it("C48 finish_reason が stop で message ごと欠落していれば malformed のまま", async () => {
    const body = successBody({ finishReason: "stop", omitMessage: true });
    const { fetchImpl } = makeFetch(() => jsonResponse(200, body));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("malformed");
  });
});

describe("chat: HTTP 状態と error マーカーによる分類", () => {
  it("C13 HTTP 500 は connection、status は 500", async () => {
    const { fetchImpl } = makeFetch(() => textResponse(500, "internal error"));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("connection");
    expect(error.status).toBe(500);
  });

  it("C14 HTTP 400 {error: No models loaded} は model-not-loaded", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(400, { error: "No models loaded" }));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("model-not-loaded");
  });

  it("C15 HTTP 400 {error: ...maximum context length...} は input-too-long", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(400, { error: "Trimmed prompt exceeds the maximum context length" }),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("input-too-long");
  });

  it("C16 HTTP 404、本文に印がなければ connection、status は 404", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(404, { error: "not found" }));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("connection");
    expect(error.status).toBe(404);
  });

  it("C16b HTTP 400 {error: Model unloaded by user or API request.} は model-not-loaded", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(400, { error: "Model unloaded by user or API request." }),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("model-not-loaded");
  });

  it("C16c HTTP 200 でも本文が {error: Model unloaded...} なら model-not-loaded（状態に依存しない）", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(200, { error: "Model unloaded by user or API request." }),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("model-not-loaded");
  });

  it("C16d response.text() が reject したら connection", async () => {
    const { fetchImpl } = makeFetch(() => rejectingTextResponse(200));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("connection");
  });

  it("L4 応答ヘッダー受信後に本文読み取り中で切断されると connection・status は null（HTTP 応答の有無を status で区別する前提）", async () => {
    const { fetchImpl } = makeFetch(() => rejectingTextResponse(200));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("connection");
    expect(error.status).toBeNull();
  });

  it("C17 fetch が TypeError(fetch failed) で reject したら connection", async () => {
    const fetchImpl = (() =>
      Promise.reject(new TypeError("fetch failed"))) as unknown as typeof globalThis.fetch;
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("connection");
  });

  it("C39 未ロードの印と文脈長超過の印が両方あれば model-not-loaded を優先する", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(400, { error: "No models loaded: maximum context length exceeded" }),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
    expect(error.kind).toBe("model-not-loaded");
  });
});

describe("chat: 中断とタイムアウト", () => {
  it("C18 呼び出し元の signal を中断すると aborted になる", async () => {
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: hangingFetch });
    const controller = new AbortController();
    const promise = client.chat(baseChatRequest, { timeoutMs: 5000, signal: controller.signal });
    const assertion = expect(promise).rejects.toMatchObject({ kind: "aborted" });
    controller.abort();
    await assertion;
  });

  it("C19 timeoutMs を過ぎると timeout になる", async () => {
    vi.useFakeTimers();
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: hangingFetch });
    const promise = client.chat(baseChatRequest, { timeoutMs: 1000 });
    const assertion = expect(promise).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("L2 応答ヘッダー受信後、本文読み取り中に timeoutMs を過ぎても timeout になる（C19 は fetch 自体の中断）", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = makeFetch((_url, init) =>
      hangingBodyResponse(200, init.signal ?? undefined),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const promise = client.chat(baseChatRequest, { timeoutMs: 1000 });
    const assertion = expect(promise).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("C20 タイムアウト待ちの最中に呼び出し元が中断すると aborted になる（timeout にしない）", async () => {
    vi.useFakeTimers();
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: hangingFetch });
    const controller = new AbortController();
    const promise = client.chat(baseChatRequest, { timeoutMs: 5000, signal: controller.signal });
    const assertion = expect(promise).rejects.toMatchObject({ kind: "aborted" });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await assertion;
  });

  it("C21 正常終了後にタイマーが残らない", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = makeFetch(() => jsonResponse(200, successBody()));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    await client.chat(baseChatRequest, { timeoutMs: 1000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("C32 既に中断済みの signal を渡すと aborted になり、fetch は呼ばれない", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, successBody()));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const controller = new AbortController();
    controller.abort();
    const error = await catchLmStudioError(
      client.chat(baseChatRequest, { timeoutMs: 1000, signal: controller.signal }),
    );
    expect(error.kind).toBe("aborted");
    expect(calls).toHaveLength(0);
  });

  it("C44 timeoutMs が 0・負・Infinity・非整数なら TypeError", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(200, successBody()));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    for (const invalid of [0, -1, Infinity, 1.5, -Infinity, NaN]) {
      await expect(client.chat(baseChatRequest, { timeoutMs: invalid })).rejects.toBeInstanceOf(
        TypeError,
      );
    }
  });
});

describe("chat: API キーが例外に漏れない", () => {
  it("C30 truncated・connection(500)・connection(fetch reject) のいずれの経路でも API キーが漏れない", async () => {
    const truncatedFetch = makeFetch(() =>
      jsonResponse(200, successBody({ finishReason: "length" })),
    ).fetchImpl;
    const httpErrorFetch = makeFetch(() => textResponse(500, "internal error")).fetchImpl;
    const rejectFetch = (() =>
      Promise.reject(new TypeError("fetch failed"))) as unknown as typeof globalThis.fetch;

    const errors = await Promise.all(
      [truncatedFetch, httpErrorFetch, rejectFetch].map(async (fetchImpl) => {
        const client = createLmStudioClient({
          baseUrl: BASE_URL,
          apiKey: SECRET_API_KEY,
          fetch: fetchImpl,
        });
        return catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
      }),
    );

    for (const error of errors) {
      expect(error.message).not.toContain(SECRET_API_KEY);
      expect(JSON.stringify(error)).not.toContain(SECRET_API_KEY);
      expect(String(error.stack)).not.toContain(SECRET_API_KEY);
      expect(JSON.stringify(error.raw)).not.toContain(SECRET_API_KEY);
    }
  });
});

function modelListBody(data: unknown[]): Record<string, unknown> {
  return { data };
}

describe("listModels", () => {
  it("C22 GET /api/v0/models に送る", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, modelListBody([])));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    await client.listModels();
    const call = firstCall(calls);
    expect(call.url).toBe(`${BASE_URL}/api/v0/models`);
    expect((call.init.method ?? "GET").toUpperCase()).toBe("GET");
  });

  it("C23 state・quantization・maxContextLength・loadedContextLength を解析する", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(
        200,
        modelListBody([
          {
            id: "m1",
            type: "llm",
            state: "loaded",
            quantization: "Q4_K_M",
            max_context_length: 8192,
            loaded_context_length: 4096,
          },
        ]),
      ),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const models = await client.listModels();
    expect(models).toEqual([
      {
        id: "m1",
        type: "llm",
        state: "loaded",
        quantization: "Q4_K_M",
        maxContextLength: 8192,
        loadedContextLength: 4096,
      },
    ]);
  });

  it("C24 欠けた項目は null になり例外にならない", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(200, modelListBody([{ id: "m1" }])));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const models = await client.listModels();
    expect(models).toEqual([
      {
        id: "m1",
        type: null,
        state: null,
        quantization: null,
        maxContextLength: null,
        loadedContextLength: null,
      },
    ]);
  });

  it("C40 HTTP 500 は connection", async () => {
    const { fetchImpl } = makeFetch(() => textResponse(500, "internal error"));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.listModels());
    expect(error.kind).toBe("connection");
    expect(error.status).toBe(500);
  });

  it("C41 本文が JSON でない、または data が配列でなければ malformed", async () => {
    const notJsonFetch = makeFetch(() => textResponse(200, "not json")).fetchImpl;
    const client1 = createLmStudioClient({ baseUrl: BASE_URL, fetch: notJsonFetch });
    const error1 = await catchLmStudioError(client1.listModels());
    expect(error1.kind).toBe("malformed");

    const notArrayFetch = makeFetch(() => jsonResponse(200, { data: "nope" })).fetchImpl;
    const client2 = createLmStudioClient({ baseUrl: BASE_URL, fetch: notArrayFetch });
    const error2 = await catchLmStudioError(client2.listModels());
    expect(error2.kind).toBe("malformed");
  });

  it("C42 id が数値の要素だけ捨てて他は返す", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(200, modelListBody([{ id: 123 }, { id: "ok" }])),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const models = await client.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("ok");
  });

  it("C46 type がある要素・ない要素でそれぞれ値・null になる", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(200, modelListBody([{ id: "a", type: "llm" }, { id: "b" }])),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const models = await client.listModels();
    expect(models.find((m) => m.id === "a")?.type).toBe("llm");
    expect(models.find((m) => m.id === "b")?.type).toBeNull();
  });

  it("C29 listModels のタイムアウト（既定 10 秒を明示指定で短縮）", async () => {
    vi.useFakeTimers();
    expect(DEFAULT_MODEL_LIST_TIMEOUT_MS).toBe(10_000);
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: hangingFetch });
    const promise = client.listModels({ timeoutMs: 500 });
    const assertion = expect(promise).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("L1 timeoutMs を渡さないと既定の 10 秒（DEFAULT_MODEL_LIST_TIMEOUT_MS）ちょうどで timeout になる", async () => {
    vi.useFakeTimers();
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: hangingFetch });
    const promise = client.listModels();
    const assertion = expect(promise).rejects.toMatchObject({ kind: "timeout" });
    // 既定値の 1ms 手前ではまだタイムアウトしていないことを確認してから、既定値ちょうどまで進める。
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_LIST_TIMEOUT_MS - 1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

describe("ensureLoaded", () => {
  it("C25 未知の state（loading）は一覧としては成功するが ensureLoaded は model-not-loaded", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(200, modelListBody([{ id: "m1", state: "loading" }])),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const models = await client.listModels();
    expect(models).toHaveLength(1);

    const error = await catchLmStudioError(client.ensureLoaded("m1"));
    expect(error.kind).toBe("model-not-loaded");
  });

  it("C26 ロード済みなら ModelInfo を返す", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(200, modelListBody([{ id: "m1", state: LOADED_STATE }])),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const model = await client.ensureLoaded("m1");
    expect(model.id).toBe("m1");
    expect(model.state).toBe(LOADED_STATE);
  });

  it("C27 not-loaded なら model-not-loaded", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(200, modelListBody([{ id: "m1", state: "not-loaded" }])),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.ensureLoaded("m1"));
    expect(error.kind).toBe("model-not-loaded");
  });

  it("C28 一覧に id がなければ model-not-loaded", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(200, modelListBody([{ id: "other", state: LOADED_STATE }])),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.ensureLoaded("m1"));
    expect(error.kind).toBe("model-not-loaded");
  });

  it("C43 listModels の失敗（connection）をそのまま伝播する（model-not-loaded にしない）", async () => {
    const { fetchImpl } = makeFetch(() => textResponse(500, "internal error"));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.ensureLoaded("m1"));
    expect(error.kind).toBe("connection");
  });
});

describe("dispatcher（undici のタイムアウト無効化）", () => {
  it("C44 既定のクライアントは listModels の init に dispatcher を渡す", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, modelListBody([])));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    await client.listModels();
    expect(firstCall(calls).init.dispatcher).toBeDefined();
  });

  it("C45 既定のクライアントは chat の init に dispatcher を渡す", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, successBody()));
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    await client.chat(baseChatRequest, { timeoutMs: 1000 });
    expect(firstCall(calls).init.dispatcher).toBeDefined();
  });

  it("C46 options.dispatcher を渡すとそれが listModels と chat の両方で使われる", async () => {
    const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    try {
      const { fetchImpl, calls } = makeFetch((url) =>
        url.endsWith("/api/v0/models")
          ? jsonResponse(200, modelListBody([]))
          : jsonResponse(200, successBody()),
      );
      const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl, dispatcher });
      await client.listModels();
      await client.chat(baseChatRequest, { timeoutMs: 1000 });
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.init.dispatcher).toBe(dispatcher);
      }
    } finally {
      await dispatcher.close();
    }
  });
});

describe("dispatcher: 実 HTTP サーバーでの回帰", () => {
  /**
   * 応答ヘッダーを遅らせるローカルサーバー。生成完了までヘッダーが来ない状況の縮小版。
   * undici のタイマーは約 500ms 刻みで、`headersTimeout` に 1 秒未満を指定しても発火は
   * 1 秒前後になる。遅延を縮めると C47 が先に成功してしまうので、この値は小さくしないこと。
   * C49 はこの遅延より十分短い `timeoutMs`（500ms）を指定して自前タイマーの方が先に効くことを見るので、
   * ここも縮めると C49 の判別力が失われる。
   */
  const HEADER_DELAY_MS = 2000;
  let server: Server | null = null;
  let baseUrl = "";

  beforeEach(async () => {
    const created = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "m1", state: LOADED_STATE }] }));
      }, HEADER_DELAY_MS);
    });
    await new Promise<void>((resolve) => {
      created.listen(0, "127.0.0.1", resolve);
    });
    const address = created.address();
    if (address === null || typeof address === "string") {
      throw new Error("待ち受けポートを取得できなかった");
    }
    server = created;
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterEach(async () => {
    const running = server;
    server = null;
    if (running !== null) {
      running.closeAllConnections();
      await new Promise<void>((resolve) => {
        running.close(() => resolve());
      });
    }
  });

  it("C47 headersTimeout を短くした dispatcher を渡すと connection になる（dispatcher が効いている証明）", async () => {
    const dispatcher = new Agent({ headersTimeout: 200, bodyTimeout: 200 });
    try {
      const client = createLmStudioClient({ baseUrl, dispatcher });
      const error = await catchLmStudioError(client.listModels({ timeoutMs: 5000 }));
      expect(error.kind).toBe("connection");
      expect(error.status).toBeNull();
    } finally {
      await dispatcher.close();
    }
  }, 10_000);

  it("C52 実 HTTP 経路の connection でも message に接続先 URL を入れない（PR10 裁定 R12）", async () => {
    // 接続先 URL が漏れうる最も現実的な経路。undici が投げる例外の message・cause は
    // host:port を含みうるが、LmStudioError.message は定型文でなければならない
    // （この message は executor が UnitFailure に逐語で写し、DB と API 応答まで流れる）。
    const dispatcher = new Agent({ headersTimeout: 200, bodyTimeout: 200 });
    try {
      const client = createLmStudioClient({ baseUrl, dispatcher });
      const error = await catchLmStudioError(client.listModels({ timeoutMs: 5000 }));
      expect(error.kind).toBe("connection");
      expect(error.message).not.toContain(baseUrl);
      expect(error.message).not.toContain("127.0.0.1");
      expect(String(error.stack)).not.toContain("127.0.0.1:");
    } finally {
      await dispatcher.close();
    }
  }, 10_000);

  it("C48 既定のクライアントは timeoutMs より前に打ち切られず成功する", async () => {
    // この遅延（2000ms）は修正前の既定値（undici の headersTimeout 300 秒）でも打ち切られないため、
    // このテスト単体では dispatcher が効いていることの証明にはならない（判別しているのは C47）。
    // ここでの役割は、既定のクライアント（実 fetch）が壊れていないことのスモークテスト。
    const client = createLmStudioClient({ baseUrl });
    const models = await client.listModels({ timeoutMs: 5000 });
    expect(models.map((model) => model.id)).toEqual(["m1"]);
  }, 10_000);

  it("C49 既定のクライアントは実 fetch + timeoutMs でも自前タイマーが先に効いて timeout になる", async () => {
    // C18〜C21・C32・L2 の timeout/aborted 分類はすべてモック fetch。ここでは undici 7 の Agent を
    // Node 内蔵の実 fetch に dispatcher として渡す本番経路を通し、その境界でも自前タイマー
    // （timeoutMs）が undici 側の既定タイムアウトより先に効くことを確認する。
    const client = createLmStudioClient({ baseUrl });
    const started = performance.now();
    const error = await catchLmStudioError(client.listModels({ timeoutMs: 500 }));
    const elapsed = performance.now() - started;
    expect(error.kind).toBe("timeout");
    expect(elapsed).toBeLessThan(HEADER_DELAY_MS);
  }, 10_000);
});

describe("close()（決定 19）", () => {
  it("C50 clientOptions.dispatcher を渡した場合、close() してもその dispatcher 自体の close は呼ばれない（所有者が閉じる）", async () => {
    const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    const closeSpy = vi.spyOn(dispatcher, "close");
    try {
      const client = createLmStudioClient({ baseUrl: BASE_URL, dispatcher });
      await client.close();
      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      await dispatcher.close();
    }
  });

  it("C51 dispatcher を渡さない場合、close() が自前の Agent を閉じ、以後の listModels が失敗する（実 HTTP サーバーを使う C47 と同じ道具立て）", async () => {
    const created = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m1", state: LOADED_STATE }] }));
    });
    await new Promise<void>((resolve) => {
      created.listen(0, "127.0.0.1", resolve);
    });
    const address = created.address();
    if (address === null || typeof address === "string") {
      throw new Error("待ち受けポートを取得できなかった");
    }
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;
    try {
      const client = createLmStudioClient({ baseUrl });
      // close する前は普通に成功する（自前の Agent がまだ生きている）。
      const before = await client.listModels({ timeoutMs: 5000 });
      expect(before.map((model) => model.id)).toEqual(["m1"]);

      await client.close();

      const error = await catchLmStudioError(client.listModels({ timeoutMs: 5000 }));
      expect(error.kind).toBe("connection");
    } finally {
      created.closeAllConnections();
      await new Promise<void>((resolve) => {
        created.close(() => resolve());
      });
    }
  }, 10_000);
});

/**
 * 接続先 URL は「接続設定の応答」以外に出さない（不変条件）。`LmStudioError.message` は
 * `executor.ts` の `toFailure` が `UnitFailure.message` に**逐語で**写し、DB（検査履歴）にも
 * API 応答にも流れるので、URL を入れない保証はここ（作る場所）で持つ。マスクを DTO の境界に
 * 置いても DB は守れない。URL が現れてよいのは `cause` だけで、`cause` は写されない。
 */
describe("C53 LmStudioError.message に接続先 URL を入れない（PR10 裁定 R12）", () => {
  const HOST = "lmstudio.test";

  /** undici のように、下位の例外の message に接続先を含める `fetch`。 */
  const rejectingFetchWithUrl = (() =>
    Promise.reject(
      new TypeError(`fetch failed: connect ECONNREFUSED ${BASE_URL}`),
    )) as unknown as typeof globalThis.fetch;

  function expectNoUrl(error: LmStudioError): void {
    expect(error.message).not.toContain(HOST);
    expect(error.message).not.toContain(BASE_URL);
    // stack の先頭行は `name: message` なので、message が汚れていればここにも出る。
    expect(String(error.stack)).not.toContain(HOST);
  }

  it("chat: connection（fetch の reject）・connection（HTTP 500）・malformed・truncated", async () => {
    const cases: Array<{ readonly kind: string; readonly fetchImpl: typeof globalThis.fetch }> = [
      { kind: "connection", fetchImpl: rejectingFetchWithUrl },
      { kind: "connection", fetchImpl: makeFetch(() => textResponse(500, "internal")).fetchImpl },
      { kind: "malformed", fetchImpl: makeFetch(() => textResponse(200, "not json")).fetchImpl },
      {
        kind: "truncated",
        fetchImpl: makeFetch(() => jsonResponse(200, successBody({ finishReason: "length" })))
          .fetchImpl,
      },
    ];

    for (const { kind, fetchImpl } of cases) {
      const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
      const error = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1000 }));
      expect(error.kind).toBe(kind);
      expectNoUrl(error);
    }
  });

  it("chat: timeout と aborted", async () => {
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: hangingFetch });

    const timedOut = await catchLmStudioError(client.chat(baseChatRequest, { timeoutMs: 1 }));
    expect(timedOut.kind).toBe("timeout");
    expectNoUrl(timedOut);

    const aborted = await catchLmStudioError(
      client.chat(baseChatRequest, { timeoutMs: 1000, signal: AbortSignal.abort() }),
    );
    expect(aborted.kind).toBe("aborted");
    expectNoUrl(aborted);
  });

  it("listModels: connection（HTTP 500）と malformed", async () => {
    const cases: Array<{ readonly kind: string; readonly fetchImpl: typeof globalThis.fetch }> = [
      { kind: "connection", fetchImpl: rejectingFetchWithUrl },
      { kind: "connection", fetchImpl: makeFetch(() => textResponse(500, "internal")).fetchImpl },
      { kind: "malformed", fetchImpl: makeFetch(() => textResponse(200, "not json")).fetchImpl },
    ];

    for (const { kind, fetchImpl } of cases) {
      const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
      const error = await catchLmStudioError(client.listModels({ timeoutMs: 1000 }));
      expect(error.kind).toBe(kind);
      expectNoUrl(error);
    }
  });

  it("ensureLoaded: model-not-loaded（モデル ID は入るが接続先は入らない）", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(200, modelListBody([{ id: "other", state: LOADED_STATE }])),
    );
    const client = createLmStudioClient({ baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await catchLmStudioError(client.ensureLoaded("m1"));
    expect(error.kind).toBe("model-not-loaded");
    expect(error.message).toContain("m1");
    expectNoUrl(error);
  });
});
