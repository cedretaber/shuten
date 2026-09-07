import type { CheckInput, LocatedCandidate, MergedFinding, Paragraph, Range } from "@shuten/shared";
import { checkOutputJsonSchema, recheckOutputJsonSchema, splitParagraphs } from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { buildCheckRequest, buildRecheckRequest } from "./build.ts";
import { CHECK_CLOSING, COMMON_INSTRUCTIONS, RECHECK_CLOSING } from "./common.ts";
import type { GenerationSettings } from "./types.ts";

/** テスト用に CheckInput を組み立てる。target.paragraphIds は範囲と重なる段落から求める。 */
function makeInput(
  paragraphs: readonly Paragraph[],
  target: Range,
  before: Range | null,
  after: Range | null,
): CheckInput {
  const paragraphIds = paragraphs
    .filter((p) => p.range.start < target.end && target.start < p.range.end)
    .map((p) => p.id);
  return {
    target: { index: 0, range: target, paragraphIds },
    context: { before, after },
    inputRange: {
      start: before?.start ?? target.start,
      end: after?.end ?? target.end,
    },
  };
}

const TEXT =
  "太郎は静かな部屋で本を読んでいた。\n窓の外では雨が降り続いていた。\n彼は本を閉じて立ち上がった。\n";
const PARAGRAPHS = splitParagraphs(TEXT);

function checkInputForParagraph1(): CheckInput {
  const before = PARAGRAPHS[0]?.range as Range;
  const target = PARAGRAPHS[1]?.range as Range;
  const after = PARAGRAPHS[2]?.range as Range;
  return makeInput(PARAGRAPHS, target, before, after);
}

const ALLOWED_WORDS = ["太郎"];

const BASE_GENERATION: GenerationSettings = {
  model: "test-model",
  maxTokens: 500,
  temperature: 0.2,
};

describe("buildCheckRequest", () => {
  it("B1: model・maxTokens・temperature を GenerationSettings から写す", () => {
    const request = buildCheckRequest({
      text: TEXT,
      paragraphs: PARAGRAPHS,
      input: checkInputForParagraph1(),
      perspective: "typo",
      allowedWords: ALLOWED_WORDS,
      generation: BASE_GENERATION,
    });

    expect(request.model).toBe("test-model");
    expect(request.maxTokens).toBe(500);
    expect(request.temperature).toBe(0.2);
  });

  it("B2: seed・reasoningEffort が未指定ならキー自体がない", () => {
    const request = buildCheckRequest({
      text: TEXT,
      paragraphs: PARAGRAPHS,
      input: checkInputForParagraph1(),
      perspective: "typo",
      allowedWords: ALLOWED_WORDS,
      generation: BASE_GENERATION,
    });

    expect("seed" in request).toBe(false);
    expect("reasoningEffort" in request).toBe(false);
  });

  it("B3: seed: 0、temperature: 0 が落ちない", () => {
    const request = buildCheckRequest({
      text: TEXT,
      paragraphs: PARAGRAPHS,
      input: checkInputForParagraph1(),
      perspective: "typo",
      allowedWords: ALLOWED_WORDS,
      generation: { ...BASE_GENERATION, temperature: 0, seed: 0, reasoningEffort: "none" },
    });

    expect("seed" in request).toBe(true);
    expect(request.seed).toBe(0);
    expect(request.temperature).toBe(0);
    expect(request.reasoningEffort).toBe("none");
  });

  it("B4: responseFormat.name が shuten_check_output、schema が checkOutputJsonSchema() と一致", () => {
    const request = buildCheckRequest({
      text: TEXT,
      paragraphs: PARAGRAPHS,
      input: checkInputForParagraph1(),
      perspective: "typo",
      allowedWords: ALLOWED_WORDS,
      generation: BASE_GENERATION,
    });

    expect(request.responseFormat?.name).toBe("shuten_check_output");
    expect(request.responseFormat?.schema).toEqual(checkOutputJsonSchema());
  });

  it("B5: messages が system・user の 2 通で、履歴を含まない", () => {
    const request = buildCheckRequest({
      text: TEXT,
      paragraphs: PARAGRAPHS,
      input: checkInputForParagraph1(),
      perspective: "typo",
      allowedWords: ALLOWED_WORDS,
      generation: BASE_GENERATION,
    });

    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[1]?.role).toBe("user");
  });

  it("B6: perspective で system プロンプトが変わり、共通部分は両方に含まれる", () => {
    const typoRequest = buildCheckRequest({
      text: TEXT,
      paragraphs: PARAGRAPHS,
      input: checkInputForParagraph1(),
      perspective: "typo",
      allowedWords: ALLOWED_WORDS,
      generation: BASE_GENERATION,
    });
    const naturalnessRequest = buildCheckRequest({
      text: TEXT,
      paragraphs: PARAGRAPHS,
      input: checkInputForParagraph1(),
      perspective: "naturalness",
      allowedWords: ALLOWED_WORDS,
      generation: BASE_GENERATION,
    });

    const typoSystem = typoRequest.messages[0]?.content ?? "";
    const naturalnessSystem = naturalnessRequest.messages[0]?.content ?? "";
    expect(typoSystem).not.toBe(naturalnessSystem);
    expect(typoSystem).toContain(COMMON_INSTRUCTIONS);
    expect(naturalnessSystem).toContain(COMMON_INSTRUCTIONS);
  });

  it("B7: user メッセージが本文と許容語を含み、末尾が CHECK_CLOSING", () => {
    const request = buildCheckRequest({
      text: TEXT,
      paragraphs: PARAGRAPHS,
      input: checkInputForParagraph1(),
      perspective: "typo",
      allowedWords: ALLOWED_WORDS,
      generation: BASE_GENERATION,
    });

    const userMessage = request.messages[1]?.content ?? "";
    expect(userMessage).toContain("<allowed_words>");
    expect(userMessage).toContain("太郎");
    expect(userMessage).toContain("<manuscript>");
    expect(userMessage.endsWith(CHECK_CLOSING)).toBe(true);
  });
});

