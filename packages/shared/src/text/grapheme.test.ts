import { describe, expect, it } from "vitest";
import { countGraphemes, segmentGraphemes } from "./grapheme.ts";

describe("countGraphemes", () => {
  it("平仮名・漢字は 1 文字ずつ数える", () => {
    expect(countGraphemes("朱点を打つ")).toBe(5);
  });

  it("空文字列は 0", () => {
    expect(countGraphemes("")).toBe(0);
  });

  it("サロゲートペア（𠮷）は 1 書記素、UTF-16 では 2 コード単位", () => {
    const text = "𠮷野家";
    expect(countGraphemes(text)).toBe(3);
    expect(text.length).toBe(4);
  });

  it("異体字セレクタ付きの漢字（葛󠄀）は 1 書記素", () => {
    const text = "葛\u{E0100}飾";
    expect(countGraphemes(text)).toBe(2);
    expect(text.length).toBe(4);
  });

  it("結合文字（か + 濁点）は 1 書記素", () => {
    const text = "が";
    expect(countGraphemes(text)).toBe(1);
    expect(text.length).toBe(2);
  });

  it("ZWJ で連結した絵文字（👨‍👩‍👧）は 1 書記素", () => {
    const text = "👨‍👩‍👧";
    expect(countGraphemes(text)).toBe(1);
    expect(text.length).toBe(8);
  });

  it("CRLF は 1 書記素として扱い、途中で分割されない", () => {
    const text = "行\r\n次";
    expect(countGraphemes(text)).toBe(3);
    expect(segmentGraphemes(text).map((s) => s.segment)).toEqual(["行", "\r\n", "次"]);
  });

  it("単独の CR と LF はそれぞれ 1 書記素", () => {
    expect(countGraphemes("a\rb\nc")).toBe(5);
  });
});

describe("segmentGraphemes", () => {
  it("各セグメントの index は UTF-16 コード単位の開始位置", () => {
    const text = "a𠮷b";
    expect(segmentGraphemes(text)).toEqual([
      { segment: "a", index: 0 },
      { segment: "𠮷", index: 1 },
      { segment: "b", index: 3 },
    ]);
  });
});
