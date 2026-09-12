import type { RunExportDto } from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { parseExportJson } from "./export-adapter.ts";

// すべて合成の値（実原稿・実行結果の断片を含まない）。

/**
 * 最小構成の有効なエクスポート JSON（`RunExportDto`）。`targets` / `checkUnits` / `findings` /
 * `unlocatedCandidates` / `unlocatedDiagnostics` はすべて空。`parseExportJson` が
 * `runExportDtoSchema`（形の正本）をそのまま使っていることの確認が目的で、写像
 * （`adaptExportToResult`）は別ファイルで検証する。
 */
function validExportJson(): RunExportDto {
  return {
    formatVersion: "1",
    exportedAt: "2026-01-01T00:00:00.000Z",
    run: {
      id: "r1",
      manuscriptVersionId: "mv1",
      modelId: "model-a",
      modelInfo: null,
      generationSettings: { maxTokens: 512, temperature: 0.2 },
      chunkSettings: {
        targetGraphemes: 1500,
        contextGraphemes: 1000,
        recheckContextGraphemes: 3000,
        roundingTolerance: 0.2,
        maxInputGraphemes: 8000,
      },
      timeouts: { checkMs: 60_000, recheckMs: 60_000 },
      perspectives: ["typo", "naturalness"],
      recheckEnabled: true,
      allowedWords: [],
      allowedWordRuleVersion: "1",
      promptVersion: "1",
      diagnosticTransformVersion: "1",
      status: "completed",
      stopReason: null,
      stopMessage: null,
      generationUnconfirmed: false,
      stopRequestedAt: null,
      recoveryConfirmedAt: null,
      recoveryConfirmMs: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
    },
    manuscript: {
      id: "mv1",
      name: "原稿",
      body: "あいうえお",
      bodyHash: "a".repeat(64),
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    targets: [],
    checkUnits: [],
    recheckUnits: [],
    findings: [],
    unlocatedCandidates: [],
    unlocatedDiagnostics: [],
  };
}

describe("export-adapter: parseExportJson", () => {
  it("runExportDtoSchema を満たす値をそのまま受け入れる", () => {
    const json = validExportJson();

    const result = parseExportJson(json);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(json);
    }
  });

  it("必須項目が欠けていれば拒否する", () => {
    const json = validExportJson() as unknown as Record<string, unknown>;
    delete json.manuscript;

    const result = parseExportJson(json);

    expect(result.ok).toBe(false);
  });

  it("`.strict()` により未知のキーを持つ値を拒否する（余分なキーを黙って落とさない）", () => {
    const json = { ...validExportJson(), endpointUrl: "http://127.0.0.1:1234" };

    const result = parseExportJson(json);

    expect(result.ok).toBe(false);
  });

  it("エラーメッセージに path と code だけを含み、値そのものは含めない", () => {
    const json = { ...validExportJson(), formatVersion: "2" };

    const result = parseExportJson(json);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((message) => message.startsWith("formatVersion: "))).toBe(true);
      expect(result.errors.join(" ")).not.toContain("2");
    }
  });
});
