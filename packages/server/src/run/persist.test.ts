import type { LlmFinding } from "@shuten/shared";
import { splitParagraphs } from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { MalformedBodyError } from "../db/errors.ts";
import type { CandidateRecord, FindingRecord, RunTargetRecord } from "../db/records.ts";
import {
  assertFindingBoundary,
  assertUnlocatedFindingBoundary,
  checkInputFromTargetRecord,
  deriveParagraphId,
  type FindingBoundaryInput,
  mergedFindingFromRecords,
  PersistBoundaryError,
  type UnlocatedFindingBoundaryInput,
} from "./persist.ts";

// 段落 0: [0, 6)「第一段落。\n」、段落 1: [6, 14)「第二段落です。\n」。
const BODY = "第一段落。\n第二段落です。\n";
const PARAGRAPHS = splitParagraphs(BODY);

/** すべての境界検査を通る最小の指摘。各テストはここから 1 項目だけ崩す。 */
const VALID_FINDING: FindingBoundaryInput = {
  locateStatus: "located",
  range: { start: 7, end: 9 },
  paragraphId: 1,
  quote: BODY.slice(7, 9),
  suggestion: null,
  category: "grammar",
  mergeKey: null,
  suppression: null,
};

describe("deriveParagraphId", () => {
  it("range.start を含む段落の id を返す", () => {
    expect(deriveParagraphId(PARAGRAPHS, 0)).toBe(0);
    expect(deriveParagraphId(PARAGRAPHS, 5)).toBe(0);
    expect(deriveParagraphId(PARAGRAPHS, 6)).toBe(1);
    expect(deriveParagraphId(PARAGRAPHS, 13)).toBe(1);
  });

  it("段落表に含まれない位置では PersistBoundaryError", () => {
    expect(() => deriveParagraphId(PARAGRAPHS, BODY.length)).toThrow(PersistBoundaryError);
  });
});

describe("assertFindingBoundary", () => {
  it("境界検査をすべて満たす指摘では投げない", () => {
    expect(() => assertFindingBoundary(VALID_FINDING, BODY, PARAGRAPHS)).not.toThrow();
  });

  it("P1: not-found の指摘に非 null の mergeKey を渡すと PersistBoundaryError", () => {
    const finding: FindingBoundaryInput = {
      ...VALID_FINDING,
      locateStatus: "not-found",
      range: null,
      mergeKey: "some-merge-key",
    };
    expect(() => assertFindingBoundary(finding, BODY, PARAGRAPHS)).toThrow(PersistBoundaryError);
  });

  it("P2: category !== 'notation' の指摘に抑制を渡すと例外", () => {
    const finding: FindingBoundaryInput = {
      ...VALID_FINDING,
      category: "grammar",
      suggestion: "修正案",
      suppression: { word: "登録語", ruleVersion: "1" },
    };
    expect(() => assertFindingBoundary(finding, BODY, PARAGRAPHS)).toThrow(PersistBoundaryError);
  });

  it("P3: 修正案 null の指摘に抑制を渡すと例外", () => {
    const finding: FindingBoundaryInput = {
      ...VALID_FINDING,
      category: "notation",
      suggestion: null,
      suppression: { word: "登録語", ruleVersion: "1" },
    };
    expect(() => assertFindingBoundary(finding, BODY, PARAGRAPHS)).toThrow(PersistBoundaryError);
  });

  it("P3b: 位置未確定の指摘に抑制を渡すと例外（前提の『位置確定済み』を満たさない）", () => {
    const finding: FindingBoundaryInput = {
      ...VALID_FINDING,
      locateStatus: "ambiguous",
      range: null,
      category: "notation",
      suggestion: "修正案",
      suppression: { word: "登録語", ruleVersion: "1" },
    };
    expect(() => assertFindingBoundary(finding, BODY, PARAGRAPHS)).toThrow(PersistBoundaryError);
  });

  it("P4: 位置確定済みの paragraphId が本文から導いた値と食い違うと例外", () => {
    const finding: FindingBoundaryInput = { ...VALID_FINDING, paragraphId: 0 };
    expect(() => assertFindingBoundary(finding, BODY, PARAGRAPHS)).toThrow(PersistBoundaryError);
  });

  it("P4b: 例外のメッセージに原因（申告値・導出値）が入り、本文全体は含まれない", () => {
    const finding: FindingBoundaryInput = { ...VALID_FINDING, paragraphId: 0 };
    try {
      assertFindingBoundary(finding, BODY, PARAGRAPHS);
      expect.unreachable("PersistBoundaryError を投げるはず");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistBoundaryError);
      const message = (error as Error).message;
      // 原因が特定できる情報（申告された paragraphId と本文から導いた値）が入っている。
      expect(message).toContain("0");
      expect(message).toContain("1");
      // 本文全体（段落 2 個ぶんの全文）は含まれない。
      expect(message).not.toContain(BODY);
    }
  });

  it("P5: 孤立サロゲートを含む引用で MalformedBodyError（本文全体は含めない例外型のまま）", () => {
    const finding: FindingBoundaryInput = { ...VALID_FINDING, quote: "a\uD800b" };
    expect(() => assertFindingBoundary(finding, BODY, PARAGRAPHS)).toThrow(MalformedBodyError);
  });

  it("P5b: 孤立サロゲートを含む修正案で MalformedBodyError", () => {
    const finding: FindingBoundaryInput = {
      ...VALID_FINDING,
      category: "notation",
      suggestion: "a\uDC00b",
    };
    expect(() => assertFindingBoundary(finding, BODY, PARAGRAPHS)).toThrow(MalformedBodyError);
  });

  it("P5c: 孤立サロゲートを含む本文で MalformedBodyError", () => {
    const malformedBody = "a\uD800b";
    expect(() => assertFindingBoundary(VALID_FINDING, malformedBody, PARAGRAPHS)).toThrow(
      MalformedBodyError,
    );
  });
});

