import { describe, expect, it } from "vitest";
import { assertWellFormedBody, MalformedBodyError } from "./errors.ts";

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
