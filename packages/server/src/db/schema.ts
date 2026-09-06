import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Drizzle スキーマ。
 *
 * この時点では scaffold の動作確認用に最小のテーブルだけを定義している。
 * 仕様書 8.1 節の保存単位（原稿版、検査実行、検査単位、再確認単位、位置診断、指摘、作者の判断）は
 * 実装設計時にここへ追加する。
 */
export const manuscripts = sqliteTable("manuscripts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** BOM 除外後の保存本文。それ以外は無加工（仕様書 5.1 節）。 */
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
