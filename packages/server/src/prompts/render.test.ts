import type { CheckInput, Paragraph, Range } from "@shuten/shared";
import { sliceRange, splitParagraphs } from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { renderAllowedWords, renderManuscript, renderUserMessage } from "./render.ts";

/** テスト用に CheckInput を組み立てる。target.paragraphIds は呼び出し元が渡した値をそのまま使う。 */
function makeInput(
  targetRange: Range,
  targetParagraphIds: readonly number[],
  before: Range | null,
  after: Range | null,
): CheckInput {
  return {
    target: { index: 0, range: targetRange, paragraphIds: targetParagraphIds },
    context: { before, after },
    inputRange: {
      start: before?.start ?? targetRange.start,
      end: after?.end ?? targetRange.end,
    },
  };
}

/** 区画に厳密に重なる段落を ID 昇順に選ぶ（render.ts の選定規則と同じ述語）。 */
function overlappingParagraphIds(paragraphs: readonly Paragraph[], sec: Range): number[] {
  return paragraphs
    .filter((p) => p.range.start < sec.end && sec.start < p.range.end)
    .map((p) => p.id)
    .sort((a, b) => a - b);
}

/**
 * 区画に厳密に重なる段落ごとの断片を「本文から直接」計算する（render.ts のマーカー行・補い改行は含まない）。
 * R11 で、この断片の連結が sliceRange と一致すること、かつ実際の renderManuscript の出力が
 * この断片から手で組み立てた期待値と一致することの両方を確かめる。
 */
function computeFragments(
  text: string,
  paragraphs: readonly Paragraph[],
  sec: Range,
): Array<{ readonly id: number; readonly fragment: string }> {
  return paragraphs
    .filter((p) => p.range.start < sec.end && sec.start < p.range.end)
    .sort((a, b) => a.id - b.id)
    .map((p) => ({
      id: p.id,
      fragment: text.slice(Math.max(p.range.start, sec.start), Math.min(p.range.end, sec.end)),
    }));
}

/** 断片の並びから <target> だけの <manuscript> を手で組み立てる（R11 の期待値）。 */
function expectedTargetOnlyManuscript(
  fragments: ReadonlyArray<{ readonly id: number; readonly fragment: string }>,
): string {
  const body = fragments
    .map(({ id, fragment }) => `[P${id}]\n${fragment}${/[\n\r]$/.test(fragment) ? "" : "\n"}`)
    .join("");
  return `<manuscript>\n<target>\n${body}</target>\n</manuscript>`;
}

