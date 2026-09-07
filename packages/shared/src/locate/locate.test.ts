import { describe, expect, it } from "vitest";
import { buildCheckInput, type CheckInput, planTargets } from "../chunk/plan.ts";
import type { ChunkSettings } from "../chunk/settings.ts";
import {
  buildGraphemeIndex,
  graphemeAt,
  isGraphemeBoundary,
  offsetAt,
} from "../text/grapheme-index.ts";
import type { Paragraph } from "../text/paragraph.ts";
import { splitParagraphs } from "../text/paragraph.ts";
import type { Range } from "../text/range.ts";
import { sliceRange } from "../text/range.ts";
import type { Diagnostic, DiagnosticCandidate } from "./diagnostic.ts";
import type { LocateFailureReason, LocateResult } from "./locate.ts";
import { locateQuote } from "./locate.ts";
import type { DiagnosticTransform } from "./position-map.ts";

/** L(s,e) = { status: "located", range: { start: s, end: e } } */
function L(start: number, end: number): LocateResult {
  return { status: "located", range: { start, end } };
}

/** D(candidates, omitted, tied) = 診断 */
function D(candidates: readonly DiagnosticCandidate[], omitted: number, tied: boolean): Diagnostic {
  return { transformVersion: "1", candidates, omitted, tied };
}

/** C(transform, text, range) = 診断候補 */
function C(transform: DiagnosticTransform, text: string, range: Range | null): DiagnosticCandidate {
  return { transform, text, range };
}

/** F(reason, [[s,e],...], diagnostic) = { status: "failed", ... } */
function F(
  reason: LocateFailureReason,
  exactMatches: ReadonlyArray<readonly [number, number]>,
  diagnostic: Diagnostic | null,
): LocateResult {
  return {
    status: "failed",
    reason,
    exactMatches: exactMatches.map(([start, end]) => ({ start, end })),
    diagnostic,
  };
}

/** 1 行のテストケース。 */
interface Row {
  readonly name: string;
  readonly paragraphId: number;
  readonly quote: string;
  readonly before: string;
  readonly after: string;
  readonly expected: LocateResult;
}

/** target と inputRange を直接与えて検査入力を組む（PR2 が作るものと同形）。 */
function makeInput(
  text: string,
  target: Range,
  inputRange: Range,
): { input: CheckInput; paragraphs: Paragraph[] } {
  const paragraphs = splitParagraphs(text);
  // planTargets と同じ重複規則。
  const paragraphIds = paragraphs
    .filter((p) => p.range.start < target.end && target.start < p.range.end)
    .map((p) => p.id);
  return {
    input: {
      target: { index: 0, range: target, paragraphIds },
      context: {
        before:
          inputRange.start < target.start ? { start: inputRange.start, end: target.start } : null,
        after: target.end < inputRange.end ? { start: target.end, end: inputRange.end } : null,
      },
      inputRange,
    },
    paragraphs,
  };
}

/** 行を 1 件実行して結果を返す。 */
function runRow(text: string, target: Range, inputRange: Range, row: Row): LocateResult {
  const { input, paragraphs } = makeInput(text, target, inputRange);
  return locateQuote(text, input, paragraphs, {
    paragraphId: row.paragraphId,
    quote: row.quote,
    before: row.before,
    after: row.after,
  });
}

