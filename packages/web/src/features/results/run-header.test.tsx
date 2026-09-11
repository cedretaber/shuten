/**
 * `RunHeader`（Task 5）の「画面ごとの仕様」1〜8 の組み込みを検査する。
 *
 * `RunProgress`・`RunControl` それぞれの中身（進捗の集計・ボタンの出し分け）はすでに
 * `run-progress.test.tsx`・`run-control.test.tsx` が単体で検査済み。ここでは
 * - `isSettingsStop(run)` が真のとき 3〜5（中間状態の案内・進捗）を出さないこと（決定 14）、
 * - 決定 9 の中間状態の案内（`statusNotice`）が出る／消えること（B12 の残り。遅延通知は
 *   `RunProgress` 側の担当で `run-progress.test.tsx` が検査済み）、
 * - `units`・`pending`・`failure` が `RunControl` へそのまま渡ること、
 * だけを見る。
 */

import type { ProgressDto, RunDto, RunUnitsDto, UnitStatusCounts } from "@shuten/shared";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { RunHeader, type RunHeaderProps } from "./run-header.tsx";

function makeRun(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: "run-1",
    manuscriptVersionId: "manuscript-1",
    modelId: "model-a",
    modelInfo: null,
    generationSettings: { maxTokens: 512, temperature: 0 },
    chunkSettings: {
      targetGraphemes: 1500,
      contextGraphemes: 200,
      recheckContextGraphemes: 200,
      roundingTolerance: 0.1,
      maxInputGraphemes: 12000,
    },
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: false,
    allowedWords: [],
    allowedWordRuleVersion: "1",
    promptVersion: "1",
    diagnosticTransformVersion: "1",
    status: "running",
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    stopRequestedAt: null,
    recoveryConfirmedAt: null,
    recoveryConfirmMs: 60_000,
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function makeCounts(overrides: Partial<UnitStatusCounts> = {}): UnitStatusCounts {
  return { pending: 0, running: 0, done: 0, failed: 0, "not-applicable": 0, ...overrides };
}

function makeProgress(overrides: Partial<ProgressDto> = {}): ProgressDto {
  return { checkUnits: makeCounts(), recheckUnits: makeCounts(), ...overrides };
}

function makeUnits(overrides: Partial<RunUnitsDto> = {}): RunUnitsDto {
  return { checkUnits: [], recheckUnits: [], ...overrides };
}

function baseProps(overrides: Partial<RunHeaderProps> = {}): RunHeaderProps {
  return {
    run: makeRun(),
    manuscriptName: "原稿A",
    progress: makeProgress(),
    units: makeUnits(),
    slowUnitCount: 0,
    onRefresh: vi.fn(),
    refreshing: false,
    onStop: vi.fn(),
    onResume: vi.fn(),
    onRetryFailed: vi.fn(),
    onConfirmRecovery: vi.fn(),
    pending: null,
    failure: null,
    ...overrides,
  };
}

function renderHeader(props: RunHeaderProps) {
  return render(
    <MemoryRouter>
      <RunHeader {...props} />
    </MemoryRouter>,
  );
}

describe("RunHeader: 決定 9 の中間状態の案内", () => {
  it("running・停止要求なしは案内が出ない", () => {
    renderHeader(baseProps({ run: makeRun({ status: "running", stopRequestedAt: null }) }));
    expect(screen.queryByText(/停止を要求しました/)).not.toBeInTheDocument();
  });

  it("running・停止要求ありは案内が出る（停止ボタンが disabled になる理由）", () => {
    renderHeader(
      baseProps({
        run: makeRun({ status: "running", stopRequestedAt: "2026-09-10T00:01:00.000Z" }),
      }),
    );
    expect(
      screen.getByText("停止を要求しました。実行中の要求の終了を待っています。"),
    ).toBeInTheDocument();
  });

  it("recovery-waiting は仕様 8.2 の文をそのまま出す", () => {
    renderHeader(baseProps({ run: makeRun({ status: "recovery-waiting" }) }));
    expect(
      screen.getByText("生成の停止を確認できません。LM Studio側を確認して再開してください"),
    ).toBeInTheDocument();
  });

  it("recovery-waiting・generationUnconfirmed 真（実運用で必ず起きる組み合わせ）でも仕様 8.2 の文が出て、二重表示にならない（レビュー指摘 I-1）", () => {
    // `packages/server/src/run/state.ts` の不変条件：`recovery-waiting` は必ず
    // `generationUnconfirmed === true` を伴って書かれる。旧実装（`generationUnconfirmed` を
    // `recovery-waiting` より先に判定）だと、この実運用で必ず起きる組み合わせのときに
    // 仕様 8.2 の定型文が一度も出ないという誤りがあった。
    renderHeader(
      baseProps({
        run: makeRun({ status: "recovery-waiting", generationUnconfirmed: true }),
      }),
    );
    expect(
      screen.getByText("生成の停止を確認できません。LM Studio側を確認して再開してください"),
    ).toBeInTheDocument();
    // `statusNotice` 側の「生成が終了したか確認できていません」は出ない（二重表示にならない）。
    expect(
      screen.queryByText("LM Studio 側の生成が終了したか確認できていません。"),
    ).not.toBeInTheDocument();
  });

  it("completed は案内が出ない", () => {
    renderHeader(baseProps({ run: makeRun({ status: "completed" }) }));
    expect(screen.queryByText(/一部の検査が失敗/)).not.toBeInTheDocument();
    expect(screen.queryByText(/停止中です/)).not.toBeInTheDocument();
  });
});

describe("RunHeader: 決定 14 isSettingsStop は 3〜5 を出さない", () => {
  it("進捗（完了 n / 全 m 件）が出ない", () => {
    renderHeader(
      baseProps({
        run: makeRun({ status: "stopped", stopReason: "settings" }),
        progress: makeProgress({ checkUnits: makeCounts({ done: 1, pending: 1 }) }),
      }),
    );
    expect(screen.queryByText(/完了 1 \/ 全 2 件/)).not.toBeInTheDocument();
  });

  it("『検査は開始できませんでした』と設定へ戻るリンクだけを出す", () => {
    renderHeader(baseProps({ run: makeRun({ status: "stopped", stopReason: "settings" }) }));
    expect(screen.getByText("検査は開始できませんでした")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "検査設定に戻る" })).toBeInTheDocument();
  });

  it("中間状態の案内（statusNotice）も出ない（レビュー指摘 M-4）", () => {
    // `stopped` かつ `stopReason === "settings"`（isSettingsStop）は、通常の状態表示・進捗だけで
    // なく決定 9 の中間状態の案内も出さない（PR12a 決定 16 のとおり、開始できなかった検査に
    // 「未処理の範囲が残っている可能性があります」等の案内は意味を持たないため）。
    renderHeader(baseProps({ run: makeRun({ status: "stopped", stopReason: "settings" }) }));
    expect(screen.queryByText(/停止中です/)).not.toBeInTheDocument();
    expect(screen.queryByText(/一部の検査が失敗/)).not.toBeInTheDocument();
    expect(screen.queryByText(/停止を要求しました/)).not.toBeInTheDocument();
  });

  it("失敗単位の再試行は controlAvailability の判断に従って出る", () => {
    const units = makeUnits({
      checkUnits: [
        {
          id: "c1",
          targetId: "t1",
          targetIndex: 0,
          perspective: "typo",
          status: "failed",
          attempts: 1,
          failure: { reason: "timeout", message: "", finishReason: null, origin: "chat" },
          pendingNote: null,
          elapsedMs: null,
          startedAt: null,
          finishedAt: null,
        },
      ],
    });
    renderHeader(baseProps({ run: makeRun({ status: "stopped", stopReason: "settings" }), units }));
    expect(screen.getByRole("button", { name: "失敗単位を再試行" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "再開" })).not.toBeInTheDocument();
  });
});

describe("RunHeader: RunControl への配線", () => {
  it("pending の間はボタンが disabled になる", () => {
    renderHeader(baseProps({ run: makeRun({ status: "running" }), pending: "stop" }));
    expect(screen.getByRole("button", { name: "停止" })).toBeDisabled();
  });

  it("failure の文言が出る", () => {
    renderHeader(
      baseProps({
        failure: { message: "すでに実行中です。最新の状態を取得しました。", links: [] },
      }),
    );
    expect(screen.getByText("すでに実行中です。最新の状態を取得しました。")).toBeInTheDocument();
  });
});
