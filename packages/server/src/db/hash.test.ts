import { describe, expect, it } from "vitest";
import { hashBody } from "./hash.ts";

describe("hashBody", () => {
  it("H1: 既知の入力に対して安定した 64 文字の 16 進文字列を返す", () => {
    const digest = hashBody("hello");
    expect(digest).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // 同じ入力なら常に同じ値（安定性）。
    expect(hashBody("hello")).toBe(digest);
  });

  it("H2: CRLF 版と LF 版の本文で異なる値になる", () => {
    const lf = hashBody("a\nb");
    const crlf = hashBody("a\r\nb");
    expect(lf).not.toBe(crlf);
    expect(lf).toHaveLength(64);
    expect(crlf).toHaveLength(64);
  });
});
