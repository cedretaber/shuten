import { describe, expect, it } from "vitest";

import { fillManuscript } from "./full-chat-prompt.ts";

describe("fillManuscript", () => {
  it("$ を含む原稿を壊さずに差し込む", () => {
    const manuscript = "値段は $$ で、$& と $` と $' と $1 が出る。";
    const result = fillManuscript("前\n{{manuscript}}\n後", manuscript);
    expect(result.ok).toBe(true);
    // 原稿が 1 文字も変わらずに入っていること
    expect(result.ok && result.value).toBe(`前\n${manuscript}\n後`);
  });

  it("{{manuscript}} が無いプロンプトはエラーになり、メッセージにプロンプト本文が含まれない", () => {
    const prompt = "これは秘密の指示です。原稿を要約してください。";
    const result = fillManuscript(prompt, "本文");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("プロンプトに {{manuscript}} が含まれていません");
    expect(result.error).not.toContain(prompt);
  });

  it("空のプロンプトもエラーになる", () => {
    const result = fillManuscript("", "本文");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("プロンプトに {{manuscript}} が含まれていません");
  });

  it("{{manuscript}} が 2 つあるプロンプトで両方が置換される", () => {
    const result = fillManuscript("A: {{manuscript}}\nB: {{manuscript}}", "原稿本文");
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe("A: 原稿本文\nB: 原稿本文");
  });
});
