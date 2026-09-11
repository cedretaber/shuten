import { describe, expect, it } from "vitest";

import { readManuscriptText, writeResultOrFixedError } from "./io.ts";

describe("readManuscriptText", () => {
  it("原稿を読み込み UTF-8 として取り込む", async () => {
    const result = await readManuscriptText(
      { readManuscriptBytes: () => Promise.resolve(new TextEncoder().encode("hello")) },
      "manuscript.txt",
    );
    expect(result).toEqual({ ok: true, value: "hello" });
  });

  it("読み込み失敗は固定文言のみ（原因を連結しない。決定9）", async () => {
    const result = await readManuscriptText(
      {
        readManuscriptBytes: () =>
          Promise.reject(new Error("ENOENT: no such file or directory, open '/secret/path'")),
      },
      "manuscript.txt",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("原稿ファイルを読み込めません");
    expect(result.error).not.toContain("/secret/path");
  });

  it("UTF-8 として読めないバイト列は原因を連結したメッセージになる（パスを含まないため許容）", async () => {
    const result = await readManuscriptText(
      { readManuscriptBytes: () => Promise.resolve(new Uint8Array([0xff])) },
      "manuscript.txt",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("原稿ファイルを UTF-8 として読み込めません");
  });
});

describe("writeResultOrFixedError", () => {
  it("成功時は書き出した内容がそのまま渡る", async () => {
    const written: { outPath: string | null; content: string }[] = [];
    const result = await writeResultOrFixedError(
      {
        writeResult: (outPath, content) => {
          written.push({ outPath, content });
          return Promise.resolve();
        },
      },
      "out.json",
      "content",
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(written).toEqual([{ outPath: "out.json", content: "content" }]);
  });

  it("書き出し失敗は固定文言のみ（原因を連結しない。決定9）", async () => {
    const result = await writeResultOrFixedError(
      {
        writeResult: () =>
          Promise.reject(new Error("EACCES: permission denied, open '/secret/out.json'")),
      },
      "out.json",
      "content",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("結果の書き出しに失敗しました");
    expect(result.error).not.toContain("/secret/out.json");
  });
});