describe("locateQuote 本文 A", () => {
  const text = "彼は言った。\n彼は言った。そして笑った。\n彼は笑った。";
  const target: Range = { start: 7, end: 21 };
  const inputRange: Range = { start: 0, end: 27 };

  const rows: readonly Row[] = [
    {
      name: "A1 段落で絞る",
      paragraphId: 1,
      quote: "彼は言った。",
      before: "",
      after: "そして",
      expected: L(7, 13),
    },
    {
      name: "A2 段落 0 を指すので対象外",
      paragraphId: 0,
      quote: "彼は言った。",
      before: "",
      after: "",
      expected: F("outside-target", [[0, 6]], null),
    },
    {
      name: "A3 段落 ID 不在、after で絞る",
      paragraphId: 5,
      quote: "彼は言った。",
      before: "",
      after: "そして",
      expected: L(7, 13),
    },
    {
      name: "A4 同段落 2 件で ambiguous",
      paragraphId: 1,
      quote: "。",
      before: "",
      after: "",
      expected: F(
        "ambiguous",
        [
          [12, 13],
          [19, 20],
        ],
        null,
      ),
    },
    {
      name: "A5 混在 3 件で ambiguous",
      paragraphId: 5,
      quote: "彼は",
      before: "",
      after: "",
      expected: F(
        "ambiguous",
        [
          [0, 2],
          [7, 9],
          [21, 23],
        ],
        null,
      ),
    },
    {
      name: "A6 ヒントが文脈側を指す",
      paragraphId: 2,
      quote: "笑った。",
      before: "彼は",
      after: "",
      expected: F("outside-target", [[23, 27]], null),
    },
    {
      name: "A7 before が改行を省く",
      paragraphId: 9,
      quote: "彼は言った。",
      before: "彼は言った。",
      after: "",
      expected: L(7, 13),
    },
    {
      name: "A8 after が改行を省く",
      paragraphId: 9,
      quote: "た。",
      before: "",
      after: "彼は笑った。",
      expected: L(18, 20),
    },
    {
      name: "A9 before が全候補と矛盾",
      paragraphId: 1,
      quote: "。",
      before: "ない",
      after: "",
      expected: F(
        "ambiguous",
        [
          [12, 13],
          [19, 20],
        ],
        null,
      ),
    },
    {
      name: "A10 一意ならヒント不備でも確定",
      paragraphId: 0,
      quote: "そして",
      before: "ない",
      after: "ない",
      expected: L(13, 16),
    },
    {
      name: "A11 対象から文脈へ続く",
      paragraphId: 1,
      quote: "笑った。\n彼は笑った。",
      before: "",
      after: "",
      expected: L(16, 27),
    },
    {
      name: "A12 文脈から始まり対象へ続く",
      paragraphId: 0,
      quote: "た。\n彼は言った。",
      before: "",
      after: "",
      expected: F("outside-target", [[4, 13]], null),
    },
    {
      name: "A13 段落で 1 件になれば before は見ない",
      paragraphId: 1,
      quote: "彼は言った。",
      before: "ない",
      after: "",
      expected: L(7, 13),
    },
    {
      name: "A14 空引用",
      paragraphId: 1,
      quote: "",
      before: "",
      after: "",
      expected: F("not-found", [], null),
    },
    {
      name: "A15 存在しない引用",
      paragraphId: 1,
      quote: "彼は泣いた。",
      before: "",
      after: "",
      expected: F("not-found", [], D([], 0, false)),
    },
    {
      name: "A16 before が全候補と矛盾したら after を見ずに ambiguous",
      paragraphId: 1,
      quote: "。",
      before: "ない",
      after: "そして",
      expected: F(
        "ambiguous",
        [
          [12, 13],
          [19, 20],
        ],
        null,
      ),
    },
    {
      name: "A17 存在するが一致の無い段落 ID で ambiguous",
      paragraphId: 2,
      quote: "彼は言った。",
      before: "",
      after: "そして",
      expected: F(
        "ambiguous",
        [
          [0, 6],
          [7, 13],
        ],
        null,
      ),
    },
    {
      name: "A18 矛盾時の候補が全部対象外",
      paragraphId: 0,
      quote: "彼は",
      before: "",
      after: "泣いた",
      expected: F("outside-target", [[0, 2]], null),
    },
  ];

  it.each(rows)("$name", (row) => {
    expect(runRow(text, target, inputRange, row)).toEqual(row.expected);
  });
});

