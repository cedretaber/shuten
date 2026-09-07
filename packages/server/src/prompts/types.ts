import type { CheckInput, MergedFinding, Paragraph, Perspective } from "@shuten/shared";

import type { ReasoningEffort } from "../lmstudio/types.ts";

/** 生成パラメーター。既定値は持たない（仕様書 13 節が未決のため、呼び出し元が決める）。 */
export interface GenerationSettings {
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly seed?: number | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
}

/** 初回検査の要求を組み立てる入力。 */
export interface CheckRequestInput {
  /** 保存本文（BOM 除外済み）。 */
  readonly text: string;
  /** 原稿版全体の段落。 */
  readonly paragraphs: readonly Paragraph[];
  readonly input: CheckInput;
  readonly perspective: Perspective;
  /** 整形済みの許容語（trim・空行除去は呼び出し元の責務）。 */
  readonly allowedWords: readonly string[];
  readonly generation: GenerationSettings;
}

/** 再確認の要求を組み立てる入力。 */
export interface RecheckRequestInput {
  readonly text: string;
  readonly paragraphs: readonly Paragraph[];
  /** buildRecheckInput の結果。target は初回と同じ。 */
  readonly input: CheckInput;
  readonly finding: MergedFinding;
  readonly allowedWords: readonly string[];
  readonly generation: GenerationSettings;
}