describe("assertUnlocatedFindingBoundary", () => {
  /** すべての境界検査を通る最小の入力。各テストはここから 1 項目だけ崩す。 */
  const VALID_UNLOCATED: UnlocatedFindingBoundaryInput = {
    quote: "第一段落",
    suggestion: null,
  };

  it("well-formed な本文・引用・修正案では投げない", () => {
    expect(() => assertUnlocatedFindingBoundary(VALID_UNLOCATED, BODY)).not.toThrow();
    expect(() =>
      assertUnlocatedFindingBoundary({ ...VALID_UNLOCATED, suggestion: "修正案" }, BODY),
    ).not.toThrow();
  });

  it("U1: 引用に孤立サロゲートを含むと MalformedBodyError", () => {
    const finding: UnlocatedFindingBoundaryInput = { ...VALID_UNLOCATED, quote: "a\uD800b" };
    expect(() => assertUnlocatedFindingBoundary(finding, BODY)).toThrow(MalformedBodyError);
  });

  it("U2: 修正案に孤立サロゲートを含むと MalformedBodyError", () => {
    const finding: UnlocatedFindingBoundaryInput = {
      ...VALID_UNLOCATED,
      suggestion: "a\uDC00b",
    };
    expect(() => assertUnlocatedFindingBoundary(finding, BODY)).toThrow(MalformedBodyError);
  });

  it("U3: 保存本文に孤立サロゲートを含むと MalformedBodyError", () => {
    const malformedBody = "a\uD800b";
    expect(() => assertUnlocatedFindingBoundary(VALID_UNLOCATED, malformedBody)).toThrow(
      MalformedBodyError,
    );
  });
});

describe("checkInputFromTargetRecord", () => {
  function buildRecord(
    contextBefore: RunTargetRecord["contextBefore"],
    contextAfter: RunTargetRecord["contextAfter"],
  ): RunTargetRecord {
    return {
      id: "target-1",
      runId: "run-1",
      targetIndex: 2,
      target: { start: 10, end: 20 },
      contextBefore,
      contextAfter,
      input: { start: contextBefore?.start ?? 10, end: contextAfter?.end ?? 20 },
      paragraphIds: [1, 2],
    };
  }

  it("P6a: 参考文脈なし（before, after ともに null）", () => {
    const record = buildRecord(null, null);
    const input = checkInputFromTargetRecord(record);
    expect(input).toEqual({
      target: { index: 2, range: { start: 10, end: 20 }, paragraphIds: [1, 2] },
      context: { before: null, after: null },
      inputRange: { start: 10, end: 20 },
    });
  });

  it("P6b: 前だけ参考文脈あり", () => {
    const contextBefore = { start: 0, end: 10 };
    const record = buildRecord(contextBefore, null);
    const input = checkInputFromTargetRecord(record);
    expect(input.context).toEqual({ before: contextBefore, after: null });
    expect(input.inputRange).toEqual({ start: 0, end: 20 });
  });

  it("P6c: 後だけ参考文脈あり", () => {
    const contextAfter = { start: 20, end: 30 };
    const record = buildRecord(null, contextAfter);
    const input = checkInputFromTargetRecord(record);
    expect(input.context).toEqual({ before: null, after: contextAfter });
    expect(input.inputRange).toEqual({ start: 10, end: 30 });
  });

  it("P6d: 前後とも参考文脈あり", () => {
    const contextBefore = { start: 0, end: 10 };
    const contextAfter = { start: 20, end: 30 };
    const record = buildRecord(contextBefore, contextAfter);
    const input = checkInputFromTargetRecord(record);
    expect(input.target).toEqual({ index: 2, range: { start: 10, end: 20 }, paragraphIds: [1, 2] });
    expect(input.context).toEqual({ before: contextBefore, after: contextAfter });
    expect(input.inputRange).toEqual({ start: 0, end: 30 });
  });
});

