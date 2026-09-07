import type { LlmCheckOutput, LlmRecheckOutput } from "@shuten/shared";
import { llmCheckOutputSchema, llmRecheckOutputSchema } from "@shuten/shared";
import type { ZodType } from "zod";

import { LmStudioError } from "../lmstudio/errors.ts";
import type { ChatResult } from "../lmstudio/types.ts";

/** zod の issues から path・message を数件つなげた要約を作る。応答本文の値そのものは入れない。 */
function summarizeIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  const MAX_ISSUES = 3;
  const parts = issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  const omitted = issues.length - parts.length;
  return omitted > 0 ? `${parts.join(" / ")}（他 ${String(omitted)} 件）` : parts.join(" / ");
}

/** `content` を JSON として解析し、スキーマで検証する。共通部分を型引数で切り替える。 */
function parseResponse<T>(result: ChatResult, schema: ZodType<T>): T {
  let json: unknown;
  try {
    json = JSON.parse(result.content) as unknown;
  } catch (err) {
    throw new LmStudioError("malformed", "LM Studio の応答を JSON として解析できなかった", {
      usage: result.usage,
      finishReason: result.finishReason,
      raw: result.raw,
      cause: err,
    });
  }

  const validated = schema.safeParse(json);
  if (!validated.success) {
    const summary = summarizeIssues(validated.error.issues);
    throw new LmStudioError("malformed", `LM Studio の応答がスキーマに一致しなかった: ${summary}`, {
      usage: result.usage,
      finishReason: result.finishReason,
      raw: result.raw,
      cause: validated.error,
    });
  }
  return validated.data;
}

/**
 * 初回検査の応答を解析する。`finishReason` は見ない（`length` の打ち切りは
 * PR5 のクライアントが既に `truncated` として例外にしている）。
 */
export function parseCheckResponse(result: ChatResult): LlmCheckOutput {
  return parseResponse(result, llmCheckOutputSchema);
}

/** 再確認の応答を解析する。処理は parseCheckResponse と同じ形。 */
export function parseRecheckResponse(result: ChatResult): LlmRecheckOutput {
  return parseResponse(result, llmRecheckOutputSchema);
}