const RECHECK_TEXT = "彼は走りだした。\n次の日、彼女もそこに来た。\n";
const RECHECK_PARAGRAPHS = splitParagraphs(RECHECK_TEXT);

function recheckInput(): CheckInput {
  const target = RECHECK_PARAGRAPHS[0]?.range as Range;
  return makeInput(RECHECK_PARAGRAPHS, target, null, null);
}

/** recheck 用の MergedFinding を組み立てる。sources は mergeCandidates を呼ばず手で作る。 */
function makeCandidate(
  perspective: LocatedCandidate["perspective"],
  category: LocatedCandidate["llm"]["category"],
  verdict: LocatedCandidate["llm"]["verdict"],
  reason: string,
  range: Range,
): LocatedCandidate {
  return {
    id: `${perspective}-${range.start}`,
    perspective,
    llm: {
      paragraphId: 0,
      quote: "走りだした",
      before: "",
      after: "",
      category,
      reason,
      suggestion: "走り出した",
      verdict,
    },
    locate: { status: "located", range },
  };
}

function makeFinding(overrides: Partial<MergedFinding> = {}): MergedFinding {
  const target = RECHECK_PARAGRAPHS[0]?.range as Range;
  const range: Range = { start: target.start + 2, end: target.start + 7 };
  const sources: readonly LocatedCandidate[] = [
    makeCandidate("typo", "notation", "likely-error", "「走りだす」は送り仮名の誤り。", range),
    makeCandidate(
      "naturalness",
      "context-misuse",
      "confirm-with-author",
      "口語表現として成立する可能性がある。",
      range,
    ),
  ];
  return {
    id: "finding-1",
    range,
    quote: "走りだした",
    category: "notation",
    suggestion: "走り出した",
    verdict: "likely-error",
    sources,
    ...overrides,
  };
}

