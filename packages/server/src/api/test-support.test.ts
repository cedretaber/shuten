/**
 * テスト基盤そのものの検査。
 *
 * ここで守るのは「フェイクが投げる `LmStudioError` の `message` に**そのときの接続先 URL**が
 * 入る」という継ぎ目である。これが壊れると、Task 10 の漏えい検査（A0）は番兵の URL を
 * 一度も含まない失敗経路を見ることになり、空振りで通ってしまう。
 */

import { describe, expect, it } from "vitest";

import { LmStudioError } from "../lmstudio/errors.ts";
import type { ChatRequest } from "../lmstudio/types.ts";
import { setupApi } from "./test-support.ts";

const SENTINEL_URL = "http://sentinel.invalid:9";
const SENTINEL_API_KEY = "sentinel-api-key";

const REQUEST: ChatRequest = {
  model: "model-a",
  messages: [{ role: "user", content: "本文" }],
  maxTokens: 16,
  temperature: 0,
};

describe("setupApi", () => {
  it("env をそのまま createConnectionManager に渡す（API キーは値を返さない）", () => {
    const { connection } = setupApi({
      env: { lmStudioUrl: SENTINEL_URL, lmStudioApiKey: SENTINEL_API_KEY },
    });
    expect(connection.describe()).toEqual({ endpointUrl: SENTINEL_URL, hasApiKey: true });
  });

  it("失敗の台本が投げる LmStudioError の message に接続先 URL が入る", async () => {
    const { connection } = setupApi({
      env: { lmStudioUrl: SENTINEL_URL, lmStudioApiKey: null },
      steps: [
        ({ failure }) => {
          throw failure("connection", "応答を受け取れずに切断した");
        },
      ],
    });

    const { client } = connection.current();
    await expect(client.chat(REQUEST, { timeoutMs: 1000 })).rejects.toThrow(/sentinel\.invalid/);
  });

  it("listModels / ensureLoaded の失敗にも接続先 URL が入る", async () => {
    const { connection } = setupApi({
      env: { lmStudioUrl: SENTINEL_URL, lmStudioApiKey: null },
      listModels: ({ failure }) => Promise.reject(failure("connection", "一覧を取得できない")),
      ensureLoaded: ({ failure }) => Promise.reject(failure("model-not-loaded", "未ロード")),
    });

    const { client } = connection.current();
    await expect(client.listModels()).rejects.toThrow(/sentinel\.invalid/);
    await expect(client.ensureLoaded("model-a")).rejects.toThrow(/sentinel\.invalid/);
  });

  it("接続設定を更新すると、以後の失敗には新しい接続先が入る（台本は共有される）", async () => {
    const harness = setupApi({
      env: { lmStudioUrl: SENTINEL_URL, lmStudioApiKey: null },
      steps: [
        ({ failure }) => {
          throw failure("connection");
        },
        ({ failure }) => {
          throw failure("connection");
        },
      ],
    });

    const before = harness.connection.current();
    await expect(before.client.chat(REQUEST, { timeoutMs: 1000 })).rejects.toThrow(
      /sentinel\.invalid/,
    );

    harness.connection.update({ endpointUrl: "http://127.0.0.1:4321" });
    const after = harness.connection.current();
    expect(after.endpointUrl).toBe("http://127.0.0.1:4321");
    // 古いクライアントは閉じられる（回数を数えている）。
    expect(harness.client.closeCalls).toBe(1);

    // 台本は共有されているので、2 件目の台本が使われる。
    const error = await after.client.chat(REQUEST, { timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LmStudioError);
    expect((error as LmStudioError).message).toContain("127.0.0.1:4321");
    expect((error as LmStudioError).message).not.toContain("sentinel");
    expect(harness.client.requests).toHaveLength(2);
  });

  it("台本を使い切ったあとの生成要求は例外にする", async () => {
    const { connection } = setupApi();
    const { client } = connection.current();
    await expect(client.chat(REQUEST, { timeoutMs: 1000 })).rejects.toThrow("台本にない生成要求");
  });
});
