import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/client.ts";
import { applyMigrations } from "./db/migrate.ts";
import { resolveDatabaseFile } from "./db/path.ts";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

// マイグレーションは起動時、API 受付前に適用する（決定 2）。
// 例外は捕まえずに（接続先 URL・API キーを出さずに）プロセスを非ゼロ終了させる。
const { db } = createDatabase(resolveDatabaseFile(config));
applyMigrations(db);

const app = createApp(config);

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`shuten server: http://${info.address}:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
});
