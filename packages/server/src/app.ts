import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { countGraphemes } from "@shuten/shared";
import { Hono } from "hono";
import type { ServerConfig } from "./config.ts";

/**
 * Hono アプリケーションを組み立てる。
 *
 * - `/api/*` は JSON API。
 * - それ以外は web パッケージのビルド成果物を静的配信する（存在する場合）。
 */
export function createApp(config: Pick<ServerConfig, "webDistDir">) {
  const app = new Hono();

  app.get("/api/health", (c) => {
    return c.json({
      status: "ok",
      node: process.version,
      // shared パッケージがサーバー側で解決できることの確認を兼ねる
      graphemeCheck: countGraphemes("👨‍👩‍👧"),
    });
  });

  if (existsSync(config.webDistDir)) {
    app.use("/*", serveStatic({ root: config.webDistDir }));
    app.get("*", serveStatic({ root: config.webDistDir, path: "index.html" }));
  }

  return app;
}
