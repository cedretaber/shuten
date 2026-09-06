import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeUtf8Strict, ingestUtf8Bytes, stripBom, Utf8DecodeError } from "./ingest.ts";
import { splitParagraphs } from "./paragraph.ts";
import { sliceRange } from "./range.ts";

const fixturesDir = path.join(import.meta.dirname, "../../test/fixtures");
// readFileSync の Buffer はプールされた大きな ArrayBuffer の一部を指すビュー。コピーせずそのまま渡す。
const readFixture = (name: string): Uint8Array => readFileSync(path.join(fixturesDir, name));

describe("stripBom", () => {
  it("先頭の U+FEFF を 1 文字だけ除外する", () => {
    expect(stripBom("\uFEFFabc")).toBe("abc");
  });

  it("BOM がない場合はそのまま返す", () => {
    expect(stripBom("abc")).toBe("abc");
  });

  it("本文中の U+FEFF は残す", () => {
    expect(stripBom("a\uFEFFb")).toBe("a\uFEFFb");
  });

  it("先頭に U+FEFF が 2 つあっても 1 つだけ除外する", () => {
    expect(stripBom("\uFEFF\uFEFFa")).toBe("\uFEFFa");
  });

  it("U+FEFF のみは空文字列", () => {
    expect(stripBom("\uFEFF")).toBe("");
  });

  it("空文字列は空文字列", () => {
    expect(stripBom("")).toBe("");
  });
});

describe("decodeUtf8Strict", () => {
  it("1 バイト文字をデコードする", () => {
    expect(decodeUtf8Strict(new Uint8Array([0x61, 0x62]))).toBe("ab");
  });

  it("マルチバイトの漢字をデコードする", () => {
    const bytes = new TextEncoder().encode("朱点");
    expect(decodeUtf8Strict(bytes)).toBe("朱点");
  });

  it("先頭の BOM は除去せずに文字列に残す", () => {
    expect(decodeUtf8Strict(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("\uFEFFa");
  });

  it("BOM のみのバイト列は 1 文字", () => {
    const result = decodeUtf8Strict(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(result).toBe("\uFEFF");
    expect(result.length).toBe(1);
  });

  it("サロゲートペアをデコードし UTF-16 では 2 コード単位", () => {
    const result = decodeUtf8Strict(new Uint8Array([0xf0, 0xa0, 0xae, 0xb7]));
    expect(result).toBe("\u{20BB7}");
    expect(result.length).toBe(2);
  });

  it("不正なバイト 0xFF は Utf8DecodeError を投げる", () => {
    expect(() => decodeUtf8Strict(new Uint8Array([0xff]))).toThrow(Utf8DecodeError);
  });

  it("途中で切れた 3 バイトシーケンスは Utf8DecodeError を投げる", () => {
    expect(() => decodeUtf8Strict(new Uint8Array([0xe3, 0x81]))).toThrow(Utf8DecodeError);
  });

  it("UTF-8 化されたサロゲートは Utf8DecodeError を投げる", () => {
    expect(() => decodeUtf8Strict(new Uint8Array([0xed, 0xa0, 0x80]))).toThrow(Utf8DecodeError);
  });

  it("過剰エンコードは Utf8DecodeError を投げる", () => {
    expect(() => decodeUtf8Strict(new Uint8Array([0xc0, 0xaf]))).toThrow(Utf8DecodeError);
  });

  it("空のバイト列は空文字列", () => {
    expect(decodeUtf8Strict(new Uint8Array(0))).toBe("");
  });

  it("投げられる例外の形（cause は TypeError）", () => {
    let caught: unknown;
    try {
      decodeUtf8Strict(new Uint8Array([0xff]));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Utf8DecodeError);
    expect((caught as Error).name).toBe("Utf8DecodeError");
    expect((caught as Error).cause).toBeInstanceOf(TypeError);
  });
});

describe("ingestUtf8Bytes", () => {
  it("先頭の BOM を 1 つだけ除去する", () => {
    expect(ingestUtf8Bytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
  });

  it("BOM が 2 つ続いても 1 つだけ除去される", () => {
    expect(ingestUtf8Bytes(new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61]))).toBe(
      "\uFEFFa",
    );
  });

  it("BOM のみのバイト列は空文字列", () => {
    expect(ingestUtf8Bytes(new Uint8Array([0xef, 0xbb, 0xbf]))).toBe("");
  });

  it("BOM がない場合はそのまま返す", () => {
    expect(ingestUtf8Bytes(new Uint8Array([0x61]))).toBe("a");
  });

  it("不正なバイト列は Utf8DecodeError を投げる", () => {
    expect(() => ingestUtf8Bytes(new Uint8Array([0xff]))).toThrow(Utf8DecodeError);
  });
});

describe("fixture の往復", () => {
  it("crlf.txt: CRLF と全角スペース", () => {
    const text = ingestUtf8Bytes(readFixture("crlf.txt"));
    expect(text).toBe("一行目\r\n二行目\r\n\r\n　三行目\r\n");
    const paragraphs = splitParagraphs(text);
    expect(paragraphs.map((p) => [p.range.start, p.range.end])).toEqual([
      [0, 5],
      [5, 10],
      [10, 12],
      [12, 18],
    ]);
    expect(paragraphs[2]?.range).toEqual({ start: 10, end: 12 });
    expect(sliceRange(text, { start: 10, end: 12 })).toBe("\r\n");
  });

  it("cr-mixed.txt: CR・LF・CRLF の混在", () => {
    const text = ingestUtf8Bytes(readFixture("cr-mixed.txt"));
    expect(text).toBe("甲\r乙\n丙\r\n丁");
    const paragraphs = splitParagraphs(text);
    expect(paragraphs.map((p) => [p.range.start, p.range.end])).toEqual([
      [0, 2],
      [2, 4],
      [4, 7],
      [7, 8],
    ]);
    expect(sliceRange(text, { start: 4, end: 7 })).toBe("丙\r\n");
  });

  it("bom-crlf.txt: BOM と CRLF", () => {
    const bytes = readFixture("bom-crlf.txt");
    const decoded = decodeUtf8Strict(bytes);
    expect(decoded.startsWith("\uFEFF")).toBe(true);
    expect(decoded.length).toBe(8);
    const text = ingestUtf8Bytes(bytes);
    expect(text).toBe("見出し\r\n本文");
    expect(text.length).toBe(7);
    const paragraphs = splitParagraphs(text);
    expect(paragraphs.map((p) => [p.range.start, p.range.end])).toEqual([
      [0, 5],
      [5, 7],
    ]);
  });

  it("invalid-utf8.txt: 不正な UTF-8 は Utf8DecodeError を投げる", () => {
    expect(() => ingestUtf8Bytes(readFixture("invalid-utf8.txt"))).toThrow(Utf8DecodeError);
  });

  it("大きな ArrayBuffer の一部を指すビュー（subarray）でも位置がずれない", () => {
    const whole = readFixture("crlf.txt");
    const padded = new Uint8Array(whole.length + 8);
    padded.set(whole, 4);
    const view = padded.subarray(4, 4 + whole.length);
    expect(ingestUtf8Bytes(view)).toBe(ingestUtf8Bytes(whole));
  });
});
