import { describe, expect, it } from "vitest";
import { buildGraphemeIndex, graphemeAt, isGraphemeBoundary } from "../text/grapheme-index.ts";
import { splitParagraphs } from "../text/paragraph.ts";
import { sliceRange } from "../text/range.ts";
import type { CheckInput, TargetRange } from "./plan.ts";
import { buildCheckInput, buildRecheckInput, planTargets } from "./plan.ts";
import { type ChunkSettings, InputTooLongError, roundingDelta } from "./settings.ts";

/** 検査用の基準設定（D = 2、DB = 1、DR = 1）。 */
function S(overrides: Partial<ChunkSettings> = {}): ChunkSettings {
  return {
    targetGraphemes: 10,
    contextGraphemes: 5,
    recheckContextGraphemes: 8,
    roundingTolerance: 0.2,
    maxInputGraphemes: 100,
    ...overrides,
  };
}

/** splitParagraphs を使って検査対象に分割する。 */
function plan(text: string, settings: ChunkSettings = S()): TargetRange[] {
  return planTargets(text, splitParagraphs(text), settings);
}

/** 各検査対象の範囲を [start, end] の配列にする。 */
function ranges(targets: readonly TargetRange[]): number[][] {
  return targets.map((t) => [t.range.start, t.range.end]);
}

/** タイル分割の不変条件を検査する（本文は空でないこと）。 */
function expectTiling(text: string, targets: readonly TargetRange[], maxLength: number): void {
  const index = buildGraphemeIndex(text);
  expect(targets.length).toBeGreaterThan(0);
  expect(targets[0]?.range.start).toBe(0);
  expect(targets[targets.length - 1]?.range.end).toBe(text.length);
  targets.forEach((target, position) => {
    expect(target.index).toBe(position);
    expect(target.range.start).toBe(position === 0 ? 0 : targets[position - 1]?.range.end);
    expect(target.range.end).toBeGreaterThan(target.range.start);
    expect(isGraphemeBoundary(index, target.range.start)).toBe(true);
    expect(isGraphemeBoundary(index, target.range.end)).toBe(true);
    const length = graphemeAt(index, target.range.end) - graphemeAt(index, target.range.start);
    expect(length).toBeLessThanOrEqual(maxLength);
  });
  expect(targets.map((t) => sliceRange(text, t.range)).join("")).toBe(text);
}

/** InputTooLongError が required・limit 付きで投げられることを検査する。 */
function expectInputTooLong(fn: () => void, required: number, limit: number): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InputTooLongError);
  if (thrown instanceof InputTooLongError) {
    expect(thrown.required).toBe(required);
    expect(thrown.limit).toBe(limit);
  }
}

/** 検査対象を直接構築する（paragraphIds は buildCheckInput が読まない）。 */
function makeTarget(range: readonly [number, number]): TargetRange {
  return { index: 0, range: { start: range[0], end: range[1] }, paragraphIds: [] };
}

