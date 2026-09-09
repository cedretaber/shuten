import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { ApiDeps } from "./api/deps.ts";
import { createApiRouter } from "./api/router.ts";
import type { ServerConfig } from "./config.ts";

/**
 * Hono アプリケーションを組み立てる。
 *
 * - `/api/*` は JSON API（`api/router.ts`）。
 * - それ以外は web パッケージのビルド成果物を静的配信する（存在する場合）。
 *
 * ルーターを静的配信より**先に**マウントする。順序が逆だと `/api/*` にも `index.html` が返る。
 */
export function createApp(config: Pick<ServerConfig, "webDistDir">, deps: ApiDeps): Hono {
  const app = new Hono();

  app.route("/api", createApiRouter(deps));

  if (existsSync(config.webDistDir)) {
    app.use("/*", serveStatic({ root: config.webDistDir }));
    app.get("*", serveStatic({ root: config.webDistDir, path: "index.html" }));
  }

  return app;
}
