import { z } from "zod";

import type { QuoteRef } from "../locate/quote-ref.ts";

/** 検査の観点。観点ごとに別の要求を送る（仕様書 6.2）。 */
export type Perspective = "typo" | "naturalness";

export const FINDING_CATEGORIES = [
  "notation",
  "omission-or-duplication",
  "particle",
  "grammar",
  "context-misuse",
  "unclear",
] as const;
export const INITIAL_VERDICTS = ["likely-error", "confirm-with-author"] as const;
export const RECHECK_VERDICTS = ["keep", "withdraw", "confirm-with-author"] as const;
export const RECHECK_REASON_KINDS = [
  "error-confirmed",
  "intentional-expression",
  "suggestion-inappropriate",
  "unnecessary-polish",
  "insufficient-context",
] as const;

/** 初回検査の暫定判定（仕様書 5.4）。 */
export type InitialVerdict = (typeof INITIAL_VERDICTS)[number];

/** 指摘の分類。許容語による自動抑制は notation（誤字・表記の訂正）だけを対象にする（仕様書 6.4）。 */
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** 初回検査で LLM が返す指摘 1 件。数値位置は持たない（仕様書 6.3）。 */
export interface LlmFinding extends QuoteRef {
  readonly category: FindingCategory;
  /** 指摘の理由。 */
  readonly reason: string;
  /** 最小限の修正案。特定できないときは null（空文字は解析時に null に正規化する）。 */
  readonly suggestion: string | null;
  readonly verdict: InitialVerdict;
}

/** 初回検査の応答全体。該当なしは空配列。 */
export interface LlmCheckOutput {
  readonly findings: readonly LlmFinding[];
}

/** 再確認の判定（仕様書 6.5）。 */
export type RecheckVerdict = (typeof RECHECK_VERDICTS)[number];

/**
 * 再確認の理由区分（仕様書 6.5 の確認内容に対応）。suggestion-inappropriate は「問題は実在するが修正案が不適切」で、
 * 修正案を有効な修正案として表示しない（修正案の改訂はしない）。
 */
export type RecheckReasonKind = (typeof RECHECK_REASON_KINDS)[number];

/** 再確認の応答。 */
export interface LlmRecheckOutput {
  readonly reason: string;
  readonly reasonKind: RecheckReasonKind;
  readonly verdict: RecheckVerdict;
  /** 修正案を有効な修正案として表示してよいか。reasonKind が suggestion-inappropriate のときは必ず false。 */
  readonly suggestionValid: boolean;
}

/**
 * 初回検査で LLM が返す指摘 1 件のワイヤ形式（`LlmFinding` と同じ形）。.transform を持たない。
 * PR10 の DTO（`shared/src/api/dto.ts` の `CandidateDto.llm`）はこのスキーマをそのまま再利用する
 * （検証ロジックを 2 か所に書かないため）。文法制約付き生成でモデルがこの順にキーを出すため、
 * キー順を変えないこと。
 */
export const llmFindingSchema = z.object({
  paragraphId: z.number().int().min(0),
  quote: z.string().min(1),
  before: z.string(),
  after: z.string(),
  category: z.enum(FINDING_CATEGORIES),
  reason: z.string(),
  suggestion: z.string().nullable(),
  verdict: z.enum(INITIAL_VERDICTS),
});

// 内部用の「ワイヤー」スキーマ。.transform / .refine / .preprocess を持たない。
// モデルの応答そのものの形を表し、z.toJSONSchema への唯一の入力になる。
const checkOutputWire = z.object({
  findings: z.array(llmFindingSchema),
});

const recheckOutputWire = z.object({
  reason: z.string(),
  reasonKind: z.enum(RECHECK_REASON_KINDS),
  verdict: z.enum(RECHECK_VERDICTS),
  suggestionValid: z.boolean(),
});

/** 初回検査の応答を検証する。未知のキーは捨てる。suggestion の空文字は null に正規化する。 */
export const llmCheckOutputSchema: z.ZodType<LlmCheckOutput> = checkOutputWire.transform(
  (output) => ({
    findings: output.findings.map((finding) => ({
      ...finding,
      // 空文字と空白のみ（全角空白を含む）は「修正案なし」として null に揃える
      suggestion:
        finding.suggestion !== null && finding.suggestion.trim() === "" ? null : finding.suggestion,
    })),
  }),
);

/**
 * 再確認の応答を検証する（仕様書 6.5）。矛盾として拒否する組：
 * suggestion-inappropriate で suggestionValid が true、suggestion-inappropriate または insufficient-context で
 * verdict が confirm-with-author 以外。
 */
export const llmRecheckOutputSchema: z.ZodType<LlmRecheckOutput> = recheckOutputWire
  .refine(
    (output) => !(output.reasonKind === "suggestion-inappropriate" && output.suggestionValid),
    {
      message:
        "reasonKind が suggestion-inappropriate のとき suggestionValid は false でなければならない",
    },
  )
  .refine(
    (output) =>
      !(
        (output.reasonKind === "suggestion-inappropriate" ||
          output.reasonKind === "insufficient-context") &&
        output.verdict !== "confirm-with-author"
      ),
    {
      message:
        "suggestion-inappropriate と insufficient-context の verdict は confirm-with-author でなければならない",
    },
  );

function toResponseSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    override: (ctx) => {
      // zod は整数に安全整数の上限を付けるが、文法制約付き生成には不要なので外す。
      if (ctx.jsonSchema.type === "integer") {
        delete ctx.jsonSchema.maximum;
      }
    },
  });
  // 検証済みの要求（decisions/0003）に合わせ、$schema は付けない。
  delete json.$schema;
  return json;
}

/** 初回検査の response_format 用 JSON Schema（json_schema.schema に入れる本体）。 */
export function checkOutputJsonSchema(): Record<string, unknown> {
  return toResponseSchema(checkOutputWire);
}

/** 再確認の response_format 用 JSON Schema。 */
export function recheckOutputJsonSchema(): Record<string, unknown> {
  return toResponseSchema(recheckOutputWire);
}
