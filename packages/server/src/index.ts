import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const app = createApp(config);

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`shuten server: http://${info.address}:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
});
