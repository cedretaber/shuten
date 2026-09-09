import { MAX_TIMEOUT_MS } from "@shuten/shared";
import { Agent, type Dispatcher } from "undici";

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

/**
 * `timeoutMs` が有限で 1 以上 `MAX_TIMEOUT_MS`（`@shuten/shared`。`2**31 - 1`）以下の整数で
 * あることを検証する（決定 8）。
 */
function validateTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(
      `timeoutMs は 1 以上 ${String(MAX_TIMEOUT_MS)} 以下の整数でなければならない（実際: ${String(timeoutMs)}）`,
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

/**
 * `fetch` の init に undici の `dispatcher` を載せるための型。Node の `fetch` は
 * `RequestInit.dispatcher` を受け付けるが、その型定義は `@types/node` が同梱する
 * `undici-types` のもので、`undici` パッケージが公開する `Dispatcher` とは別の宣言になる。
 * 実体は同じなので、`dispatcher` だけ差し替えた型を定義し、`fetch` に渡すときに戻す。
 */
type FetchInit = Omit<RequestInit, "dispatcher"> & {
  readonly dispatcher?: Dispatcher | undefined;
};

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
  init: FetchInit,
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
    const requestInit: FetchInit = { ...init, signal: controller.signal };
    // 上記のとおり `dispatcher` の宣言元が違うだけなので、ここで元の型に戻す。
    const response = await fetchImpl(url, requestInit as unknown as RequestInit);
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
  /**
   * undici（Node の `fetch` の実体）が持つ独自のタイムアウトを無効にするための Dispatcher。
   * クライアント 1 つにつき 1 つだけ作り、すべての要求で使い回す。
   *
   * `headersTimeout` の既定は 300 秒で、`stream: false` で生成を頼む我々の使い方では
   * 応答ヘッダーが生成の完了までこない。つまり既定のままだと 300 秒が生成時間の事実上の上限になり、
   * 呼び出し元が `timeoutMs` に 15 分を渡しても 300 秒で切られる。しかもその切断は我々の
   * `AbortSignal` でもタイマーでもないため、`sendRequest` は `timeout` ではなく `connection` に
   * 分類してしまい、仕様書 7 節が求める「接続失敗とタイムアウトの区別」が壊れる（実測 301,289ms）。
   * そこで両方 0 にして無効化し、打ち切りの責任を `sendRequest` のタイマーだけに一本化する。
   */
  /**
   * `clientOptions.dispatcher` を渡された場合は呼び出し元の所有物なので `close()` で閉じない
   * （所有者が閉じる。決定 19）。自前で作った場合だけ `ownDispatcher` に持ち、`close()` の対象にする。
   */
  let ownDispatcher: Agent | undefined;
  let dispatcher: Dispatcher;
  if (clientOptions.dispatcher !== undefined) {
    dispatcher = clientOptions.dispatcher;
  } else {
    ownDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    dispatcher = ownDispatcher;
  }

  async function listModels(options?: RequestOptions): Promise<ModelInfo[]> {
    const signal = options?.signal;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_MODEL_LIST_TIMEOUT_MS;
    const url = joinUrl(baseUrl, "/api/v0/models");
    const headers = buildHeaders(apiKey, false);
    const { status, text } = await sendRequest(
      fetchImpl,
      url,
      { method: "GET", headers, dispatcher },
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
      // ここでの raw は HTTP 応答本文ではなく、一覧から見つかった ModelInfo（無ければ null）。
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
      { method: "POST", headers, body: requestBody, dispatcher },
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

  /**
   * 自前で作った `Agent` だけ閉じる。`clientOptions.dispatcher` を渡された場合（`ownDispatcher`
   * が undefined のまま）は何もしない（決定 19）。
   */
  async function close(): Promise<void> {
    if (ownDispatcher !== undefined) {
      await ownDispatcher.close();
    }
  }

  return { listModels, ensureLoaded, chat, close };
}
