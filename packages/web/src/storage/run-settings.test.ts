/**
 * `storage/run-settings.ts` の単体テスト（PR11c 決定 4、計画書 S4-1〜4）。
 *
 * 基本（メイン画面）・詳細（設定画面）は同じ `localStorage` の保存値の別々の持ち分を読み書きする。
 * 「現在の保存値を読む → 自分の持ち分だけ差し替える → 書き戻す」という部分更新が効いていることを、
 * 一方の書き込みがもう一方の持ち分を壊さないことで確認する。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "./keys.ts";
import {
  ADVANCED_RUN_SETTINGS_DEFAULTS,
  BASIC_RUN_SETTINGS_DEFAULTS,
  readAdvancedRunSettings,
  readBasicRunSettings,
  writeAdvancedRunSettings,
  writeBasicRunSettings,
} from "./run-settings.ts";

describe("readBasicRunSettings / readAdvancedRunSettings / writeBasicRunSettings / writeAdvancedRunSettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("S4-1: 詳細を書いても基本の持ち分が残る", () => {
    const basic = {
      ...BASIC_RUN_SETTINGS_DEFAULTS,
      perspectives: ["typo"] as const,
      targetGraphemes: 2_000,
    };
    writeBasicRunSettings(basic);

    writeAdvancedRunSettings(ADVANCED_RUN_SETTINGS_DEFAULTS);

    expect(readBasicRunSettings()).toEqual(basic);
  });

  it("S4-2: 基本を書いても詳細の持ち分が残る", () => {
    const advanced = {
      ...ADVANCED_RUN_SETTINGS_DEFAULTS,
      generation: { ...ADVANCED_RUN_SETTINGS_DEFAULTS.generation, temperature: 0.7 },
      timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    };
    writeAdvancedRunSettings(advanced);

    writeBasicRunSettings(BASIC_RUN_SETTINGS_DEFAULTS);

    expect(readAdvancedRunSettings()).toEqual(advanced);
  });

  it("S4-3: chunkSettings が項目単位で混ざる（targetGraphemes は基本、maxInputGraphemes は詳細）", () => {
    writeBasicRunSettings({ ...BASIC_RUN_SETTINGS_DEFAULTS, targetGraphemes: 2_000 });
    writeAdvancedRunSettings({ ...ADVANCED_RUN_SETTINGS_DEFAULTS, maxInputGraphemes: 20_000 });

    expect(readBasicRunSettings().targetGraphemes).toBe(2_000);
    expect(readAdvancedRunSettings().maxInputGraphemes).toBe(20_000);
  });

  it("S4-4: seed の無い詳細設定を書くと、保存値から seed がキーごと消える", () => {
    writeAdvancedRunSettings({
      ...ADVANCED_RUN_SETTINGS_DEFAULTS,
      generation: { ...ADVANCED_RUN_SETTINGS_DEFAULTS.generation, seed: 42 },
    });

    // seed を持たない AdvancedRunSettings を書き戻す。
    writeAdvancedRunSettings(ADVANCED_RUN_SETTINGS_DEFAULTS);

    const raw = localStorage.getItem(STORAGE_KEYS.runSettings);
    expect(raw).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: 直前で null でないことを確認済み
    const parsed = JSON.parse(raw!);
    expect("seed" in parsed.generation).toBe(false);
  });
});
