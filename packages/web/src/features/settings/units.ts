/**
 * 画面と API の単位変換（決定 12 の表）。往復の変換をここ 1 か所にまとめる。
 *
 * | 項目 | 画面での入力 | 送信する値 |
 * | --- | --- | --- |
 * | `checkMs` / `recheckMs` | 秒（整数 1〜`MAX_TIMEOUT_SECONDS`） | 入力 × 1000 |
 * | `roundingTolerance` | パーセント（整数 0〜99） | 入力 ÷ 100 |
 *
 * `Math.round` を挟むのは、画面が渡す値が常に往復ぴったりの整数とは限らない場合への保険
 * （0.2 * 100 === 20、20 / 100 === 0.2 などは JS の Number でも厳密に成立するが、
 * 他の入力で浮動小数の誤差が出ても整数側へ寄せる）。
 */

import { MAX_TIMEOUT_MS } from "@shuten/shared";

/** 画面でのタイムアウト入力の上限（秒）。`Math.floor(MAX_TIMEOUT_MS / 1000)`。 */
export const MAX_TIMEOUT_SECONDS: number = Math.floor(MAX_TIMEOUT_MS / 1000);

export function msToSeconds(ms: number): number {
  return Math.round(ms / 1000);
}

export function secondsToMs(seconds: number): number {
  return seconds * 1000;
}

export function toleranceToPercent(value: number): number {
  return Math.round(value * 100);
}

export function percentToTolerance(percent: number): number {
  return percent / 100;
}
