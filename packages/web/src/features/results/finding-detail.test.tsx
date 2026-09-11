/**
 * 指摘詳細パネル（`finding-detail.tsx`）の DOM テスト（Task 7、R4）。
 *
 * 純関数（`describeRecheck` / `relatedFindings`）の検査は `finding-detail.test.ts` の役割。
 * ここでは `FindingDetail` コンポーネントを直接描画し、決定 9（`paragraphId` を出さない）、
 * 位置確定時・位置特定失敗時の引用の出し分け、取得中・取得失敗の欄の出し分け、修正案の扱い、
 * 関連する他の指摘のリンク、`onNavigate` の有無での操作子の出し分けを検査する。
 *
 * 見出し（仕様 5.4「分類と短い見出し」。裁定：分類ラベル ＋ 原文を 1 行にする）の内容は、
 * 見出し本体（「原文」節）と同じ引用文字列を使うため、`getByText` の単純な一致は複数ヒットして
 * あいまいになる。以降のテストでは、本文側（「原文」／「LLM の引用…」の `<h3>` を含む
 * `<section>`）に `within` でスコープしてから引用文字列を検査する。
 */

import type { CandidateDto, DiagnosticDto, FindingDetailDto, FindingDto } from "@shuten/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FindingDetailProps } from "./finding-detail.tsx";
import { FindingDetail } from "./finding-detail.tsx";

/** 「原文」または「LLM の引用（原文との一致未確認）」の見出しを含む `<section>` を返す。 */
function quoteSection(headingText: string): HTMLElement {
  const heading = screen.getByText(headingText);
  const section = heading.closest("section");
  if (section === null) {
    throw new Error(`見出し「${headingText}」を含む section が見つかりません`);
  }
  return section as HTMLElement;
}

const BODY = "これはテスト用の本文です。誤字を含みます。";