describe("planTargets", () => {
  interface PlanCase {
    name: string;
    text: string;
    expected: number[][];
    /** 段落との重なり。notes に与えられた行だけ。 */
    ids?: number[][];
  }

  const planCases: readonly PlanCase[] = [
    { name: "空本文", text: "", expected: [] },
    {
      name: "段落境界が窓内",
      text: "あいうえ\nかきくけこさ\nたちつてとなにぬね\nは",
      expected: [
        [0, 12],
        [12, 23],
      ],
      ids: [
        [0, 1],
        [2, 3],
      ],
    },
    {
      name: "同距離は外側",
      text: "あいうえおかき\nくけこ\nさしすせそたちつてと",
      expected: [
        [0, 12],
        [12, 22],
      ],
    },
    {
      name: "文境界へフォールバック",
      text: "あいうえおかきく。けこさしすせそたちつ。なにぬねのはひふへほ",
      expected: [
        [0, 9],
        [9, 20],
        [20, 30],
      ],
      ids: [[0], [0], [0]],
    },
    {
      name: "書記素境界へフォールバック",
      text: "あ".repeat(25),
      expected: [
        [0, 10],
        [10, 20],
        [20, 25],
      ],
    },
    {
      name: "ZWJ 絵文字をまたぐ ideal",
      text:
        "あいうえおかきくけ" + "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}" + "さしすせそたちつてと",
      expected: [
        [0, 17],
        [17, 27],
      ],
    },
    {
      name: "異体字セレクタをまたぐ ideal",
      text: "あいうえおかきくけ" + "葛\u{E0100}" + "さしすせそたちつてと",
      expected: [
        [0, 12],
        [12, 22],
      ],
    },
    {
      name: "CRLF をまたがない",
      text: "あいうえおかきくけ\r\nさしすせそたちつてとな",
      expected: [
        [0, 11],
        [11, 22],
      ],
    },
    { name: "残りが目標 + delta ちょうど", text: "あ".repeat(12), expected: [[0, 12]] },
    {
      name: "残りが目標 + delta + 1",
      text: "あ".repeat(13),
      expected: [
        [0, 10],
        [10, 13],
      ],
    },
    {
      name: "窓の下端を含む",
      text: "あいうえおかき\nくけこさしすせそたちつて",
      expected: [
        [0, 8],
        [8, 20],
      ],
    },
    {
      name: "窓の上端を含む",
      text: "あいうえおかきくけこさ\nすせそたちつてとなに",
      expected: [
        [0, 12],
        [12, 22],
      ],
    },
    {
      name: "窓の外は選ばない",
      text: "あいうえおかきくけこさし\nすせそたちつてとな",
      expected: [
        [0, 10],
        [10, 22],
      ],
      ids: [[0], [0, 1]],
    },
  ];

  it.each(planCases)("期待される範囲を返す：$name", (c) => {
    const targets = plan(c.text);
    expect(ranges(targets)).toEqual(c.expected);
    if (c.ids !== undefined) {
      expect(targets.map((t) => t.paragraphIds)).toEqual(c.ids);
    }
  });

  it.each(planCases)("タイル分割の不変条件を満たす：$name", (c) => {
    if (c.text === "") {
      expect(plan(c.text)).toEqual([]);
      return;
    }
    const maxLength = 10 + roundingDelta(10, 0.2);
    expectTiling(c.text, plan(c.text), maxLength);
  });

  it("index は 0 始まりの連番（文境界へフォールバックの行）", () => {
    const text = "あいうえおかきく。けこさしすせそたちつ。なにぬねのはひふへほ";
    expect(plan(text).map((t) => t.index)).toEqual([0, 1, 2]);
  });

  const randomPieces = [
    "あ",
    "い。",
    "う！",
    "\n",
    "\r\n",
    "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
    "葛\u{E0100}",
    "か\u3099",
    "「え」",
  ];

  // mulberry32：シード付き PRNG。[0, 1) の浮動小数を返す。
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a += 0x6d2b79f5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("乱数によるタイル分割検査（シード付き PRNG、300 回）", () => {
    const random = mulberry32(20260907);
    for (let i = 0; i < 300; i += 1) {
      const pieceCount = 1 + Math.floor(random() * 40);
      let text = "";
      for (let j = 0; j < pieceCount; j += 1) {
        const piece = randomPieces[Math.floor(random() * randomPieces.length)];
        if (piece === undefined) {
          throw new Error("ピースが undefined です");
        }
        text += piece;
      }
      const targetGraphemes = 1 + Math.floor(random() * 7);
      const settings = S({ targetGraphemes, roundingTolerance: 0.4 });
      const maxLength = targetGraphemes + roundingDelta(targetGraphemes, 0.4);
      expectTiling(text, planTargets(text, splitParagraphs(text), settings), maxLength);
    }
  });
});

