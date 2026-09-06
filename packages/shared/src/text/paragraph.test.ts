import { describe, expect, it } from "vitest";
import { splitParagraphs } from "./paragraph.ts";
import { sliceRange } from "./range.ts";

/** 段落分割のテストデータ（入力と期待される範囲の組）。 */
type Case = {
  name: string;
  text: string;
  expected: [number, number][];
};

const cases: Case[] = [
  { name: "空文字列", text: "", expected: [] },
  { name: "改行なしの本文", text: "abc", expected: [[0, 3]] },
  {
    name: "LF で区切られる",
    text: "a\nb",
    expected: [
      [0, 2],
      [2, 3],
    ],
  },
  { name: "末尾の LF", text: "a\n", expected: [[0, 2]] },
  { name: "単独の LF", text: "\n", expected: [[0, 1]] },
  {
    name: "LF が 2 つ",
    text: "\n\n",
    expected: [
      [0, 1],
      [1, 2],
    ],
  },
  {
    name: "CRLF で区切られる",
    text: "a\r\nb",
    expected: [
      [0, 3],
      [3, 4],
    ],
  },
  { name: "末尾の CRLF", text: "a\r\n", expected: [[0, 3]] },
  {
    name: "単独 CR で区切られる",
    text: "a\rb",
    expected: [
      [0, 2],
      [2, 3],
    ],
  },
  { name: "末尾の単独 CR", text: "a\r", expected: [[0, 2]] },
  { name: "単独の CR", text: "\r", expected: [[0, 1]] },
  {
    name: "CR が 2 つ",
    text: "\r\r",
    expected: [
      [0, 1],
      [1, 2],
    ],
  },
  {
    name: "CRLF の後に単独 CR",
    text: "a\r\n\r",
    expected: [
      [0, 3],
      [3, 4],
    ],
  },
  { name: "単独の CRLF", text: "\r\n", expected: [[0, 2]] },
  {
    name: "単独 CR の後に CRLF",
    text: "a\r\r\nb",
    expected: [
      [0, 2],
      [2, 4],
      [4, 5],
    ],
  },
  {
    name: "LF の後に CR",
    text: "a\n\rb",
    expected: [
      [0, 2],
      [2, 3],
      [3, 4],
    ],
  },
  {
    name: "CRLF が 2 つ",
    text: "a\r\n\r\nb",
    expected: [
      [0, 3],
      [3, 5],
      [5, 6],
    ],
  },
  {
    name: "日本語と改行の混在",
    text: "一\r\n二\n三\r四",
    expected: [
      [0, 3],
      [3, 5],
      [5, 7],
      [7, 8],
    ],
  },
  { name: "全角スペースは区切りにならない", text: "\u3000段落", expected: [[0, 3]] },
  { name: "改行なしの長い段落", text: "あ".repeat(20000), expected: [[0, 20000]] },
  {
    name: "NEL・LS・PS・VT・FF は区切りにならない",
    text: "a\u0085b\u2028c\u2029d\u000Be\u000Cf",
    expected: [[0, 11]],
  },
  {
    name: "本文中の U+FEFF は普通の文字",
    text: "a\uFEFFb\nc",
    expected: [
      [0, 4],
      [4, 5],
    ],
  },
  {
    name: "サロゲートペアと ZWJ 絵文字",
    text: "\u{20BB7}\n\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\r\n",
    expected: [
      [0, 3],
      [3, 13],
    ],
  },
];

describe("splitParagraphs", () => {
  for (const { name, text, expected } of cases) {
    it(name, () => {
      expect(splitParagraphs(text).map((p) => [p.range.start, p.range.end])).toEqual(expected);
    });
  }

  it("id は配列のインデックスと一致する", () => {
    const result = splitParagraphs("a\nb\r\nc\rd");
    expect(result.map((p) => p.id)).toEqual([0, 1, 2, 3]);
  });

  for (const { name, text } of cases) {
    it(`カバレッジ不変条件: ${name}`, () => {
      const result = splitParagraphs(text);
      if (text.length === 0) {
        expect(result).toEqual([]);
        return;
      }
      expect(result[0]?.range.start).toBe(0);
      for (let k = 1; k < result.length; k += 1) {
        expect(result[k]?.range.start).toBe(result[k - 1]?.range.end);
      }
      expect(result[result.length - 1]?.range.end).toBe(text.length);
      for (const p of result) {
        expect(p.range.end).toBeGreaterThan(p.range.start);
      }
      expect(result.map((p) => sliceRange(text, p.range)).join("")).toBe(text);
      expect(result.map((p) => p.id)).toEqual(result.map((_, i) => i));
    });
  }
});
