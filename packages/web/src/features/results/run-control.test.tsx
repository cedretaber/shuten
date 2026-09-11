/**
 * `RunControl`（Task 5、決定 6・7・8）の描画側の検査。
 *
 * ボタンの出し分けそのもの（`controlAvailability`）は `run-control.test.ts` で純関数として
 * 検査済み。ここでは「その判定どおりに DOM が組み立つこと」「`pending` の間はすべてのボタンが
 * `disabled` になること」「`failure` の文言とリンクが出ること」だけを見る（B9・決定 8 の描画側）。
 */

import type { CheckUnitDto, RunDto, RunUnitsDto } from "@shuten/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ControlFailure } from "./run-control.ts";
import { RunControl, type RunControlProps } from "./run-control.tsx";

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

function makeCheckUnit(overrides: Partial<CheckUnitDto> = {}): CheckUnitDto {
  return {
    id: "check-1",
    targetId: "target-1",
    targetIndex: 0,
    perspective: "typo",
    status: "pending",
    attempts: 0,
    failure: null,
    pendingNote: null,
    elapsedMs: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeUnits(overrides: Partial<RunUnitsDto> = {}): RunUnitsDto {
  return { checkUnits: [], recheckUnits: [], ...overrides };
}

const FAILED_UNITS = makeUnits({
  checkUnits: [
    makeCheckUnit({
      status: "failed",
      failure: { reason: "timeout", message: "", finishReason: null, origin: "chat" },
    }),
  ],
});

function baseProps(overrides: Partial<RunControlProps> = {}): RunControlProps {
  return {
    run: makeRun(),
    units: null,
    onStop: vi.fn(),
    onResume: vi.fn(),
    onRetryFailed: vi.fn(),
    onConfirmRecovery: vi.fn(),
    pending: null,
    failure: null,
    ...overrides,
  };
}

function renderControl(props: RunControlProps) {
  return render(
    <MemoryRouter>
      <RunControl {...props} />
    </MemoryRouter>,
  );
}

function buttonNames() {
  return screen.queryAllByRole("button").map((b) => b.textContent);
}

describe("RunControl: B9 決定 6 の出し分け", () => {
  it("running・停止要求なし：停止ボタンだけが有効で出る", () => {
    renderControl(baseProps({ run: makeRun({ status: "running", stopRequestedAt: null }) }));
    const stop = screen.getByRole("button", { name: "停止" });
    expect(stop).toBeEnabled();
    expect(buttonNames()).toEqual(["停止"]);
  });

  it("running・停止要求あり：停止ボタンは残るが disabled（2 回目以降は押せない）", () => {
    renderControl(
      baseProps({
        run: makeRun({ status: "running", stopRequestedAt: "2026-09-10T00:01:00.000Z" }),
      }),
    );
    const stop = screen.getByRole("button", { name: "停止" });
    expect(stop).toBeDisabled();
  });

  it("recovery-waiting・未確認：再開と復旧確認が出る。停止・再試行は出ない", () => {
    renderControl(
      baseProps({
        run: makeRun({ status: "recovery-waiting", recoveryConfirmedAt: null }),
        units: FAILED_UNITS,
      }),
    );
    expect(buttonNames().sort()).toEqual(["復旧を確認", "再開"].sort());
    // 再開のボタンには決定 8.2 の注記を添える。
    expect(
      screen.getByText("同じ検査の続きから再開します（実行 ID は変わりません）"),
    ).toBeInTheDocument();
  });

  it("recovery-waiting・確認済み：復旧確認は消えるが再開は残る（決定 7）", () => {
    renderControl(
      baseProps({
        run: makeRun({
          status: "recovery-waiting",
          recoveryConfirmedAt: "2026-09-10T00:02:00.000Z",
        }),
      }),
    );
    expect(buttonNames()).toEqual(["再開"]);
  });

  it("stopped（settings）：失敗単位があれば再試行だけが出る（停止・再開は出ない）", () => {
    renderControl(
      baseProps({
        run: makeRun({ status: "stopped", stopReason: "settings" }),
        units: FAILED_UNITS,
      }),
    );
    expect(buttonNames()).toEqual(["失敗単位を再試行"]);
  });

  it("stopped（settings 以外）：再開と再試行の両方が出る", () => {
    renderControl(
      baseProps({
        run: makeRun({ status: "stopped", stopReason: "connection-lost" }),
        units: FAILED_UNITS,
      }),
    );
    expect(buttonNames().sort()).toEqual(["失敗単位を再試行", "再開"].sort());
  });

  it("partially-failed：再試行だけが出る", () => {
    renderControl(baseProps({ run: makeRun({ status: "partially-failed" }), units: FAILED_UNITS }));
    expect(buttonNames()).toEqual(["失敗単位を再試行"]);
  });

  it("completed：ボタンが 1 つも出ない", () => {
    renderControl(baseProps({ run: makeRun({ status: "completed" }), units: FAILED_UNITS }));
    expect(buttonNames()).toEqual([]);
  });
});

describe("RunControl: 決定 8 pending の間は全ボタンを disabled にする", () => {
  it("recovery-waiting で pending が 'stop' でも、再開・復旧確認の両方が disabled になる", () => {
    renderControl(
      baseProps({
        run: makeRun({ status: "recovery-waiting", recoveryConfirmedAt: null }),
        pending: "stop",
      }),
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });
});

describe("RunControl: クリックでハンドラーを呼ぶ", () => {
  it("停止ボタンを押すと onStop が呼ばれる", async () => {
    const onStop = vi.fn();
    renderControl(baseProps({ onStop }));
    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("再試行ボタンを押すと onRetryFailed が呼ばれる", async () => {
    const onRetryFailed = vi.fn();
    renderControl(
      baseProps({
        run: makeRun({ status: "partially-failed" }),
        units: FAILED_UNITS,
        onRetryFailed,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "失敗単位を再試行" }));
    expect(onRetryFailed).toHaveBeenCalledTimes(1);
  });

  it("再開ボタンを押すと onResume が呼ばれる（onConfirmRecovery は呼ばれない）", async () => {
    const onResume = vi.fn();
    const onConfirmRecovery = vi.fn();
    renderControl(
      baseProps({
        run: makeRun({ status: "recovery-waiting", recoveryConfirmedAt: null }),
        onResume,
        onConfirmRecovery,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "再開" }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onConfirmRecovery).not.toHaveBeenCalled();
  });

  it("復旧を確認ボタンを押すと onConfirmRecovery が呼ばれる（onResume は呼ばれない）", async () => {
    const onResume = vi.fn();
    const onConfirmRecovery = vi.fn();
    renderControl(
      baseProps({
        run: makeRun({ status: "recovery-waiting", recoveryConfirmedAt: null }),
        onResume,
        onConfirmRecovery,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "復旧を確認" }));
    expect(onConfirmRecovery).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });
});

describe("RunControl: 決定 8 操作の失敗の案内", () => {
  const FAILURE_WITH_LINKS: ControlFailure = {
    message:
      "接続先が検査開始時と異なるため再開・再試行できません。接続設定を戻すか、新しい検査を開始してください。",
    links: ["settings", "home"],
  };

  it("failure の定型文とリンクが出る", () => {
    renderControl(baseProps({ failure: FAILURE_WITH_LINKS }));
    expect(screen.getByText(FAILURE_WITH_LINKS.message)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "接続設定を確認する" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "新しい検査を開始する" })).toBeInTheDocument();
  });

  it("links が空なら案内文だけでリンクは出ない", () => {
    renderControl(baseProps({ failure: { message: "すでに実行中です。", links: [] } }));
    expect(screen.getByText("すでに実行中です。")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("failure が無く、ボタンも無ければ何も描かない（completed かつ failure なし）", () => {
    const { container } = renderControl(
      baseProps({ run: makeRun({ status: "completed" }), failure: null }),
    );
    expect(container.firstChild).toBeNull();
  });
});
