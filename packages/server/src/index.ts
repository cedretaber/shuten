import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/client.ts";
import { applyMigrations } from "./db/migrate.ts";
import { resolveDatabaseFile } from "./db/path.ts";
import { createLmStudioClient } from "./lmstudio/client.ts";
import { createOrchestrator } from "./run/orchestrator.ts";
import { createRequestQueue } from "./run/queue.ts";
import { createRecoveryGate } from "./run/recovery-gate.ts";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

// マイグレーションは起動時、API 受付前に適用する（決定 2）。
// 例外は捕まえずに（接続先 URL・API キーを出さずに）プロセスを非ゼロ終了させる。
const { db } = createDatabase(resolveDatabaseFile(config));
applyMigrations(db);

// キューと復旧ゲートはプロセス内に 1 個だけ作り、オーケストレーターへ渡す（決定 24）。
// オーケストレーターの内側で作ると、同じインスタンスを共有すべき PR10 の接続確認が使えない。
const client = createLmStudioClient({ baseUrl: config.lmStudioUrl, apiKey: config.lmStudioApiKey });
const queue = createRequestQueue();
const recoveryGate = createRecoveryGate();
const orchestrator = createOrchestrator({
  db,
  client,
  queue,
  recoveryGate,
  endpointUrl: config.lmStudioUrl,
  recoveryConfirmMs: config.recoveryConfirmMs,
});

// 起動時照合（決定 13）：マイグレーション適用後・API 受付前に行う。自動では再開しない。
// 例外は捕まえずに（接続先 URL・API キーを出さずに）プロセスを非ゼロ終了させる。
orchestrator.reconcileOnStartup();

// PR10 まで HTTP の口は作らないので、オーケストレーターは createApp に渡さない。
const app = createApp(config);

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`shuten server: http://${info.address}:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
});
