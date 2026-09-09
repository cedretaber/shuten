/**
 * `/api` 配下のルーター（PR10 決定 1・4）。
 *
 * 各エンドポイントは Task 5 以降でここに足す。ハンドラーは「zod 検証 → オーケストレーター／
 * リポジトリ呼び出し → DTO 射影 → 状態コード」だけを行い、応答は必ず `respond` を通す
 * （`c.json` を直接呼ばない。決定 3）。例外の写像は `onError` の 1 か所（決定 4）。
 */

import { countGraphemes } from "@shuten/shared";
import { Hono } from "hono";
import { z } from "zod";

import type { ApiDeps } from "./deps.ts";
import { handleApiError, respond } from "./errors.ts";
import { registerManuscriptRoutes } from "./manuscripts.ts";
import { registerRecoveryRoutes } from "./recovery.ts";
import { registerRunRoutes } from "./runs.ts";
import { registerSettingsRoutes } from "./settings.ts";

/**
 * `GET /api/health` の応答（既存のまま）。`shared` パッケージがサーバー側で解決できることの
 * 確認を兼ねる。他の応答と同じく `respond` を通すため、ここにスキーマを持つ。
 */
const healthDtoSchema = z
  .object({
    status: z.literal("ok"),
    node: z.string(),
    graphemeCheck: z.number(),
  })
  .strict();

export function createApiRouter(deps: ApiDeps): Hono {
  const router = new Hono();

  // 決定 4：写像は 1 か所。`route()` で親アプリにマウントしても、この errorHandler が使われる。
  router.onError(handleApiError);

  router.get("/health", (c) =>
    respond(c, healthDtoSchema, {
      status: "ok",
      node: process.version,
      graphemeCheck: countGraphemes("👨‍👩‍👧"),
    }),
  );

  registerSettingsRoutes(router, deps);
  registerRecoveryRoutes(router, deps);
  registerManuscriptRoutes(router, deps);
  registerRunRoutes(router, deps);

  // Task 8 以降がここに route を足す。

  return router;
}
