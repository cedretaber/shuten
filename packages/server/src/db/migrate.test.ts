import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDatabase } from "./client.ts";
import { applyMigrations, resolveMigrationsFolder } from "./migrate.ts";
import { findRun } from "./repositories/runs.ts";

/** 仕様書 8.1 節で定義する 9 表 + PR10 決定 5 の `settings` 表。 */
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
  "settings",
] as const;

/** `meta/_journal.json` の最小限の形（本テストで使う部分だけ）。 */
interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}
interface Journal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly JournalEntry[];
}

/**
 * 本物の `drizzle/` フォルダから `0000` のマイグレーションだけを一時ディレクトリへコピーする
 * （決定 21 の「既存データが入った DB に適用できること」の検証用）。
 *
 * `.sql` ファイルは本物をそのままコピーする（ハッシュ・内容を変えない）。`_journal.json` は
 * entries を idx 0 の 1 件だけにする。`when`（タイムスタンプ）は本物の journal からそのまま
 * 引き継ぐ。drizzle の migrator は「最後に適用したマイグレーションの `created_at` より
 * `folderMillis`（journal の `when`）が大きいものだけ」を適用対象にする（ハッシュの一致では
 * 判定しない。`drizzle-orm/sqlite-core/dialect.js` の `migrate()` で確認済み）ため、`when` を
 * 本物と合わせておかないと、後で本物のフォルダを当てたときに `0000` が二重適用されてしまう。
 *
 * 呼び出し側は返されたディレクトリを使い終わったら `rmSync` で消すこと。
 */