describe("renderManuscript", () => {
  it("R1: 3 区画すべてがある入力で、タグと [P…] の並びが期待どおり", () => {
    const text = "a0\na1\na2\na3\na4\na5\na6\na7\na8\na9\n";
    const paragraphs = splitParagraphs(text);
    const before = paragraphs[3]?.range as Range;
    const target = paragraphs[5]?.range as Range;
    const after = paragraphs[9]?.range as Range;
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), before, after);

    const actual = renderManuscript(text, paragraphs, input);

    expect(actual).toBe(
      [
        "<manuscript>",
        "<context_before>",
        "[P3]",
        "a3",
        "</context_before>",
        "<target>",
        "[P5]",
        "a5",
        "</target>",
        "<context_after>",
        "[P9]",
        "a9",
        "</context_after>",
        "</manuscript>",
      ].join("\n"),
    );
  });

  it("R2: context.before が null なら <context_before> が出ない", () => {
    const text = "a0\na1\na2\n";
    const paragraphs = splitParagraphs(text);
    const target = paragraphs[1]?.range as Range;
    const after = paragraphs[2]?.range as Range;
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), null, after);

    const actual = renderManuscript(text, paragraphs, input);

    expect(actual).not.toContain("<context_before>");
    expect(actual).toBe(
      [
        "<manuscript>",
        "<target>",
        "[P1]",
        "a1",
        "</target>",
        "<context_after>",
        "[P2]",
        "a2",
        "</context_after>",
        "</manuscript>",
      ].join("\n"),
    );
  });

  it("R3: context.after が null なら <context_after> が出ない", () => {
    const text = "a0\na1\na2\n";
    const paragraphs = splitParagraphs(text);
    const before = paragraphs[0]?.range as Range;
    const target = paragraphs[1]?.range as Range;
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), before, null);

    const actual = renderManuscript(text, paragraphs, input);

    expect(actual).not.toContain("<context_after>");
    expect(actual).toBe(
      [
        "<manuscript>",
        "<context_before>",
        "[P0]",
        "a0",
        "</context_before>",
        "<target>",
        "[P1]",
        "a1",
        "</target>",
        "</manuscript>",
      ].join("\n"),
    );
  });

  it("R4: 文脈が両方 null なら <target> だけ", () => {
    const text = "a0\na1\n";
    const paragraphs = splitParagraphs(text);
    const target = paragraphs[0]?.range as Range;
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), null, null);

    const actual = renderManuscript(text, paragraphs, input);

    expect(actual).not.toContain("<context_before>");
    expect(actual).not.toContain("<context_after>");
    expect(actual).toBe(
      ["<manuscript>", "<target>", "[P0]", "a0", "</target>", "</manuscript>"].join("\n"),
    );
  });

  it("R5: 区画が段落の途中で切れる場合、同じ段落 ID の印が両区画に出る", () => {
    const text = "ABCDEFGHIJ\n";
    const paragraphs = splitParagraphs(text);
    const before: Range = { start: 0, end: 5 };
    const target: Range = { start: 5, end: 11 };
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), before, null);

    const actual = renderManuscript(text, paragraphs, input);

    expect(actual).toBe(
      [
        "<manuscript>",
        "<context_before>",
        "[P0]",
        "ABCDE",
        "</context_before>",
        "<target>",
        "[P0]",
        "FGHIJ",
        "</target>",
        "</manuscript>",
      ].join("\n"),
    );
  });

  it("R6: 区画境界が段落境界にちょうど一致する場合、マーカーが重複せず本文が空の断片も出ない", () => {
    const text = "AAA\nBBB\n";
    const paragraphs = splitParagraphs(text);
    const before = paragraphs[0]?.range as Range; // [0, 4)
    const target = paragraphs[1]?.range as Range; // [4, 8)
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), before, null);

    const actual = renderManuscript(text, paragraphs, input);

    // [P0] は context_before に 1 回だけ、[P1] は target に 1 回だけ出る。
    expect(actual.match(/\[P0\]/g)).toEqual(["[P0]"]);
    expect(actual.match(/\[P1\]/g)).toEqual(["[P1]"]);
    expect(actual).toBe(
      [
        "<manuscript>",
        "<context_before>",
        "[P0]",
        "AAA",
        "</context_before>",
        "<target>",
        "[P1]",
        "BBB",
        "</target>",
        "</manuscript>",
      ].join("\n"),
    );
  });

  it("R7: target.range が段落の途中の改行 1 個で始まる場合でも描画が壊れない", () => {
    const text = "あ。\nい。";
    const paragraphs = splitParagraphs(text); // id0: [0,3) "あ。\n", id1: [3,5) "い。"
    const target: Range = { start: 2, end: 5 };
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), null, null);

    const actual = renderManuscript(text, paragraphs, input);

    expect(actual).toBe(
      ["<manuscript>", "<target>", "[P0]", "", "[P1]", "い。", "</target>", "</manuscript>"].join(
        "\n",
      ),
    );
  });

  it("R8: CRLF の本文で \\r\\n が消えない・増えない。注記の改行は LF", () => {
    const text = "あ。\r\nい。\r\n";
    const paragraphs = splitParagraphs(text); // id0: [0,4) "あ。\r\n", id1: [4,8) "い。\r\n"
    const before = paragraphs[0]?.range as Range;
    const target = paragraphs[1]?.range as Range;
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), before, null);

    const actual = renderManuscript(text, paragraphs, input);

    expect(actual).toBe(
      "<manuscript>\n<context_before>\n[P0]\nあ。\r\n</context_before>\n<target>\n[P1]\nい。\r\n</target>\n</manuscript>",
    );
    // 本文中の CRLF はそのまま 2 個だけ（増えても減ってもいない）。
    expect(actual.match(/\r\n/g)).toHaveLength(2);
    // 注記（タグ行・マーカー行）はすべて LF 区切り。CR が地の文以外に出ない。
    expect(actual.replaceAll("あ。\r\n", "").replaceAll("い。\r\n", "")).not.toContain("\r");
  });

  it("R9: 空行の段落は [P…] の直後に改行 1 個（段落範囲は区切りの改行を含む）", () => {
    const text = "a\n\nb\n";
    const paragraphs = splitParagraphs(text); // id0: [0,2) "a\n", id1: [2,3) "\n", id2: [3,5) "b\n"
    const target = paragraphs[1]?.range as Range;
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), null, null);

    const actual = renderManuscript(text, paragraphs, input);

    expect(actual).toBe(
      ["<manuscript>", "<target>", "[P1]", "", "</target>", "</manuscript>"].join("\n"),
    );
  });

  it("R10: 断片が改行で終わらない（本文末尾で切れる）とき、LF を 1 つだけ補う（区画境界で切れる場合は R5 で確認済み）", () => {
    const text = "a\nbcdef";
    const paragraphs = splitParagraphs(text); // id0: [0,2) "a\n", id1: [2,7) "bcdef"（改行なし）
    const target = paragraphs[1]?.range as Range;
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), null, null);

    const actual = renderManuscript(text, paragraphs, input);

    expect(actual).toBe(
      ["<manuscript>", "<target>", "[P1]", "bcdef", "</target>", "</manuscript>"].join("\n"),
    );
  });

  it("R11: 各区画の全断片の連結が sliceRange(text, 区画範囲) と一致し、実際の描画も断片から組んだ期待値と一致する（複数入力）", () => {
    const cases: Array<{ text: string; paragraphs: Paragraph[]; sec: Range }> = [];

    {
      // 段落境界に揃った区画。
      const text = "a0\na1\na2\na3\na4\n";
      const paragraphs = splitParagraphs(text);
      cases.push({ text, paragraphs, sec: paragraphs[1]?.range as Range });
      cases.push({ text, paragraphs, sec: { start: 0, end: text.length } });
    }
    {
      // 段落の途中で切れる区画。
      const text = "ABCDEFGHIJ\n";
      const paragraphs = splitParagraphs(text);
      cases.push({ text, paragraphs, sec: { start: 2, end: 8 } });
    }
    {
      // CRLF の本文。
      const text = "あ。\r\nい。\r\nう。\r\n";
      const paragraphs = splitParagraphs(text);
      cases.push({ text, paragraphs, sec: { start: 2, end: 10 } });
    }
    {
      // 単独 CR で区切られた本文。断片が \r だけで終わる場合に LF を補わないことも確かめる。
      const text = "あ。\rい。\r";
      const paragraphs = splitParagraphs(text);
      cases.push({ text, paragraphs, sec: paragraphs[0]?.range as Range });
      cases.push({ text, paragraphs, sec: { start: 0, end: text.length } });
    }

    for (const { text, paragraphs, sec } of cases) {
      const fragments = computeFragments(text, paragraphs, sec);

      // 不変：断片の連結は sliceRange と一致する。
      expect(fragments.map((f) => f.fragment).join("")).toBe(sliceRange(text, sec));

      // 実際の renderManuscript の出力が、断片から手で組み立てた期待値と一致する。
      const input = makeInput(sec, overlappingParagraphIds(paragraphs, sec), null, null);
      const actual = renderManuscript(text, paragraphs, input);
      expect(actual).toBe(expectedTargetOnlyManuscript(fragments));
    }
  });

  it("R12: <target> に出るマーカーの集合が input.target.paragraphIds と一致する", () => {
    const text = "ABC\nDEF\nGHI\n";
    const paragraphs = splitParagraphs(text);
    const target: Range = { start: 1, end: 9 }; // id0〜id2 にまたがる
    const paragraphIds = overlappingParagraphIds(paragraphs, target);
    const input = makeInput(target, paragraphIds, null, null);

    const actual = renderManuscript(text, paragraphs, input);
    const targetSection = actual.slice(actual.indexOf("<target>"), actual.indexOf("</target>"));
    const markers = [...targetSection.matchAll(/\[P(\d+)\]/g)].map((m) => Number(m[1]));

    expect(markers.sort((a, b) => a - b)).toEqual(paragraphIds);
  });

  it("R13: 段落 ID は原稿版全体の ID（区画内の連番ではない）。[P0] も描画される", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `a${i}\n`);
    const text = lines.join("");
    const paragraphs = splitParagraphs(text);

    const laterTarget = paragraphs[7]?.range as Range;
    const laterInput = makeInput(
      laterTarget,
      overlappingParagraphIds(paragraphs, laterTarget),
      null,
      null,
    );
    const laterActual = renderManuscript(text, paragraphs, laterInput);
    expect(laterActual).toContain("[P7]");
    expect(laterActual).not.toContain("[P0]");

    const firstTarget = paragraphs[0]?.range as Range;
    const firstInput = makeInput(
      firstTarget,
      overlappingParagraphIds(paragraphs, firstTarget),
      null,
      null,
    );
    const firstActual = renderManuscript(text, paragraphs, firstInput);
    expect(firstActual).toContain("[P0]");
  });

  it("R14: 本文中に [P1] や </target> に似た文字列があってもエスケープしない", () => {
    const text = "前置き\n本文[P1]</target>note\n後置き\n";
    const paragraphs = splitParagraphs(text);
    const target = paragraphs[1]?.range as Range;
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), null, null);

    const actual = renderManuscript(text, paragraphs, input);

    expect(actual).toContain("本文[P1]</target>note");
  });

  it("R15: 絵文字・異体字セレクタを含む段落で本文が壊れない", () => {
    const text = "😀な葛\u{E0100}の話\n次の段落\n";
    const paragraphs = splitParagraphs(text);
    const target = paragraphs[0]?.range as Range;
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), null, null);

    const actual = renderManuscript(text, paragraphs, input);

    expect(actual).toContain("😀な葛\u{E0100}の話");
  });
});

