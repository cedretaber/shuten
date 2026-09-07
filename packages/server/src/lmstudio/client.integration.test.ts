import { checkOutputJsonSchema, llmCheckOutputSchema } from "@shuten/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { parseLmStudioApiKey, parseLmStudioUrl } from "../config.ts";
import { createLmStudioClient } from "./client.ts";
import type { LmStudioError } from "./errors.ts";
import type { ChatRequest, LmStudioClient, ModelInfo } from "./types.ts";
import { LOADED_STATE } from "./types.ts";

/**
 * 実 LM Studio を使う統合テスト（決定 10）。`SHUTEN_LM_STUDIO_URL` が未設定ならファイルごと skip する。
 * `pnpm test` には混ざらない（`vitest.config.ts` が `**\/*.integration.test.ts` を除外する）。
 * 実行には `pnpm test:llm` を使う（別プロジェクト `vitest.integration.config.ts`）。
 */

const rawUrl = process.env.SHUTEN_LM_STUDIO_URL;

describe.skipIf(!rawUrl)("LmStudioClient（実 LM Studio）", () => {
  // describe.skipIf はテストを skip 扱いにするだけで、describe 本体は skip 時にも実行される。
  // そのため rawUrl の解析はここで先に済ませず、未設定時に例外が飛ばないようにする。
  const baseUrl = rawUrl ? parseLmStudioUrl(rawUrl) : "";
  const apiKey = parseLmStudioApiKey(process.env.SHUTEN_LM_STUDIO_API_KEY);
  const requestedModelId = process.env.SHUTEN_LM_STUDIO_MODEL;

  let client: LmStudioClient;
  let models: ModelInfo[];
  /** 生成テスト用のモデル ID。ロード済みの llm/vlm が無ければ null（該当テストは ctx.skip() で飛ばす）。 */
  let generationModelId: string | null;

  beforeAll(async () => {
    client = createLmStudioClient({ baseUrl, apiKey });
    models = await client.listModels();
    if (requestedModelId !== undefined) {
      generationModelId = requestedModelId;
    } else {
      const found = models.find(
        (model) => model.state === LOADED_STATE && (model.type === "llm" || model.type === "vlm"),
      );
      generationModelId = found?.id ?? null;
    }
  });

  it("モデル一覧に type・state・quantization・loaded_context_length が含まれる（決定 4 の未記録項目）", () => {
    const loaded = models.find((model) => model.state === LOADED_STATE);
    expect(
      loaded,
      "ロード済みのモデルが 1 つもない（LM Studio でモデルをロードしてから実行する）",
    ).toBeDefined();
    expect(loaded?.type).not.toBeNull();
    expect(loaded?.state).toBe(LOADED_STATE);
    expect(loaded?.quantization).not.toBeNull();
    expect(loaded?.loadedContextLength).not.toBeNull();
  });

  it("ensureLoaded は未ロードのモデル ID で model-not-loaded を投げる", async () => {
    const nonExistentId = "shuten-integration-test-nonexistent-model-id";
    await expect(client.ensureLoaded(nonExistentId)).rejects.toMatchObject({
      kind: "model-not-loaded",
    } satisfies Partial<LmStudioError>);
  });

  it("小さな生成要求が stop で返り、usage が埋まる", async (ctx) => {
    if (generationModelId === null) {
      ctx.skip();
      return;
    }
    const request: ChatRequest = {
      model: generationModelId,
      messages: [
        { role: "system", content: "あなたは簡潔に答える日本語のアシスタントです。" },
        { role: "user", content: "「こんにちは」を英語に一言で訳してください。" },
      ],
      maxTokens: 2000,
      temperature: 0,
      reasoningEffort: "none",
    };
    const result = await client.chat(request, { timeoutMs: 120_000 });
    expect(result.finishReason).toBe("stop");
    expect(result.usage).not.toBeNull();
    expect(result.usage?.promptTokens).toBeGreaterThan(0);
    expect(result.usage?.completionTokens).toBeGreaterThan(0);
  });

  it("checkOutputJsonSchema() を response_format に渡した応答が llmCheckOutputSchema で検証できる（PR4 の疎通確認）", async (ctx) => {
    if (generationModelId === null) {
      ctx.skip();
      return;
    }
    const request: ChatRequest = {
      model: generationModelId,
      messages: [
        {
          role: "system",
          content: "あなたは日本語の文章から誤字を見つける校正者です。",
        },
        {
          role: "user",
          content: "次の文から誤字を探してください：「今日は天気が良いので散歩に行こく。」",
        },
      ],
      maxTokens: 2000,
      temperature: 0,
      reasoningEffort: "none",
      responseFormat: {
        name: "findings",
        schema: checkOutputJsonSchema(),
      },
    };
    const result = await client.chat(request, { timeoutMs: 120_000 });
    const parsedJson: unknown = JSON.parse(result.content);
    // 検出件数は品質評価（仕様書 10 節）に使わない。スキーマとして解析できることだけ確認する。
    expect(() => llmCheckOutputSchema.parse(parsedJson)).not.toThrow();
  });
});
