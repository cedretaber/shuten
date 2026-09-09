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

  it("R14: 未知の /api/* は JSON の 404（index.html にフォールバックしない）", async () => {
    const { app } = setupApi({ webDistDir: distDir });
    const res = await app.request("/api/nope");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ error: { code: "not-found" } });
  });

  it("R14: /api そのものも JSON の 404", async () => {
    const { app } = setupApi({ webDistDir: distDir });
    const res = await app.request("/api");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not-found" } });
  });

  it("R14: /api/* のマウントは notFound を飲み込まない（POST など他のメソッドでも同じ）", async () => {
    const { app } = setupApi({ webDistDir: distDir });
    const res = await app.request("/api/health", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not-found" } });
  });

  it("webDistDir が無ければ静的配信を付けない（API だけが動く）", async () => {
    const { app } = setupApi();
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/")).status).toBe(404);
    // 静的配信が無くても未知の /api/* は JSON の 404。
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not-found" } });
  });
});
