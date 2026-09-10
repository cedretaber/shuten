/**
 * 確定済み原稿のプレビュー切り出し（決定 17）。
 *
 * `body.slice(0, PREVIEW_GRAPHEMES)` は使わない：サロゲートペア・結合文字・ZWJ 絵文字・CRLF の
 * 途中で切れる。`buildGraphemeIndex` と `offsetAt` で UTF-16 位置を求めて切る。
 *
 * `offsetAt(index, PREVIEW_GRAPHEMES)` を直に呼ばない：`offsetAt` は範囲外
 * （`grapheme > index.count`）で `RangeError` を投げるため、本文が `PREVIEW_GRAPHEMES` 書記素未満
 * だと必ず落ちる。`Math.min(index.count, PREVIEW_GRAPHEMES)` で挟む。
 */

import { buildGraphemeIndex, offsetAt } from "@shuten/shared";

export const PREVIEW_GRAPHEMES = 500;

/**
 * 先頭 `PREVIEW_GRAPHEMES` 書記素を切り出す。本文がそれより短ければ全文を返し
 * `truncated: false` とする（この場合、全文展開の操作自体を画面に出さない）。
 */
export function buildPreview(body: string): { text: string; truncated: boolean } {
  const index = buildGraphemeIndex(body);
  const previewCount = Math.min(index.count, PREVIEW_GRAPHEMES);
  const text = body.slice(0, offsetAt(index, previewCount));
  return { text, truncated: index.count > PREVIEW_GRAPHEMES };
}
