import { describe, expect, it } from "vitest";
import { hashBody } from "../../hash.ts";
import { createDatabase } from "../client.ts";
import { MalformedBodyError } from "../errors.ts";
import { applyMigrations } from "../migrate.ts";
import { findManuscriptVersion, insertManuscriptVersion } from "./manuscripts.ts";

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

describe("db/repositories/manuscripts", () => {
  it("R1: CRLF・単独CR・本文中のBOM・サロゲートペア・異体字セレクタ・ZWJ絵文字を含む本文がそのまま戻る", () => {
    const { db, close } = setupDb();
    // CRLF・単独 CR・BOM・IVS・ZWJ は \u escape で明示する
    // （規約：CRLF を含む期待値は fixture ではなく文字列リテラルで作る）。
    const body =
      "先頭\r\n" + // CRLF
      "次\r次" + // 単独 CR
      "次\ufeff次" + // 本文中の BOM（先頭ではない位置）
      "\u{20BB7}次" + // サロゲートペア（𠮷）
      "葛\u{E0100}次" + // 異体字セレクタ（IVS）
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}次"; // ZWJ 絵文字（👨‍👩‍👧）

    const inserted = insertManuscriptVersion(db, { name: "原稿", body });
    expect(inserted.body).toBe(body);

    const found = findManuscriptVersion(db, inserted.id);
    expect(found).not.toBeNull();
    expect(found?.body).toBe(body);
    close();
  });

  it("R1b: 孤立サロゲートを含む本文の保存は MalformedBodyError になり、行が残らない", () => {
    const { db, close } = setupDb();
    const body = "a\uD800b";

    expect(() => insertManuscriptVersion(db, { id: "mv-r1b", name: "原稿", body })).toThrow(
      MalformedBodyError,
    );
    expect(findManuscriptVersion(db, "mv-r1b")).toBeNull();
    close();
  });

  it("R2: body_hash が CRLF 版と LF 版で異なる（改行が本文の一部であることの確認）", () => {
    const { db, close } = setupDb();
    const crlfBody = "一行目\r\n二行目";
    const lfBody = "一行目\n二行目";

    const crlf = insertManuscriptVersion(db, { name: "原稿", body: crlfBody });
    const lf = insertManuscriptVersion(db, { name: "原稿", body: lfBody });

    expect(crlf.bodyHash).not.toBe(lf.bodyHash);
    expect(crlf.bodyHash).toBe(hashBody(crlfBody));
    expect(lf.bodyHash).toBe(hashBody(lfBody));
    close();
  });

  it("findManuscriptVersion: 存在しない ID は null を返す", () => {
    const { db, close } = setupDb();
    expect(findManuscriptVersion(db, "no-such-id")).toBeNull();
    close();
  });
});
