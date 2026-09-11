import type { FindingDto } from "@shuten/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FindingList } from "./finding-list.tsx";
import styles from "./results-page.module.css";

/**
 * 指摘一覧の DOM 検査（Task 6、決定 6・7・8・10）。DOM を描画するので `.tsx`（`finding-filter.ts`
 * の純関数の検査とは分ける）。
 */

function makeFinding(overrides: Partial<FindingDto> = {}): FindingDto {
  return {
    id: "finding-1",
    runId: "run-1",
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

describe("FindingList: 行はボタンで、クリックで選択できる", () => {
  it("見つかった件数ぶんのボタンが並ぶ", () => {
    const findings = [
      makeFinding({ id: "f1" }),
      makeFinding({ id: "f2" }),
      makeFinding({ id: "f3" }),
    ];
    render(<FindingList findings={findings} selectedFindingId={null} onSelectFinding={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("渡された順のまま描く（並び替えない）", () => {
    const findings = [
      makeFinding({ id: "f1", quote: "いち" }),
      makeFinding({ id: "f2", quote: "に" }),
      makeFinding({ id: "f3", quote: "さん" }),
    ];
    render(<FindingList findings={findings} selectedFindingId={null} onSelectFinding={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      expect.stringContaining("いち"),
      expect.stringContaining("に"),
      expect.stringContaining("さん"),
    ]);
  });

  it("行をクリックすると onSelectFinding がその指摘の ID で呼ばれる", async () => {
    const user = userEvent.setup();
    const onSelectFinding = vi.fn();
    const findings = [makeFinding({ id: "f1" }), makeFinding({ id: "f2" })];
    render(
      <FindingList
        findings={findings}
        selectedFindingId={null}
        onSelectFinding={onSelectFinding}
      />,
    );
    const buttons = screen.getAllByRole("button");
    await user.click(buttons[1] as HTMLElement);
    expect(onSelectFinding).toHaveBeenCalledTimes(1);
    expect(onSelectFinding).toHaveBeenCalledWith("f2");
  });

  it("選択中の指摘の行にだけ選択用 class が付く", () => {
    const findings = [makeFinding({ id: "f1" }), makeFinding({ id: "f2" })];
    render(<FindingList findings={findings} selectedFindingId="f2" onSelectFinding={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]?.className).not.toContain(styles.findingRowSelected);
    expect(buttons[1]?.className).toContain(styles.findingRowSelected);
  });

  it("見つからないときは絞り込みに一致しない旨のメッセージを出す（ボタンは 0 個）", () => {
    render(<FindingList findings={[]} selectedFindingId={null} onSelectFinding={vi.fn()} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText(/絞り込みに一致する指摘はありません/)).toBeInTheDocument();
  });
});

describe("FindingList: 位置特定失敗の印", () => {
  it("located では印が出ない", () => {
    const finding = makeFinding({ locateStatus: "located", range: { start: 0, end: 1 } });
    render(<FindingList findings={[finding]} selectedFindingId={null} onSelectFinding={vi.fn()} />);
    expect(screen.queryByText("本文に見つからない")).not.toBeInTheDocument();
    expect(screen.queryByText("候補が複数あり特定できない")).not.toBeInTheDocument();
  });

  it("not-found では「本文に見つからない」の印が出る", () => {
    const finding = makeFinding({ locateStatus: "not-found", range: null });
    render(<FindingList findings={[finding]} selectedFindingId={null} onSelectFinding={vi.fn()} />);
    expect(screen.getByText("本文に見つからない")).toBeInTheDocument();
  });

  it("ambiguous では「候補が複数あり特定できない」の印が出る", () => {
    const finding = makeFinding({ locateStatus: "ambiguous", range: null });
    render(<FindingList findings={[finding]} selectedFindingId={null} onSelectFinding={vi.fn()} />);
    expect(screen.getByText("候補が複数あり特定できない")).toBeInTheDocument();
  });
});

describe("FindingList: 一覧の見出しで引用の文字列を切らない", () => {
  // 結合文字列: U+304B（か）+ U+3099（結合濁点）。合成すると見た目は「が」（U+304C）になるが、
  // コードポイントは 2 つのまま——エディタや変換で実際の合成済み文字（U+304C）へ化けると検査の
  // 意味が変わるため、\u エスケープで明示する（ブリーフの指示）。
  const COMBINING_DAKUTEN_GA = "\u304B\u3099";
  const COMBINING_QUOTE = `${COMBINING_DAKUTEN_GA}しばい当たり前ですね`;

  it("結合文字を含む長い引用でも全文が textContent に入っている", () => {
    const finding = makeFinding({ id: "f1", quote: COMBINING_QUOTE });
    render(<FindingList findings={[finding]} selectedFindingId={null} onSelectFinding={vi.fn()} />);
    const button = screen.getByRole("button");
    expect(button.textContent).toContain(COMBINING_QUOTE);
  });

  // ZWJ（U+200D）で連結した絵文字: man（U+1F468）+ ZWJ + woman（U+1F469）+ ZWJ + girl（U+1F467）。
  // それぞれ UTF-16 ではサロゲートペア。\u エスケープで明示する（ブリーフの指示）。
  const ZWJ_FAMILY_EMOJI = "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67";
  const ZWJ_EMOJI_QUOTE = `${ZWJ_FAMILY_EMOJI}という絵文字を含む引用`;

  it("ZWJ 連結の絵文字を含む引用でも全文が textContent に入っている", () => {
    const finding = makeFinding({ id: "f2", quote: ZWJ_EMOJI_QUOTE });
    render(<FindingList findings={[finding]} selectedFindingId={null} onSelectFinding={vi.fn()} />);
    const button = screen.getByRole("button");
    expect(button.textContent).toContain(ZWJ_EMOJI_QUOTE);
  });

  it("引用の <span> は dangerouslySetInnerHTML を使わず、テキストノードとして持つ（切らずに置く）", () => {
    const finding = makeFinding({ id: "f3", quote: COMBINING_QUOTE });
    const { container } = render(
      <FindingList findings={[finding]} selectedFindingId={null} onSelectFinding={vi.fn()} />,
    );
    const quoteEl = container.querySelector(`.${styles.findingQuote}`);
    expect(quoteEl).not.toBeNull();
    expect(quoteEl?.textContent).toBe(COMBINING_QUOTE);
  });
});
