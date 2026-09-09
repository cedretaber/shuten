/**
 * 接続設定の口（PR10 決定 5・8）。
 *
 * `GET`/`PUT /api/settings/connection` は接続先 URL・API キーの参照・変更。API キー本体は
 * 応答に載せない（`hasApiKey` だけ。決定 5）。`POST /api/settings/connection/check` は
 * **現在の接続**で `listModels()` までを試すだけで、試験生成は送らない（決定 8）。
 */

import {
  connectionCheckDtoSchema,
  connectionCheckRequestSchema,
  connectionSettingsDtoSchema,
  putConnectionRequestSchema,
} from "@shuten/shared";
import type { Hono } from "hono";

import { LmStudioError } from "../lmstudio/errors.ts";
import type { ModelInfo } from "../lmstudio/types.ts";
import { LOADED_STATE } from "../lmstudio/types.ts";
import type { ApiDeps } from "./deps.ts";
import { toModelInfoDto } from "./dto.ts";
import { ApiError, readJson, respond } from "./errors.ts";
import { CONNECTION_CHECK_ERROR_MESSAGES } from "./messages.ts";

export function registerSettingsRoutes(router: Hono, deps: ApiDeps): void {
  router.get("/settings/connection", (c) =>
    respond(c, connectionSettingsDtoSchema, deps.connection.describe()),
  );

  router.put("/settings/connection", async (c) => {
    const body = putConnectionRequestSchema.parse(await readJson(c));
    // 「走っているか」の正本はレジストリ（決定 7）。runs.status ではなく activeRunIds を見る。
    if (deps.orchestrator.activeRunIds().length > 0) {
      throw new ApiError(409, "runs-active", "検査実行が走っているため接続設定を変更できません");
    }
    deps.connection.update(body);
    return respond(c, connectionSettingsDtoSchema, deps.connection.describe());
  });

  router.post("/settings/connection/check", async (c) => {
    const body = connectionCheckRequestSchema.parse(await readJson(c, { optional: true }));
    const { client } = deps.connection.current();

    let models: readonly ModelInfo[];
    try {
      models = await client.listModels();
    } catch (error) {
      // 決定 8：`reason` は `LmStudioError.kind` から取り、それ以外の例外は "connection" 扱い。
      const reason = error instanceof LmStudioError ? error.kind : "connection";
      return respond(c, connectionCheckDtoSchema, {
        reachable: false,
        error: { reason, message: CONNECTION_CHECK_ERROR_MESSAGES[reason] },
        models: [],
        model: null,
      });
    }

    const modelId = body.modelId;
    const found = modelId === undefined ? undefined : models.find((m) => m.id === modelId);

    return respond(c, connectionCheckDtoSchema, {
      reachable: true,
      error: null,
      models: models.map(toModelInfoDto),
      model:
        modelId === undefined
          ? null
          : {
              id: modelId,
              found: found !== undefined,
              state: found?.state ?? null,
              loaded: found?.state === LOADED_STATE,
            },
    });
  });
}
