import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createConnectionManager } from "./connection.ts";
import { createDatabase } from "./db/client.ts";
import { applyMigrations } from "./db/migrate.ts";
import { resolveDatabaseFile } from "./db/path.ts";
import { createRunEventHub } from "./run/event-hub.ts";
import { createOrchestrator } from "./run/orchestrator.ts";
import { createRequestQueue } from "./run/queue.ts";
import { createRecoveryGate } from "./run/recovery-gate.ts";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

// マイグレーションは起動時、API 受付前に適用する（決定 2）。
// 例外は捕まえずに（接続先 URL・API キーを出さずに）プロセスを非ゼロ終了させる。
const { db } = createDatabase(resolveDatabaseFile(config));
applyMigrations(db);

// 接続の供給元（PR10 決定 5・6）。接続先 URL は settings 表 → 環境変数の順で決める。
// 保存済みの値が不正なときの例外は捕まえない（URL を含まない定型文で非ゼロ終了する）。
const connection = createConnectionManager({
  db,
  env: { lmStudioUrl: config.lmStudioUrl, lmStudioApiKey: config.lmStudioApiKey },
});

// キューと復旧ゲートはプロセス内に 1 個だけ作り、オーケストレーターへ渡す（決定 24）。
// オーケストレーターの内側で作ると、同じインスタンスを共有すべき接続確認が使えない。
const queue = createRequestQueue();
const recoveryGate = createRecoveryGate();

// 実行イベントの配信元（PR10 決定 13）。`emit` をそのままオーケストレーターの `onEvent` に渡す。
const hub = createRunEventHub();

const orchestrator = createOrchestrator({
  db,
  connection,
  queue,
  recoveryGate,
  recoveryConfirmMs: config.recoveryConfirmMs,
  onEvent: hub.emit,
});

// 起動時照合（決定 13）：マイグレーション適用後・API 受付前に行う。自動では再開しない。
// 例外は捕まえずに（接続先 URL・API キーを出さずに）プロセスを非ゼロ終了させる。
orchestrator.reconcileOnStartup();

const app = createApp(config, {
  db,
  connection,
  recoveryGate,
  orchestrator,
  hub,
  // validateHardTimeouts に渡す（決定 14）。queue は API が使わない（決定 8）。
  recoveryConfirmMs: config.recoveryConfirmMs,
});

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`shuten server: http://${info.address}:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
});
