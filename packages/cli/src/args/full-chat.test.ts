import { MAX_TIMEOUT_MS, RUN_SETTINGS_DEFAULTS } from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { parseFullChatArgs } from "./full-chat.ts";

const REQUIRED = [
  "--manuscript",
  "manuscript.txt",
  "--model",
  "test-model",
  "--prompt-file",
  "prompt.txt",
];

describe("parseFullChatArgs: 既定値", () => {
  it("必須 3 つが揃えば成功し、既定値が RUN_SETTINGS_DEFAULTS と一致する", () => {
    const result = parseFullChatArgs(REQUIRED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manuscriptPath).toBe("manuscript.txt");
    expect(result.value.model).toBe("test-model");
    expect(result.value.promptPath).toBe("prompt.txt");
    expect(result.value.outPath).toBeNull();
    expect(result.value.maxTokens).toBe(RUN_SETTINGS_DEFAULTS.generation.maxTokens);
    expect(result.value.temperature).toBe(RUN_SETTINGS_DEFAULTS.generation.temperature);
    expect(result.value.seed).toBeUndefined();
    expect(result.value.reasoningEffort).toBe(RUN_SETTINGS_DEFAULTS.generation.reasoningEffort);
    expect(result.value.checkTimeoutMs).toBe(RUN_SETTINGS_DEFAULTS.timeouts.checkMs);
  });
});

describe("parseFullChatArgs: 必須引数の欠落", () => {
  it("--manuscript だけ欠けるとそれだけをメッセージに出す", () => {
    const result = parseFullChatArgs(["--model", "test-model", "--prompt-file", "prompt.txt"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("必須オプションがありません: --manuscript");
  });

  it("3 つとも欠けると欠けているものだけをこの順で並べる", () => {
    const result = parseFullChatArgs([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("必須オプションがありません: --manuscript, --model, --prompt-file");
  });
});

describe("parseFullChatArgs: 数値・列挙の検証", () => {
  it("--max-tokens 0 は拒否される", () => {
    const result = parseFullChatArgs([...REQUIRED, "--max-tokens", "0"]);
    expect(result.ok).toBe(false);
  });

  it("--seed -1 は拒否される", () => {
    const result = parseFullChatArgs([...REQUIRED, "--seed", "-1"]);
    expect(result.ok).toBe(false);
  });

  it("--temperature abc は拒否される", () => {
    const result = parseFullChatArgs([...REQUIRED, "--temperature", "abc"]);
    expect(result.ok).toBe(false);
  });

  it("--check-timeout-ms が MAX_TIMEOUT_MS を超えると拒否される", () => {
    const result = parseFullChatArgs([
      ...REQUIRED,
      "--check-timeout-ms",
      String(MAX_TIMEOUT_MS + 1),
    ]);
    expect(result.ok).toBe(false);
  });

  it("--check-timeout-ms が MAX_TIMEOUT_MS ちょうどなら通る", () => {
    const result = parseFullChatArgs([...REQUIRED, "--check-timeout-ms", String(MAX_TIMEOUT_MS)]);
    expect(result.ok).toBe(true);
  });

  it("--reasoning-effort medium は通る", () => {
    const result = parseFullChatArgs([...REQUIRED, "--reasoning-effort", "medium"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reasoningEffort).toBe("medium");
  });

  it("--reasoning-effort ultra は拒否される", () => {
    const result = parseFullChatArgs([...REQUIRED, "--reasoning-effort", "ultra"]);
    expect(result.ok).toBe(false);
  });
});

describe("parseFullChatArgs: この方式には無いオプション", () => {
  it("--perspectives typo は未知のオプションとして拒否される", () => {
    const result = parseFullChatArgs([...REQUIRED, "--perspectives", "typo"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/未知のオプション/);
  });

  it("--mode split は未知のオプションとして拒否される", () => {
    const result = parseFullChatArgs([...REQUIRED, "--mode", "split"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/未知のオプション/);
  });

  it("--allowed-words は未知のオプションとして拒否される", () => {
    const result = parseFullChatArgs([...REQUIRED, "--allowed-words", "words.txt"]);
    expect(result.ok).toBe(false);
  });

  it("--recheck-timeout-ms は未知のオプションとして拒否される", () => {
    const result = parseFullChatArgs([...REQUIRED, "--recheck-timeout-ms", "1000"]);
    expect(result.ok).toBe(false);
  });

  it("--target-graphemes は未知のオプションとして拒否される（分割設定は無い）", () => {
    const result = parseFullChatArgs([...REQUIRED, "--target-graphemes", "1500"]);
    expect(result.ok).toBe(false);
  });
});
