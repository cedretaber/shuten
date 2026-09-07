import { checkOutputJsonSchema, recheckOutputJsonSchema } from "@shuten/shared";

import type { ChatRequest } from "../lmstudio/types.ts";
import { CHECK_CLOSING, RECHECK_CLOSING } from "./common.ts";
import { NATURALNESS_SYSTEM_PROMPT } from "./naturalness.ts";
import { RECHECK_SYSTEM_PROMPT, renderFindingBlock } from "./recheck.ts";
import { renderUserMessage } from "./render.ts";
import type { CheckRequestInput, GenerationSettings, RecheckRequestInput } from "./types.ts";
import { TYPO_SYSTEM_PROMPT } from "./typo.ts";

/** GenerationSettings をそのまま ChatRequest の生成パラメーターに写す。既定値は作らない。 */
function generationFields(
  generation: GenerationSettings,
): Pick<ChatRequest, "model" | "maxTokens" | "temperature" | "seed" | "reasoningEffort"> {
  return {
    model: generation.model,
    maxTokens: generation.maxTokens,
    temperature: generation.temperature,
    ...(generation.seed !== undefined ? { seed: generation.seed } : {}),
    ...(generation.reasoningEffort !== undefined
      ? { reasoningEffort: generation.reasoningEffort }
      : {}),
  };
}

/** 初回検査の system プロンプトを観点から選ぶ。 */
function checkSystemPrompt(perspective: CheckRequestInput["perspective"]): string {
  return perspective === "typo" ? TYPO_SYSTEM_PROMPT : NATURALNESS_SYSTEM_PROMPT;
}

/** 初回検査の ChatRequest を組み立てる。 */
export function buildCheckRequest(args: CheckRequestInput): ChatRequest {
  const systemPrompt = checkSystemPrompt(args.perspective);
  const userMessage = renderUserMessage({
    text: args.text,
    paragraphs: args.paragraphs,
    input: args.input,
    allowedWords: args.allowedWords,
    closing: CHECK_CLOSING,
  });
  return {
    ...generationFields(args.generation),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    responseFormat: { name: "shuten_check_output", schema: checkOutputJsonSchema() },
  };
}

/** 再確認の ChatRequest を組み立てる。 */
export function buildRecheckRequest(args: RecheckRequestInput): ChatRequest {
  const closing = `${renderFindingBlock(args.finding, args.paragraphs)}\n\n${RECHECK_CLOSING}`;
  const userMessage = renderUserMessage({
    text: args.text,
    paragraphs: args.paragraphs,
    input: args.input,
    allowedWords: args.allowedWords,
    closing,
  });
  return {
    ...generationFields(args.generation),
    messages: [
      { role: "system", content: RECHECK_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    responseFormat: { name: "shuten_recheck_output", schema: recheckOutputJsonSchema() },
  };
}
