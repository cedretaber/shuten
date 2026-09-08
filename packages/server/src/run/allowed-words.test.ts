import { describe, expect, it } from "vitest";

import { splitAllowedWords } from "./allowed-words.ts";

describe("splitAllowedWords", () => {
  it("CRLF・CR・LF の混在で分割できる（U1）", () => {
    expect(splitAllowedWords("あ\r\nい\rう\nえ")).toEqual(["あ", "い", "う", "え"]);
  });

  it("各行が trim され、空行と空白のみの行が除かれる（U2）", () => {
    expect(splitAllowedWords("  あ  \n\n   \nい\n\t\n")).toEqual(["あ", "い"]);
  });

  it("完全一致の重複が 1 つになり、出現順が保たれる（U3）", () => {
    expect(splitAllowedWords("う\nあ\nい\nあ\nう")).toEqual(["う", "あ", "い"]);
  });

  it("空文字を渡すと空配列（U4）", () => {
    expect(splitAllowedWords("")).toEqual([]);
  });
});
