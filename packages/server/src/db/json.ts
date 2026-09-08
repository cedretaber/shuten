import type {
  ChunkSettings,
  DiagnosticCandidate,
  LlmFinding,
  Perspective,
  Range,
} from "@shuten/shared";
import { FINDING_CATEGORIES, INITIAL_VERDICTS } from "@shuten/shared";
import { z } from "zod";

import type { ModelInfo, Usage } from "../lmstudio/types.ts";
import type { GenerationSettings } from "../prompts/types.ts";

/**
 * 検査の観点（仕様書 6.2 節）。`@shuten/shared` は `Perspective` 型は公開しているが
 * ランタイムのタプルは公開していないため、ここに置く。`schema.ts` の列挙列・`z.enum` の両方から使う。
 */
export const PERSPECTIVES = ["typo", "naturalness"] as const satisfies readonly Perspective[];

/**
 * 位置診断の変換規則名（`@shuten/shared` の `DiagnosticTransform`）。
 * shared はこの型のランタイムのタプルを公開していないため、ここにローカルに持つ。
 */
const DIAGNOSTIC_TRANSFORMS = ["newline", "nfc", "newline+nfc"] as const;

/** `packages/server/src/lmstudio/types.ts` の `ReasoningEffort`。ランタイムのタプルは公開されていない。 */
const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;

/** JSON 列に保存する `Range`（`@shuten/shared` の `{ start, end }`）。 */
const rangeSchema = z.object({
  start: z.number().int(),
  end: z.number().int(),
}) satisfies z.ZodType<Range>;

/** `runs.model_info`。`ensureLoaded` が返した応答（`ModelInfo`）。取れなければ列全体が null。 */
const modelInfoSchema = z.object({
  id: z.string(),
  type: z.string().nullable(),
  state: z.string().nullable(),
  quantization: z.string().nullable(),
  maxContextLength: z.number().nullable(),
  loadedContextLength: z.number().nullable(),
}) satisfies z.ZodType<ModelInfo>;

/** `runs.model_info` 列そのもの（null を許す）。 */
export const runModelInfoSchema = modelInfoSchema.nullable() satisfies z.ZodType<ModelInfo | null>;

/**
 * `runs.generation_settings`。`model` は `runs.model_id` に別項目として持つため含めない（決定 11）。
 */
export const runGenerationSettingsSchema = z.object({
  maxTokens: z.number(),
  temperature: z.number(),
  seed: z.number().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
}) satisfies z.ZodType<Omit<GenerationSettings, "model">>;

/** `runs.chunk_settings`。 */
export const runChunkSettingsSchema = z.object({
  targetGraphemes: z.number(),
  contextGraphemes: z.number(),
  recheckContextGraphemes: z.number(),
  roundingTolerance: z.number(),
  maxInputGraphemes: z.number(),
}) satisfies z.ZodType<ChunkSettings>;

/** `runs.timeouts`。再開しても設定を変えないため実行に紐づけて保存する値。 */
export const runTimeoutsSchema = z.object({
  checkMs: z.number(),
  recheckMs: z.number(),
}) satisfies z.ZodType<{ readonly checkMs: number; readonly recheckMs: number }>;

/** `runs.perspectives`。 */
export const runPerspectivesSchema = z.array(z.enum(PERSPECTIVES)).readonly() satisfies z.ZodType<
  readonly Perspective[]
>;

/** `runs.allowed_words`。分割・trim 済みの許容語配列。 */
export const runAllowedWordsSchema = z.array(z.string()).readonly() satisfies z.ZodType<
  readonly string[]
>;

/** `run_targets.paragraph_ids`。0 以上の整数の配列。 */
export const runTargetParagraphIdsSchema = z
  .array(z.number().int().min(0))
  .readonly() satisfies z.ZodType<readonly number[]>;

/** `check_units.usage` / `recheck_units.usage`。取れなければ列全体が null。 */
const usageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  reasoningTokens: z.number().nullable(),
}) satisfies z.ZodType<Usage>;

export const unitUsageSchema = usageSchema.nullable() satisfies z.ZodType<Usage | null>;

/**
 * `candidates.llm`。LLM が返した `LlmFinding` をそのまま持つ。`quote` の照合に使うため未加工。
 * `z.object` は既定で未知キーを捨てる（strip）ので、モデルが余分なキーを返しても無視する（J1）。
 */
export const candidateLlmSchema = z.object({
  paragraphId: z.number().int(),
  quote: z.string(),
  before: z.string(),
  after: z.string(),
  category: z.enum(FINDING_CATEGORIES),
  reason: z.string(),
  suggestion: z.string().nullable(),
  verdict: z.enum(INITIAL_VERDICTS),
}) satisfies z.ZodType<LlmFinding>;

/** `diagnostics.exact_matches`。絞り込み後に残った完全一致の範囲（採用位置には使わない）。 */
export const diagnosticExactMatchesSchema = z.array(rangeSchema).readonly() satisfies z.ZodType<
  readonly Range[]
>;

const diagnosticCandidateSchema = z.object({
  transform: z.enum(DIAGNOSTIC_TRANSFORMS),
  text: z.string(),
  range: rangeSchema.nullable(),
}) satisfies z.ZodType<DiagnosticCandidate>;

/** `diagnostics.transform_candidates`。`not-found` のときだけ非 null。 */
export const diagnosticTransformCandidatesSchema = z
  .array(diagnosticCandidateSchema)
  .readonly()
  .nullable() satisfies z.ZodType<readonly DiagnosticCandidate[] | null>;

/**
 * JSON 列を読み戻し、`schema` で検証して返す。
 *
 * `value` が文字列なら `JSON.parse` してから検証する。drizzle の `mode: "json"` は
 * 解析済みの値を返すが、生の SQL 経由では文字列のまま来るため両方を受ける。
 * 検証に失敗しても既定値・空配列・null には置き換えず、どの列で落ちたかが分かる例外を投げる。
 */
export function parseJsonColumn<T>(schema: z.ZodType<T>, value: unknown, column: string): T {
  let parsed: unknown;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (err) {
      throw new Error(`JSON 列 ${column} の読み戻しに失敗しました（不正な JSON 文字列）`, {
        cause: err,
      });
    }
  } else {
    parsed = value;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`JSON 列 ${column} の読み戻しに失敗しました: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.data;
}
