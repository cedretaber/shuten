import { countGraphemes, segmentGraphemes } from "@shuten/shared";
import { describe, expect, it } from "vitest";
import { buildPreview, PREVIEW_GRAPHEMES } from "./preview.ts";

/**
 * `buildPreview` の検証（W6-6〜7、決定 17）。
 *
 * `segmentGraphemes` で独立に計算した期待値と突き合わせる。`buildPreview` の実装が
 * `buildGraphemeIndex` / `offsetAt` を使っていても、期待値の計算経路は別（`segmentGraphemes` を
 * 直接畳み込む）にして、実装のバグをすり抜けにくくする。
 */

/** `segmentGraphemes` を使って先頭 n 書記素を独立に切り出す（テストの期待値専用）。 */
function expectedHead(body: string, n: number): string {
  return segmentGraphemes(body)
    .slice(0, n)
    .map((s) => s.segment)
    .join("");
}

describe("buildPreview", () => {
  it("W6-6: 499 書記素の本文は例外を投げず、全文を返す（truncated: false）", () => {
    const body = "あ".repeat(499);
    const result = buildPreview(body);
    expect(result.text).toBe(body);
    expect(result.truncated).toBe(false);
  });

  it("W6-6: 500 書記素の本文は例外を投げず、全文を返す（truncated: false）", () => {
    const body = "あ".repeat(500);
    const result = buildPreview(body);
    expect(result.text).toBe(body);
    expect(result.truncated).toBe(false);
  });

  it("W6-6: 501 書記素の本文は先頭 500 書記素だけを返す（truncated: true）", () => {
    const body = "あ".repeat(501);
    const result = buildPreview(body);
    expect(result.text).toBe("あ".repeat(500));
    expect(result.truncated).toBe(true);
    expect(countGraphemes(result.text)).toBe(PREVIEW_GRAPHEMES);
  });

  it("W6-6: 500 番目付近に ZWJ 絵文字・異体字セレクタ・CRLF があっても書記素境界で切れる", () => {
    // 495 個の「あ」（書記素 0〜494）+ ZWJ 絵文字（495）+ 異体字セレクタ付き絵文字（496）+
    // CRLF（497）+ 「あ」×13（498〜510）＝ 511 書記素。特殊なクラスタは 500 書記素目より前にある。
    const zwjEmoji = "👨‍👩‍👧"; // family: man + ZWJ + woman + ZWJ + girl（1 書記素、UTF-16 で 8 コード単位）
    const variationSelector = "☺️"; // U+263A + U+FE0F（1 書記素、2 コード単位）
    const crlf = "\r\n"; // 1 書記素、2 コード単位
    const body = "あ".repeat(495) + zwjEmoji + variationSelector + crlf + "あ".repeat(13);
    expect(countGraphemes(body)).toBe(511);

    const result = buildPreview(body);

    expect(result.truncated).toBe(true);
    expect(countGraphemes(result.text)).toBe(PREVIEW_GRAPHEMES);
    expect(result.text).toBe(expectedHead(body, PREVIEW_GRAPHEMES));
    // 素朴な UTF-16 単位での切り出しと一致しない：`body.slice(0, 500)` はクラスタの途中で切れる。
    expect(result.text).not.toBe(body.slice(0, PREVIEW_GRAPHEMES));
    // 特殊なクラスタが途中で切れていない（サロゲート単体・結合文字の欠落がない）。
    expect(result.text).toContain(zwjEmoji);
    expect(result.text).toContain(variationSelector);
    expect(result.text).toContain(crlf);
  });

  it("W6-7: 500 書記素ちょうどのとき truncated は false", () => {
    const body = "あ".repeat(500);
    expect(buildPreview(body).truncated).toBe(false);
  });

  it("空文字列でも例外を投げない", () => {
    const result = buildPreview("");
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });
});