describe("buildCheckInput", () => {
  // 8 つの短い会話段落。長さ 23。
  const textF = "あい\nうえ\nおか\nきく\nけこ\nさし\nすせ\nそた";
  // 5 段落。長さ 19。
  const textG = "あい\nうえお\nか\nきくけ\nこさしすせそ";
  // 単一段落。窓内に段落境界なし。20 書記素。
  const textH = "あいうえおかきくけこさしすせそたちつてと";
  // ZWJ 絵文字入り。21 コード単位、14 書記素。
  const textJ = "あい\n" + "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}え\n" + "おか\nきく\nけこ";

  type Span = readonly [number, number];

  function span(v: Span | null): { start: number; end: number } | null {
    return v === null ? null : { start: v[0], end: v[1] };
  }

  interface CheckCase {
    name: string;
    text: string;
    target: Span;
    settings: ChunkSettings;
    before: Span | null;
    after: Span | null;
    input: Span;
  }

  const checkCases: readonly CheckCase[] = [
    {
      name: "段落始端が窓内",
      text: textF,
      target: [9, 15],
      settings: S(),
      before: [3, 9],
      after: [15, 21],
      input: [3, 21],
    },
    {
      name: "短い会話段落を複数含む",
      text: textF,
      target: [9, 15],
      settings: S({ contextGraphemes: 8 }),
      before: [0, 9],
      after: [15, 23],
      input: [0, 23],
    },
    {
      name: "本文先頭では before が null",
      text: textF,
      target: [0, 6],
      settings: S(),
      before: null,
      after: [6, 12],
      input: [0, 12],
    },
    {
      name: "本文末尾では after が null",
      text: textF,
      target: [18, 23],
      settings: S(),
      before: [12, 18],
      after: null,
      input: [12, 23],
    },
    {
      name: "ideal が本文の外なら丸めない",
      text: textF,
      target: [3, 9],
      settings: S(),
      before: [0, 3],
      after: [9, 15],
      input: [0, 15],
    },
    {
      name: "文脈長 0 は null",
      text: textF,
      target: [9, 15],
      settings: S({ contextGraphemes: 0 }),
      before: null,
      after: null,
      input: [9, 15],
    },
    {
      name: "前方は最も近い始端、後方の同距離は大きい側",
      text: textF,
      target: [12, 18],
      settings: S({ contextGraphemes: 4, roundingTolerance: 0.5 }),
      before: [9, 12],
      after: [18, 23],
      input: [9, 23],
    },
    {
      name: "前方は窓内で最も近い始端（text G）",
      text: textG,
      target: [13, 19],
      settings: S({ contextGraphemes: 4, roundingTolerance: 0.5 }),
      before: [9, 13],
      after: null,
      input: [9, 19],
    },
    {
      name: "前方の同距離は小さい側（text G）",
      text: textG,
      target: [13, 19],
      settings: S({ contextGraphemes: 5, roundingTolerance: 0.2 }),
      before: [7, 13],
      after: null,
      input: [7, 19],
    },
    {
      name: "段落境界が窓内にない（text H）",
      text: textH,
      target: [9, 15],
      settings: S({ contextGraphemes: 5, roundingTolerance: 0 }),
      before: [4, 9],
      after: [15, 20],
      input: [4, 20],
    },
    {
      name: "上限ちょうど",
      text: textF,
      target: [9, 15],
      settings: S({ maxInputGraphemes: 18 }),
      before: [3, 9],
      after: [15, 21],
      input: [3, 21],
    },
  ];

  it.each(checkCases)("$name", (c) => {
    const result = buildCheckInput(
      c.text,
      splitParagraphs(c.text),
      makeTarget(c.target),
      c.settings,
    );
    expect(result.context.before).toEqual(span(c.before));
    expect(result.context.after).toEqual(span(c.after));
    expect(result.inputRange).toEqual(span(c.input));
  });

  it("文脈が ZWJ 絵文字をまたぐ（text J）：required は書記素数で 11 字", () => {
    const result = buildCheckInput(
      textJ,
      splitParagraphs(textJ),
      makeTarget([16, 19]),
      S({ targetGraphemes: 5, maxInputGraphemes: 11 }),
    );
    expect(result.context.before).toEqual({ start: 3, end: 16 });
    expect(result.context.after).toEqual({ start: 19, end: 21 });
    expect(result.inputRange).toEqual({ start: 3, end: 21 });
  });

  it("文脈が ZWJ 絵文字をまたぐ（text J）：上限超過は InputTooLongError", () => {
    expectInputTooLong(
      () =>
        buildCheckInput(
          textJ,
          splitParagraphs(textJ),
          makeTarget([16, 19]),
          S({ targetGraphemes: 5, maxInputGraphemes: 10 }),
        ),
      11,
      10,
    );
  });

  it("上限超過：InputTooLongError（required 18、limit 17）", () => {
    expectInputTooLong(
      () =>
        buildCheckInput(
          textF,
          splitParagraphs(textF),
          makeTarget([9, 15]),
          S({ maxInputGraphemes: 17 }),
        ),
      18,
      17,
    );
  });
});

