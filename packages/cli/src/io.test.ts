import { describe, expect, it } from "vitest";

import {
  type FileIdentity,
  findPathConflict,
  readEvalResultText,
  readManuscriptText,
  readTruthText,
  writeResultOrFixedError,
} from "./io.ts";

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

  it("label を渡すと失敗文言に反映される（evaluate の指標・レポートで使う）", async () => {
    const result = await writeResultOrFixedError(
      { writeResult: () => Promise.reject(new Error("boom")) },
      "report.md",
      "content",
      "レポート",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("レポートの書き出しに失敗しました");
  });
});

describe("readTruthText / readEvalResultText", () => {
  it("readTruthText は正解ファイルを読み込み UTF-8 として取り込む", async () => {
    const result = await readTruthText(
      { readTruthBytes: () => Promise.resolve(new TextEncoder().encode('{"a":1}')) },
      "truth.json",
    );
    expect(result).toEqual({ ok: true, value: '{"a":1}' });
  });

  it("readTruthText の読み込み失敗は固定文言のみ（決定9）", async () => {
    const result = await readTruthText(
      {
        readTruthBytes: () => Promise.reject(new Error("ENOENT: open '/secret/truth.json'")),
      },
      "truth.json",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("正解ファイルを読み込めません");
    expect(result.error).not.toContain("/secret/truth.json");
  });

  it("readEvalResultText は結果ファイルを読み込み UTF-8 として取り込む", async () => {
    const result = await readEvalResultText(
      { readResultBytes: () => Promise.resolve(new TextEncoder().encode('{"b":2}')) },
      "result.json",
    );
    expect(result).toEqual({ ok: true, value: '{"b":2}' });
  });

  it("readEvalResultText の読み込み失敗は固定文言のみ（決定9）", async () => {
    const result = await readEvalResultText(
      {
        readResultBytes: () => Promise.reject(new Error("ENOENT: open '/secret/result.json'")),
      },
      "result.json",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("結果ファイルを読み込めません");
    expect(result.error).not.toContain("/secret/result.json");
  });
});

describe("findPathConflict（決定21）", () => {
  function stubStat(identities: Readonly<Record<string, FileIdentity | null>>) {
    return {
      statFile: (path: string) => Promise.resolve(identities[path] ?? null),
    };
  }

  it("正規化パスが一致すれば衝突する", async () => {
    const conflict = await findPathConflict(stubStat({}), [
      { name: "--out", path: "./out.json" },
      { name: "--manuscript", path: "out.json" },
    ]);
    expect(conflict).toEqual(["--out", "--manuscript"]);
  });

  it("パスが異なり実体も無ければ衝突しない", async () => {
    const conflict = await findPathConflict(stubStat({}), [
      { name: "--out", path: "out.json" },
      { name: "--manuscript", path: "novel.txt" },
    ]);
    expect(conflict).toBeNull();
  });

  it("dev/ino が一致すれば衝突する（シンボリックリンク経由の別名）", async () => {
    const conflict = await findPathConflict(
      stubStat({
        "out.json": { dev: 1, ino: 42 },
        "link-to-out.json": { dev: 1, ino: 42 },
      }),
      [
        { name: "--out", path: "out.json" },
        { name: "--report", path: "link-to-out.json" },
      ],
    );
    expect(conflict).toEqual(["--out", "--report"]);
  });

  it("dev/ino が一致すれば衝突する（ハードリンク経由の別名も同じ機構で捕まる）", async () => {
    const conflict = await findPathConflict(
      stubStat({
        "a.json": { dev: 2, ino: 7 },
        "hardlink-of-a.json": { dev: 2, ino: 7 },
      }),
      [
        { name: "--result", path: "a.json" },
        { name: "--result", path: "hardlink-of-a.json" },
      ],
    );
    expect(conflict).toEqual(["--result", "--result"]);
  });

  it("3 つ以上のパスでも組み合わせをすべて見る", async () => {
    const conflict = await findPathConflict(
      stubStat({ "c.json": { dev: 1, ino: 1 }, "d.json": { dev: 1, ino: 1 } }),
      [
        { name: "--out", path: "a.json" },
        { name: "--report", path: "b.json" },
        { name: "--truth", path: "c.json" },
        { name: "--result", path: "d.json" },
      ],
    );
    expect(conflict).toEqual(["--truth", "--result"]);
  });

  it("衝突が無ければ null", async () => {
    const conflict = await findPathConflict(
      stubStat({ "a.json": { dev: 1, ino: 1 }, "b.json": { dev: 1, ino: 2 } }),
      [
        { name: "--out", path: "a.json" },
        { name: "--manuscript", path: "b.json" },
      ],
    );
    expect(conflict).toBeNull();
  });
});
