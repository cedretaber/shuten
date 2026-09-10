/**
 * `storage/local.ts` の単体テスト（計画書 W3-1〜8）。`localStorage` が使えない環境（プライベート
 * ウィンドウなど）や壊れた値でも例外を外に出さず既定値へ戻ることを確認する。
 */

import { RUN_SETTINGS_DEFAULTS } from "@shuten/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { STORAGE_KEYS } from "./keys.ts";
import {
  readStored,
  type StoredAllowedWords,
  storedAllowedWordsSchema,
  storedRunSettingsSchema,
  writeStored,
} from "./local.ts";

describe("readStored / writeStored / removeStored", () => {
  beforeEach(() => {
    // テスト間で localStorage の状態とスパイが残らないようにする。
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("W3-1: 保存した値をそのまま読み出せる（往復）", () => {
    const value: StoredAllowedWords = {
      manuscriptVersionId: "mv-1",
      allowedWordsRaw: "猫又\n付喪神",
    };
    const fallback: StoredAllowedWords = { manuscriptVersionId: "", allowedWordsRaw: "" };

    writeStored(STORAGE_KEYS.allowedWords, value);
    const restored = readStored(STORAGE_KEYS.allowedWords, storedAllowedWordsSchema, fallback);

    expect(restored).toEqual(value);
  });

  it("W3-2: JSON として壊れた値は既定値を返し、キーを消す", () => {
    localStorage.setItem(STORAGE_KEYS.allowedWords, "{ 壊れた json");
    const fallback: StoredAllowedWords = { manuscriptVersionId: "", allowedWordsRaw: "" };

    const restored = readStored(STORAGE_KEYS.allowedWords, storedAllowedWordsSchema, fallback);

    expect(restored).toEqual(fallback);
    expect(localStorage.getItem(STORAGE_KEYS.allowedWords)).toBeNull();
  });

  it("W3-3: JSON だがスキーマ違反の値は既定値を返し、キーを消す", () => {
    // manuscriptVersionId が number（スキーマは string を要求）。
    localStorage.setItem(
      STORAGE_KEYS.allowedWords,
      JSON.stringify({ manuscriptVersionId: 123, allowedWordsRaw: "犬神" }),
    );
    const fallback: StoredAllowedWords = { manuscriptVersionId: "", allowedWordsRaw: "" };

    const restored = readStored(STORAGE_KEYS.allowedWords, storedAllowedWordsSchema, fallback);

    expect(restored).toEqual(fallback);
    expect(localStorage.getItem(STORAGE_KEYS.allowedWords)).toBeNull();
  });

  it("W3-4: getItem が throw する環境では既定値を返し、例外を外に出さない", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("private window");
    });
    const fallback = "fallback-model-id";

    let result: string | undefined;
    expect(() => {
      result = readStored(STORAGE_KEYS.selectedModelId, z.string(), fallback);
    }).not.toThrow();
    expect(result).toBe(fallback);
  });

  it("W3-5: setItem が throw する環境では例外を外に出さない（値も書き込まれない）", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => writeStored(STORAGE_KEYS.selectedModelId, "model-a")).not.toThrow();
    expect(localStorage.getItem(STORAGE_KEYS.selectedModelId)).toBeNull();
  });

  it("W3-6: storedRunSettingsSchema は RUN_SETTINGS_DEFAULTS 由来の値を受け入れる", () => {
    const parsed = storedRunSettingsSchema.safeParse(RUN_SETTINGS_DEFAULTS);

    expect(parsed.success).toBe(true);
  });

  it("W3-6b: reasoningEffort が列挙外の値ならスキーマ違反として拒否する", () => {
    // reasoningEffort に許容されない値を入れるとスキーマ違反として拒否される（境界を実際に守っているかの確認）。
    const broken = {
      ...RUN_SETTINGS_DEFAULTS,
      generation: { ...RUN_SETTINGS_DEFAULTS.generation, reasoningEffort: "invalid" },
    };

    const parsed = storedRunSettingsSchema.safeParse(broken);

    expect(parsed.success).toBe(false);
  });

  it("W3-7: 許容語は manuscriptVersionId と allowedWordsRaw の組で保存される", () => {
    const value: StoredAllowedWords = {
      manuscriptVersionId: "mv-42",
      allowedWordsRaw: "白狐、九尾",
    };

    writeStored(STORAGE_KEYS.allowedWords, value);

    const raw = localStorage.getItem(STORAGE_KEYS.allowedWords);
    expect(raw).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: 直前で null でないことを確認済み
    expect(JSON.parse(raw!)).toEqual({
      manuscriptVersionId: "mv-42",
      allowedWordsRaw: "白狐、九尾",
    });
  });

  it("W3-8: 壊れた値を消す removeItem が throw しても既定値を返し例外を外に出さない", () => {
    localStorage.setItem(STORAGE_KEYS.allowedWords, "{ 壊れた json");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("private window");
    });
    const fallback: StoredAllowedWords = { manuscriptVersionId: "", allowedWordsRaw: "" };

    let result: StoredAllowedWords | undefined;
    expect(() => {
      result = readStored(STORAGE_KEYS.allowedWords, storedAllowedWordsSchema, fallback);
    }).not.toThrow();
    expect(result).toEqual(fallback);
  });
});
