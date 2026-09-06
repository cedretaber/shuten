import { describe, expect, it } from "vitest";
import { buildGraphemeIndex, graphemeAt, isGraphemeBoundary, offsetAt } from "./grapheme-index.ts";

describe("buildGraphemeIndex", () => {
  it("空文字列は boundaries [0]、count 0、位置 0 は境界", () => {
    const index = buildGraphemeIndex("");
    expect(index.boundaries).toEqual([0]);
    expect(index.count).toBe(0);
    expect(isGraphemeBoundary(index, 0)).toBe(true);
  });

  it("サロゲートペアは boundaries [0, 1, 3, 4]、count 3", () => {
    const index = buildGraphemeIndex("a\u{20BB7}b");
    expect(index.boundaries).toEqual([0, 1, 3, 4]);
    expect(index.count).toBe(3);
  });

  it("graphemeAt と offsetAt は位置と書記素番号を相互変換する", () => {
    const index = buildGraphemeIndex("a\u{20BB7}b");
    expect(graphemeAt(index, 3)).toBe(2);
    expect(offsetAt(index, 2)).toBe(3);
  });

  it("サロゲートペア内部の位置は境界でなく、graphemeAt は RangeError", () => {
    const index = buildGraphemeIndex("a\u{20BB7}b");
    expect(isGraphemeBoundary(index, 2)).toBe(false);
    expect(() => graphemeAt(index, 2)).toThrowError(RangeError);
  });

  it("ZWJ ファミリーと x は boundaries [0, 8, 9]、count 2", () => {
    const index = buildGraphemeIndex("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}x");
    expect(index.boundaries).toEqual([0, 8, 9]);
    expect(index.count).toBe(2);
  });

  it("異体字セレクタ付き漢字は boundaries [0, 3, 4]", () => {
    const index = buildGraphemeIndex("葛\u{E0100}飾");
    expect(index.boundaries).toEqual([0, 3, 4]);
  });

  it("CRLF は 1 クラスタで boundaries [0, 1, 3, 4]", () => {
    const index = buildGraphemeIndex("行\r\n次");
    expect(index.boundaries).toEqual([0, 1, 3, 4]);
  });

  it("結合文字（か + 濁点）は boundaries [0, 2]、count 1", () => {
    const index = buildGraphemeIndex("か\u3099");
    expect(index.boundaries).toEqual([0, 2]);
    expect(index.count).toBe(1);
  });
});

describe("offsetAt", () => {
  it("offsetAt(idx, count) は text.length に等しい", () => {
    const text = "あ\u{20BB7}\r\nい";
    const index = buildGraphemeIndex(text);
    expect(offsetAt(index, index.count)).toBe(text.length);
  });

  it("範囲外の書記素番号は RangeError", () => {
    const index = buildGraphemeIndex("abc");
    expect(() => offsetAt(index, index.count + 1)).toThrowError(RangeError);
    expect(() => offsetAt(index, -1)).toThrowError(RangeError);
  });
});

describe("round trip", () => {
  it("0..count の全 k について graphemeAt(idx, offsetAt(idx, k)) === k", () => {
    const text = "あ\u{20BB7}\r\nい";
    const index = buildGraphemeIndex(text);
    for (let k = 0; k <= index.count; k += 1) {
      expect(graphemeAt(index, offsetAt(index, k))).toBe(k);
    }
  });
});