describe("locateQuote 本文 B", () => {
  const text = "一二三四五\n六七八九十\n一二三四五\n六七八九十";
  const target: Range = { start: 12, end: 18 };
  const inputRange: Range = { start: 6, end: 23 };

  const rows: readonly Row[] = [
    {
      name: "B1 入力範囲外の一致は数えない",
      paragraphId: 2,
      quote: "一二三",
      before: "",
      after: "",
      expected: L(12, 15),
    },
    {
      name: "B2 文脈側 2 件、段落で 1 件、対象外",
      paragraphId: 3,
      quote: "六七",
      before: "",
      after: "",
      expected: F("outside-target", [[18, 20]], null),
    },
    {
      name: "B3 全候補が対象外",
      paragraphId: 7,
      quote: "六七",
      before: "",
      after: "",
      expected: F(
        "outside-target",
        [
          [6, 8],
          [18, 20],
        ],
        null,
      ),
    },
    {
      name: "B4 一意な一致（before は入力範囲内で一致）",
      paragraphId: 2,
      quote: "四五",
      before: "一二三",
      after: "",
      expected: L(15, 17),
    },
  ];

  it.each(rows)("$name", (row) => {
    expect(runRow(text, target, inputRange, row)).toEqual(row.expected);
  });
});

describe("locateQuote 本文 C", () => {
  const text = "\u{20BB7}野家。\r\nか\u3099き\n終わり";
  const target: Range = { start: 0, end: 14 };
  const inputRange: Range = { start: 0, end: 14 };

  const rows: readonly Row[] = [
    {
      name: "C1 本文先頭のサロゲートペア",
      paragraphId: 0,
      quote: "\u{20BB7}野",
      before: "",
      after: "家。",
      expected: L(0, 3),
    },
    {
      name: "C2 本文末",
      paragraphId: 2,
      quote: "終わり",
      before: "き",
      after: "",
      expected: L(11, 14),
    },
    {
      name: "C3 CRLF と結合文字を含む完全一致",
      paragraphId: 0,
      quote: "。\r\nか\u3099",
      before: "",
      after: "",
      expected: L(4, 9),
    },
    {
      name: "C4 サロゲート途中の一致は捨てる",
      paragraphId: 0,
      quote: "\uD842",
      before: "",
      after: "",
      expected: F("not-found", [], D([], 0, false)),
    },
    {
      name: "C5 結合文字途中の一致は捨てる",
      paragraphId: 1,
      quote: "か",
      before: "",
      after: "",
      expected: F("not-found", [], D([], 0, false)),
    },
    {
      name: "C6 NFC でのみ一致",
      paragraphId: 1,
      quote: "がき",
      before: "",
      after: "",
      expected: F("not-found", [], D([C("nfc", "か\u3099き", { start: 7, end: 10 })], 0, false)),
    },
    {
      name: "C7 改行統一でのみ一致",
      paragraphId: 0,
      quote: "家。\n",
      before: "",
      after: "",
      expected: F("not-found", [], D([C("newline", "家。\r\n", { start: 3, end: 7 })], 0, false)),
    },
    {
      name: "C8 両方でのみ一致",
      paragraphId: 0,
      quote: "。\nがき",
      before: "",
      after: "",
      expected: F(
        "not-found",
        [],
        D([C("newline+nfc", "。\r\nか\u3099き", { start: 4, end: 10 })], 0, false),
      ),
    },
    {
      name: "C9 どの変換でも一致なし",
      paragraphId: 0,
      quote: "吉野家",
      before: "",
      after: "",
      expected: F("not-found", [], D([], 0, false)),
    },
  ];

  it.each(rows)("$name", (row) => {
    expect(runRow(text, target, inputRange, row)).toEqual(row.expected);
  });
});

describe("locateQuote 本文 D", () => {
  const text = "か\u3099\u0301る";
  const target: Range = { start: 0, end: 4 };
  const inputRange: Range = { start: 0, end: 4 };

  const rows: readonly Row[] = [
    {
      name: "D1 位置対応不能",
      paragraphId: 0,
      quote: "が",
      before: "",
      after: "",
      expected: F("not-found", [], D([C("nfc", "か\u3099\u0301", null)], 0, false)),
    },
  ];

  it.each(rows)("$name", (row) => {
    expect(runRow(text, target, inputRange, row)).toEqual(row.expected);
  });
});

