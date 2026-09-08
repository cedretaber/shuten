import path from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDatabase } from "./client.ts";
import { applyMigrations, resolveMigrationsFolder } from "./migrate.ts";

/** 仕様書 8.1 節で定義する 9 表。 */
const EXPECTED_TABLES = [
  "manuscript_versions",
  "runs",
  "run_targets",
  "check_units",
  "candidates",
  "findings",
  "recheck_units",
  "diagnostics",
  "judgments",
] as const;

describe("applyMigrations", () => {
  it("M1: メモリ DB に適用でき、9 表がすべてある", () => {
    const { db, close } = createDatabase(":memory:");
    applyMigrations(db);

    const rows = db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`);
    const names = new Set(rows.map((r) => r.name));
    for (const table of EXPECTED_TABLES) {
      expect(names.has(table)).toBe(true);
    }

    close();
  });

  it("M2: 二度適用しても失敗しない（冪等）", () => {
    const { db, close } = createDatabase(":memory:");
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
    close();
  });

  it("M3: 解決した migrationsFolder が絶対パスで packages/server/drizzle を指す", () => {
    const folder = resolveMigrationsFolder();
    expect(path.isAbsolute(folder)).toBe(true);
    expect(folder.endsWith(path.join("packages", "server", "drizzle"))).toBe(true);
  });
});
