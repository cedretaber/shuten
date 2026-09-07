import { describe, expect, it } from "vitest";
import { buildGraphemeIndex } from "../text/grapheme-index.ts";
import type { Range } from "../text/range.ts";
import { findSentenceBoundaries } from "./sentence.ts";

/** 本文と範囲から文境界を計算するテスト補助。範囲省略時は全文。 */
function find(text: string, range?: Range): number[] {
  const index = buildGraphemeIndex(text);
  const r = range ?? { start: 0, end: text.length };
  return findSentenceBoundaries(text, r, index);
}

describe("findSentenceBoundaries", () => {
  it("。の直後を文境界にする", () => {
    expect(find("雨だ。傘を持つ。帰る")).toEqual([3, 8]);
  });

  it("全角の？！は文境界、U+3000 は通常文字として境界の妨げにならない", () => {
    expect(find("本当？　そう！ええ")).toEqual([3, 7]);
  });

  it("終端記号と閉じ括弧の並びは 1 つの境界、直後の文字の前", () => {
    expect(find("「行こう。」と言った。")).toEqual([6]);
  });

  it("閉じ括弧だけでは文境界にならない", () => {
    expect(find("「行こう」と言った")).toEqual([]);
  });

  it("……（U+2026）は文境界にならない", () => {
    expect(find("待って……行く")).toEqual([]);
  });

  it("境界が range.end に等しいときは返さない", () => {
    expect(find("雨だ。")).toEqual([]);
  });

  it("。」）！の並びは全体の直後に 1 つの境界", () => {
    expect(find("あ。」）！い")).toEqual([5]);
  });

  it("終端記号の直後に結合文字が続く場合は境界にならない", () => {
    expect(find("あ。\u0301い")).toEqual([]);
  });

  it("ASCII の ! と ? は終端記号、ASCII の . は終端記号でない", () => {
    expect(find("a!b?c.")).toEqual([2, 4]);
  });

  it("複数の文境界を昇順で返す", () => {
    expect(find("あ。い。う。え")).toEqual([2, 4, 6]);
  });

  it("range.start 以前と range.end に等しい境界は返さない", () => {
    expect(find("あ。い。う。え", { start: 3, end: 6 })).toEqual([4]);
  });

  it("範囲より前の終端記号は境界を生まない", () => {
    expect(find("あ。い。う。え", { start: 2, end: 7 })).toEqual([4, 6]);
  });
});
