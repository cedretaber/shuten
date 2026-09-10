/**
 * `describeAdvancedChanges` の単体テスト（PR11c 決定 6、計画書 S5-1・S5-2）。
 *
 * メイン画面の要約は「既定値と違う項目を名前と値で」出す。件数だけでは、以前に上げた温度や
 * 伸ばしたタイムアウトを見落としたまま検査を開始してしまう。ここではその材料になる純関数が
 * 「既定値と違う項目だけを、表示単位で、決められた順に」返すことを見る。
 */

import { describe, expect, it } from "vitest";
import { ADVANCED_RUN_SETTINGS_DEFAULTS } from "../../storage/run-settings.ts";
import { describeAdvancedChanges } from "./advanced-settings-description.ts";

describe("describeAdvancedChanges", () => {
  it("S5-1: すべて既定値なら空配列", () => {
    expect(describeAdvancedChanges(ADVANCED_RUN_SETTINGS_DEFAULTS)).toEqual([]);
  });

  it("S5-1: シードは未設定（キーごと無い）なら既定値として扱い、出さない", () => {
    // `exactOptionalPropertyTypes` のため、`seed: undefined` を明示した形も別に確かめる。
    const withUndefinedSeed = {
      ...ADVANCED_RUN_SETTINGS_DEFAULTS,
      generation: { ...ADVANCED_RUN_SETTINGS_DEFAULTS.generation, seed: undefined },
    };

    expect(describeAdvancedChanges(withUndefinedSeed)).toEqual([]);
  });

  it("S5-2: 変更した項目だけが、表示単位（秒・%）で、決められた順に並ぶ", () => {
    // 順序の検証のため、8 項目すべてを既定値と違う値にする。
    const changed = describeAdvancedChanges({
      generation: {
        maxTokens: 20_000,
        temperature: 0.8,
        seed: 42,
        reasoningEffort: "high",
      },
      roundingTolerance: 0.3,
      maxInputGraphemes: 20_000,
      timeouts: { checkMs: 600_000, recheckMs: 600_000 },
    });

    expect(changed).toEqual([
      { label: "最大トークン数", value: "20000" },
      { label: "温度", value: "0.8" },
      { label: "シード", value: "42" },
      { label: "思考の強さ", value: "強い" },
      { label: "丸め許容", value: "30%" }, // 0.3 → 30%
      { label: "入力上限", value: "20000 字" },
      { label: "初回検査のタイムアウト", value: "600 秒" }, // 600000ms → 600 秒
      { label: "再確認のタイムアウト", value: "600 秒" },
    ]);
  });

  it("S5-2: 変えていない項目は並びから抜ける（並び順は残った項目の相対順を保つ）", () => {
    const changed = describeAdvancedChanges({
      ...ADVANCED_RUN_SETTINGS_DEFAULTS,
      generation: { ...ADVANCED_RUN_SETTINGS_DEFAULTS.generation, temperature: 0.8 },
      timeouts: {
        ...ADVANCED_RUN_SETTINGS_DEFAULTS.timeouts,
        checkMs: 600_000,
      },
    });

    expect(changed).toEqual([
      { label: "温度", value: "0.8" },
      { label: "初回検査のタイムアウト", value: "600 秒" },
    ]);
  });
});
