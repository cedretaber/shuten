import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BodyParagraph } from "./body-view.ts";
import type { BodyParagraphProps } from "./body-view.tsx";
import { BodyView, paragraphPropsEqual } from "./body-view.tsx";
import styles from "./results.module.css";

/**
 * 本文の描画（Task 4、決定 6・申し送り 3・4）。
 *
 * 選択の塗り分けは props 経由で React に描かせる設計（決定 6）なので、DOM を手で
 * 書き換える実装ではないことを className の比較で確認する。再描画の抑止は
 * `paragraphPropsEqual`（`React.memo` に渡す比較関数）の単体テストで検査する。
 * 描画回数を数えるモックや DOM ノードの同一性は使わない——子が再描画されても
 * 同じ DOM ノードが再利用されるため、常に緑になって何も守らない。
 */

// 段落 0: 素のセグメントと、f1・f2 が重なる強調、また別の素のセグメント。
// 段落 1: 空段落（segments が空）。
// 段落 2: f3 だけの強調。
const paragraphs: readonly BodyParagraph[] = [
  {
    id: 0,
    segments: [
      { start: 0, end: 1, text: "あ", findingIds: [] },
      { start: 1, end: 3, text: "いう", findingIds: ["f1", "f2"] },
      { start: 3, end: 5, text: "えお", findingIds: [] },
    ],
  },
  { id: 1, segments: [] },
  {
    id: 2,
    segments: [{ start: 6, end: 8, text: "かき", findingIds: ["f3"] }],
  },
];

describe("paragraphPropsEqual", () => {
  const paragraph: BodyParagraph = { id: 0, segments: [] };
  const onSelectFinding = vi.fn();

  function makeProps(overrides: Partial<BodyParagraphProps> = {}): BodyParagraphProps {
    return { paragraph, selectedIdHere: null, onSelectFinding, ...overrides };
  }

  it("R2-1: 3 つとも同じ参照なら true", () => {
    expect(paragraphPropsEqual(makeProps(), makeProps())).toBe(true);
  });

  it('R2-2: selectedIdHere が null から "f1" に変わると false', () => {
    const a = makeProps({ selectedIdHere: null });
    const b = makeProps({ selectedIdHere: "f1" });
    expect(paragraphPropsEqual(a, b)).toBe(false);
  });

  it("R2-3: paragraph が別インスタンス（内容が同じでも）なら false", () => {
    const a = makeProps({ paragraph: { id: 0, segments: [] } });
    const b = makeProps({ paragraph: { id: 0, segments: [] } });
    expect(paragraphPropsEqual(a, b)).toBe(false);
  });

  it("R2-4: onSelectFinding が別関数なら false", () => {
    const a = makeProps({ onSelectFinding: vi.fn() });
    const b = makeProps({ onSelectFinding: vi.fn() });
    expect(paragraphPropsEqual(a, b)).toBe(false);
  });
});

describe("BodyView", () => {
  it("R2-5: 段落数が paragraphs の長さと一致し、<p> の textContent に改行を含まない", () => {
    const { container } = render(
      <BodyView paragraphs={paragraphs} selectedFindingId={null} onSelectFinding={vi.fn()} />,
    );
    const ps = container.querySelectorAll("p");
    expect(ps.length).toBe(paragraphs.length);
    for (const p of ps) {
      expect(p.textContent).not.toContain("\n");
      expect(p.textContent).not.toContain("\r");
    }
  });

  it("R2-6: 素のセグメントは <span> で包まずテキストノードのまま描く", () => {
    const { container } = render(
      <BodyView paragraphs={paragraphs} selectedFindingId={null} onSelectFinding={vi.fn()} />,
    );
    const p0 = container.querySelector('[data-paragraph-id="0"]') as HTMLElement;
    expect(p0.textContent).toBe("あいうえお");
    // "あ" と "えお" はどの <span> の textContent にも現れない（span で包まれていない）。
    const spanTexts = Array.from(p0.querySelectorAll("span")).map((s) => s.textContent);
    expect(spanTexts).not.toContain("あ");
    expect(spanTexts).not.toContain("えお");
  });

  it("R2-7: data-findings は重なる指摘 ID を空白区切りで持ち、[data-findings~=] で引ける", () => {
    const { container } = render(
      <BodyView paragraphs={paragraphs} selectedFindingId={null} onSelectFinding={vi.fn()} />,
    );
    const span = container.querySelector('[data-findings~="f1"]');
    expect(span).not.toBeNull();
    expect(span?.getAttribute("data-findings")).toBe("f1 f2");
    expect(span?.textContent).toBe("いう");
  });

  it("R2-8: 強調をクリックすると onSelectFinding が先頭の ID で呼ばれる", () => {
    const onSelectFinding = vi.fn();
    const { container } = render(
      <BodyView
        paragraphs={paragraphs}
        selectedFindingId={null}
        onSelectFinding={onSelectFinding}
      />,
    );
    const span = container.querySelector('[data-findings~="f1"]') as Element;
    fireEvent.click(span);
    expect(onSelectFinding).toHaveBeenCalledTimes(1);
    expect(onSelectFinding).toHaveBeenCalledWith("f1"); // 重なる f1・f2 のうち先頭（決定 8）
  });

  it("R2-9: 選択中の指摘を含む <span> にだけ選択用 class が付き、選択を移すと前の class が戻る", () => {
    const { container, rerender } = render(
      <BodyView paragraphs={paragraphs} selectedFindingId="f1" onSelectFinding={vi.fn()} />,
    );
    const spanF1 = container.querySelector('[data-findings~="f1"]') as HTMLElement;
    const spanF3 = container.querySelector('[data-findings~="f3"]') as HTMLElement;
    expect(spanF1.className).toContain(styles.highlightSelected);
    expect(spanF3.className).not.toContain(styles.highlightSelected);

    rerender(<BodyView paragraphs={paragraphs} selectedFindingId="f3" onSelectFinding={vi.fn()} />);
    const spanF1After = container.querySelector('[data-findings~="f1"]') as HTMLElement;
    const spanF3After = container.querySelector('[data-findings~="f3"]') as HTMLElement;
    expect(spanF1After.className).not.toContain(styles.highlightSelected);
    expect(spanF3After.className).toContain(styles.highlightSelected);
  });

  it("R2-10: 空段落は <p> として残る（消えない）", () => {
    const { container } = render(
      <BodyView paragraphs={paragraphs} selectedFindingId={null} onSelectFinding={vi.fn()} />,
    );
    const emptyParagraph = container.querySelector('[data-paragraph-id="1"]');
    expect(emptyParagraph).not.toBeNull();
    expect(emptyParagraph?.tagName).toBe("P");
    expect(emptyParagraph?.textContent).toBe("");
  });
});
