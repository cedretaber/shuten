import { LmStudioError } from "./errors.ts";
import type {
  ChatOptions,
  ChatRequest,
  ChatResult,
  LmStudioClient,
  LmStudioClientOptions,
  ModelInfo,
  RequestOptions,
} from "./types.ts";
import { LOADED_STATE } from "./types.ts";
import { findErrorMarker, parseChatCompletion, parseModelList, toWireChatBody } from "./wire.ts";

/**
 * `listModels`（`ensureLoaded` 経由も含む）の既定タイムアウト。初期値であり、仕様書 13 節の
 * タイムアウト決定そのものではない（決定 8）。生成（`chat`）には既定値を置かない。
 */
export const DEFAULT_MODEL_LIST_TIMEOUT_MS = 10_000;

/** JSON として解析できなかった応答本文を `raw` に入れるときの上限文字数。 */
const RAW_TEXT_LIMIT = 2000;

const MARKER_MESSAGES: Record<"model-not-loaded" | "input-too-long", string> = {
  "model-not-loaded": "LM Studio: モデルが未ロードだった",
  "input-too-long": "LM Studio: 入力が文脈長の上限を超えた",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateRaw(text: string): string {
  return text.length > RAW_TEXT_LIMIT ? text.slice(0, RAW_TEXT_LIMIT) : text;
}

/** `timeoutMs` が有限で 1 以上 `2**31 - 1` 以下の整数であることを検証する（決定 8）。 */
function validateTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) {
    throw new TypeError(
      `timeoutMs は 1 以上 2**31-1 以下の整数でなければならない（実際: ${String(timeoutMs)}）`,
    );
  }
}

