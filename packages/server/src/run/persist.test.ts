import { splitParagraphs } from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { MalformedBodyError } from "../db/errors.ts";
import type { RunTargetRecord } from "../db/records.ts";
import {
  assertFindingBoundary,
  checkInputFromTargetRecord,
  deriveParagraphId,
  type FindingBoundaryInput,
  PersistBoundaryError,
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
