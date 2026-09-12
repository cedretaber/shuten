import { hashBody } from "@shuten/server/hash.ts";
import { LmStudioError } from "@shuten/server/lmstudio/errors.ts";
import type {
  ChatRequest,
  ChatResult,
  LmStudioClient,
  ModelInfo,
} from "@shuten/server/lmstudio/types.ts";
import type { GenerationSettings } from "@shuten/server/prompts/types.ts";
import { describe, expect, it, vi } from "vitest";

import { runFullChat } from "./full-chat.ts";

/** テスト用の合成原稿・プロンプト。実原稿は使わない。 */
const PROMPT = "指示文。\n{{manuscript}}\n以上。";
const TEXT = "これは合成のテスト原稿です。二文目もある。";

const GENERATION: GenerationSettings = {
  model: "test-model",
  maxTokens: 100,
  temperature: 0.2,
  seed: 7,
  reasoningEffort: "low",
};

function makeModelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "test-model",
    type: "llm",
    state: "loaded",
    quantization: null,
    maxContextLength: null,
    loadedContextLength: null,
    ...overrides,
  };
}

function makeChatResult(overrides: Partial<ChatResult> = {}): ChatResult {
  return {
    content: "応答本文",
    reasoningContent: null,
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, reasoningTokens: null },
    raw: { dummy: true },
    ...overrides,
  };
}

