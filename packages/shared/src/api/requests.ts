import { z } from "zod";

import { MAX_TIMEOUT_MS } from "./defaults.ts";

/**
 * 要求（本書「要求」節）。zod 4 で書き、**構文的な検証だけ**を行う。意味的な検証
 * （分割設定の整合、再試行対象の妥当性）は既存の関数（`validateChunkSettings`、
 * `retryFailedUnits`）に任せて、その例外を 400 に写す（決定 4）。
 */

export const putConnectionRequestSchema = z.object({
  endpointUrl: z.string().min(1),
  /** 省略＝維持、null＝消去、文字列＝設定（空白のみは消去と同じ。`parseLmStudioApiKey` に合わせる）。 */
  apiKey: z.string().nullable().optional(),
});
export type PutConnectionRequest = z.infer<typeof putConnectionRequestSchema>;

export const connectionCheckRequestSchema = z.object({
  modelId: z.string().min(1).optional(),
});
export type ConnectionCheckRequest = z.infer<typeof connectionCheckRequestSchema>;

export const createManuscriptRequestSchema = z.object({
  name: z.string().min(1).max(200),
  body: z.string(), // 空は zod でなく empty-body で 400 にする（決定 14）
});
export type CreateManuscriptRequest = z.infer<typeof createManuscriptRequestSchema>;

// z.int() は zod 4 で「安全な整数」（Number.isSafeInteger）に限る。CLI の parseIntegerOption と同じ範囲。
export const generationSettingsRequestSchema = z.object({
  maxTokens: z.int().min(1), // CLI --max-tokens と同じ：1 以上の安全な整数
  temperature: z.number(), // zod 4 の z.number() は NaN・±Infinity を通さない
  seed: z.int().min(0).optional(), // CLI --seed と同じ：0 以上の安全な整数
  reasoningEffort: z.enum(["none", "low", "medium", "high"]).optional(),
});
export type GenerationSettingsRequest = z.infer<typeof generationSettingsRequestSchema>;

export const chunkSettingsRequestSchema = z.object({
  targetGraphemes: z.int(),
  contextGraphemes: z.int(),
  recheckContextGraphemes: z.int(),
  roundingTolerance: z.number(),
  maxInputGraphemes: z.int(),
}); // 範囲・整合はハンドラーが validateChunkSettings で見る（決定 14）
export type ChunkSettingsRequest = z.infer<typeof chunkSettingsRequestSchema>;

export const startRunRequestSchema = z.object({
  startOperationId: z.string().min(1).max(200),
  manuscriptVersionId: z.string().min(1),
  modelId: z.string().min(1),
  generation: generationSettingsRequestSchema,
  chunkSettings: chunkSettingsRequestSchema,
  timeouts: z.object({
    checkMs: z.int().min(1).max(MAX_TIMEOUT_MS),
    recheckMs: z.int().min(1).max(MAX_TIMEOUT_MS),
  }),
  perspectives: z.array(z.enum(["typo", "naturalness"])).min(1), // 重複はハンドラーで除く
  recheckEnabled: z.boolean(),
  allowedWordsRaw: z.string(),
});
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

export const retryFailedRequestSchema = z.object({
  /** 省略＝全件。空配列は誤り（PR9b 決定 36）なので min(1)。 */
  unitIds: z.array(z.string().min(1)).min(1).optional(),
});
export type RetryFailedRequest = z.infer<typeof retryFailedRequestSchema>;

export const confirmRecoveryRequestSchema = z.object({ runId: z.string().min(1) });
export type ConfirmRecoveryRequest = z.infer<typeof confirmRecoveryRequestSchema>;

export const putJudgmentRequestSchema = z.object({
  status: z.enum(["undecided", "adopt-planned", "rejected", "held"]),
  note: z.string().max(2000).nullable().optional(), // 省略＝null
});
export type PutJudgmentRequest = z.infer<typeof putJudgmentRequestSchema>;