function makeFinding(overrides: Partial<FindingDto> = {}): FindingDto {
  return {
    id: "finding-1",
    runId: "run-1",
    targetId: "target-1",
    locateStatus: "located",
    range: { start: 0, end: 2 },
    paragraphId: 12345,
    quote: "これ",
    suggestion: null,
    category: "notation",
    initialVerdict: "likely-error",
    suppression: null,
    reasons: [{ candidateId: "candidate-1", perspective: "typo", reason: "誤字がある" }],
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

function makeCandidate(overrides: Partial<CandidateDto> = {}): CandidateDto {
  return {
    id: "candidate-1",
    checkUnitId: "check-1",
    perspective: "typo",
    candidateIndex: 0,
    llm: {
      paragraphId: 0,
      quote: "これ",
      before: "",
      after: "はテスト",
      category: "notation",
      reason: "誤字がある",
      suggestion: null,
      verdict: "likely-error",
    },
    locateStatus: "located",
    range: { start: 0, end: 2 },
    ...overrides,
  };
}

function makeDetail(overrides: Partial<FindingDetailDto> = {}): FindingDetailDto {
  return {
    ...makeFinding(),
    candidates: [makeCandidate()],
    diagnostics: [],
    ...overrides,
  };
}

function makeDiagnostic(overrides: Partial<DiagnosticDto> = {}): DiagnosticDto {
  return {
    candidateId: "candidate-2",
    quote: "みつからない",
    reason: "not-found",
    searchRange: { start: 0, end: 20 },
    exactMatches: [],
    transformVersion: null,
    transformCandidates: null,
    omitted: null,
    tied: null,
    ...overrides,
  };
}

function baseProps(overrides: Partial<FindingDetailProps> = {}): FindingDetailProps {
  return {
    finding: makeFinding(),
    detail: makeDetail(),
    detailError: null,
    body: BODY,
    sameRange: [],
    overlapping: [],
    onSelectFinding: vi.fn(),
    onSaveJudgment: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe("FindingDetail: 決定 9 paragraphId を出さない", () => {
  it("paragraphId の値が document に出ない", () => {
    const finding = makeFinding({ paragraphId: 98765 });
    render(<FindingDetail {...baseProps({ finding, detail: makeDetail({ ...finding }) })} />);

    expect(document.body.textContent ?? "").not.toContain("98765");
  });
});

describe("FindingDetail: 引用の出し分け", () => {
  it("位置確定時は本文から切り出した引用を「原文」として出す", () => {
    const finding = makeFinding({
      locateStatus: "located",
      range: { start: 5, end: 10 },
      quote: "無視されるはずの LLM 引用",
    });
    render(<FindingDetail {...baseProps({ finding })} />);

    expect(within(quoteSection("原文")).getByText(BODY.slice(5, 10))).toBeInTheDocument();
    expect(screen.queryByText("無視されるはずの LLM 引用")).not.toBeInTheDocument();
  });

  it("位置特定失敗時は finding.quote を「LLM の引用（原文との一致未確認）」として出す", () => {
    const finding = makeFinding({
      locateStatus: "not-found",
      range: null,
      quote: "LLM が申告した引用",
    });
    render(<FindingDetail {...baseProps({ finding })} />);

    expect(
      within(quoteSection("LLM の引用（原文との一致未確認）")).getByText("LLM が申告した引用"),
    ).toBeInTheDocument();
  });
});

describe("FindingDetail: 見出し（仕様 5.4「分類と短い見出し」。裁定：分類ラベル ＋ 原文）", () => {
  it("位置確定時は、見出しに分類ラベルと本文から切り出した原文の両方が出る", () => {
    const finding = makeFinding({
      category: "grammar",
      locateStatus: "located",
      range: { start: 5, end: 10 },
      quote: "無視されるはずの LLM 引用",
    });
    render(<FindingDetail {...baseProps({ finding })} />);

    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("文法");
    expect(heading.textContent).toContain(BODY.slice(5, 10));
    // 見出しには LLM の生の引用（quote）ではなく、本文から切り出した原文が出る。
    expect(heading.textContent).not.toContain("無視されるはずの LLM 引用");
  });

  it("位置特定失敗時は、見出しに finding.quote が使われ、未確認であることも見出しから分かる", () => {
    const finding = makeFinding({
      category: "grammar",
      locateStatus: "not-found",
      range: null,
      quote: "LLM が申告した引用",
    });
    render(<FindingDetail {...baseProps({ finding })} />);

    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("文法");
    expect(heading.textContent).toContain("LLM が申告した引用");
    expect(heading.textContent).toContain("未確認");
  });

  it("見出しの引用は結合文字・ZWJ の絵文字を含んでいても全文が DOM に入る（切り詰めない）", () => {
    // 「が」の濁点を結合文字で表現した例 + ZWJ の家族の絵文字。書記素境界を無視した
    // `slice`/`Array.from(...).slice(...)` はどちらもこの文字列を割りうる。
    const quoteWithCombiningAndZwj =
      "これはか\u{3099}テストです\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    const finding = makeFinding({
      locateStatus: "not-found",
      range: null,
      quote: quoteWithCombiningAndZwj,
    });
    render(<FindingDetail {...baseProps({ finding })} />);

    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain(quoteWithCombiningAndZwj);
  });
});

describe("FindingDetail: 取得中・取得失敗の欄の出し分け（元候補・位置診断だけ）", () => {
  it("取得中（detail === null, detailError === null）は「読み込み中…」で、引用・理由は finding から描く", () => {
    render(<FindingDetail {...baseProps({ detail: null, detailError: null })} />);

    expect(screen.getByText("読み込み中…")).toBeInTheDocument();
    // 一覧が持つ情報（finding）だけで引用・理由は既に出ている。
    expect(within(quoteSection("原文")).getByText("これ")).toBeInTheDocument();
    expect(screen.getByText(/誤字がある/)).toBeInTheDocument();
  });

  it("取得失敗（detail === null, detailError !== null）はその欄にエラーを出す（詳細全体は消えない）", () => {
    render(
      <FindingDetail
        {...baseProps({ detail: null, detailError: "指摘詳細の取得に失敗しました" })}
      />,
    );

    expect(screen.getByText("指摘詳細の取得に失敗しました")).toBeInTheDocument();
    expect(screen.queryByText("読み込み中…")).not.toBeInTheDocument();
    // 詳細全体は消えていない（引用は出続ける）。
    expect(within(quoteSection("原文")).getByText("これ")).toBeInTheDocument();
  });

  it("取得済みなら候補の locateStatus（outside-target を含む）が出る", () => {
    const detail = makeDetail({
      candidates: [makeCandidate({ locateStatus: "outside-target" })],
    });
    render(<FindingDetail {...baseProps({ detail })} />);

    expect(screen.getByText(/検査対象範囲外/)).toBeInTheDocument();
  });

  it("位置診断（診断候補を含む）が出る", () => {
    const detail = makeDetail({
      diagnostics: [
        makeDiagnostic({
          transformCandidates: [
            { transform: "nfc", text: "変換後の候補", range: { start: 1, end: 3 } },
          ],
        }),
      ],
    });
    render(<FindingDetail {...baseProps({ detail })} />);

    expect(screen.getByText("みつからない")).toBeInTheDocument();
    expect(screen.getByText(/変換後の候補/)).toBeInTheDocument();
  });
});

describe("FindingDetail: 修正案", () => {
  it("suggestion が null なら「修正案なし」", () => {
    render(<FindingDetail {...baseProps({ finding: makeFinding({ suggestion: null }) })} />);
    expect(screen.getByText("修正案なし")).toBeInTheDocument();
  });

  it("有効な修正案はそのまま出す", () => {
    const finding = makeFinding({ suggestion: "これは" });
    render(<FindingDetail {...baseProps({ finding })} />);
    expect(screen.getByText("これは")).toBeInTheDocument();
    expect(
      screen.queryByText("この修正案は再確認で不適切と判定されました"),
    ).not.toBeInTheDocument();
  });

  it("recheck.suggestionValid === false のとき、修正案は出るが不適切だった旨を添える", () => {
    const finding = makeFinding({
      suggestion: "これは",
      recheck: {
        id: "recheck-1",
        status: "done",
        notApplicableReason: null,
        verdict: "confirm-with-author",
        reasonKind: "suggestion-inappropriate",
        reason: "修正案が不適切",
        suggestionValid: false,
        failure: null,
      },
    });
    render(<FindingDetail {...baseProps({ finding })} />);

    expect(screen.getByText("これは")).toBeInTheDocument();
    expect(screen.getByText("この修正案は再確認で不適切と判定されました")).toBeInTheDocument();
  });

  it("recheck.reasonKind === 'suggestion-inappropriate' のときも同様（suggestionValid が null でも）", () => {
    const finding = makeFinding({
      suggestion: "これは",
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
    render(<FindingDetail {...baseProps({ finding })} />);

    expect(screen.getByText("この修正案は再確認で不適切と判定されました")).toBeInTheDocument();
  });
});

describe("FindingDetail: 判定（決定 12 行 2）の再確認理由", () => {
  it("再確認済みのとき、recheck.reason の本文を出す（reasonKind だけでなく理由の自由記述も）", () => {
    const finding = makeFinding({
      recheck: {
        id: "recheck-1",
        status: "done",
        notApplicableReason: null,
        verdict: "withdraw",
        reasonKind: "intentional-expression",
        reason: "文脈から意図的な倒置と判断",
        suggestionValid: null,
        failure: null,
      },
    });
    render(<FindingDetail {...baseProps({ finding })} />);

    expect(screen.getByText("文脈から意図的な倒置と判断")).toBeInTheDocument();
  });

  it("recheck が無い、または reason が null のときは何も出さない", () => {
    render(<FindingDetail {...baseProps({ finding: makeFinding({ recheck: null }) })} />);
    // 判定セクション自体は出るが、理由の段落は無い（`理由` セクションとは別物であることの確認）。
    expect(screen.getByText("判定")).toBeInTheDocument();
  });
});

describe("FindingDetail: 抑制候補", () => {
  it("suppression !== null のとき「許容語『〜』により抑制」と明示する", () => {
    const finding = makeFinding({ suppression: { word: "こと", ruleVersion: "1" } });
    render(<FindingDetail {...baseProps({ finding })} />);

    expect(screen.getByText("許容語『こと』により抑制")).toBeInTheDocument();
  });
});

describe("FindingDetail: 関連する他の指摘（決定 8）", () => {
  it("sameRange と overlapping を別の見出しで出し、クリックで onSelectFinding が呼ばれる", async () => {
    const user = userEvent.setup();
    const onSelectFinding = vi.fn();
    const sameRangeFinding = makeFinding({ id: "finding-same", quote: "同じ範囲" });
    const overlappingFinding = makeFinding({ id: "finding-overlap", quote: "重なる範囲" });

    render(
      <FindingDetail
        {...baseProps({
          sameRange: [sameRangeFinding],
          overlapping: [overlappingFinding],
          onSelectFinding,
        })}
      />,
    );

    expect(screen.getByText("同じ範囲の他の指摘")).toBeInTheDocument();
    expect(screen.getByText("範囲が重なる他の指摘")).toBeInTheDocument();
    // 「同じ箇所」という語は使わない（重なるが一致しない群をそう呼ばないため）。
    expect(screen.queryByText(/同じ箇所/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /同じ範囲/ }));
    expect(onSelectFinding).toHaveBeenCalledWith("finding-same");

    await user.click(screen.getByRole("button", { name: /重なる範囲/ }));
    expect(onSelectFinding).toHaveBeenCalledWith("finding-overlap");
  });

  it("どちらも空なら見出しごと出さない", () => {
    render(<FindingDetail {...baseProps({ sameRange: [], overlapping: [] })} />);

    expect(screen.queryByText("同じ範囲の他の指摘")).not.toBeInTheDocument();
    expect(screen.queryByText("範囲が重なる他の指摘")).not.toBeInTheDocument();
  });
});

describe("FindingDetail: onNavigate（Task 9 が渡すまで操作子を出さない）", () => {
  it("onNavigate が無いとき、移動の操作子を出さない", () => {
    render(<FindingDetail {...baseProps()} />);
    expect(screen.queryByRole("button", { name: /移動/ })).not.toBeInTheDocument();
  });

  it("onNavigate があるとき、操作子を出し、クリックで呼ばれる", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<FindingDetail {...baseProps({ onNavigate })} />);

    const button = screen.getByRole("button", { name: /移動/ });
    await user.click(button);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe("FindingDetail: 採否の操作子（Task 8、決定 13）", () => {
  // 操作子そのもの（4 状態のラジオ・メモの null 送信・保存中の無効化・失敗時の巻き戻し・
  // 常時表示の注記）は judgment-control.test.tsx（R5）の役割。ここでは配線だけを見る：
  // 選択中の指摘の judgment が操作子の初期値になること、保存が finding.id 付きで
  // onSaveJudgment を呼ぶこと。

  it("選択中の指摘の採否・メモが操作子の初期値になる", () => {
    const finding = makeFinding({
      judgment: {
        findingId: "finding-1",
        status: "adopt-planned",
        note: "著者へ確認済み",
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    });
    render(<FindingDetail {...baseProps({ finding })} />);

    expect(screen.getByRole("radio", { name: "採用予定" })).toBeChecked();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("著者へ確認済み");
  });

  it("保存ボタンを押すと、選択中の指摘の ID 付きで onSaveJudgment が呼ばれる", async () => {
    const user = userEvent.setup();
    const onSaveJudgment = vi.fn(() => Promise.resolve());
    const finding = makeFinding({ id: "finding-42" });
    render(<FindingDetail {...baseProps({ finding, onSaveJudgment })} />);

    await user.click(screen.getByRole("radio", { name: "却下" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onSaveJudgment).toHaveBeenCalledWith("finding-42", "rejected", null);
  });

  it("指摘を選び直すと、操作子の入力が新しい指摘の値に切り替わる（前の指摘の入力が残らない）", () => {
    const findingA = makeFinding({
      id: "finding-a",
      judgment: {
        findingId: "finding-a",
        status: "rejected",
        note: "A のメモ",
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    });
    const findingB = makeFinding({
      id: "finding-b",
      judgment: {
        findingId: "finding-b",
        status: "undecided",
        note: null,
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    });
    const { rerender } = render(<FindingDetail {...baseProps({ finding: findingA })} />);
    expect(screen.getByRole("radio", { name: "却下" })).toBeChecked();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("A のメモ");

    rerender(<FindingDetail {...baseProps({ finding: findingB })} />);
    expect(screen.getByRole("radio", { name: "未判断" })).toBeChecked();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });
});
