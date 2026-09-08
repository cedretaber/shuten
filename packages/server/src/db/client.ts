import Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";

/**
 * 開いた SQLite ハンドル。`close()` で閉じられる（決定 12）。
 * 再起動を模したテスト（一度閉じて開き直す）に SQLite ハンドルが要るため、
 * Drizzle のインスタンスだけでなく `better-sqlite3` のハンドルも保持する。
 */
export interface AppDatabaseHandle {
  readonly db: BetterSQLite3Database<typeof schema>;
  close(): void;
}

export type AppDatabase = AppDatabaseHandle["db"];

/**
 * SQLite を開いて Drizzle のインスタンスを返す。
 *
 * `":memory:"` を渡すとメモリ DB になる（テスト用）。
 * トランザクションは短い更新処理に限定し、LLM 応答待ちを含めない
 * （docs/decisions/0001-tech-stack.md）。
 *
 * WAL のまま開いたファイルを Windows で開き直せないことがあるので、
 * 再起動を模したテストは必ず `close()` してから開き直すこと。
 */
export function createDatabase(file: string): AppDatabaseHandle {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return {
    db,
    close(): void {
      sqlite.close();
    },
  };
}
