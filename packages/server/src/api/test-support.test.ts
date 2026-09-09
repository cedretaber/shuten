/**
 * テスト基盤そのものの検査。
 *
 * ここで守るのは 2 つ。
 *
 * 1. フェイクが `createClient` の `baseUrl` に結び直され、台本がその接続先を読めること
 *    （`PUT /api/settings/connection` が実行に効くことの土台）。
 * 2. 失敗の台本が投げる `LmStudioError` の `message` に**接続先 URL が入らない**こと
 *    （裁定 R12。実クライアントと同じ性質にする）。代わりに `FAKE_FAILURE_MARKER` が入るので、
 *    A0（Task 10）は「失敗経路を実際に通ったか」をその印で確かめられる。
 */

import { afterEach, describe, expect, it } from "vitest";

import { LmStudioError } from "../lmstudio/errors.ts";
import type { ChatRequest } from "../lmstudio/types.ts";
import { FAKE_FAILURE_MARKER } from "../run/test-support.ts";
import { setupApi } from "./test-support.ts";

const SENTINEL_URL = "http://sentinel.invalid:9";
const SENTINEL_API_KEY = "sentinel-api-key";

const REQUEST: ChatRequest = {
  model: "model-a",
  messages: [{ role: "user", content: "本文" }],
  maxTokens: 16,
  temperature: 0,
};

/**
 * 作ったハーネスを覚えておき、テストごとに閉じる。`setupApi()` はメモリ DB を開くので、
 * 閉じないと better-sqlite3 のハンドルが積み上がる（Task 5 以降はこの形を真似ること）。
 */
const opened: Array<{ close: () => void }> = [];
function open(...args: Parameters<typeof setupApi>): ReturnType<typeof setupApi> {
  const harness = setupApi(...args);
  opened.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of opened.splice(0)) {
    harness.close();
  }
});

describe("setupApi", () => {
  it("env をそのまま createConnectionManager に渡す（API キーは値を返さない）", () => {
    const { connection } = open({
      env: { lmStudioUrl: SENTINEL_URL, lmStudioApiKey: SENTINEL_API_KEY },
    });
    expect(connection.describe()).toEqual({ endpointUrl: SENTINEL_URL, hasApiKey: true });
  });

  it("台本は自分が結ばれている接続先を文脈から読める", async () => {
    const seen: string[] = [];
    const harness = open({
      env: { lmStudioUrl: SENTINEL_URL, lmStudioApiKey: null },
      steps: [
        ({ endpointUrl, failure }) => {
          seen.push(endpointUrl);
          throw failure("connection");
        },
        ({ endpointUrl, failure }) => {
          seen.push(endpointUrl);
          throw failure("connection");
        },
      ],
    });

    await harness.connection
      .current()
      .client.chat(REQUEST, { timeoutMs: 1000 })
      .catch(() => undefined);

    harness.connection.update({ endpointUrl: "http://127.0.0.1:4321" });
    expect(harness.connection.current().endpointUrl).toBe("http://127.0.0.1:4321");
    // 古いクライアントは閉じられる（回数を数えている）。
    expect(harness.client.closeCalls).toBe(1);

    await harness.connection
      .current()
      .client.chat(REQUEST, { timeoutMs: 1000 })
      .catch(() => undefined);

    // 台本・記録は共有され、接続先だけが差し替わる。
    expect(seen).toEqual([SENTINEL_URL, "http://127.0.0.1:4321"]);
    expect(harness.client.requests).toHaveLength(2);
  });

  it("R12: 失敗の message に接続先 URL を入れず、失敗の印を入れる", async () => {
    const { connection } = open({
      env: { lmStudioUrl: SENTINEL_URL, lmStudioApiKey: null },
      steps: [
        ({ failure }) => {
          throw failure("connection", "応答を受け取れずに切断した");
        },
      ],
    });

    const error = await connection
      .current()
      .client.chat(REQUEST, { timeoutMs: 1000 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LmStudioError);
    const message = (error as LmStudioError).message;
    expect(message).toContain(`${FAKE_FAILURE_MARKER}-connection`);
    expect(message).not.toContain("sentinel");
    expect(String((error as LmStudioError).stack)).not.toContain("sentinel");
  });

  it("R12: listModels / ensureLoaded の失敗も同じ性質を持つ", async () => {
    const { connection } = open({
      env: { lmStudioUrl: SENTINEL_URL, lmStudioApiKey: null },
      listModels: ({ failure }) => Promise.reject(failure("connection", "一覧を取得できない")),
      ensureLoaded: ({ failure }) => Promise.reject(failure("model-not-loaded", "未ロード")),
    });
    const { client } = connection.current();

    for (const promise of [client.listModels(), client.ensureLoaded("model-a")]) {
      const error = await promise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LmStudioError);
      expect((error as LmStudioError).message).toContain(FAKE_FAILURE_MARKER);
      expect((error as LmStudioError).message).not.toContain("sentinel");
    }
  });

  it("close は冪等（2 回呼んでも例外にならない）", () => {
    const harness = open();
    expect(() => {
      harness.close();
      harness.close();
    }).not.toThrow();
  });

  it("台本を使い切ったあとの生成要求は例外にする", async () => {
    const { connection } = open();
    const { client } = connection.current();
    await expect(client.chat(REQUEST, { timeoutMs: 1000 })).rejects.toThrow("台本にない生成要求");
  });
});
