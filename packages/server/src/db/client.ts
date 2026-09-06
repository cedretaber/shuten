import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";

export type AppDatabase = ReturnType<typeof createDatabase>;

/**
 * SQLite を開いて Drizzle のインスタンスを返す。
 *
 * `":memory:"` を渡すとメモリ DB になる（テスト用）。
 * トランザクションは短い更新処理に限定し、LLM 応答待ちを含めない
 * （docs/decisions/0001-tech-stack.md）。
 */
export function createDatabase(file: string) {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}
