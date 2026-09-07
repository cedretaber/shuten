import { describe, expect, it } from "vitest";
import { buildGraphemeIndex } from "../text/grapheme-index.ts";
import { sliceRange } from "../text/range.ts";
import type { DiagnosticTransform } from "./position-map.ts";
import {
  applyTransform,
  buildComparisonText,
  coverSource,
  mapToSource,
  overlapsTransformedChunk,
} from "./position-map.ts";

describe("applyTransform の変換", () => {
  it("newline は CRLF と単独 CR を LF に統一する", () => {
    expect(applyTransform("a\r\nb\rc\n", "newline")).toBe("a\nb\nc\n");
  });

  it("nfc は結合形を正規形に変換し、既に正規形なら不変", () => {
    expect(applyTransform("か\u3099", "nfc")).toBe("が");
    expect(applyTransform("が", "nfc")).toBe("が");
  });

  it("newline+nfc は先に改行を統一してから NFC 化する", () => {
    expect(applyTransform("か\u3099\r\n", "newline+nfc")).toBe("が\n");
  });
});

describe("buildComparisonText 本文 C", () => {
  const textC = "\u{20BB7}野家。\r\nか\u3099き\n終わり";
  const indexC = buildGraphemeIndex(textC);
  const full = { start: 0, end: 14 };

  it("boundaries は [0,2,3,4,5,7,9,10,11,12,13,14]", () => {
    expect(indexC.boundaries).toEqual([0, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14]);
  });

  it("newline の比較文字列とチャンク", () => {
    const cmp = buildComparisonText(textC, full, indexC, "newline");
    expect(cmp.text).toBe("\u{20BB7}野家。\nか\u3099き\n終わり");
    expect(cmp.chunks).toEqual([{ sourceStart: 5, sourceEnd: 7, outputStart: 5, outputEnd: 6 }]);
  });

  it("nfc の比較文字列とチャンク", () => {
    const cmp = buildComparisonText(textC, full, indexC, "nfc");
    expect(cmp.text).toBe("\u{20BB7}野家。\r\nがき\n終わり");
    expect(cmp.chunks).toEqual([{ sourceStart: 7, sourceEnd: 9, outputStart: 7, outputEnd: 8 }]);
  });

  it("newline+nfc の比較文字列とチャンク", () => {
    const cmp = buildComparisonText(textC, full, indexC, "newline+nfc");
    expect(cmp.text).toBe("\u{20BB7}野家。\nがき\n終わり");
    expect(cmp.chunks).toEqual([
      { sourceStart: 5, sourceEnd: 7, outputStart: 5, outputEnd: 6 },
      { sourceStart: 7, sourceEnd: 9, outputStart: 6, outputEnd: 7 },
    ]);
  });

  it("mapToSource は全 offset を正しい原文位置の配列に写す", () => {
    const cases: ReadonlyArray<readonly [DiagnosticTransform, number[]]> = [
      ["newline", [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14]],
      ["nfc", [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14]],
      ["newline+nfc", [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14]],
    ];
    for (const [transform, expected] of cases) {
      const cmp = buildComparisonText(textC, full, indexC, transform);
      const mapped: Array<number | null> = [];
      for (let offset = 0; offset <= cmp.text.length; offset += 1) {
        mapped.push(mapToSource(cmp, offset));
      }
      expect(mapped).toEqual(expected);
    }
  });
});

describe("buildComparisonText 本文 D", () => {
  const textD = "か\u3099\u0301る";
  const indexD = buildGraphemeIndex(textD);

  it("boundaries は [0,3,4]", () => {
    expect(indexD.boundaries).toEqual([0, 3, 4]);
  });

  it("nfc の比較文字列・チャンク", () => {
    const cmp = buildComparisonText(textD, { start: 0, end: 4 }, indexD, "nfc");
    expect(cmp.text).toBe("が\u0301る");
    expect(cmp.chunks).toEqual([{ sourceStart: 0, sourceEnd: 3, outputStart: 0, outputEnd: 2 }]);
  });

  it("mapToSource はチャンク内部を null、端を原文位置に写す", () => {
    const cmp = buildComparisonText(textD, { start: 0, end: 4 }, indexD, "nfc");
    expect(mapToSource(cmp, 0)).toBe(0);
    expect(mapToSource(cmp, 1)).toBeNull();
    expect(mapToSource(cmp, 2)).toBe(3);
    expect(mapToSource(cmp, 3)).toBe(4);
  });

  it("coverSource はチャンクをまたぐ端を原文範囲まで広げる", () => {
    const cmp = buildComparisonText(textD, { start: 0, end: 4 }, indexD, "nfc");
    expect(coverSource(cmp, indexD, 0, 1)).toEqual({ start: 0, end: 3 });
    expect(coverSource(cmp, indexD, 2, 3)).toEqual({ start: 3, end: 4 });
  });

  it("overlapsTransformedChunk はチャンクとの重複を判定する", () => {
    const cmp = buildComparisonText(textD, { start: 0, end: 4 }, indexD, "nfc");
    expect(overlapsTransformedChunk(cmp, 0, 1)).toBe(true);
    expect(overlapsTransformedChunk(cmp, 2, 3)).toBe(false);
  });
});

describe("クラスタごとの NFC は全文 NFC と一致", () => {
  const texts = [
    "\u{20BB7}野家。\r\nか\u3099き\n終わり",
    "か\u3099\u0301る",
    "か\u3099一\nか\u3099二\nか\u3099三\nか\u3099四",
    "か\u3099一\n二\nか\u3099三",
    "\u{1F468}\u200D\u{1F469}e\u0301\u{20BB7}\r\n",
  ];

  it("各文字列で nfc の比較文字列が全文 normalize と等しい", () => {
    for (const text of texts) {
      const cmp = buildComparisonText(
        text,
        { start: 0, end: text.length },
        buildGraphemeIndex(text),
        "nfc",
      );
      expect(cmp.text).toBe(text.normalize("NFC"));
    }
  });
});

describe("恒等変換", () => {
  it("範囲内に改行変換の対象がない場合は比較文字列が原文範囲と等しくチャンクは空", () => {
    const textC = "\u{20BB7}野家。\r\nか\u3099き\n終わり";
    const indexC = buildGraphemeIndex(textC);
    const range = { start: 7, end: 14 };
    const cmp = buildComparisonText(textC, range, indexC, "newline");
    expect(cmp.text).toBe(sliceRange(textC, range));
    expect(cmp.chunks).toEqual([]);
    expect(mapToSource(cmp, 3)).toBe(10);
  });
});

describe("範囲外の入力", () => {
  it("範囲の端が書記素境界でない（サロゲートペア内部）場合は RangeError", () => {
    const textC = "\u{20BB7}野家。\r\nか\u3099き\n終わり";
    const indexC = buildGraphemeIndex(textC);
    expect(() => buildComparisonText(textC, { start: 1, end: 14 }, indexC, "nfc")).toThrowError(
      RangeError,
    );
  });

  it("mapToSource は範囲外の offset で RangeError", () => {
    const textC = "\u{20BB7}野家。\r\nか\u3099き\n終わり";
    const indexC = buildGraphemeIndex(textC);
    const cmp = buildComparisonText(textC, { start: 0, end: 14 }, indexC, "newline");
    expect(() => mapToSource(cmp, -1)).toThrowError(RangeError);
    expect(() => mapToSource(cmp, cmp.text.length + 1)).toThrowError(RangeError);
  });
});
