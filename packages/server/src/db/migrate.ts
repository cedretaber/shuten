import path from "node:path";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type * as schema from "./schema.ts";

/**
 * マイグレーションフォルダの絶対パス。モジュール基準で解決する（決定 2）。
 *
 * `pnpm dev` をリポジトリ直下から実行する場合と `packages/server` で `node src/index.ts` する場合で
 * カレントディレクトリが違うため、cwd 基準にはしない。
 */
export function resolveMigrationsFolder(): string {
  return path.join(import.meta.dirname, "../../drizzle");
}

/**
 * マイグレーションを適用する（決定 2）。起動時、`createApp` の前、API 受付前に呼ぶ。
 * `migrate` は同期関数（drizzle-orm@0.45.2 の型定義で確認済み）。二度適用しても失敗しない（冪等）。
 *
 * `migrationsFolder` は省略可能（既定は `resolveMigrationsFolder()`）。本番の呼び出し
 * （`src/index.ts`）は省略したまま使う。テストが「`0000` だけを適用した DB に `0001` を当てる」
 * ような途中状態を作るために、一時ディレクトリへコピーした一部のマイグレーションだけを
 * 指すフォルダを渡せるようにする（PR9 決定 21 の既存データ互換テスト）。
 */
export function applyMigrations(
  db: BetterSQLite3Database<typeof schema>,
  migrationsFolder: string = resolveMigrationsFolder(),
): void {
  migrate(db, { migrationsFolder });
}
