/**
 * 指摘詳細パネル（`finding-detail.tsx`）の DOM テスト（Task 7、R4）。
 *
 * 純関数（`describeRecheck` / `relatedFindings`）の検査は `finding-detail.test.ts` の役割。
 * ここでは `FindingDetail` コンポーネントを直接描画し、決定 9（`paragraphId` を出さない）、
 * 位置確定時・位置特定失敗時の引用の出し分け、取得中・取得失敗の欄の出し分け、修正案の扱い、
 * 関連する他の指摘のリンク、`onNavigate` の有無での操作子の出し分けを検査する。
 */

import type { CandidateDto, DiagnosticDto, FindingDetailDto, FindingDto } from "@shuten/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FindingDetailProps } from "./finding-detail.tsx";
import { FindingDetail } from "./finding-detail.tsx";

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

    expect(screen.getByText("原文")).toBeInTheDocument();
    expect(screen.getByText(BODY.slice(5, 10))).toBeInTheDocument();
    expect(screen.queryByText("無視されるはずの LLM 引用")).not.toBeInTheDocument();
  });

  it("位置特定失敗時は finding.quote を「LLM の引用（原文との一致未確認）」として出す", () => {
    const finding = makeFinding({
      locateStatus: "not-found",
      range: null,
      quote: "LLM が申告した引用",
    });
    render(<FindingDetail {...baseProps({ finding })} />);

    expect(screen.getByText("LLM の引用（原文との一致未確認）")).toBeInTheDocument();
    expect(screen.getByText("LLM が申告した引用")).toBeInTheDocument();
  });
});

describe("FindingDetail: 取得中・取得失敗の欄の出し分け（元候補・位置診断だけ）", () => {
  it("取得中（detail === null, detailError === null）は「読み込み中…」で、引用・理由は finding から描く", () => {
    render(<FindingDetail {...baseProps({ detail: null, detailError: null })} />);

    expect(screen.getByText("読み込み中…")).toBeInTheDocument();
    // 一覧が持つ情報（finding）だけで引用・理由は既に出ている。
    expect(screen.getByText("これ")).toBeInTheDocument();
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
    expect(screen.getByText("これ")).toBeInTheDocument();
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

describe("FindingDetail: 採否は表示のみ", () => {
  it("現在の採否ラベルを出す（操作子は Task 8）", () => {
    const finding = makeFinding({
      judgment: {
        findingId: "finding-1",
        status: "adopt-planned",
        note: "著者へ確認済み",
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    });
    render(<FindingDetail {...baseProps({ finding })} />);

    expect(screen.getByText("採用予定")).toBeInTheDocument();
    expect(screen.getByText("著者へ確認済み")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});
