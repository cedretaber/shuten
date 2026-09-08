import path from "node:path";
import type { ServerConfig } from "../config.ts";

/**
 * SQLite ファイルのパスを決める（決定 2）。
 *
 * `config.dataDir` は `config.ts` が環境変数から絶対パスに解決済みで、
 * `index.ts` が起動時に `mkdirSync` している。ファイル名はここで固定する。
 */
export function resolveDatabaseFile(config: ServerConfig): string {
  return path.join(config.dataDir, "shuten.db");
}
