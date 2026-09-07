import type { ChatRequest, ModelInfo, Usage } from "./types.ts";

/**
 * LM Studio の OpenAI 互換 API との間の、HTTP を知らない純粋な変換・検証層。
 *
 * ここでは「解析できたか」だけを返す。どの `FailureReason` に分類するかは `client.ts` の責務。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** ChatRequest をワイヤ形式の本文にする（決定 3）。 */
export function toWireChatBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    // 要求 08 で確認済み。ストリーミングは使わない。
    stream: false,
  };
  // undefined かどうかで判定する（seed: 0、temperature: 0 は falsy なのでキーが消えてしまう）。
  if (request.seed !== undefined) {
    body.seed = request.seed;
  }
  if (request.reasoningEffort !== undefined) {
    body.reasoning_effort = request.reasoningEffort;
  }
  if (request.responseFormat !== undefined) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: request.responseFormat.name,
        strict: true,
        schema: request.responseFormat.schema,
      },
    };
  }
  return body;
}

/**
 * `/api/v0/models` の応答を解析する。`data` が配列でなければ null（呼び出し側が malformed にする）。
 * `id` が文字列でない要素はその要素だけ捨てる（一覧全体を失敗にしない）。
 */
export function parseModelList(json: unknown): ModelInfo[] | null {
  if (!isRecord(json)) {
    return null;
  }
  const data = json.data;
  if (!Array.isArray(data)) {
    return null;
  }
  const models: ModelInfo[] = [];
  for (const item of data) {
    if (!isRecord(item)) {
      continue;
    }
    const id = item.id;
    if (typeof id !== "string") {
      continue;
    }
    models.push({
      id,
      type: toStringOrNull(item.type),
      state: toStringOrNull(item.state),
      quantization: toStringOrNull(item.quantization),
      maxContextLength: toNumberOrNull(item.max_context_length),
      loadedContextLength: toNumberOrNull(item.loaded_context_length),
    });
  }
  return models;
}

/** 生成応答の外枠。解析できなければ null（呼び出し側が malformed にする）。 */
export interface ParsedCompletion {
  /** 欠けている・null なら解析失敗（`parseChatCompletion` 自体が null を返す）。 */
  readonly finishReason: string;
  /** 文字列でなければ null。length の判定を先に行うため、ここでは失敗にしない。 */
  readonly content: string | null;
  readonly reasoningContent: string | null;
  readonly usage: Usage | null;
}

function parseUsage(value: unknown): Usage | null {
  if (!isRecord(value)) {
    return null;
  }
  const promptTokens = value.prompt_tokens;
  const completionTokens = value.completion_tokens;
  const totalTokens = value.total_tokens;
  // 一部だけ 0 で埋めると「実測 0」と「取得できなかった」の区別がつかなくなるため、
  // 3 項目のいずれかが欠けている・数値でなければ usage 全体を null にする（決定 5）。
  if (
    typeof promptTokens !== "number" ||
    typeof completionTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return null;
  }
  let reasoningTokens: number | null = null;
  const details = value.completion_tokens_details;
  if (isRecord(details) && typeof details.reasoning_tokens === "number") {
    reasoningTokens = details.reasoning_tokens;
  }
  return { promptTokens, completionTokens, totalTokens, reasoningTokens };
}

/** 生成応答の外枠。解析できなければ null（呼び出し側が malformed にする）。 */
export function parseChatCompletion(json: unknown): ParsedCompletion | null {
  if (!isRecord(json)) {
    return null;
  }
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first = choices[0];
  if (!isRecord(first)) {
    return null;
  }
  const finishReason = first.finish_reason;
  if (typeof finishReason !== "string") {
    return null;
  }
  const message = first.message;
  if (!isRecord(message)) {
    return null;
  }
  const content = toStringOrNull(message.content);
  const reasoningContent = toStringOrNull(message.reasoning_content);
  const usage = parseUsage(json.usage);
  return { finishReason, content, reasoningContent, usage };
}

const MODEL_NOT_LOADED_MARKERS = ["no models loaded", "model_not_found", "not loaded", "unloaded"];
const INPUT_TOO_LONG_MARKERS = ["context length", "context_length", "too long", "maximum context"];

/**
 * 応答本文（JSON なら `error` の値を `JSON.stringify` した文字列、そうでなければ本文テキスト）から印を探す。
 * 両方の印が一致した場合は `model-not-loaded` を優先する（生成を送ってはいけない状態のほうが重い）。
 */
export function findErrorMarker(errorText: string): "model-not-loaded" | "input-too-long" | null {
  const lower = errorText.toLowerCase();
  if (MODEL_NOT_LOADED_MARKERS.some((marker) => lower.includes(marker))) {
    return "model-not-loaded";
  }
  if (INPUT_TOO_LONG_MARKERS.some((marker) => lower.includes(marker))) {
    return "input-too-long";
  }
  return null;
}
