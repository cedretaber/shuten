/**
 * 指摘から本文への移動先の決定・要素検索・スクロール呼び出し（Task 9、決定 9、申し送り 3）の検査。
 *
 * R6：位置確定の指摘は強調（`finding`）へ、位置特定失敗の指摘は検査対象範囲を含む段落
 * （`paragraph`）へ、該当する検査対象が無ければ `null` になることを見る。DOM からの要素検索
 * （`findTargetElement`）と、jsdom に無い `scrollIntoView` を安全に呼ぶ側（`scrollIntoViewIfPossible`）
 * も合わせて検査する。幾何（`getBoundingClientRect` など）は検査しない。
 */

import type { FindingDto, RunTargetDto } from "@shuten/shared";
import { describe, expect, it, vi } from "vitest";
import { findTargetElement, navigationTargetOf, scrollIntoViewIfPossible } from "./navigate.ts";

const RUN_ID = "run-1";

function makeFinding(overrides: Partial<FindingDto> = {}): FindingDto {
  return {
    id: "finding-1",
    runId: RUN_ID,
    targetId: "target-1",
    locateStatus: "located",
    range: { start: 0, end: 1 },
    paragraphId: 0,
    quote: "あ",
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

function makeTarget(overrides: Partial<RunTargetDto> = {}): RunTargetDto {
  return {
    id: "target-1",
    targetIndex: 0,
    target: { start: 0, end: 1 },
    contextBefore: null,
    contextAfter: null,
    input: { start: 0, end: 1 },
    paragraphIds: [0],
    ...overrides,
  };
}

// 3 段落。段落 0："一段落目\n"（0-5）、段落 1："二段落目\n"（5-10）、段落 2："三段落目"（10-14）。
const BODY = "一段落目\n二段落目\n三段落目";

describe("navigationTargetOf", () => {
  it("位置が確定した指摘（located かつ range 非 null）は finding を返す", () => {
    const finding = makeFinding({ locateStatus: "located", range: { start: 0, end: 1 } });
    const result = navigationTargetOf(finding, [makeTarget()], BODY);
    expect(result).toEqual({ kind: "finding", findingId: "finding-1" });
  });

  it("locateStatus が located でも range が null なら段落へフォールバックする", () => {
    // DTO 上ありうる組み合わせ（決定 7 のコメントと同じ理由で、型上は独立している）。
    const finding = makeFinding({ locateStatus: "located", range: null, targetId: "target-1" });
    const target = makeTarget({ id: "target-1", target: { start: 6, end: 8 } }); // 二段落目の内側
    const result = navigationTargetOf(finding, [target], BODY);
    expect(result).toEqual({ kind: "paragraph", paragraphId: 1 });
  });

  it("not-found の指摘は検査対象範囲（target.target.start）を含む段落を返す", () => {
    const finding = makeFinding({
      locateStatus: "not-found",
      range: null,
      targetId: "target-1",
    });
    const target = makeTarget({ id: "target-1", target: { start: 11, end: 12 } }); // 三段落目の内側
    const result = navigationTargetOf(finding, [target], BODY);
    expect(result).toEqual({ kind: "paragraph", paragraphId: 2 });
  });

  it("ambiguous の指摘も同様に段落を返す", () => {
    const finding = makeFinding({
      locateStatus: "ambiguous",
      range: null,
      targetId: "target-1",
    });
    const target = makeTarget({ id: "target-1", target: { start: 0, end: 2 } }); // 一段落目の内側
    const result = navigationTargetOf(finding, [target], BODY);
    expect(result).toEqual({ kind: "paragraph", paragraphId: 0 });
  });

  it("finding.paragraphId は使わない（LLM 申告値と食い違っていても target.target.start 側を優先する）", () => {
    const finding = makeFinding({
      locateStatus: "not-found",
      range: null,
      targetId: "target-1",
      paragraphId: 99, // 本文に存在しない、LLM の申告値のつもりの値
    });
    const target = makeTarget({ id: "target-1", target: { start: 11, end: 12 } }); // 三段落目
    const result = navigationTargetOf(finding, [target], BODY);
    expect(result).toEqual({ kind: "paragraph", paragraphId: 2 });
  });

  it("targets に finding.targetId が無ければ null（移動の操作子を出さない）", () => {
    const finding = makeFinding({
      locateStatus: "not-found",
      range: null,
      targetId: "target-missing",
    });
    const result = navigationTargetOf(finding, [makeTarget({ id: "target-1" })], BODY);
    expect(result).toBeNull();
  });
});

describe("findTargetElement", () => {
  it('finding は [data-findings~="<id>"] の最初の要素を返す（複数指摘が重なる場合も先頭一致）', () => {
    document.body.innerHTML = `
      <div id="container">
        <p data-paragraph-id="0">
          <span data-findings="other-id">よそ</span>
          <span data-findings="finding-1 finding-2">対象</span>
        </p>
      </div>
    `;
    const container = document.getElementById("container") as HTMLElement;
    const element = findTargetElement(container, { kind: "finding", findingId: "finding-1" });
    expect(element).not.toBeNull();
    expect(element?.textContent).toBe("対象");
  });

  it('paragraph は [data-paragraph-id="<id>"] を返す', () => {
    document.body.innerHTML = `
      <div id="container">
        <p data-paragraph-id="0">一段落目</p>
        <p data-paragraph-id="1">二段落目</p>
      </div>
    `;
    const container = document.getElementById("container") as HTMLElement;
    const element = findTargetElement(container, { kind: "paragraph", paragraphId: 1 });
    expect(element).not.toBeNull();
    expect(element?.textContent).toBe("二段落目");
  });

  it("該当する要素が無ければ null", () => {
    document.body.innerHTML = `<div id="container"></div>`;
    const container = document.getElementById("container") as HTMLElement;
    expect(findTargetElement(container, { kind: "finding", findingId: "no-such-id" })).toBeNull();
    expect(findTargetElement(container, { kind: "paragraph", paragraphId: 0 })).toBeNull();
  });
});

describe("scrollIntoViewIfPossible", () => {
  it("scrollIntoView を持たない要素（jsdom の既定）でも例外を投げない", () => {
    const element = document.createElement("div");
    expect(typeof element.scrollIntoView).not.toBe("function"); // jsdom には無い（申し送り 3）
    expect(() => scrollIntoViewIfPossible(element)).not.toThrow();
  });

  it("scrollIntoView がある（テストで代入したスタブ）ときはそれを呼ぶ", () => {
    const element = document.createElement("div");
    const scrollIntoView = vi.fn();
    // jsdom に無い API をテスト側でスタブする（申し送り 3 のとおり）。
    Object.defineProperty(element, "scrollIntoView", { value: scrollIntoView, configurable: true });
    scrollIntoViewIfPossible(element);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
