/**
 * `RunControl`（Task 5、決定 6・7・8）の描画側の検査。
 *
 * ボタンの出し分けそのもの（`controlAvailability`）は `run-control.test.ts` で純関数として
 * 検査済み。ここでは「その判定どおりに DOM が組み立つこと」「`pending` の間はすべてのボタンが
 * `disabled` になること」「`failure` の文言とリンクが出ること」だけを見る（B9・決定 8 の描画側）。
 */

import type { CheckUnitDto, RecoveryDto, RunDto, RunUnitsDto } from "@shuten/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiClientProvider } from "../../api/context.tsx";
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

/** `notImplemented` パターン（`recovery-notice.test.tsx` と同じ流儀）。呼ばれない口は例外にする。 */
function makeApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`${name} は呼ばれない想定`);
  };
  return {
    getConnection: notImplemented("getConnection"),
    putConnection: notImplemented("putConnection"),
    checkConnection: notImplemented("checkConnection"),
    createManuscript: notImplemented("createManuscript"),
    uploadManuscript: notImplemented("uploadManuscript"),
    getManuscript: notImplemented("getManuscript"),
    startRun: notImplemented("startRun"),
    getRun: notImplemented("getRun"),
    getRuns: notImplemented("getRuns"),
    getRunUnits: notImplemented("getRunUnits"),
    stopRun: notImplemented("stopRun"),
    resumeRun: notImplemented("resumeRun"),
    retryFailedUnits: notImplemented("retryFailedUnits"),
    getRecovery: notImplemented("getRecovery"),
    confirmRecovery: notImplemented("confirmRecovery"),
    getFindings: notImplemented("getFindings"),
    getFinding: notImplemented("getFinding"),
    putJudgment: notImplemented("putJudgment"),
    subscribeRunEvents: notImplemented("subscribeRunEvents"),
    ...overrides,
  };
}

function renderControl(props: RunControlProps, client: ApiClient = makeApiClient()) {
  return render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <RunControl {...props} />
      </ApiClientProvider>
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

  it("recovery-waiting・未確認：RecoveryNotice の主・副ボタンが出る。停止・再試行・汎用の再開は出ない（Task 7）", () => {
    renderControl(
      baseProps({
        run: makeRun({ status: "recovery-waiting", recoveryConfirmedAt: null }),
        units: FAILED_UNITS,
      }),
    );
    expect(buttonNames().sort()).toEqual(
      [
        "LM Studio 側で生成が止まったことを確認した → 再開する",
        "確認だけ記録する（この検査は再開しない）",
      ].sort(),
    );
    // 汎用の「再開」ボタンは recovery-waiting では出ない（RecoveryNotice に一本化。Task 7）。
    // 注記（`同じ検査の続きから…`）は最終レビュー Minor 5 で RecoveryNotice の主ボタンにも付いた
    // ため、ボタンの有無でしか判別できない。注記そのものは 1 つだけ出る。
    expect(screen.queryByRole("button", { name: "再開" })).not.toBeInTheDocument();
    expect(
      screen.getAllByText("同じ検査の続きから再開します（実行 ID は変わりません）"),
    ).toHaveLength(1);
  });

  it("recovery-waiting・確認済み：副ボタンは消えるが主ボタンは残る（決定 7、Task 7）", () => {
    renderControl(
      baseProps({
        run: makeRun({
          status: "recovery-waiting",
          recoveryConfirmedAt: "2026-09-10T00:02:00.000Z",
        }),
      }),
    );
    expect(buttonNames()).toEqual(["LM Studio 側で生成が止まったことを確認した → 再開する"]);
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

  it("recovery-waiting の主ボタンを押すと onResume が呼ばれる（onConfirmRecovery は呼ばれない。Task 7）", async () => {
    const onResume = vi.fn();
    const onConfirmRecovery = vi.fn();
    renderControl(
      baseProps({
        run: makeRun({ status: "recovery-waiting", recoveryConfirmedAt: null }),
        onResume,
        onConfirmRecovery,
      }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "LM Studio 側で生成が止まったことを確認した → 再開する",
      }),
    );
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onConfirmRecovery).not.toHaveBeenCalled();
  });

  it("recovery-waiting の副ボタンを押すと onConfirmRecovery が呼ばれる（onResume は呼ばれない。Task 7）", async () => {
    const onResume = vi.fn();
    const onConfirmRecovery = vi.fn();
    renderControl(
      baseProps({
        run: makeRun({ status: "recovery-waiting", recoveryConfirmedAt: null }),
        onResume,
        onConfirmRecovery,
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "確認だけ記録する（この検査は再開しない）" }),
    );
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

describe("RunControl: recovery-blocked の配線（レビュー指摘 I-3）", () => {
  it("stopReason === 'recovery-blocked' のとき RecoveryNotice の案内が出る（RunControl が実際に描くことの検査）", async () => {
    const getRecovery = vi.fn(() =>
      Promise.resolve({ blocked: true, runIds: ["run-1", "run-2"] } satisfies RecoveryDto),
    );
    renderControl(
      baseProps({
        run: makeRun({ id: "run-1", status: "stopped", stopReason: "recovery-blocked" }),
      }),
      makeApiClient({ getRecovery }),
    );

    expect(
      screen.getByText("別の検査の復旧待ちのため停止しています。先にそちらを確認してください。"),
    ).toBeInTheDocument();
    const otherRunLink = await screen.findByRole("link", { name: /run-2/ });
    expect(otherRunLink).toHaveAttribute("href", "/runs/run-2");
    // 表示中の実行（run-1）自身へのリンクは出ない。
    expect(
      screen.queryByRole("link", { name: /^この検査を確認する（run-1）$/ }),
    ).not.toBeInTheDocument();
  });
});
