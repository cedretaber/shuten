import { describe, expect, it } from "vitest";
import {
  type ChunkSettings,
  InputTooLongError,
  InvalidChunkSettingsError,
  roundingDelta,
  validateChunkSettings,
} from "./settings.ts";

/** 検証用の基準設定（初期案）。 */
const base: ChunkSettings = {
  targetGraphemes: 1500,
  contextGraphemes: 1000,
  recheckContextGraphemes: 3000,
  roundingTolerance: 0.2,
  maxInputGraphemes: 8000,
};

describe("roundingDelta", () => {
  it("floor(目標 × 割合) を返す", () => {
    expect(roundingDelta(1500, 0.2)).toBe(300);
    expect(roundingDelta(10, 0.2)).toBe(2);
    expect(roundingDelta(4, 0.2)).toBe(0);
    expect(roundingDelta(7, 0.5)).toBe(3);
  });
});

describe("validateChunkSettings", () => {
  it("妥当な設定は例外を投げていない", () => {
    expect(() => validateChunkSettings(base)).not.toThrow();
  });

  it("不正な設定には InvalidChunkSettingsError を投げる", () => {
    const invalidCases: readonly ChunkSettings[] = [
      { ...base, targetGraphemes: 0 },
      { ...base, targetGraphemes: 1.5 },
      { ...base, targetGraphemes: 2 ** 53 },
      { ...base, contextGraphemes: -1 },
      { ...base, contextGraphemes: 0.5 },
      { ...base, contextGraphemes: 2 ** 53 },
      { ...base, recheckContextGraphemes: -1 },
      { ...base, recheckContextGraphemes: 1.5 },
      { ...base, recheckContextGraphemes: 2 ** 53 },
      { ...base, roundingTolerance: 1 },
      { ...base, roundingTolerance: -0.1 },
      { ...base, roundingTolerance: Number.NaN },
      { ...base, roundingTolerance: Number.POSITIVE_INFINITY },
      { ...base, maxInputGraphemes: 1799 },
      { ...base, maxInputGraphemes: 1800.5 },
      { ...base, maxInputGraphemes: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const settings of invalidCases) {
      expect(() => validateChunkSettings(settings)).toThrowError(InvalidChunkSettingsError);
    }
  });

  it("maxInputGraphemes=1800（下限ちょうど）は例外を投げていない", () => {
    expect(() => validateChunkSettings({ ...base, maxInputGraphemes: 1800 })).not.toThrow();
  });
});

describe("InputTooLongError", () => {
  it("required と limit を持ち、Error である", () => {
    const error = new InputTooLongError(18, 15);
    expect(error.required).toBe(18);
    expect(error.limit).toBe(15);
    expect(error.name).toBe("InputTooLongError");
    expect(error).toBeInstanceOf(Error);
  });
});
