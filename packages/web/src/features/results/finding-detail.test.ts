/**
 * 指摘詳細の表示規則（`finding-detail.ts`）の純関数テスト（Task 7、R4）。
 *
 * `describeRecheck` は決定 12 の表の 5 行を 1 件ずつ検査する。`relatedFindings` は決定 8 の
 * 2 群（同じ範囲・重なるが一致しない）と、隣接するだけの範囲がどちらにも入らないことを検査する。
 */

import type { FindingDto } from "@shuten/shared";
import { describe, expect, it } from "vitest";
import { describeRecheck, relatedFindings } from "./finding-detail.ts";

function makeFinding(overrides: Partial<FindingDto> = {}): FindingDto {
  return {
    id: "finding-1",
    runId: "run-1",
    targetId: "target-1",
    locateStatus: "located",
    range: { start: 0, end: 10 },
    paragraphId: 0,
    quote: "引用",
    suggestion: null,
    category: "notation",
    initialVerdict: "likely-error",
    suppression: null,
    reasons: [],
    recheck: null,
    judgment: {
      findingId: "finding-1",
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
    createdAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("describeRecheck: 決定 12 の表", () => {
  it("行 1：recheck が null のとき、最終判定は初回判定、状態は「再確認なし」", () => {
    const finding = makeFinding({ initialVerdict: "confirm-with-author", recheck: null });

    const result = describeRecheck(finding);

    expect(result.stateLabel).toBe("再確認なし");
    expect(result.finalVerdict).toEqual({ kind: "initial", verdict: "confirm-with-author" });
    expect(result.initialVerdict).toBe("confirm-with-author");
    expect(result.suggestionUsable).toBe(true);
  });

  it("行 2：status が done かつ verdict が非 null のとき、最終判定は verdict、初回判定は履歴として残る", () => {
    const finding = makeFinding({
      initialVerdict: "confirm-with-author",
      recheck: {
        id: "recheck-1",
        status: "done",
        notApplicableReason: null,
        verdict: "keep",
        reasonKind: "error-confirmed",
        reason: "誤りを確認した",
        suggestionValid: true,
        failure: null,
      },
    });

    const result = describeRecheck(finding);

    expect(result.stateLabel).toBe("再確認済み（誤りを確認）");
    expect(result.finalVerdict).toEqual({ kind: "recheck", verdict: "keep" });
    // 初回判定は最終判定が recheck でも失われない（仕様 5.4「初回判定は履歴に保持」）。
    expect(result.initialVerdict).toBe("confirm-with-author");
  });

  it("行 3：status が pending / running のとき、最終判定は未検証の初回判定、状態は「再確認待ち」", () => {
    const pending = makeFinding({
      initialVerdict: "likely-error",
      recheck: {
        id: "recheck-1",
        status: "pending",
        notApplicableReason: null,
        verdict: null,
        reasonKind: null,
        reason: null,
        suggestionValid: null,
        failure: null,
      },
    });
    const running = makeFinding({
      initialVerdict: "likely-error",
      recheck: {
        id: "recheck-1",
        status: "running",
        notApplicableReason: null,
        verdict: null,
        reasonKind: null,
        reason: null,
        suggestionValid: null,
        failure: null,
      },
    });

    for (const finding of [pending, running]) {
      const result = describeRecheck(finding);
      expect(result.stateLabel).toBe("再確認待ち");
      expect(result.finalVerdict).toEqual({ kind: "initial-unverified", verdict: "likely-error" });
      expect(result.initialVerdict).toBe("likely-error");
    }
  });

  it("行 4：status が failed のとき、最終判定は未検証の初回判定、状態は「再確認失敗」＋失敗理由", () => {
    const finding = makeFinding({
      initialVerdict: "likely-error",
      recheck: {
        id: "recheck-1",
        status: "failed",
        notApplicableReason: null,
        verdict: null,
        reasonKind: null,
        reason: null,
        suggestionValid: null,
        failure: { reason: "timeout", message: "timed out", finishReason: null, origin: "chat" },
      },
    });

    const result = describeRecheck(finding);

    expect(result.stateLabel).toBe("再確認失敗（タイムアウト）");
    expect(result.finalVerdict).toEqual({ kind: "initial-unverified", verdict: "likely-error" });
  });

  it("行 5：status が not-applicable のとき、最終判定は未検証の初回判定、状態は notApplicableReason のラベル", () => {
    const finding = makeFinding({
      initialVerdict: "likely-error",
      recheck: {
        id: "recheck-1",
        status: "not-applicable",
        notApplicableReason: "suppressed",
        verdict: null,
        reasonKind: null,
        reason: null,
        suggestionValid: null,
        failure: null,
      },
    });

    const result = describeRecheck(finding);

    expect(result.stateLabel).toBe("再確認なし（許容語で抑制）");
    expect(result.finalVerdict).toEqual({ kind: "initial-unverified", verdict: "likely-error" });
  });
});

describe("describeRecheck: suggestionUsable（決定 12）", () => {
  it("recheck.suggestionValid === false のとき false", () => {
    const finding = makeFinding({
      recheck: {
        id: "recheck-1",
        status: "done",
        notApplicableReason: null,
        verdict: "keep",
        reasonKind: "error-confirmed",
        reason: "誤りを確認した",
        suggestionValid: false,
        failure: null,
      },
    });

    expect(describeRecheck(finding).suggestionUsable).toBe(false);
  });

  it("recheck.reasonKind === 'suggestion-inappropriate' のとき false（suggestionValid が null でも）", () => {
    const finding = makeFinding({
      recheck: {
        id: "recheck-1",
        status: "done",
        notApplicableReason: null,
        verdict: "confirm-with-author",
        reasonKind: "suggestion-inappropriate",
        reason: "修正案が不適切",
        suggestionValid: null,
        failure: null,
      },
    });

    expect(describeRecheck(finding).suggestionUsable).toBe(false);
  });

  it("上記どちらにも該当しなければ true", () => {
    const finding = makeFinding({
      recheck: {
        id: "recheck-1",
        status: "done",
        notApplicableReason: null,
        verdict: "keep",
        reasonKind: "error-confirmed",
        reason: "誤りを確認した",
        suggestionValid: true,
        failure: null,
      },
    });

    expect(describeRecheck(finding).suggestionUsable).toBe(true);
  });
});

describe("relatedFindings: 決定 8 の 2 群", () => {
  it("range.start と range.end が完全一致するものは sameRange、自分自身は含めない", () => {
    const selected = makeFinding({ id: "selected", range: { start: 0, end: 10 } });
    const same = makeFinding({ id: "same", range: { start: 0, end: 10 } });
    const other = makeFinding({ id: "other", range: { start: 20, end: 30 } });

    const result = relatedFindings(selected, [selected, same, other]);

    expect(result.sameRange.map((f) => f.id)).toEqual(["same"]);
    expect(result.overlapping.map((f) => f.id)).toEqual([]);
  });

  it("重なるが一致しないものは overlapping（[0,10) と [9,20)）", () => {
    const selected = makeFinding({ id: "selected", range: { start: 0, end: 10 } });
    const overlapping = makeFinding({ id: "overlapping", range: { start: 9, end: 20 } });

    const result = relatedFindings(selected, [selected, overlapping]);

    expect(result.sameRange.map((f) => f.id)).toEqual([]);
    expect(result.overlapping.map((f) => f.id)).toEqual(["overlapping"]);
  });

  it("隣接するだけ（[0,10) と [10,20)）はどちらにも入らない", () => {
    const selected = makeFinding({ id: "selected", range: { start: 0, end: 10 } });
    const adjacent = makeFinding({ id: "adjacent", range: { start: 10, end: 20 } });

    const result = relatedFindings(selected, [selected, adjacent]);

    expect(result.sameRange.map((f) => f.id)).toEqual([]);
    expect(result.overlapping.map((f) => f.id)).toEqual([]);
  });

  it("選択中の指摘が位置未確定（range === null）のとき、どちらも空", () => {
    const selected = makeFinding({ id: "selected", range: null, locateStatus: "not-found" });
    const other = makeFinding({ id: "other", range: { start: 0, end: 10 } });

    const result = relatedFindings(selected, [selected, other]);

    expect(result.sameRange).toEqual([]);
    expect(result.overlapping).toEqual([]);
  });

  it("visible 側が位置未確定（range === null）の要素は比較対象から除く", () => {
    const selected = makeFinding({ id: "selected", range: { start: 0, end: 10 } });
    const unlocated = makeFinding({ id: "unlocated", range: null, locateStatus: "not-found" });

    const result = relatedFindings(selected, [selected, unlocated]);

    expect(result.sameRange).toEqual([]);
    expect(result.overlapping).toEqual([]);
  });
});
