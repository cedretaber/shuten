/**
 * 画面と API の単位変換（決定 12 の表）の往復テスト（W7-2〜3）。
 *
 * 画面はタイムアウトを秒、丸め許容をパーセントで入力させ、送信時に API の単位（ミリ秒・割合）へ
 * 変換する。往復（画面 → API → 画面）で元の値に戻ることを確認する。
 */

import { MAX_TIMEOUT_MS } from "@shuten/shared";
import { describe, expect, it } from "vitest";
import {
  MAX_TIMEOUT_SECONDS,
  msToSeconds,
  percentToTolerance,
  secondsToMs,
  toleranceToPercent,
} from "./units.ts";

describe("msToSeconds / secondsToMs", () => {
  it("W7-2: 300000ms は 300 秒、300 秒は 300000ms（往復する）", () => {
    expect(msToSeconds(300_000)).toBe(300);
    expect(secondsToMs(300)).toBe(300_000);
    expect(secondsToMs(msToSeconds(300_000))).toBe(300_000);
    expect(msToSeconds(secondsToMs(300))).toBe(300);
  });

  it("MAX_TIMEOUT_SECONDS は MAX_TIMEOUT_MS を 1000 で割って切り捨てた値", () => {
    expect(MAX_TIMEOUT_SECONDS).toBe(Math.floor(MAX_TIMEOUT_MS / 1000));
    expect(MAX_TIMEOUT_SECONDS).toBe(2_147_483);
  });
});

describe("toleranceToPercent / percentToTolerance", () => {
  it("W7-3: 0.2 は 20%、20% は 0.2（往復する）", () => {
    expect(toleranceToPercent(0.2)).toBe(20);
    expect(percentToTolerance(20)).toBe(0.2);
    expect(percentToTolerance(toleranceToPercent(0.2))).toBe(0.2);
    expect(toleranceToPercent(percentToTolerance(20))).toBe(20);
  });

  it("0.15 も往復する（浮動小数の誤差が出ないことの確認）", () => {
    expect(toleranceToPercent(0.15)).toBe(15);
    expect(percentToTolerance(15)).toBe(0.15);
  });
});
