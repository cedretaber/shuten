/**
 * API のテスト基盤（PR10 Task 4）。
 *
 * `setupApi()` はメモリ DB・フェイクの LM Studio クライアント・オーケストレーター・
 * event hub を組んで `createApp` まで作る。以降の Task のエンドポイントのテストは、
 * すべてこの入口から `app.request(...)` を呼ぶ。
 *
 * 差し替えられる継ぎ目は 3 つ。
 *
 * - `env`：`createConnectionManager` に渡す起動時の既定値。番兵（`http://sentinel.invalid:9` /
 *   `sentinel-api-key`）を入れて漏えい検査（Task 10 の A0）に使う。
 * - `ssePingIntervalMs`：SSE の心拍間隔（Task 9 が短い値を使う）。
 * - フェイククライアントの台本（`steps` / `listModels` / `ensureLoaded`）。
 *
 * フェイクは `createClient` の `baseUrl` に**結び直される**（`client.bind`）。接続設定を
 * 更新すると新しい接続先に結んだクライアントができ、失敗の台本が投げる `LmStudioError` の
 * `message` にはその接続先が入る。**番兵の URL を失敗経路まで届かせるのはこの継ぎ目**で、
 * ここを固定文字列にすると A0 が空振りで通る。
 */

import type { Hono } from "hono";

import { createApp } from "../app.ts";
import type { ConnectionManager } from "../connection.ts";
import { createConnectionManager } from "../connection.ts";
import type { AppDatabase } from "../db/client.ts";
import { createDatabase } from "../db/client.ts";
import { applyMigrations } from "../db/migrate.ts";
import type { RunEventHub } from "../run/event-hub.ts";
import { createRunEventHub } from "../run/event-hub.ts";
import type { Orchestrator } from "../run/orchestrator.ts";
import { createOrchestrator } from "../run/orchestrator.ts";
import { createRequestQueue } from "../run/queue.ts";
import type { RecoveryGate } from "../run/recovery-gate.ts";
import { createRecoveryGate } from "../run/recovery-gate.ts";
import type { ChatStep, ScriptedClient, ScriptedClientOptions } from "../run/test-support.ts";
import { SCRIPTED_ENDPOINT_URL, scriptedClient } from "../run/test-support.ts";

/**
 * `webDistDir` の既定。存在しないパスを渡して静的配信を無効にする
 * （機器固有の値を書かないため、相対でも絶対でもない固定のリテラルにする）。
 */
export const NO_WEB_DIST_DIR = "/nonexistent";

export interface SetupApiOverrides {
  /** `createConnectionManager` に渡す起動時の既定値。既定はループバックの接続先・API キーなし。 */
  readonly env?:
    | { readonly lmStudioUrl: string; readonly lmStudioApiKey: string | null }
    | undefined;
  /** フェイククライアントの台本（生成要求への応答）。 */
  readonly steps?: readonly ChatStep[] | undefined;
  readonly listModels?: ScriptedClientOptions["listModels"];
  readonly ensureLoaded?: ScriptedClientOptions["ensureLoaded"];
  /**
   * 復旧確認の待機上限。既定 0（`checkMs` がそのままハード上限という従来の意味。決定 8）。
   * テストが停止のたびに待たされないようにするため。
   */
  readonly recoveryConfirmMs?: number | undefined;
  /** SSE の心拍間隔（Task 9）。省略時は `ApiDeps` の既定。 */
  readonly ssePingIntervalMs?: number | undefined;
  /** 静的配信の元。既定 `NO_WEB_DIST_DIR`（存在しないので静的配信は付かない）。 */
  readonly webDistDir?: string | undefined;
  readonly createId?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface ApiHarness {
  readonly app: Hono;
  readonly db: AppDatabase;
  readonly orchestrator: Orchestrator;
  readonly hub: RunEventHub;
  readonly gate: RecoveryGate;
  /** フェイククライアントの操作口（台本・記録・`bind`）。 */
  readonly client: ScriptedClient;
  readonly connection: ConnectionManager;
}

export function setupApi(overrides: SetupApiOverrides = {}): ApiHarness {
  const env = overrides.env ?? { lmStudioUrl: SCRIPTED_ENDPOINT_URL, lmStudioApiKey: null };

  const { db } = createDatabase(":memory:");
  applyMigrations(db);

  const client = scriptedClient(overrides.steps ?? [], {
    endpointUrl: env.lmStudioUrl,
    listModels: overrides.listModels,
    ensureLoaded: overrides.ensureLoaded,
  });

  const connection = createConnectionManager({
    db,
    env,
    // 接続先が変わるたびに、その URL に結び直したフェイクを返す（台本と記録は共有）。
    createClient: (options) => client.bind(options.baseUrl),
  });

  const queue = createRequestQueue();
  const gate = createRecoveryGate();
  const hub = createRunEventHub();
  const recoveryConfirmMs = overrides.recoveryConfirmMs ?? 0;

  const orchestrator = createOrchestrator({
    db,
    connection,
    queue,
    recoveryGate: gate,
    recoveryConfirmMs,
    onEvent: hub.emit,
    ...(overrides.createId === undefined ? {} : { createId: overrides.createId }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });

  const app = createApp(
    { webDistDir: overrides.webDistDir ?? NO_WEB_DIST_DIR },
    {
      db,
      connection,
      recoveryGate: gate,
      orchestrator,
      hub,
      recoveryConfirmMs,
      ...(overrides.ssePingIntervalMs === undefined
        ? {}
        : { ssePingIntervalMs: overrides.ssePingIntervalMs }),
    },
  );

  return { app, db, orchestrator, hub, gate, client, connection };
}
