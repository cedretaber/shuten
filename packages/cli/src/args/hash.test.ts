import { describe, expect, it } from "vitest";

import { parseHashArgs } from "./hash.ts";

describe("parseHashArgs", () => {
  it("--manuscript を受け付ける", () => {
    const result = parseHashArgs(["--manuscript", "manuscript.txt"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manuscriptPath).toBe("manuscript.txt");
  });

  it("--manuscript がないとエラー値を返す", () => {
    const result = parseHashArgs([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/--manuscript/);
  });

  it("未知のオプションを拒否する", () => {
    const result = parseHashArgs(["--manuscript", "manuscript.txt", "--model", "x"]);
    expect(result.ok).toBe(false);
  });

  it("値のないオプションを拒否する", () => {
    const result = parseHashArgs(["--manuscript"]);
    expect(result.ok).toBe(false);
  });

  it("例外を投げない（エラー値で返す）", () => {
    expect(() => parseHashArgs([])).not.toThrow();
  });
});
