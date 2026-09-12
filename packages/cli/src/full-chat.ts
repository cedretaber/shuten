/**
 * `full-chat`（全文チャット方式）の実行本体（決定 15・34・36・37・40）。
 *
 * LM Studio へ生成要求を 1 回だけ送る。分割・観点・許容語・再確認・再試行は持たない
 * （`packages/server/src/run/executor.ts` の `runOne` を「再試行なしの 1 回だけ」に
 * 簡略化したもの）。`packages/server` には何も足さない（決定 34）。`main.ts` への接続は
 * 後続タスクの仕事なので、ここではまだ繋がない。
 */
import { hashBody } from "@shuten/server/hash.ts";
import { LmStudioError } from "@shuten/server/lmstudio/errors.ts";
import type {
  ChatRequest,
  ChatResult,
  LmStudioClient,
  ModelInfo,
  Usage,
} from "@shuten/server/lmstudio/types.ts";
import type { GenerationSettings } from "@shuten/server/prompts/types.ts";
import type { UnitFailure } from "@shuten/server/run/result.ts";
import { countGraphemes, isGenerationCapable, splitParagraphs } from "@shuten/shared";

import { fillManuscript } from "./full-chat-prompt.ts";

export const FULL_CHAT_FORMAT_VERSION = "full-chat/1";

/** 記録する実行条件（決定 40）。分割・観点・許容語・再確認に関わる項目は持たない。 */
export interface FullChatConditions {
  readonly startedAt: string;
  readonly finishedAt: string;
  /** ensureLoaded が返した ModelInfo。届く前に失敗したら null。 */
  readonly model: ModelInfo | null;
  readonly generation: GenerationSettings;
  /** この要求のハード上限（決定 15）。CLI は recoveryConfirmMs 相当が 0 なのでそのまま効く。 */
  readonly timeouts: { readonly checkMs: number };
  readonly manuscript: {
    readonly utf16Length: number;
    readonly graphemeCount: number;
    readonly paragraphCount: number;
    readonly bodyHash: string;
  };
  /** 差し込み「前」の生のプロンプトの hashBody 値（決定 36）。 */
  readonly promptHash: string;
}

export interface FullChatResult {
  readonly formatVersion: typeof FULL_CHAT_FORMAT_VERSION;
  readonly status: "completed" | "failed";
  /** 成功したときだけ応答本文。失敗時は null（打ち切られた本文を成功として残さない。決定 15）。 */
  readonly content: string | null;
  readonly reasoningContent: string | null;
  readonly finishReason: string | null;
  readonly usage: Usage | null;
  readonly failure: UnitFailure | null;
  readonly conditions: FullChatConditions;
}

export type FullChatRunResult =
  | { readonly ok: true; readonly value: FullChatResult }
  | { readonly ok: false; readonly error: string };

export interface FullChatRunArgs {
  /** 保存本文（BOM 除外済み）。 */
  readonly text: string;
  /** 差し込み「前」の生のプロンプト。 */
  readonly prompt: string;
  readonly generation: GenerationSettings;
  readonly timeoutMs: number;
  readonly client: LmStudioClient;
  /** テストのための継ぎ目。未指定なら () => new Date()。 */
  readonly now?: (() => Date) | undefined;
}

/** `run/executor.ts` の `toFailure` と同じ 4 行（あちらは export されていない。決定 34）。 */
function toFailure(error: LmStudioError, origin: "ensure-loaded" | "chat"): UnitFailure {
  return {
    reason: error.kind,
    message: error.message,
    finishReason: error.finishReason,
    origin,
  };
}

export async function runFullChat(args: FullChatRunArgs): Promise<FullChatRunResult> {
  const now = args.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const filled = fillManuscript(args.prompt, args.text);
  if (!filled.ok) {
    return { ok: false, error: filled.error };
  }

  const manuscriptConditions = {
    utf16Length: args.text.length,
    graphemeCount: countGraphemes(args.text),
    paragraphCount: splitParagraphs(args.text).length,
    bodyHash: hashBody(args.text),
  };
  const promptHash = hashBody(args.prompt);

  /** 届いた範囲の conditions を組み立てる。model は取れていなければ null。 */
  const buildConditions = (model: ModelInfo | null): FullChatConditions => ({
    startedAt,
    finishedAt: now().toISOString(),
    model,
    generation: args.generation,
    timeouts: { checkMs: args.timeoutMs },
    manuscript: manuscriptConditions,
    promptHash,
  });

  const failed = (model: ModelInfo | null, failure: UnitFailure): FullChatResult => ({
    formatVersion: FULL_CHAT_FORMAT_VERSION,
    status: "failed",
    content: null,
    reasoningContent: null,
    finishReason: failure.finishReason,
    usage: null,
    failure,
    conditions: buildConditions(model),
  });

  let modelInfo: ModelInfo;
  try {
    modelInfo = await args.client.ensureLoaded(args.generation.model);
  } catch (error) {
    if (!(error instanceof LmStudioError)) {
      throw error;
    }
    return {
      ok: true,
      value: { ...failed(null, toFailure(error, "ensure-loaded")), usage: error.usage },
    };
  }

  if (!isGenerationCapable(modelInfo)) {
    const failure: UnitFailure = {
      reason: "model-not-loaded",
      message: `モデル種別が生成に使えない（llm / vlm 以外、または種別欠落）: ${
        modelInfo.type ?? "(欠落)"
      }`,
      finishReason: null,
      origin: "ensure-loaded",
    };
    return { ok: true, value: failed(modelInfo, failure) };
  }

  const request: ChatRequest = {
    model: args.generation.model,
    messages: [{ role: "user", content: filled.value }],
    maxTokens: args.generation.maxTokens,
    temperature: args.generation.temperature,
    ...(args.generation.seed !== undefined ? { seed: args.generation.seed } : {}),
    reasoningEffort: args.generation.reasoningEffort,
  };

  let result: ChatResult;
  try {
    result = await args.client.chat(request, { timeoutMs: args.timeoutMs });
  } catch (error) {
    if (!(error instanceof LmStudioError)) {
      throw error;
    }
    return {
      ok: true,
      value: {
        ...failed(modelInfo, toFailure(error, "chat")),
        usage: error.usage,
      },
    };
  }

  if (result.finishReason !== "stop") {
    // 決定 37：stop 以外の終了理由は成功にせず truncated として扱う。再試行はしない。
    const error = new LmStudioError(
      "truncated",
      `生成が通常どおり終わらなかった（finish_reason: ${result.finishReason}）`,
      { usage: result.usage, finishReason: result.finishReason, raw: result.raw },
    );
    return {
      ok: true,
      value: {
        ...failed(modelInfo, toFailure(error, "chat")),
        usage: error.usage,
      },
    };
  }

  return {
    ok: true,
    value: {
      formatVersion: FULL_CHAT_FORMAT_VERSION,
      status: "completed",
      content: result.content,
      reasoningContent: result.reasoningContent,
      finishReason: result.finishReason,
      usage: result.usage,
      failure: null,
      conditions: buildConditions(modelInfo),
    },
  };
}