function createPartialMigrationsFolder(): string {
  const realFolder = resolveMigrationsFolder();
  const journal = JSON.parse(
    readFileSync(path.join(realFolder, "meta", "_journal.json"), "utf-8"),
  ) as Journal;
  const firstEntry = journal.entries[0];
  if (!firstEntry) {
    throw new Error("実物の meta/_journal.json に entries がありません");
  }

  const partialFolder = mkdtempSync(path.join(os.tmpdir(), "shuten-migrate-partial-"));
  mkdirSync(path.join(partialFolder, "meta"), { recursive: true });
  copyFileSync(
    path.join(realFolder, `${firstEntry.tag}.sql`),
    path.join(partialFolder, `${firstEntry.tag}.sql`),
  );
  const partialJournal: Journal = {
    version: journal.version,
    dialect: journal.dialect,
    entries: [firstEntry],
  };
  writeFileSync(
    path.join(partialFolder, "meta", "_journal.json"),
    JSON.stringify(partialJournal, null, 2),
  );
  return partialFolder;
}

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

  it("M1b: settings 表が key・value・updated_at 列を持ち、runs に recovery_confirmed_at 列がある（PR10 決定 5・マイグレーション 0002）", () => {
    const { db, close } = createDatabase(":memory:");
    applyMigrations(db);

    const settingsColumns = db
      .all<{ name: string }>(sql`pragma table_info(settings)`)
      .map((c) => c.name);
    expect(new Set(settingsColumns)).toEqual(new Set(["key", "value", "updated_at"]));

    const runsColumns = db.all<{ name: string }>(sql`pragma table_info(runs)`).map((c) => c.name);
    expect(runsColumns).toContain("recovery_confirmed_at");

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

  it("Mig1: 0000 だけを適用した DB に runs の行を作り、そこへ 0001 を適用できる。既存行は recoveryConfirmMs: 0 になる（決定 21）", () => {
    const partialFolder = createPartialMigrationsFolder();
    const { db, close } = createDatabase(":memory:");
    try {
      // 0000 だけを適用する（0001 の2列はまだ無い状態）。
      applyMigrations(db, partialFolder);
      const columnsBeforeUpgrade = db.all<{ name: string }>(sql`pragma table_info(runs)`);
      expect(columnsBeforeUpgrade.some((c) => c.name === "recovery_confirm_ms")).toBe(false);
      expect(columnsBeforeUpgrade.some((c) => c.name === "stop_requested_at")).toBe(false);

      // 0000 の形の runs 行を作る。insertRun も schema.ts のテーブルオブジェクト経由の
      // .insert().values() も使えない（drizzle の buildInsertQuery は `.values()` に書かなかった
      // 列も含め、スキーマに定義された列すべてを INSERT 文の列リストに出す。default があれば
      // その値、無ければ明示的な NULL を補うため、0001 の2列を省略しても実テーブルに無い
      // recovery_confirm_ms / stop_requested_at を参照してしまい、0000 だけを適用したテーブルでは
      // 失敗する。`sqlite-core/dialect.js` の `buildInsertQuery` で確認済み）。
      // 0000 が書いていた形そのものを模すため、生 SQL で列を明示して書き込む。
      db.run(sql`
        INSERT INTO manuscript_versions (id, name, body, body_hash, created_at)
        VALUES ('mv1', '原稿', '本文', 'hash', ${Date.now()})
      `);
      db.run(sql`
        INSERT INTO runs (
          id, manuscript_version_id, model_id, endpoint_url,
          generation_settings, chunk_settings, timeouts, perspectives,
          recheck_enabled, allowed_words, allowed_word_rule_version,
          prompt_version, diagnostic_transform_version, status,
          generation_unconfirmed, started_at
        ) VALUES (
          'r1', 'mv1', 'model-a', 'http://127.0.0.1:1234',
          ${JSON.stringify({ maxTokens: 512, temperature: 0.2 })},
          ${JSON.stringify({
            targetGraphemes: 1500,
            contextGraphemes: 1000,
            recheckContextGraphemes: 3000,
            roundingTolerance: 0.2,
            maxInputGraphemes: 8000,
          })},
          ${JSON.stringify({ checkMs: 60_000, recheckMs: 60_000 })},
          ${JSON.stringify(["typo"])},
          0, ${JSON.stringify([])}, '1',
          '1', '1', 'running',
          0, ${Date.now()}
        )
      `);

      // 本物のフォルダで 0001 まで適用する。
      applyMigrations(db);

      const columnsAfterUpgrade = db.all<{ name: string }>(sql`pragma table_info(runs)`);
      expect(columnsAfterUpgrade.some((c) => c.name === "recovery_confirm_ms")).toBe(true);
      expect(columnsAfterUpgrade.some((c) => c.name === "stop_requested_at")).toBe(true);

      // 適用前から存在した行が recoveryConfirmMs: 0（＝checkMs がそのままハード上限という
      // 従来の意味）、stopRequestedAt: null で読める。
      const found = findRun(db, "r1");
      expect(found).not.toBeNull();
      expect(found?.recoveryConfirmMs).toBe(0);
      expect(found?.stopRequestedAt).toBeNull();

      close();
    } finally {
      rmSync(partialFolder, { recursive: true, force: true });
    }
  });

  it("Mig2: 空の DB に 0000 → 0001 を順に適用できる（applyMigrations の複数適用）", () => {
    const partialFolder = createPartialMigrationsFolder();
    const { db, close } = createDatabase(":memory:");
    try {
      // 1回目：0000 だけ（空の DB）。
      applyMigrations(db, partialFolder);
      const rowsAfter0000 = db.all<{ name: string }>(
        sql`select name from sqlite_master where type = 'table'`,
      );
      expect(new Set(rowsAfter0000.map((r) => r.name)).has("runs")).toBe(true);
      const columnsAfter0000 = db.all<{ name: string }>(sql`pragma table_info(runs)`);
      expect(columnsAfter0000.some((c) => c.name === "recovery_confirm_ms")).toBe(false);

      // 2回目：本物のフォルダ（0000 + 0001）を当て、0001 だけが追加適用される。
      applyMigrations(db);
      const columnsAfter0001 = db.all<{ name: string }>(sql`pragma table_info(runs)`);
      expect(columnsAfter0001.some((c) => c.name === "recovery_confirm_ms")).toBe(true);
      expect(columnsAfter0001.some((c) => c.name === "stop_requested_at")).toBe(true);
      // 9表とも壊れずに残っている。
      const rowsAfter0001 = db.all<{ name: string }>(
        sql`select name from sqlite_master where type = 'table'`,
      );
      const names = new Set(rowsAfter0001.map((r) => r.name));
      for (const table of EXPECTED_TABLES) {
        expect(names.has(table)).toBe(true);
      }

      close();
    } finally {
      rmSync(partialFolder, { recursive: true, force: true });
    }
  });
});
