import type { RunDto } from "@shuten/shared";
import { InvalidChunkSettingsError, runDtoSchema, Utf8DecodeError } from "@shuten/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { InvalidLmStudioUrlError } from "../config.ts";
import { MalformedBodyError } from "../db/errors.ts";
import { LmStudioError } from "../lmstudio/errors.ts";
import { RetryTargetError } from "../run/orchestrator.ts";
import {
  ApiError,
  handleApiError,
  INTERNAL_ERROR_MESSAGE,
  notFound,
  readJson,
  respond,
} from "./errors.ts";

/** 番兵。エラー本文・ログのどちらにも出てはならない（決定 4・不変条件）。 */
const SENTINEL_URL = "http://sentinel.invalid:9";

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/** 投げるだけのアプリ。`handleApiError` を `onError` に付けた形で写像を観測する。 */
function throwingApp(error: unknown): Hono {
  const app = new Hono();
  app.onError(handleApiError);
  app.get("/x", () => {
    throw error;
  });
  return app;
}

async function requestError(error: unknown): Promise<{ status: number; body: ErrorBody }> {
  const res = await throwingApp(error).request("/x");
  return { status: res.status, body: (await res.json()) as ErrorBody };
}

describe("handleApiError", () => {
  it("ApiError はその status / code / message をそのまま返す", async () => {
    const { status, body } = await requestError(new ApiError(409, "runs-active", "実行中です"));
    expect(status).toBe(409);
    expect(body).toEqual({ error: { code: "runs-active", message: "実行中です" } });
  });

  it("notFound は 404 not-found で、message に対象と ID だけを入れる", async () => {
    const { status, body } = await requestError(notFound("実行", "run-1"));
    expect(status).toBe(404);
    expect(body.error.code).toBe("not-found");
    expect(body.error.message).toContain("run-1");
  });

  it("A7: zod 失敗は 400 validation で、message にパス名だけが入り値が入らない", async () => {
    const schema = z.object({ modelId: z.string(), timeouts: z.object({ checkMs: z.number() }) });
    const result = schema.safeParse({ modelId: 42, timeouts: { checkMs: "秘密の値" } });
    expect(result.success).toBe(false);
    const { status, body } = await requestError(result.error);

    expect(status).toBe(400);
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("modelId");
    expect(body.error.message).toContain("timeouts.checkMs");
    expect(body.error.message).not.toContain("秘密の値");
    expect(body.error.message).not.toContain("42");
  });

  it("schema.parse が投げた例外も 400 validation になる（ハンドラーの実経路）", async () => {
    // 各 Task のハンドラーは `schema.parse(await readJson(c))` と書く。zod 4 の `parse` が
    // 投げるのは `safeParse().error` と同じクラスとは限らないので、実際に投げさせて確かめる。
    const app = new Hono();
    app.onError(handleApiError);
    app.get("/x", () => {
      z.object({ id: z.string() }).parse({ id: 1 });
      return new Response("unreachable");
    });

    const res = await app.request("/x");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("id");
  });

  it("MalformedBodyError は 400 malformed-body", async () => {
    const { status, body } = await requestError(new MalformedBodyError("孤立サロゲート"));
    expect(status).toBe(400);
    expect(body.error.code).toBe("malformed-body");
  });

  it("Utf8DecodeError は 400 invalid-utf8", async () => {
    const { status, body } = await requestError(new Utf8DecodeError());
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid-utf8");
  });

  it("InvalidChunkSettingsError は 400 invalid-run-settings", async () => {
    const { status, body } = await requestError(new InvalidChunkSettingsError("分割設定が不正"));
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid-run-settings");
  });

  it("RetryTargetError は 400 invalid-retry-target", async () => {
    const { status, body } = await requestError(new RetryTargetError("cu-1 は対象外"));
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid-retry-target");
  });

  it("InvalidLmStudioUrlError は 400 validation で、message に URL を出さない", async () => {
    const { status, body } = await requestError(
      new InvalidLmStudioUrlError(`URL が不正です: ${SENTINEL_URL}`),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("validation");
    expect(body.error.message).not.toContain("sentinel");
  });

  it("A7: 未知の例外は 500 internal で、本文は定型文だけ", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { status, body } = await requestError(new TypeError(`想定外 ${SENTINEL_URL}`));
      expect(status).toBe(500);
      expect(body).toEqual({ error: { code: "internal", message: INTERNAL_ERROR_MESSAGE } });
      expect(JSON.stringify(body)).not.toContain("sentinel");
    } finally {
      spy.mockRestore();
    }
  });

  it("Error ではない値でも 500 internal になる", async () => {
    // Hono は Error 以外の throw を onError に渡さず「Unknown Error」にするので、
    // ここは写像そのものを直接呼んで確かめる（`handleApiError` は unknown を受ける）。
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = new Hono();
      app.get("/x", (c) => handleApiError("文字列を投げた", c));
      const res = await app.request("/x");
      expect(res.status).toBe(500);
      expect((await res.json()) as ErrorBody).toEqual({
        error: { code: "internal", message: INTERNAL_ERROR_MESSAGE },
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("500 のログに LmStudioError の message（接続先を含みうる）を出さない", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { status, body } = await requestError(
        new LmStudioError("connection", `${SENTINEL_URL} に接続できません`),
      );
      expect(status).toBe(500);
      expect(JSON.stringify(body)).not.toContain("sentinel");

      const logged = spy.mock.calls
        .map((call) => call.map((arg) => String(arg)).join(" "))
        .join("\n");
      expect(logged).toContain("LmStudioError");
      expect(logged).not.toContain("sentinel");
    } finally {
      spy.mockRestore();
    }
  });
});

/** ---------------------------------------------------------------------- */
/** readJson */
/** ---------------------------------------------------------------------- */

/** `readJson` の結果、または写った `ApiError` を JSON で返すアプリ。 */
function readJsonApp(options?: { readonly optional?: boolean }): Hono {
  const app = new Hono();
  app.onError(handleApiError);
  app.post("/x", async (c) => c.json({ value: await readJson(c, options) }));
  return app;
}

async function postBody(
  app: Hono,
  body: string | undefined,
  contentType: string | undefined,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (contentType !== undefined) {
    headers["content-type"] = contentType;
  }
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    Object.assign(init, { body });
  }
  const res = await app.request("/x", init);
  return { status: res.status, json: await res.json() };
}

