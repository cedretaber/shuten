import { describe, expect, it } from "vitest";
import { sliceRange } from "./range.ts";

describe("sliceRange", () => {
  it("範囲内の文字列を切り出す", () => {
    expect(sliceRange("abc", { start: 1, end: 3 })).toBe("bc");
  });

  it("サロゲートペアも UTF-16 コード単位で切り出せる", () => {
    expect(sliceRange("a\u{20BB7}b", { start: 1, end: 3 })).toBe("\u{20BB7}");
  });
});
