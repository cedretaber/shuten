import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, INTERNAL_ERROR_MESSAGE, readJson } from "./api/errors.ts";
import { setupApi } from "./api/test-support.ts";

describe("GET /api/health", () => {
  it("status ok を返し、shared の書記素計数が動く", async () => {
    const harness = setupApi();
    try {
      const res = await harness.app.request("/api/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ status: "ok", graphemeCheck: 1 });
    } finally {
      harness.close();
    }
  });
});

/**
 * 決定 4 の「エラーは 1 形式」を**実配線で**固定する。
 *
 * `api/errors.test.ts` の写像テストは `handleApiError` を直接付けた素の Hono を使っており、
 * 「`/api` にマウントした route が投げた例外が JSON の 1 形式になる」ことまでは見ていない。
 * Task 5 以降のハンドラーはすべてこの経路に乗るので、route を足し始める前にここで留める。
 */
describe("エラーの 1 形式（マウントしたルーター経由）", () => {
  interface ErrorBody {
    readonly error: { readonly code: string; readonly message: string };
  }

  async function requestThrough(
    extendRouter: (router: Hono) => void,
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; contentType: string | null; body: ErrorBody }> {
    const harness = setupApi({ extendRouter });
    try {
      const res = await harness.app.request(path, init);
      return {
        status: res.status,
        contentType: res.headers.get("content-type"),
        body: (await res.json()) as ErrorBody,
      };
    } finally {
      harness.close();
    }
  }

  it("ハンドラーが投げた ApiError が status と code そのままの JSON になる", async () => {
    const { status, contentType, body } = await requestThrough((router) => {
      router.get("/boom", () => {
        throw new ApiError(409, "runs-active", "実行中です");
      });
    }, "/api/boom");

    expect(status).toBe(409);
    expect(contentType).toContain("application/json");
    expect(body).toEqual({ error: { code: "runs-active", message: "実行中です" } });
  });

  it("ハンドラーの zod 検証失敗が 400 validation になる（値は本文に出ない）", async () => {
    const { status, body } = await requestThrough(
      (router) => {
        router.post("/boom", async (c) => {
          const parsed = z.object({ modelId: z.string() }).parse(await readJson(c));
          return c.json(parsed);
        });
      },
      "/api/boom",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: 42 }),
      },
    );

    expect(status).toBe(400);
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("modelId");
    expect(body.error.message).not.toContain("42");
  });

  it("非同期のハンドラーが投げた例外も 500 internal の定型文になる", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { status, body } = await requestThrough((router) => {
        router.get("/boom", async () => {
          await Promise.resolve();
          throw new TypeError("想定外");
        });
      }, "/api/boom");

      expect(status).toBe(500);
      expect(body).toEqual({ error: { code: "internal", message: INTERNAL_ERROR_MESSAGE } });
    } finally {
      spy.mockRestore();
    }
  });

  it("ルーターのミドルウェアが投げた例外も 1 形式になる", async () => {
    const { status, body } = await requestThrough((router) => {
      router.use("/boom", () => {
        throw new ApiError(400, "validation", "入力の検証に失敗しました: id");
      });
      router.get("/boom", (c) => c.json({ ok: true }));
    }, "/api/boom");

    expect(status).toBe(400);
    expect(body.error.code).toBe("validation");
  });
});

describe("A7: 静的配信との共存", () => {
  // 本物の web/dist は使わず、index.html だけを置いた一時ディレクトリで確かめる。
  const distDir = mkdtempSync(path.join(tmpdir(), "shuten-web-dist-"));
  writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>shuten</title>\n");

  afterAll(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  /** 静的配信ありの構成でアプリを 1 つ作り、使い終わったら閉じる。 */
  async function withStaticApp<T>(use: (app: Hono) => Promise<T>): Promise<T> {
    const harness = setupApi({ webDistDir: distDir });
    try {
      return await use(harness.app);
    } finally {
      harness.close();
    }
  }

  it("/api/health は API が返し、静的配信に飲み込まれない", async () => {
    await withStaticApp(async (app) => {
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ status: "ok" });
    });
  });

  it("/api/* 以外は静的配信が返す", async () => {
    await withStaticApp(async (app) => {
      const res = await app.request("/");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("shuten");
    });
  });

  it("R14: 未知の /api/* は JSON の 404（index.html にフォールバックしない）", async () => {
    await withStaticApp(async (app) => {
      const res = await app.request("/api/nope");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ error: { code: "not-found" } });
    });
  });

  it("R14: /api そのものも JSON の 404", async () => {
    await withStaticApp(async (app) => {
      const res = await app.request("/api");
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "not-found" } });
    });
  });

  it("R14: /api/* のマウントは notFound を飲み込まない（POST など他のメソッドでも同じ）", async () => {
    await withStaticApp(async (app) => {
      const res = await app.request("/api/health", { method: "POST" });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "not-found" } });
    });
  });

  it("webDistDir が無ければ静的配信を付けない（API だけが動く）", async () => {
    const harness = setupApi();
    try {
      expect((await harness.app.request("/api/health")).status).toBe(200);
      expect((await harness.app.request("/")).status).toBe(404);
      // 静的配信が無くても未知の /api/* は JSON の 404。
      const res = await harness.app.request("/api/nope");
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "not-found" } });
    } finally {
      harness.close();
    }
  });
});
