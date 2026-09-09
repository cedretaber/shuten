import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { setupApi } from "./api/test-support.ts";

describe("GET /api/health", () => {
  it("status ok を返し、shared の書記素計数が動く", async () => {
    const { app } = setupApi();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", graphemeCheck: 1 });
  });
});

describe("A7: 静的配信との共存", () => {
  // 本物の web/dist は使わず、index.html だけを置いた一時ディレクトリで確かめる。
  const distDir = mkdtempSync(path.join(tmpdir(), "shuten-web-dist-"));
  writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>shuten</title>\n");

  afterAll(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  it("/api/health は API が返し、静的配信に飲み込まれない", async () => {
    const { app } = setupApi({ webDistDir: distDir });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("/api/* 以外は静的配信が返す", async () => {
    const { app } = setupApi({ webDistDir: distDir });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("shuten");
  });

  // 未知の `/api/*` は、静的配信の SPA フォールバック（`app.get("*", index.html)`）に拾われて
  // 200 と index.html を返す。PR9 以前からの挙動で、本 Task では変えない（ルーターに
  // catch-all を足すと、Task 5 以降が足す route の登録順に依存する罠を作るため）。
  // JSON の 404 を返したい場合は別途決める（計画書のエンドポイント一覧に規定が無い）。

  it("webDistDir が無ければ静的配信を付けない（API だけが動く）", async () => {
    const { app } = setupApi();
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/")).status).toBe(404);
  });
});