describe("locateQuote 本文 E", () => {
  const text = "か\u3099一\nか\u3099二\nか\u3099三\nか\u3099四";
  const target: Range = { start: 0, end: 15 };
  const inputRange: Range = { start: 0, end: 15 };

  const rows: readonly Row[] = [
    {
      name: "E1 段落 2 に近い順、打ち切り 1、距離 1 が 2 件",
      paragraphId: 2,
      quote: "が",
      before: "",
      after: "",
      expected: F(
        "not-found",
        [],
        D(
          [
            C("nfc", "か\u3099", { start: 8, end: 10 }),
            C("nfc", "か\u3099", { start: 4, end: 6 }),
            C("nfc", "か\u3099", { start: 12, end: 14 }),
          ],
          1,
          true,
        ),
      ),
    },
    {
      name: "E2 段落不在、位置順、同順位",
      paragraphId: 9,
      quote: "が",
      before: "",
      after: "",
      expected: F(
        "not-found",
        [],
        D(
          [
            C("nfc", "か\u3099", { start: 0, end: 2 }),
            C("nfc", "か\u3099", { start: 4, end: 6 }),
            C("nfc", "か\u3099", { start: 8, end: 10 }),
          ],
          1,
          true,
        ),
      ),
    },
    {
      name: "E3 段落 1、距離 1 が 2 件",
      paragraphId: 1,
      quote: "が",
      before: "",
      after: "",
      expected: F(
        "not-found",
        [],
        D(
          [
            C("nfc", "か\u3099", { start: 4, end: 6 }),
            C("nfc", "か\u3099", { start: 0, end: 2 }),
            C("nfc", "か\u3099", { start: 8, end: 10 }),
          ],
          1,
          true,
        ),
      ),
    },
    {
      name: "E4 段落 0、距離がすべて異なる",
      paragraphId: 0,
      quote: "が",
      before: "",
      after: "",
      expected: F(
        "not-found",
        [],
        D(
          [
            C("nfc", "か\u3099", { start: 0, end: 2 }),
            C("nfc", "か\u3099", { start: 4, end: 6 }),
            C("nfc", "か\u3099", { start: 8, end: 10 }),
          ],
          1,
          false,
        ),
      ),
    },
  ];

  it.each(rows)("$name", (row) => {
    expect(runRow(text, target, inputRange, row)).toEqual(row.expected);
  });
});

describe("locateQuote 本文 F", () => {
  const text = "か\u3099一\n二\nか\u3099三";
  const target: Range = { start: 0, end: 9 };
  const inputRange: Range = { start: 0, end: 9 };

  const rows: readonly Row[] = [
    {
      name: "F1 同順位 2 件",
      paragraphId: 1,
      quote: "が",
      before: "",
      after: "",
      expected: F(
        "not-found",
        [],
        D(
          [C("nfc", "か\u3099", { start: 0, end: 2 }), C("nfc", "か\u3099", { start: 6, end: 8 })],
          0,
          true,
        ),
      ),
    },
    {
      name: "F2 同順位なし",
      paragraphId: 0,
      quote: "が",
      before: "",
      after: "",
      expected: F(
        "not-found",
        [],
        D(
          [C("nfc", "か\u3099", { start: 0, end: 2 }), C("nfc", "か\u3099", { start: 6, end: 8 })],
          0,
          false,
        ),
      ),
    },
  ];

  it.each(rows)("$name", (row) => {
    expect(runRow(text, target, inputRange, row)).toEqual(row.expected);
  });
});

describe("locateQuote 本文 G", () => {
  const text = "あああ";
  const target: Range = { start: 0, end: 3 };
  const inputRange: Range = { start: 0, end: 3 };

  const rows: readonly Row[] = [
    {
      name: "G1 重なる出現",
      paragraphId: 0,
      quote: "ああ",
      before: "",
      after: "",
      expected: F(
        "ambiguous",
        [
          [0, 2],
          [1, 3],
        ],
        null,
      ),
    },
  ];

  it.each(rows)("$name", (row) => {
    expect(runRow(text, target, inputRange, row)).toEqual(row.expected);
  });
});

