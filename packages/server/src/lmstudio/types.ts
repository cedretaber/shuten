/**
 * LM Studio クライアントのアプリ側の型（決定 3・4・5）。
 *
 * ワイヤ形式（snake_case の JSON）はここには出さない。`wire.ts` が相互変換を担う。
 */

/** 思考の強さ。トップレベルの `reasoning_effort` に対応する（決定 0003）。 */
export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/**
 * 生成要求。camelCase のアプリ側表現。ワイヤ形式への変換は `wire.ts` の `toWireChatBody` が行う。
 */
export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  /** 思考込みの生成トークン予算（決定 0003）。ワイヤの `max_tokens`。 */
  readonly maxTokens: number;
  readonly temperature: number;
  readonly seed?: number | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly responseFormat?:
    | { readonly name: string; readonly schema: Record<string, unknown> }
    | undefined;
}

/** `state` がこの値のときだけ生成を許す。 */
export const LOADED_STATE = "loaded";

/**
 * `/api/v0/models` の 1 要素。応答本文は実験で記録していないため、`id` 以外はすべて欠けうる（決定 4）。
 */
export interface ModelInfo {
  readonly id: string;
  /** "llm" / "vlm" / "embeddings" など。欠けていれば null。 */
  readonly type: string | null;
  /** "loaded" / "not-loaded" / 未知の値 / 欠けていれば null。厳密に `LOADED_STATE` のときだけ生成を許す。 */
  readonly state: string | null;
  readonly quantization: string | null;
  readonly maxContextLength: number | null;
  /** ロード中のみ持つ値。 */
  readonly loadedContextLength: number | null;
}

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** `completion_tokens_details.reasoning_tokens`。項目がなければ null（決定 5）。 */
  readonly reasoningTokens: number | null;
}

export interface ChatResult {
  readonly content: string;
  /** `message.reasoning_content`。項目がなければ null、空文字はそのまま空文字。 */
  readonly reasoningContent: string | null;
  /** "length" はここに来ない（`truncated` として例外になる。決定 6）。 */
  readonly finishReason: string;
  /** 応答に usage がなければ null。 */
  readonly usage: Usage | null;
  /** 応答 JSON 全体（実行記録・診断用）。 */
  readonly raw: unknown;
}

export interface LmStudioClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
}

/** 呼び出し単位で渡す共通オプション。 */
export interface RequestOptions {
  readonly signal?: AbortSignal | undefined;
  /** ミリ秒単位のタイムアウト。呼び出し元の signal とは独立に扱う。 */
  readonly timeoutMs?: number | undefined;
}

export type ChatOptions = RequestOptions;

export interface LmStudioClient {
  /** `GET /api/v0/models` でモデル一覧とロード状態を取る。 */
  listModels(options?: RequestOptions | undefined): Promise<readonly ModelInfo[]>;
  /**
   * `id` が完全一致するモデルを一覧から探し、`state === LOADED_STATE` を確認する。
   * 見つからない、または未ロードなら `LmStudioError`（`model-not-loaded`）を投げる。
   */
  ensureLoaded(modelId: string, options?: RequestOptions | undefined): Promise<ModelInfo>;
  /** `POST /v1/chat/completions` で 1 回の生成要求を送る。内部で `ensureLoaded` は呼ばない。 */
  chat(request: ChatRequest, options?: ChatOptions | undefined): Promise<ChatResult>;
}
