import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { assertWellFormedBody, isUniqueConstraintViolation, MalformedBodyError } from "./errors.ts";

describe("assertWellFormedBody", () => {
  it("E1: 孤立サロゲート（対になっていない下位サロゲート）を含む文字列で MalformedBodyError を投げる", () => {
    const loneLowSurrogate = "a\uDC00b";
    expect(() => assertWellFormedBody(loneLowSurrogate)).toThrow(MalformedBodyError);
  });

  it("E2: 孤立サロゲート（対になっていない上位サロゲート）を含む文字列で MalformedBodyError を投げる", () => {
    const loneHighSurrogate = "a\uD800b";
    expect(() => assertWellFormedBody(loneHighSurrogate)).toThrow(MalformedBodyError);
  });

  it("E3: サロゲートペアを含む正常な本文では投げない", () => {
    // 𠮷（U+20BB7、吉の異体字）は上位・下位のサロゲートペアで表現される。
    const surrogatePair = "𠮷野家";
    expect(() => assertWellFormedBody(surrogatePair)).not.toThrow();
  });

  it("E4: 異体字セレクタを含む正常な本文では投げない", () => {
    // 葛󠄀（葛 + IVS U+E0100）。異体字セレクタもサロゲートペアで表現される。
    const withVariationSelector = "葛\u{E0100}飾区";
    expect(() => assertWellFormedBody(withVariationSelector)).not.toThrow();
  });

  it("E5: ZWJ で連結した絵文字を含む正常な本文では投げない", () => {
    // 👨‍👩‍👧‍👦（家族の絵文字。サロゲートペア 4 つを ZWJ（U+200D）でつないだもの）。
    const zwjEmoji = "👨‍👩‍👧‍👦";
    expect(() => assertWellFormedBody(zwjEmoji)).not.toThrow();
  });

  it("E6: MalformedBodyError の name が 'MalformedBodyError' である", () => {
    const err = new MalformedBodyError("test");
    expect(err.name).toBe("MalformedBodyError");
    expect(err).toBeInstanceOf(Error);
  });
});

/** 実際に一意制約違反を起こしてから判定する（決定 12）。better-sqlite3 のエラー形状をモックしない。 */
function makeUniqueConstraintViolation(column: string): unknown {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE t (${column} TEXT UNIQUE)`);
  db.prepare(`INSERT INTO t (${column}) VALUES (?)`).run("x");
  try {
    db.prepare(`INSERT INTO t (${column}) VALUES (?)`).run("x");
    throw new Error("一意制約違反が発生しなかった（テストの前提が壊れている）");
  } catch (error) {
    return error;
  } finally {
    db.close();
  }
}

describe("isUniqueConstraintViolation", () => {
  it("対象の列名を含む SQLITE_CONSTRAINT_UNIQUE で true を返す", () => {
    const error = makeUniqueConstraintViolation("start_operation_id");
    expect(isUniqueConstraintViolation(error, "start_operation_id")).toBe(true);
  });

  it("別の列の一意制約違反では false を返す（列名の指定が効いていること）", () => {
    const error = makeUniqueConstraintViolation("target_id");
    expect(isUniqueConstraintViolation(error, "start_operation_id")).toBe(false);
  });

  it("SqliteError 以外の例外では false を返す", () => {
    expect(isUniqueConstraintViolation(new Error("plain error"), "start_operation_id")).toBe(false);
  });

  it("Error でない値では false を返す", () => {
    expect(isUniqueConstraintViolation("not an error", "start_operation_id")).toBe(false);
  });
});