describe("readJson", () => {
  it("application/json の正しい JSON をそのまま返す", async () => {
    const { status, json } = await postBody(
      readJsonApp(),
      JSON.stringify({ a: 1 }),
      "application/json",
    );
    expect(status).toBe(200);
    expect(json).toEqual({ value: { a: 1 } });
  });

  it("charset 付きの Content-Type も受け付ける", async () => {
    const { status, json } = await postBody(
      readJsonApp(),
      JSON.stringify({ a: 1 }),
      "application/json; charset=utf-8",
    );
    expect(status).toBe(200);
    expect(json).toEqual({ value: { a: 1 } });
  });

  it("A7: Content-Type が text/plain なら 400 invalid-json（500 にしない）", async () => {
    const { status, json } = await postBody(readJsonApp(), JSON.stringify({ a: 1 }), "text/plain");
    expect(status).toBe(400);
    expect((json as ErrorBody).error.code).toBe("invalid-json");
  });

  it("Content-Type が無ければ 400 invalid-json", async () => {
    const { status, json } = await postBody(readJsonApp(), JSON.stringify({ a: 1 }), undefined);
    expect(status).toBe(400);
    expect((json as ErrorBody).error.code).toBe("invalid-json");
  });

  it("A7: 壊れた JSON は 400 invalid-json（500 にしない）", async () => {
    const { status, json } = await postBody(readJsonApp(), "{ こわれた", "application/json");
    expect(status).toBe(400);
    expect((json as ErrorBody).error.code).toBe("invalid-json");
  });

  it("空本文は 400 invalid-json", async () => {
    const { status, json } = await postBody(readJsonApp(), "", "application/json");
    expect(status).toBe(400);
    expect((json as ErrorBody).error.code).toBe("invalid-json");
  });

  it("optional なら空本文を {} として返す", async () => {
    const { status, json } = await postBody(
      readJsonApp({ optional: true }),
      "",
      "application/json",
    );
    expect(status).toBe(200);
    expect(json).toEqual({ value: {} });
  });

  it("optional でも Content-Type が application/json でなければ 400 invalid-json", async () => {
    const { status, json } = await postBody(readJsonApp({ optional: true }), "", "text/plain");
    expect(status).toBe(400);
    expect((json as ErrorBody).error.code).toBe("invalid-json");
  });

  it("optional でも壊れた JSON は 400 invalid-json", async () => {
    const { status, json } = await postBody(
      readJsonApp({ optional: true }),
      "{ こわれた",
      "application/json",
    );
    expect(status).toBe(400);
    expect((json as ErrorBody).error.code).toBe("invalid-json");
  });
});

/** ---------------------------------------------------------------------- */
/** respond */
/** ---------------------------------------------------------------------- */

describe("respond", () => {
  const schema = z.object({ id: z.string() }).strict();

  function respondApp(value: { readonly id: string }, status?: 200 | 201 | 202): Hono {
    const app = new Hono();
    app.onError(handleApiError);
    app.get("/x", (c) => respond(c, schema, value, status));
    return app;
  }

  it("スキーマを通った値を JSON で返す（既定は 200）", async () => {
    const res = await respondApp({ id: "a" }).request("/x");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ id: "a" });
  });

  it("status を指定できる（201 / 202）", async () => {
    expect((await respondApp({ id: "a" }, 201).request("/x")).status).toBe(201);
    expect((await respondApp({ id: "a" }, 202).request("/x")).status).toBe(202);
  });

  it("A7: スキーマに合わない値は 500 internal になり、値の中身が本文に出ない", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // 射影漏れの再現：`endpointUrl` を落とさずに `RunRecord` をそのまま渡した場合。
      const leaky = { id: "run-1", endpointUrl: SENTINEL_URL } as unknown as RunDto;
      const app = new Hono();
      app.onError(handleApiError);
      app.get("/x", (c) => respond(c, runDtoSchema, leaky));

      const res = await app.request("/x");
      const text = await res.text();

      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        error: { code: "internal", message: INTERNAL_ERROR_MESSAGE },
      });
      expect(text).not.toContain("sentinel");
      expect(text).not.toContain("run-1");

      // ログにもキーのパスだけを出す（値は出さない）。
      const logged = spy.mock.calls
        .map((call) => call.map((arg) => String(arg)).join(" "))
        .join("\n");
      expect(logged).not.toContain("sentinel");
    } finally {
      spy.mockRestore();
    }
  });
});