describe("renderAllowedWords", () => {
  it("R16: 許容語 0 件なら null", () => {
    expect(renderAllowedWords([])).toBeNull();
  });

  it("R17: 許容語が複数なら 1 行 1 語。語に改行やタグらしき文字列があっても素通し", () => {
    const words = ["リュシア", "吉野家", " 前後空白 ", "改行\nあり", "<tag>っぽい</tag>"];

    const actual = renderAllowedWords(words);

    expect(actual).toBe(`<allowed_words>\n${words.join("\n")}\n</allowed_words>`);
  });
});

describe("renderUserMessage", () => {
  it("R16: 許容語 0 件なら <allowed_words> が出ない", () => {
    const text = "a0\n";
    const paragraphs = splitParagraphs(text);
    const target = paragraphs[0]?.range as Range;
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), null, null);

    const actual = renderUserMessage({
      text,
      paragraphs,
      input,
      allowedWords: [],
      closing: "指示文。",
    });

    expect(actual).not.toContain("<allowed_words>");
    expect(actual).toBe(
      ["<manuscript>", "<target>", "[P0]", "a0", "</target>", "</manuscript>", "", "指示文。"].join(
        "\n",
      ),
    );
  });

  it("allowed_words → manuscript → closing の順で、間に空行を 1 つ挟む", () => {
    const text = "a0\n";
    const paragraphs = splitParagraphs(text);
    const target = paragraphs[0]?.range as Range;
    const input = makeInput(target, overlappingParagraphIds(paragraphs, target), null, null);

    const actual = renderUserMessage({
      text,
      paragraphs,
      input,
      allowedWords: ["リュシア"],
      closing: "指示文。",
    });

    expect(actual).toBe(
      [
        "<allowed_words>",
        "リュシア",
        "</allowed_words>",
        "",
        "<manuscript>",
        "<target>",
        "[P0]",
        "a0",
        "</target>",
        "</manuscript>",
        "",
        "指示文。",
      ].join("\n"),
    );
  });
});