describe("mergedFindingFromRecords", () => {
  function makeLlm(overrides: Partial<LlmFinding> = {}): LlmFinding {
    return {
      paragraphId: 0,
      quote: "誤字",
      before: "",
      after: "",
      category: "notation",
      reason: "理由",
      suggestion: "修正案",
      verdict: "likely-error",
      ...overrides,
    };
  }

  /** 位置確定済みの指摘（保存済みの集約値を持つ）。各テストはここから 1 項目だけ崩す。 */
  const LOCATED_FINDING: FindingRecord = {
    id: "f1",
    runId: "r1",
    manuscriptVersionId: "mv1",
    targetId: "t1",
    locateStatus: "located",
    range: { start: 0, end: 2 },
    paragraphId: 0,
    quote: "誤字",
    suggestion: "修正案",
    category: "notation",
    initialVerdict: "confirm-with-author",
    mergeKey: "mk",
    suppression: null,
    createdAt: new Date("2026-09-09T00:00:00.000Z"),
  };

  function makeCandidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
    return {
      id: "c1",
      runId: "r1",
      checkUnitId: "cu1",
      findingId: "f1",
      candidateIndex: 0,
      llm: makeLlm(),
      locateStatus: "located",
      range: { start: 0, end: 2 },
      mergeKey: "mk",
      createdAt: new Date("2026-09-09T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("保存済みの集約値（category・quote・suggestion・range・verdict）をそのまま使い、候補側の値では上書きしない（再計算しない）", () => {
    // 候補の llm.category / llm.quote / llm.suggestion をわざと指摘と食い違わせ、
    // 出力が指摘（保存済みの集約値）側であって候補側ではないことを確認する。
    const candidateWithDifferentValues = makeCandidate({
      llm: makeLlm({ category: "grammar", quote: "候補側の引用", suggestion: "候補側の修正案" }),
    });

    const merged = mergedFindingFromRecords(LOCATED_FINDING, [
      { candidate: candidateWithDifferentValues, perspective: "typo" },
    ]);

    expect(merged.id).toBe("f1");
    expect(merged.range).toEqual({ start: 0, end: 2 });
    expect(merged.quote).toBe("誤字"); // 指摘側の quote（候補側の "候補側の引用" ではない）
    expect(merged.category).toBe("notation"); // 指摘側の category（候補側の "grammar" ではない）
    expect(merged.suggestion).toBe("修正案"); // 指摘側の suggestion
    expect(merged.verdict).toBe("confirm-with-author"); // 指摘側の initialVerdict
  });

  it("sources は各候補の id・観点・llm・located の locate をそのまま並べる（入力順）", () => {
    const candidate1 = makeCandidate({
      id: "c-typo",
      llm: makeLlm({ reason: "誤字観点の理由" }),
      range: { start: 0, end: 2 },
    });
    const candidate2 = makeCandidate({
      id: "c-naturalness",
      llm: makeLlm({ reason: "自然さ観点の理由" }),
      range: { start: 0, end: 2 },
    });

    const merged = mergedFindingFromRecords(LOCATED_FINDING, [
      { candidate: candidate1, perspective: "typo" },
      { candidate: candidate2, perspective: "naturalness" },
    ]);

    expect(merged.sources).toEqual([
      {
        id: "c-typo",
        perspective: "typo",
        llm: candidate1.llm,
        locate: { status: "located", range: { start: 0, end: 2 } },
      },
      {
        id: "c-naturalness",
        perspective: "naturalness",
        llm: candidate2.llm,
        locate: { status: "located", range: { start: 0, end: 2 } },
      },
    ]);
  });

  it("locateStatus が located でない指摘には使えない（PersistBoundaryError）", () => {
    const unlocatedFinding: FindingRecord = {
      ...LOCATED_FINDING,
      locateStatus: "not-found",
      range: null,
      mergeKey: null,
    };
    expect(() => mergedFindingFromRecords(unlocatedFinding, [])).toThrow(PersistBoundaryError);
  });

  it("locateStatus が located でも range が null（不変条件が壊れた行）なら PersistBoundaryError", () => {
    const brokenFinding: FindingRecord = { ...LOCATED_FINDING, range: null };
    expect(() => mergedFindingFromRecords(brokenFinding, [])).toThrow(PersistBoundaryError);
  });

  it("候補側の range が null（located のはずなのに不変条件が壊れている）なら PersistBoundaryError", () => {
    const brokenCandidate = makeCandidate({ range: null });
    expect(() =>
      mergedFindingFromRecords(LOCATED_FINDING, [
        { candidate: brokenCandidate, perspective: "typo" },
      ]),
    ).toThrow(PersistBoundaryError);
  });

  it("sources が空配列でも組み立てられる（起票の下準備段階など）", () => {
    const merged = mergedFindingFromRecords(LOCATED_FINDING, []);
    expect(merged.sources).toEqual([]);
  });
});
