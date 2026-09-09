import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { ApiDeps } from "./api/deps.ts";
import { ApiError, handleApiError } from "./api/errors.ts";
import { createApiRouter } from "./api/router.ts";
import type { ServerConfig } from "./config.ts";

/** `/api` 配下か（`/api` そのものも含む）。 */
function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/**
 * Hono アプリケーションを組み立てる。
 *
 * - `/api/*` は JSON API（`api/router.ts`）。
 * - それ以外は web パッケージのビルド成果物を静的配信する（存在する場合）。
 *
 * ルーターを静的配信より**先に**マウントする。順序が逆だと `/api/*` にも `index.html` が返る。
 * 静的配信は `/api` 配下を対象にしない（裁定 R14）。ルーターに合致しなかった `/api/*` は
 * SPA のフォールバックに拾われず `notFound` まで落ち、**JSON の 404** になる。
 * 200 と HTML を返すと、PR11 の API クライアントは JSON の解析に失敗するだけで、
 * 分岐に使える状態コードを受け取れない。
 */
export function createApp(config: Pick<ServerConfig, "webDistDir">, deps: ApiDeps): Hono {
  const app = new Hono();

  app.route("/api", createApiRouter(deps));

  if (existsSync(config.webDistDir)) {
    const assets = serveStatic({ root: config.webDistDir });
    const spaFallback = serveStatic({ root: config.webDistDir, path: "index.html" });
    app.use("/*", (c, next) => (isApiPath(c.req.path) ? next() : assets(c, next)));
    app.get("*", (c, next) => (isApiPath(c.req.path) ? next() : spaFallback(c, next)));
  }

  // ルーターに合致しなかった `/api/*` は、他のエラーと同じ 1 形式で返す（決定 4）。
  // `message` に要求パスは入れない（利用者の入力をそのまま反射しない）。
  app.notFound((c) =>
    isApiPath(c.req.path)
      ? handleApiError(new ApiError(404, "not-found", "エンドポイントが見つかりません"), c)
      : c.text("Not Found", 404),
  );

  return app;
}