describe("buildRecheckRequest", () => {
  it("B8: recheckOutputJsonSchema() と shuten_recheck_output を使う", () => {
    const finding: MergedFinding = {
      id: "finding-1",
      range: {
        start: (RECHECK_PARAGRAPHS[0]?.range.start ?? 0) + 2,
        end: (RECHECK_PARAGRAPHS[0]?.range.start ?? 0) + 7,
      },
      quote: "走りだした",
      category: "notation",
      suggestion: "走り出した",
      verdict: "likely-error",
      sources: [
        makeCandidate("typo", "notation", "likely-error", "誤り。", {
          start: (RECHECK_PARAGRAPHS[0]?.range.start ?? 0) + 2,
          end: (RECHECK_PARAGRAPHS[0]?.range.start ?? 0) + 7,
        }),
      ],
    };
    const request = buildRecheckRequest({
      text: RECHECK_TEXT,
      paragraphs: RECHECK_PARAGRAPHS,
      input: recheckInput(),
      finding,
      allowedWords: [],
      generation: BASE_GENERATION,
    });

    expect(request.responseFormat?.name).toBe("shuten_recheck_output");
    expect(request.responseFormat?.schema).toEqual(recheckOutputJsonSchema());
  });

  it("B9: system に COMMON_INSTRUCTIONS が入り、user に <allowed_words> と RECHECK_CLOSING がある", () => {
    const start = RECHECK_PARAGRAPHS[0]?.range.start ?? 0;
    const finding: MergedFinding = {
      id: "finding-1",
      range: { start: start + 2, end: start + 7 },
      quote: "走りだした",
      category: "notation",
      suggestion: "走り出した",
      verdict: "likely-error",
      sources: [
        makeCandidate("typo", "notation", "likely-error", "誤り。", {
          start: start + 2,
          end: start + 7,
        }),
      ],
    };
    const request = buildRecheckRequest({
      text: RECHECK_TEXT,
      paragraphs: RECHECK_PARAGRAPHS,
      input: recheckInput(),
      finding,
      allowedWords: ["太郎"],
      generation: BASE_GENERATION,
    });

    const system = request.messages[0]?.content ?? "";
    const user = request.messages[1]?.content ?? "";
    expect(system).toContain(COMMON_INSTRUCTIONS);
    expect(user).toContain("<allowed_words>");
    expect(user.endsWith(RECHECK_CLOSING)).toBe(true);
  });

  it("B10: user に引用・分類・修正案・暫定判定・段落表記と sources 各件の観点・分類・判定・理由が入る", () => {
    const finding = makeFinding();
    const request = buildRecheckRequest({
      text: RECHECK_TEXT,
      paragraphs: RECHECK_PARAGRAPHS,
      input: recheckInput(),
      finding,
      allowedWords: [],
      generation: BASE_GENERATION,
    });

    const user = request.messages[1]?.content ?? "";
    expect(user).toContain("<finding>");
    expect(user).toContain("段落: [P0]");
    expect(user).toContain("引用: 走りだした");
    expect(user).toContain("分類: notation");
    expect(user).toContain("修正案: 走り出した");
    expect(user).toContain("暫定判定: likely-error");
    expect(user).toContain("元の指摘:");
    expect(user).toContain(
      "- 観点 typo / 分類 notation / 判定 likely-error / 理由: 「走りだす」は送り仮名の誤り。",
    );
    expect(user).toContain(
      "- 観点 naturalness / 分類 context-misuse / 判定 confirm-with-author / 理由: 口語表現として成立する可能性がある。",
    );
    expect(user).toContain("</finding>");
  });

  it("B11: sources が 3 件（うち同一観点 2 件）でも全件が並ぶ", () => {
    const target = RECHECK_PARAGRAPHS[0]?.range as Range;
    const range: Range = { start: target.start + 2, end: target.start + 7 };
    const sources: readonly LocatedCandidate[] = [
      makeCandidate("typo", "notation", "likely-error", "理由1", range),
      makeCandidate("typo", "notation", "likely-error", "理由2", range),
      makeCandidate("naturalness", "context-misuse", "confirm-with-author", "理由3", range),
    ];
    const finding = makeFinding({ sources });
    const request = buildRecheckRequest({
      text: RECHECK_TEXT,
      paragraphs: RECHECK_PARAGRAPHS,
      input: recheckInput(),
      finding,
      allowedWords: [],
      generation: BASE_GENERATION,
    });

    const user = request.messages[1]?.content ?? "";
    expect(user).toContain("- 観点 typo / 分類 notation / 判定 likely-error / 理由: 理由1");
    expect(user).toContain("- 観点 typo / 分類 notation / 判定 likely-error / 理由: 理由2");
    expect(user).toContain(
      "- 観点 naturalness / 分類 context-misuse / 判定 confirm-with-author / 理由: 理由3",
    );
    const occurrences = user.split("- 観点 ").length - 1;
    expect(occurrences).toBe(3);
  });

  it("B12: suggestion が null の指摘で「修正案: （なし）」になり、null の文字列が出ない", () => {
    const finding = makeFinding({ suggestion: null });
    const request = buildRecheckRequest({
      text: RECHECK_TEXT,
      paragraphs: RECHECK_PARAGRAPHS,
      input: recheckInput(),
      finding,
      allowedWords: [],
      generation: BASE_GENERATION,
    });

    const user = request.messages[1]?.content ?? "";
    expect(user).toContain("修正案: （なし）");
    expect(user).not.toContain("修正案: null");
    expect(user).not.toMatch(/修正案:\s*null(?!\S)/);
  });
});

describe("プロンプトのスナップショット", () => {
  it("B13-typo: buildCheckRequest（typo）のスナップショット", () => {
    const request = buildCheckRequest({
      text: TEXT,
      paragraphs: PARAGRAPHS,
      input: checkInputForParagraph1(),
      perspective: "typo",
      allowedWords: ALLOWED_WORDS,
      generation: BASE_GENERATION,
    });

    expect(request).toMatchSnapshot();
  });

  it("B13-naturalness: buildCheckRequest（naturalness）のスナップショット", () => {
    const request = buildCheckRequest({
      text: TEXT,
      paragraphs: PARAGRAPHS,
      input: checkInputForParagraph1(),
      perspective: "naturalness",
      allowedWords: ALLOWED_WORDS,
      generation: BASE_GENERATION,
    });

    expect(request).toMatchSnapshot();
  });

  it("B13-recheck: buildRecheckRequest のスナップショット", () => {
    const finding = makeFinding();
    const request = buildRecheckRequest({
      text: RECHECK_TEXT,
      paragraphs: RECHECK_PARAGRAPHS,
      input: recheckInput(),
      finding,
      allowedWords: ["太郎"],
      generation: BASE_GENERATION,
    });

    expect(request).toMatchSnapshot();
  });
});
