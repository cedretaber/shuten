import { describe, expect, it } from "vitest";

import { parseArgs } from "./args.ts";

const REQUIRED = ["--manuscript", "manuscript.txt", "--model", "test-model"];

describe("parseArgs: 既定値", () => {
  it("必須以外を省略すると計画の暫定値になる（C 表の前提）", () => {
    const result = parseArgs(REQUIRED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allowedWordsPath).toBeNull();
    expect(result.value.outPath).toBeNull();
    expect(result.value.mode).toBe("split");
    expect(result.value.perspectives).toEqual(["typo", "naturalness"]);
    expect(result.value.maxTokens).toBe(16000);
    expect(result.value.temperature).toBe(0);
    expect(result.value.seed).toBeUndefined();
    expect(result.value.reasoningEffort).toBeUndefined();
    expect(result.value.chunkSettings).toEqual({
      targetGraphemes: 1500,
      contextGraphemes: 1000,
      recheckContextGraphemes: 3000,
      roundingTolerance: 0.2,
      maxInputGraphemes: 12000,
    });
    expect(result.value.checkTimeoutMs).toBe(300000);
    expect(result.value.recheckTimeoutMs).toBe(300000);
  });
});

describe("parseArgs C1: 必須引数の欠落", () => {
  it("--manuscript も --model もないとエラー値を返す", () => {
    const result = parseArgs([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/--manuscript/);
    expect(result.error).toMatch(/--model/);
  });

  it("--manuscript だけないとエラー値を返す", () => {
    const result = parseArgs(["--model", "test-model"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/--manuscript/);
  });

  it("--model だけないとエラー値を返す", () => {
    const result = parseArgs(["--manuscript", "manuscript.txt"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/--model/);
  });

  it("例外を投げない（エラー値で返す）", () => {
    expect(() => parseArgs([])).not.toThrow();
  });
});

describe("parseArgs C2: 未知のオプション・不正な値", () => {
  it("未知のオプションを拒否する", () => {
    const result = parseArgs([...REQUIRED, "--not-an-option", "1"]);
    expect(result.ok).toBe(false);
  });

  it("数値でない --max-tokens を拒否する", () => {
    const result = parseArgs([...REQUIRED, "--max-tokens", "abc"]);
    expect(result.ok).toBe(false);
  });

  it("数値でない --target-graphemes を拒否する", () => {
    const result = parseArgs([...REQUIRED, "--target-graphemes", "1500.5.5"]);
    expect(result.ok).toBe(false);
  });

  it.each(["abc", "2.", "1e1"])("数値でない --temperature %s を拒否する", (raw) => {
    const result = parseArgs([...REQUIRED, "--temperature", raw]);
    expect(result.ok).toBe(false);
  });

  // 仕様書 13 節（モデルごとの生成パラメーター）が未決のため、CLI では範囲を課さない。
  it.each(["0", "1", "2", "-1", "3", "2.1"])(
    "有限数の --temperature %s は範囲によらず受け付ける",
    (raw) => {
      const result = parseArgs([...REQUIRED, "--temperature", raw]);
      expect(result.ok).toBe(true);
    },
  );

  it("値のないオプションを拒否する", () => {
    const result = parseArgs([...REQUIRED, "--max-tokens"]);
    expect(result.ok).toBe(false);
  });

  it("同じオプションの重複指定を拒否する", () => {
    const result = parseArgs([...REQUIRED, "--max-tokens", "100", "--max-tokens", "200"]);
    expect(result.ok).toBe(false);
  });
});

describe("parseArgs C3: --perspectives の分割と検証", () => {
  it("カンマ区切りを分割する", () => {
    const result = parseArgs([...REQUIRED, "--perspectives", "typo,naturalness"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.perspectives).toEqual(["typo", "naturalness"]);
  });

  it("1 件だけの指定も受け付ける", () => {
    const result = parseArgs([...REQUIRED, "--perspectives", "typo"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.perspectives).toEqual(["typo"]);
  });

  it("未知の観点を拒否する", () => {
    const result = parseArgs([...REQUIRED, "--perspectives", "typo,unknown"]);
    expect(result.ok).toBe(false);
  });

  it("空文字列を拒否する", () => {
    const result = parseArgs([...REQUIRED, "--perspectives", ""]);
    expect(result.ok).toBe(false);
  });

  it("末尾のカンマ（空要素）を拒否する", () => {
    const result = parseArgs([...REQUIRED, "--perspectives", "typo,"]);
    expect(result.ok).toBe(false);
  });

  it("重複を出現順を保って除く", () => {
    const single = parseArgs([...REQUIRED, "--perspectives", "typo,typo"]);
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(single.value.perspectives).toEqual(["typo"]);

    const both = parseArgs([...REQUIRED, "--perspectives", "naturalness,typo,naturalness"]);
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.value.perspectives).toEqual(["naturalness", "typo"]);
  });

  it("重複除去より先に未知の観点を拒否する", () => {
    const result = parseArgs([...REQUIRED, "--perspectives", "typo,unknown,typo"]);
    expect(result.ok).toBe(false);
  });
});

describe("parseArgs C4: full-text でも recheck-context-graphemes を検証する", () => {
  it("--mode full-text でも --recheck-context-graphemes が chunkSettings に記録される", () => {
    const result = parseArgs([
      ...REQUIRED,
      "--mode",
      "full-text",
      "--recheck-context-graphemes",
      "500",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("full-text");
    expect(result.value.chunkSettings.recheckContextGraphemes).toBe(500);
  });

  it("--mode full-text でも不正な --recheck-context-graphemes を拒否する（使われないだけで検証はする）", () => {
    const result = parseArgs([
      ...REQUIRED,
      "--mode",
      "full-text",
      "--recheck-context-graphemes",
      "-1",
    ]);
    expect(result.ok).toBe(false);
  });

  it("未知の --mode を拒否する", () => {
    const result = parseArgs([...REQUIRED, "--mode", "unknown-mode"]);
    expect(result.ok).toBe(false);
  });
});
