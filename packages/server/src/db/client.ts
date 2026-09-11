import Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
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
 * `AppDatabase`（`BetterSQLite3Database<typeof schema>`）と、`db.transaction((tx) => ...)` が
 * コールバックへ渡す `tx`（`SQLiteTransaction<...>`）の共通の親（PR9 決定 15）。
 *
 * `BetterSQLite3Database` は `BaseSQLiteDatabase<'sync', RunResult, TSchema>` を継承し、
 * `SQLiteTransaction` も同じ `BaseSQLiteDatabase` を継承する（drizzle-orm@0.45.2 の
 * `sqlite-core/db.d.ts` / `sqlite-core/session.d.ts` で確認済み）。リポジトリ関数の第 1 引数を
 * この型にしておくと、`db` を直接渡しても、外側の `db.transaction` から得た `tx` を渡しても
 * 同じ関数を使い回せる（決定 15 の「1 単位ぶんを 1 トランザクションで書く」に必要）。
 */
export type AppDatabaseLike = BaseSQLiteDatabase<"sync", Database.RunResult, typeof schema>;

export interface CreateDatabaseOptions {
  /**
   * 実行された SQL 文を 1 本ずつ受け取る（PR12c 決定 7）。better-sqlite3 の `verbose` に
   * そのまま渡す継ぎ目で、**テストのための継ぎ目**である。本番の呼び出し（`src/index.ts`）は
   * この第 2 引数を渡さない。
   */
  readonly onStatement?: (sql: string) => void;
}

/**
 * SQLite を開いて Drizzle のインスタンスを返す。
 *
 * `":memory:"` を渡すとメモリ DB になる（テスト用）。
 * トランザクションは短い更新処理に限定し、LLM 応答待ちを含めない
 * （docs/decisions/0001-tech-stack.md）。
 *
 * WAL のまま開いたファイルを Windows で開き直せないことがあるので、
 * 再起動を模したテストは必ず `close()` してから開き直すこと。
 *
 * `options.onStatement` は SQL 文の本数を数える回帰テスト（PR12c 決定 7）のための継ぎ目。
 * `exactOptionalPropertyTypes` があるため `{ verbose: undefined }` を渡さず、条件付きで
 * `Database.Options` を組み立てる。
 */
export function createDatabase(file: string, options?: CreateDatabaseOptions): AppDatabaseHandle {
  const sqliteOptions: Database.Options =
    options?.onStatement === undefined
      ? {}
      : { verbose: (message) => options.onStatement?.(String(message)) };
  const sqlite = new Database(file, sqliteOptions);
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
