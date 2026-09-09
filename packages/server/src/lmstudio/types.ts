/**
 * LM Studio クライアントのアプリ側の型（決定 3・4・5）。
 *
 * ワイヤ形式（snake_case の JSON）はここには出さない。`wire.ts` が相互変換を担う。
 */

import type { ReasoningEffort } from "@shuten/shared";
import type { Dispatcher } from "undici";

/**
 * 思考の強さ。値の正本は `@shuten/shared` の `run/reasoning-effort.ts` に移した
 * （PR10 決定 2・9）。ここでは再エクスポートだけ行う。
 */
export type { ReasoningEffort };

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

/**
 * `state` がこの値のときだけ生成を許す。実体は `@shuten/shared` の `run/model-capability.ts` に
 * 移した（PR11 決定 9）。ここでは再エクスポートだけ行う（`client.ts`・`api/settings.ts` の
 * import 元はこのファイルのまま変えない）。
 */
export { LOADED_STATE } from "@shuten/shared";

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

/**
 * クライアントは環境変数を読まない。接続先・API キー・`fetch` はすべて引数で受け取る（決定 2）。
 * UI から接続先を上書きする経路（PR10・PR11）と、モックでの単体テストが同じ入口を使えるようにする。
 */
export interface LmStudioClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | null | undefined;
  /** 未指定なら globalThis.fetch を使う。 */
  readonly fetch?: typeof globalThis.fetch | undefined;
  /**
   * `fetch` に渡す undici の Dispatcher。未指定ならクライアントが
   * タイムアウトを無効化した Agent を 1 つ作って使う（`client.ts` の注釈を参照）。
   * テストと、将来接続設定を外から差し替える呼び出し元のための継ぎ目。
   */
  readonly dispatcher?: Dispatcher | undefined;
}

/** `listModels`・`ensureLoaded` で渡す共通オプション。 */
export interface RequestOptions {
  readonly signal?: AbortSignal | undefined;
  /** ミリ秒単位のタイムアウト。呼び出し元の signal とは独立に扱う。 */
  readonly timeoutMs?: number | undefined;
}

/** `chat` で渡すオプション。生成は既定値を置かないため `timeoutMs` は必須（決定 2・決定 8）。 */
export interface ChatOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}

export interface LmStudioClient {
  /** `GET /api/v0/models` でモデル一覧とロード状態を取る。 */
  listModels(options?: RequestOptions): Promise<ModelInfo[]>;
  /**
   * `id` が完全一致するモデルを一覧から探し、`state === LOADED_STATE` を確認する。
   * 見つからない、または未ロードなら `LmStudioError`（`model-not-loaded`）を投げる。
   */
  ensureLoaded(modelId: string, options?: RequestOptions): Promise<ModelInfo>;
  /** `POST /v1/chat/completions` で 1 回の生成要求を送る。内部で `ensureLoaded` は呼ばない。 */
  chat(request: ChatRequest, options: ChatOptions): Promise<ChatResult>;
  /**
   * クライアントが自前で作った undici の `Agent` を閉じる（決定 19。PR7 からの持ち越し）。
   * `clientOptions.dispatcher` を呼び出し元が渡した場合はそちらの所有物なので閉じない
   * （呼び出し元が閉じる責任を持つ）。`ConnectionManager.update` が古いクライアントを
   * 閉じるときと shutdown で使う。
   */
  close(): Promise<void>;
}
