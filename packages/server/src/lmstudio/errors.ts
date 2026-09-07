import type { FailureReason } from "@shuten/shared";

import type { Usage } from "./types.ts";

/**
 * LM Studio 由来の失敗を区別できる例外にする（仕様書 7 節、決定 7）。
 *
 * クラスフィールドは列挙可能なので `JSON.stringify(error)` に `kind`・`status`・`raw` などが出る。
 * `message` と `stack` は `Error` の非列挙プロパティなので出ない。
 */
export class LmStudioError extends Error {
  readonly kind: FailureReason;
  /** HTTP 応答があったときだけ。 */
  readonly status: number | null;
  /** `truncated` や、応答から usage を取れた後の `malformed`（解析失敗）のように、取れたときだけ非 null。 */
  readonly usage: Usage | null;
  readonly finishReason: string | null;
  /**
   * 応答本文。`malformed`（解析失敗）でも `ChatResult.raw` などが入る。ただし `ensureLoaded` の
   * `model-not-loaded` では該当 `ModelInfo`（見つからなければ null）が入る。
   * 要求本文とヘッダーは入れない（API キーを含まないようにするため）。
   */
  readonly raw: unknown;

  constructor(
    kind: FailureReason,
    message: string,
    options?: {
      status?: number | null | undefined;
      usage?: Usage | null | undefined;
      finishReason?: string | null | undefined;
      raw?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LmStudioError";
    this.kind = kind;
    this.status = options?.status ?? null;
    this.usage = options?.usage ?? null;
    this.finishReason = options?.finishReason ?? null;
    this.raw = options?.raw ?? null;
  }
}