describe("buildRecheckInput", () => {
  const textF = "あい\nうえ\nおか\nきく\nけこ\nさし\nすせ\nそた";

  /** 初回検査入力を作る（S() で）。 */
  function initialFor(target: readonly [number, number]): CheckInput {
    return buildCheckInput(textF, splitParagraphs(textF), makeTarget(target), S());
  }

  /** 再確認入力が初回入力を必ず含むことを検査する。 */
  function expectContainsInitial(result: CheckInput, initial: CheckInput): void {
    expect(result.inputRange.start).toBeLessThanOrEqual(initial.inputRange.start);
    expect(result.inputRange.end).toBeGreaterThanOrEqual(initial.inputRange.end);
  }

  it("文脈が広がる（R = 8）", () => {
    const initial = initialFor([9, 15]);
    const result = buildRecheckInput(textF, splitParagraphs(textF), initial, S());
    expect(result.target).toBe(initial.target);
    expect(result.context.before).toEqual({ start: 0, end: 9 });
    expect(result.context.after).toEqual({ start: 15, end: 23 });
    expect(result.inputRange).toEqual({ start: 0, end: 23 });
    expectContainsInitial(result, initial);
  });

  it("再確認の文脈が初回より狭くても初回の入力を含む（R = 2）", () => {
    const initial = initialFor([9, 15]);
    const result = buildRecheckInput(
      textF,
      splitParagraphs(textF),
      initial,
      S({ recheckContextGraphemes: 2 }),
    );
    expect(result.target).toBe(initial.target);
    expect(result.context.before).toEqual({ start: 3, end: 9 });
    expect(result.context.after).toEqual({ start: 15, end: 21 });
    expect(result.inputRange).toEqual({ start: 3, end: 21 });
    expectContainsInitial(result, initial);
  });

  it("再確認の文脈 0 でも初回の入力を含む（R = 0）", () => {
    const initial = initialFor([9, 15]);
    const result = buildRecheckInput(
      textF,
      splitParagraphs(textF),
      initial,
      S({ recheckContextGraphemes: 0 }),
    );
    expect(result.target).toBe(initial.target);
    expect(result.context.before).toEqual({ start: 3, end: 9 });
    expect(result.context.after).toEqual({ start: 15, end: 21 });
    expect(result.inputRange).toEqual({ start: 3, end: 21 });
    expectContainsInitial(result, initial);
  });

  it("本文末尾の検査対象", () => {
    const initial = initialFor([18, 23]);
    const result = buildRecheckInput(textF, splitParagraphs(textF), initial, S());
    expect(result.target).toBe(initial.target);
    expect(result.context.before).toEqual({ start: 9, end: 18 });
    expect(result.context.after).toBeNull();
    expect(result.inputRange).toEqual({ start: 9, end: 23 });
    expectContainsInitial(result, initial);
  });

  it("上限超過：InputTooLongError（required 23、limit 22）", () => {
    const initial = initialFor([9, 15]);
    expectInputTooLong(
      () => buildRecheckInput(textF, splitParagraphs(textF), initial, S({ maxInputGraphemes: 22 })),
      23,
      22,
    );
  });
});