describe("locateQuote 本文 H", () => {
  const text = "がき\n葛\u{E0100}城\u{1F468}\u200D\u{1F469}。";
  const target: Range = { start: 0, end: 13 };
  const inputRange: Range = { start: 0, end: 13 };

  const rows: readonly Row[] = [
    {
      name: "H1 異体字セレクタを含む完全一致",
      paragraphId: 1,
      quote: "葛\u{E0100}城",
      before: "き",
      after: "",
      expected: L(3, 7),
    },
    {
      name: "H2 ZWJ 絵文字を含む完全一致",
      paragraphId: 1,
      quote: "城\u{1F468}\u200D\u{1F469}。",
      before: "",
      after: "",
      expected: L(6, 13),
    },
    {
      name: "H3 異体字セレクタの直前で切れる引用は捨てる",
      paragraphId: 1,
      quote: "葛",
      before: "",
      after: "",
      expected: F("not-found", [], D([], 0, false)),
    },
    {
      name: "H4 ZWJ 列の途中で切れる引用は捨てる",
      paragraphId: 1,
      quote: "\u{1F468}",
      before: "",
      after: "",
      expected: F("not-found", [], D([], 0, false)),
    },
    {
      name: "H5 引用側だけ NFC で変わる",
      paragraphId: 0,
      quote: "か\u3099き",
      before: "",
      after: "",
      expected: F("not-found", [], D([C("nfc", "がき", { start: 0, end: 2 })], 0, false)),
    },
    {
      name: "H6 引用側だけ改行統一で変わる",
      paragraphId: 0,
      quote: "き\r\n",
      before: "",
      after: "",
      expected: F("not-found", [], D([C("newline", "き\n", { start: 1, end: 3 })], 0, false)),
    },
    {
      name: "H7 引用側だけ両方で変わり、端が書記素境界に揃わない",
      paragraphId: 0,
      quote: "か\u3099き\r\n葛",
      before: "",
      after: "",
      expected: F("not-found", [], D([C("newline+nfc", "がき\n葛\u{E0100}", null)], 0, false)),
    },
  ];

  it.each(rows)("$name", (row) => {
    expect(runRow(text, target, inputRange, row)).toEqual(row.expected);
  });
});

describe("locateQuote 本文 J", () => {
  // 段落 3 に候補が無く、距離 2 の候補が段落 0 と段落 4 の 2 件ある（同順位が候補の無い段落を挟んで生じる）。
  const text = "か\u3099一\nか\u3099二\nか\u3099三\n四\nか\u3099五";
  const target: Range = { start: 8, end: 12 };
  const inputRange: Range = { start: 0, end: 17 };

  const rows: readonly Row[] = [
    {
      name: "J1 段落 2 に近い順、候補の無い段落を挟んだ同順位",
      paragraphId: 2,
      quote: "が",
      before: "",
      after: "",
      expected: F(
        "not-found",
        [],
        D(
          [
            C("nfc", "か\u3099", { start: 8, end: 10 }),
            C("nfc", "か\u3099", { start: 4, end: 6 }),
            C("nfc", "か\u3099", { start: 0, end: 2 }),
          ],
          1,
          true,
        ),
      ),
    },
  ];

  it.each(rows)("$name", (row) => {
    expect(runRow(text, target, inputRange, row)).toEqual(row.expected);
  });
});