/** `listModels` / `close` はこのテストでは使わないのでエラーにしておく（呼ばれたら気づけるように）。 */
function makeClient(overrides: {
  readonly ensureLoaded?: LmStudioClient["ensureLoaded"];
  readonly chat?: LmStudioClient["chat"];
}): LmStudioClient {
  return {
    listModels: vi.fn().mockRejectedValue(new Error("listModels は呼ばれない想定")),
    ensureLoaded: overrides.ensureLoaded ?? vi.fn().mockResolvedValue(makeModelInfo()),
    chat: overrides.chat ?? vi.fn().mockResolvedValue(makeChatResult()),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const FIXED_NOW = () => new Date("2026-09-12T00:00:00.000Z");

describe("runFullChat", () => {
  describe("成功時の要求の形（T12）", () => {
    it("responseFormat を渡さず、messages が差し込み済みの user 1 通だけになる", async () => {
      const chat = vi.fn().mockResolvedValue(makeChatResult());
      const client = makeClient({ chat });

      const result = await runFullChat({
        text: TEXT,
        prompt: PROMPT,
        generation: GENERATION,
        timeoutMs: 1000,
        client,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(true);
      expect(chat).toHaveBeenCalledTimes(1);
      const request = chat.mock.calls[0]?.[0] as ChatRequest;
      expect(request).not.toHaveProperty("responseFormat");
      expect(request.messages).toEqual([
        { role: "user", content: "指示文。\nこれは合成のテスト原稿です。二文目もある。\n以上。" },
      ]);
      // 手順 3：ensureLoaded に options を渡さない（run/executor.ts:280 と同じ）。
      expect(client.ensureLoaded).toHaveBeenCalledWith("test-model");
      expect(chat.mock.calls[0]?.[1]).toEqual({ timeoutMs: 1000 });
    });

    it("reasoningContent が結果の別項目に入る", async () => {
      const client = makeClient({
        chat: vi.fn().mockResolvedValue(makeChatResult({ reasoningContent: "思考過程" })),
      });

      const result = await runFullChat({
        text: TEXT,
        prompt: PROMPT,
        generation: GENERATION,
        timeoutMs: 1000,
        client,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.reasoningContent).toBe("思考過程");
      expect(result.value.content).toBe("応答本文");
    });

    it("{{manuscript}} が無いプロンプトでは ok: false になり、chat も ensureLoaded も呼ばれない", async () => {
      const ensureLoaded = vi.fn().mockResolvedValue(makeModelInfo());
      const chat = vi.fn().mockResolvedValue(makeChatResult());
      const client = makeClient({ ensureLoaded, chat });

      const result = await runFullChat({
        text: TEXT,
        prompt: "原稿を差し込む目印を含まないプロンプト",
        generation: GENERATION,
        timeoutMs: 1000,
        client,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(false);
      expect(ensureLoaded).not.toHaveBeenCalled();
      expect(chat).not.toHaveBeenCalled();
    });

    it("truncated 例外（finish_reason: length）で failed になり本文を残さない", async () => {
      const client = makeClient({
        chat: vi
          .fn()
          .mockRejectedValue(
            new LmStudioError("truncated", "打ち切られた", { finishReason: "length" }),
          ),
      });

      const result = await runFullChat({
        text: TEXT,
        prompt: PROMPT,
        generation: GENERATION,
        timeoutMs: 1000,
        client,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("failed");
      expect(result.value.content).toBeNull();
      expect(result.value.failure?.finishReason).toBe("length");
    });
  });

  describe("モデル種別（T21）", () => {
    it.each(["llm", "vlm"] as const)("type: %s では chat が呼ばれる", async (type) => {
      const chat = vi.fn().mockResolvedValue(makeChatResult());
      const client = makeClient({
        ensureLoaded: vi.fn().mockResolvedValue(makeModelInfo({ type })),
        chat,
      });

      const result = await runFullChat({
        text: TEXT,
        prompt: PROMPT,
        generation: GENERATION,
        timeoutMs: 1000,
        client,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(true);
      expect(chat).toHaveBeenCalledTimes(1);
    });

    it.each([["embeddings"], [null]] as const)(
      "type: %s では chat が呼ばれず model-not-loaded として failed になる",
      async (type) => {
        const chat = vi.fn().mockResolvedValue(makeChatResult());
        const client = makeClient({
          ensureLoaded: vi.fn().mockResolvedValue(makeModelInfo({ type })),
          chat,
        });

        const result = await runFullChat({
          text: TEXT,
          prompt: PROMPT,
          generation: GENERATION,
          timeoutMs: 1000,
          client,
          now: FIXED_NOW,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(chat).not.toHaveBeenCalled();
        expect(result.value.status).toBe("failed");
        expect(result.value.failure?.reason).toBe("model-not-loaded");
        expect(result.value.failure?.origin).toBe("ensure-loaded");
      },
    );
  });

  describe("結果に入れないもの（T30）", () => {
    it("原稿・プロンプトの目印がどちらも結果 JSON に含まれない", async () => {
      const manuscriptMarker = "ZZ原稿の目印ZZ";
      const promptMarker = "YYプロンプトの目印YY";
      const text = `${manuscriptMarker}を含む原稿。`;
      const prompt = `${promptMarker}\n{{manuscript}}`;
      // モックの応答本文にはどちらの目印も含めない（決定 36 のテストが正しい理由で落ちるように）。
      const client = makeClient({ chat: vi.fn().mockResolvedValue(makeChatResult()) });

      const result = await runFullChat({
        text,
        prompt,
        generation: GENERATION,
        timeoutMs: 1000,
        client,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(true);
      const json = JSON.stringify(result);
      expect(json).not.toContain(manuscriptMarker);
      expect(json).not.toContain(promptMarker);
    });

    it("conditions.promptHash が差し込み前のプロンプトの hashBody と一致する", async () => {
      const client = makeClient({});

      const result = await runFullChat({
        text: TEXT,
        prompt: PROMPT,
        generation: GENERATION,
        timeoutMs: 1000,
        client,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.conditions.promptHash).toBe(hashBody(PROMPT));
    });

    it("JSON.stringify(result) に raw が含まれない", async () => {
      const client = makeClient({
        chat: vi.fn().mockResolvedValue(makeChatResult({ raw: { secret: "RAW_MARKER_XYZ" } })),
      });

      const result = await runFullChat({
        text: TEXT,
        prompt: PROMPT,
        generation: GENERATION,
        timeoutMs: 1000,
        client,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(true);
      const json = JSON.stringify(result);
      expect(json).not.toContain("RAW_MARKER_XYZ");
      expect(json).not.toContain('"raw"');
    });
  });

  describe("失敗の記録（T31）", () => {
    it("ensureLoaded が LmStudioError を投げたとき failed になり conditions.model が null", async () => {
      const client = makeClient({
        ensureLoaded: vi.fn().mockRejectedValue(new LmStudioError("model-not-loaded", "未ロード")),
      });

      const result = await runFullChat({
        text: TEXT,
        prompt: PROMPT,
        generation: GENERATION,
        timeoutMs: 1000,
        client,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("failed");
      expect(result.value.failure?.origin).toBe("ensure-loaded");
      expect(result.value.conditions.model).toBeNull();
    });

    it("chat が例外を投げずに finishReason: tool_calls を返したとき failed / truncated として扱い、1 回しか呼ばれない", async () => {
      const chat = vi.fn().mockResolvedValue(makeChatResult({ finishReason: "tool_calls" }));
      const client = makeClient({ chat });

      const result = await runFullChat({
        text: TEXT,
        prompt: PROMPT,
        generation: GENERATION,
        timeoutMs: 1000,
        client,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("failed");
      expect(result.value.failure?.reason).toBe("truncated");
      expect(result.value.failure?.finishReason).toBe("tool_calls");
      expect(result.value.content).toBeNull();
      expect(chat).toHaveBeenCalledTimes(1);
    });

    it("LmStudioError でない例外はそのまま投げ直される（ensureLoaded 由来）", async () => {
      const client = makeClient({
        ensureLoaded: vi.fn().mockRejectedValue(new Error("boom")),
      });

      await expect(
        runFullChat({
          text: TEXT,
          prompt: PROMPT,
          generation: GENERATION,
          timeoutMs: 1000,
          client,
          now: FIXED_NOW,
        }),
      ).rejects.toThrow("boom");
    });

    it("LmStudioError でない例外はそのまま投げ直される（chat 由来）", async () => {
      const client = makeClient({
        chat: vi.fn().mockRejectedValue(new Error("boom-chat")),
      });

      await expect(
        runFullChat({
          text: TEXT,
          prompt: PROMPT,
          generation: GENERATION,
          timeoutMs: 1000,
          client,
          now: FIXED_NOW,
        }),
      ).rejects.toThrow("boom-chat");
    });
  });
});