function buildHeaders(apiKey: string | null | undefined, includeContentType: boolean): Headers {
  const headers = new Headers();
  if (includeContentType) {
    headers.set("content-type", "application/json");
  }
  if (apiKey !== null && apiKey !== undefined && apiKey.trim() !== "") {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

/** `baseUrl` 末尾のスラッシュを何個でも取り除いてから `path` をつなげる。 */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

interface RawResponse {
  readonly status: number;
  readonly text: string;
}

/**
 * `signal.aborted` を読むだけの関数呼び出しにする。直接 `signal?.aborted === true` を
 * 分岐に使うと、TypeScript がその後の `await` を挟んだ分岐でも「常に false」と誤って
 * 絞り込んでしまうため、関数呼び出しの背後に隠して絞り込みを無効化する。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted);
}

/**
 * `fetch` を呼び、応答本文を `text()` で 1 回だけ読む。中断・タイムアウト・接続失敗を分類して
 * `LmStudioError` として投げる（決定 8）。例外の形（`err.name`）では判定しない。
 */
async function sendRequest(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<RawResponse> {
  validateTimeoutMs(timeoutMs);
  if (isAborted(callerSignal)) {
    throw new LmStudioError("aborted", "呼び出し元によって要求が中断された（送信前）");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, text };
  } catch (err) {
    if (isAborted(callerSignal)) {
      throw new LmStudioError("aborted", "呼び出し元によって要求が中断された", { cause: err });
    }
    if (timedOut) {
      throw new LmStudioError("timeout", `要求が ${String(timeoutMs)}ms でタイムアウトした`, {
        cause: err,
      });
    }
    throw new LmStudioError("connection", "LM Studio への接続に失敗した", { cause: err });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

interface ParsedBody {
  readonly json: unknown;
  readonly parsed: boolean;
}

/** 本文テキストを JSON として解析する。失敗しても例外を漏らさない。 */
function parseBody(text: string): ParsedBody {
  try {
    return { json: JSON.parse(text) as unknown, parsed: true };
  } catch {
    return { json: undefined, parsed: false };
  }
}

/** `raw` に入れる値。JSON として解析できたらそのオブジェクト、できなければ本文の先頭 2,000 文字。 */
function rawFromBody(body: ParsedBody, text: string): unknown {
  return body.parsed ? body.json : truncateRaw(text);
}

/**
 * 本文に `error` キーがあれば印を照合する。HTTP 状態にかかわらず適用する（決定 7）。
 * 照合対象は、JSON として解析できたら `error` の値を `JSON.stringify` した文字列、
 * できなければ本文テキスト全体。
 */
function checkErrorMarker(body: ParsedBody, text: string, status: number): LmStudioError | null {
  let matchText: string | null = null;
  if (body.parsed) {
    if (isRecord(body.json) && "error" in body.json) {
      matchText = JSON.stringify(body.json.error);
    }
  } else {
    matchText = text;
  }
  if (matchText === null) {
    return null;
  }
  const marker = findErrorMarker(matchText);
  if (marker === null) {
    return null;
  }
  return new LmStudioError(marker, MARKER_MESSAGES[marker], {
    status,
    raw: rawFromBody(body, text),
  });
}

export function createLmStudioClient(clientOptions: LmStudioClientOptions): LmStudioClient {
  const baseUrl = clientOptions.baseUrl;
  const apiKey = clientOptions.apiKey ?? null;
  const fetchImpl = clientOptions.fetch ?? globalThis.fetch;

  async function listModels(options?: RequestOptions): Promise<ModelInfo[]> {
    const signal = options?.signal;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_MODEL_LIST_TIMEOUT_MS;
    const url = joinUrl(baseUrl, "/api/v0/models");
    const headers = buildHeaders(apiKey, false);
    const { status, text } = await sendRequest(
      fetchImpl,
      url,
      { method: "GET", headers },
      signal,
      timeoutMs,
    );
    const body = parseBody(text);
    if (status !== 200) {
      throw new LmStudioError("connection", `LM Studio が HTTP ${String(status)} を返した`, {
        status,
        raw: rawFromBody(body, text),
      });
    }
    const models = body.parsed ? parseModelList(body.json) : null;
    if (models === null) {
      throw new LmStudioError("malformed", "LM Studio のモデル一覧を解析できなかった", {
        status,
        raw: rawFromBody(body, text),
      });
    }
    return models;
  }

  async function ensureLoaded(modelId: string, options?: RequestOptions): Promise<ModelInfo> {
    const models = await listModels(options);
    const found = models.find((model) => model.id === modelId);
    if (found === undefined || found.state !== LOADED_STATE) {
      throw new LmStudioError("model-not-loaded", `モデル ${modelId} がロードされていない`, {
        raw: found ?? null,
      });
    }
    return found;
  }

  async function chat(request: ChatRequest, options: ChatOptions): Promise<ChatResult> {
    const { signal, timeoutMs } = options;
    const url = joinUrl(baseUrl, "/v1/chat/completions");
    const headers = buildHeaders(apiKey, true);
    const requestBody = JSON.stringify(toWireChatBody(request));
    const { status, text } = await sendRequest(
      fetchImpl,
      url,
      { method: "POST", headers, body: requestBody },
      signal,
      timeoutMs,
    );
    const body = parseBody(text);

    const markerError = checkErrorMarker(body, text, status);
    if (markerError !== null) {
      throw markerError;
    }

    if (status !== 200) {
      throw new LmStudioError("connection", `LM Studio が HTTP ${String(status)} を返した`, {
        status,
        raw: rawFromBody(body, text),
      });
    }

    const completion = body.parsed ? parseChatCompletion(body.json) : null;
    if (completion === null) {
      throw new LmStudioError("malformed", "LM Studio の応答の外枠を解析できなかった", {
        status,
        raw: rawFromBody(body, text),
      });
    }

    if (completion.finishReason === "length") {
      throw new LmStudioError("truncated", "生成が max_tokens で打ち切られた", {
        status,
        usage: completion.usage,
        finishReason: completion.finishReason,
        raw: rawFromBody(body, text),
      });
    }

    if (completion.content === null) {
      throw new LmStudioError("malformed", "message.content が文字列でない", {
        status,
        raw: rawFromBody(body, text),
      });
    }

    return {
      content: completion.content,
      reasoningContent: completion.reasoningContent,
      finishReason: completion.finishReason,
      usage: completion.usage,
      raw: rawFromBody(body, text),
    };
  }

  return { listModels, ensureLoaded, chat };
}