describe("locateQuote 本文 K", () => {
  // 段落 0 は本文に存在するが入力範囲外。段落 1 は入力範囲と部分的に重なる。段落 2 には一致が無い。
  // 段落: 0 [0,3) "一二\n"、1 [3,7) "三一二\n"、2 [7,9) "四\n"、3 [9,13) "一二五\n"、4 [13,16) "一二六"
  const text = "一二\n三一二\n四\n一二五\n一二六";
  const target: Range = { start: 9, end: 13 };
  const inputRange: Range = { start: 4, end: 16 };

  const rows: readonly Row[] = [
    {
      name: "K1 入力範囲外の段落 ID はヒントなしとして飛ばし、after で絞る",
      paragraphId: 0,
      quote: "一二",
      before: "",
      after: "五",
      expected: L(9, 11),
    },
    {
      name: "K2 入力範囲内にあるが一致の無い段落 ID は打ち切って ambiguous",
      paragraphId: 2,
      quote: "一二",
      before: "",
      after: "五",
      expected: F(
        "ambiguous",
        [
          [4, 6],
          [9, 11],
          [13, 15],
        ],
        null,
      ),
    },
    {
      name: "K3 入力範囲と部分的に重なる段落 ID は有効なヒント",
      paragraphId: 1,
      quote: "一二",
      before: "",
      after: "",
      expected: F("outside-target", [[4, 6]], null),
    },
    {
      name: "K4 対象の段落 ID で絞る",
      paragraphId: 3,
      quote: "一二",
      before: "",
      after: "",
      expected: L(9, 11),
    },
  ];

  it.each(rows)("$name", (row) => {
    expect(runRow(text, target, inputRange, row)).toEqual(row.expected);
  });
});

describe("ランダム検査", () => {
  /** 固定シードの擬似乱数（mulberry32）。 */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pieces = [
    "\r\n",
    "\n",
    "\u{1F468}\u200D\u{1F469}",
    "か\u3099",
    "。",
    "「",
    "」",
    "あ",
    "い",
    "彼",
    "は",
    "言った",
    "\u{20BB7}",
    "　",
    "え\u0301",
    "！",
    "……",
  ];

  const settings: ChunkSettings = {
    targetGraphemes: 10,
    contextGraphemes: 4,
    recheckContextGraphemes: 8,
    roundingTolerance: 0.2,
    maxInputGraphemes: 100,
  };

  it("引用は常に一意に located される（300 反復）", () => {
    const random = mulberry32(20260907);
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const pieceCount = 1 + Math.floor(random() * 40);
      let text = "";
      for (let i = 0; i < pieceCount; i += 1) {
        const piece = pieces[Math.floor(random() * pieces.length)];
        if (piece !== undefined) {
          text += piece;
        }
      }
      if (text === "") {
        continue;
      }
      const paragraphs = splitParagraphs(text);
      const targets = planTargets(text, paragraphs, settings);
      for (const target of targets) {
        const input = buildCheckInput(text, paragraphs, target, settings);
        const index = buildGraphemeIndex(text);
        const ts = graphemeAt(index, target.range.start);
        const te = graphemeAt(index, target.range.end);
        const ie = graphemeAt(index, input.inputRange.end);
        // qs < qe <= ie が成り立つ（mulberry32 は 1 未満なので）。
        const qs = ts + Math.floor(random() * (te - ts));
        const qe = qs + 1 + Math.floor(random() * (ie - qs));
        const start = offsetAt(index, qs);
        const end = offsetAt(index, qe);
        const quote = text.slice(start, end);
        const paragraph = paragraphs.find((p) => p.range.start <= start && start < p.range.end);
        if (paragraph === undefined) {
          throw new Error(`段落が位置 ${start} を含んでいません`);
        }
        const before = text.slice(input.inputRange.start, start);
        const after = text.slice(end, input.inputRange.end);
        const result = locateQuote(text, input, paragraphs, {
          paragraphId: paragraph.id,
          quote,
          before,
          after,
        });
        if (result.status !== "located") {
          throw new Error(`located となるべきが失敗しました: ${result.reason}`);
        }
        const range = result.range;
        expect(range).toEqual({ start, end });
        expect(sliceRange(text, range)).toBe(quote);
        expect(isGraphemeBoundary(index, range.start)).toBe(true);
        expect(isGraphemeBoundary(index, range.end)).toBe(true);
        expect(target.range.start <= range.start && range.start < target.range.end).toBe(true);
      }
    }
  });
});
