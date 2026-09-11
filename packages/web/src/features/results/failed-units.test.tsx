/**
 * 失敗単位の一覧と個別再試行（Task 6、決定 6・12。仕様書 8.2「失敗した処理を個別に再試行できる」）。
 *
 * ここでは `FailedUnits` 単体の描画・出し分けだけを見る。「この単位を再試行」が `results-page.tsx` の
 * `runControlAction` に正しく配線されること（`retryFailedUnits` の呼ばれ方）は
 * `results-page.test.tsx` 側で見る。
 *
 * Task 7（レビュー指摘）：「すべて再試行」はヘッダーの操作列（`RunControl`）と重複していたため、
 * この一覧からは削除した（`onRetryAll` プロパティごと削除）。ヘッダー側の検査は
 * `run-control.test.tsx`・`results-page.test.tsx` の役割。
 */

import type { CheckUnitDto, RecheckUnitDto, RunDto, RunUnitsDto } from "@shuten/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FailedUnits } from "./failed-units.tsx";

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
    status: "partially-failed",
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
    status: "failed",
    attempts: 1,
    failure: { reason: "timeout", message: "", finishReason: null, origin: "chat" },
    pendingNote: null,
    elapsedMs: 1234,
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: "2026-09-10T00:00:01.000Z",
    ...overrides,
  };
}

function makeRecheckUnit(overrides: Partial<RecheckUnitDto> = {}): RecheckUnitDto {
  return {
    id: "recheck-1",
    findingId: "finding-1",
    inputRange: null,
    status: "failed",
    notApplicableReason: null,
    attempts: 1,
    failure: { reason: "timeout", message: "", finishReason: null, origin: "chat" },
    pendingNote: null,
    verdict: null,
    reasonKind: null,
    reason: null,
    suggestionValid: null,
    elapsedMs: 500,
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: "2026-09-10T00:00:01.000Z",
    ...overrides,
  };
}

function makeUnits(overrides: Partial<RunUnitsDto> = {}): RunUnitsDto {
  return { checkUnits: [], recheckUnits: [], ...overrides };
}

describe("FailedUnits: 出す条件（run.status）", () => {
  it("status が running のときは何も出ない", () => {
    const run = makeRun({ status: "running" });
    const units = makeUnits({ checkUnits: [makeCheckUnit()] });
    const { container } = render(
      <FailedUnits run={run} units={units} onRetryUnit={vi.fn()} pending={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("status が completed のときは、units に failed が残っていても何も出ない", () => {
    const run = makeRun({ status: "completed" });
    const units = makeUnits({ checkUnits: [makeCheckUnit()] });
    const { container } = render(
      <FailedUnits run={run} units={units} onRetryUnit={vi.fn()} pending={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("status が partially-failed かつ失敗単位が無いときは何も出ない", () => {
    const run = makeRun({ status: "partially-failed" });
    const units = makeUnits();
    const { container } = render(
      <FailedUnits run={run} units={units} onRetryUnit={vi.fn()} pending={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("status が partially-failed かつ失敗した検査単位があれば一覧が出る", () => {
    const run = makeRun({ status: "partially-failed" });
    const units = makeUnits({ checkUnits: [makeCheckUnit()] });
    render(<FailedUnits run={run} units={units} onRetryUnit={vi.fn()} pending={null} />);
    expect(screen.getByText(/範囲 1/)).toBeInTheDocument();
  });

  it("status が stopped かつ失敗した検査単位があれば一覧が出る", () => {
    const run = makeRun({ status: "stopped", stopReason: "aborted" });
    const units = makeUnits({ checkUnits: [makeCheckUnit()] });
    render(<FailedUnits run={run} units={units} onRetryUnit={vi.fn()} pending={null} />);
    expect(screen.getByText(/範囲 1/)).toBeInTheDocument();
  });
});

describe("FailedUnits: input-too-long の非対称（決定 6・36）", () => {
  it("input-too-long の検査単位にはボタンが無く、案内文が出る", () => {
    const run = makeRun();
    const units = makeUnits({
      checkUnits: [
        makeCheckUnit({
          failure: { reason: "input-too-long", message: "", finishReason: null, origin: "local" },
        }),
      ],
    });
    render(<FailedUnits run={run} units={units} onRetryUnit={vi.fn()} pending={null} />);
    expect(
      screen.getByText(
        "入力が長すぎるため再試行できません（分割長を見直して新しい検査を開始してください）",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "この単位を再試行" })).not.toBeInTheDocument();
  });

  it("input-too-long の再確認単位にはボタンがある（検査単位との非対称）", () => {
    const run = makeRun();
    // 同じ input-too-long でも、検査単位はボタンが無く（案内文のみ）、再確認単位はボタンが出る、
    // という非対称そのものを 1 つの描画で確かめる（検査単位側だけボタンを出す実装に戻したら
    // ボタンが 2 件になって赤くなる）。
    const units = makeUnits({
      checkUnits: [
        makeCheckUnit({
          id: "check-1",
          failure: { reason: "input-too-long", message: "", finishReason: null, origin: "local" },
        }),
      ],
      recheckUnits: [
        makeRecheckUnit({
          id: "recheck-1",
          failure: { reason: "input-too-long", message: "", finishReason: null, origin: "local" },
        }),
      ],
    });
    render(<FailedUnits run={run} units={units} onRetryUnit={vi.fn()} pending={null} />);
    expect(screen.getAllByRole("button", { name: "この単位を再試行" })).toHaveLength(1);
    expect(
      screen.getByText(
        "入力が長すぎるため再試行できません（分割長を見直して新しい検査を開始してください）",
      ),
    ).toBeInTheDocument();
  });
});

describe("FailedUnits: 個別の再試行", () => {
  it("『この単位を再試行』を押すと onRetryUnit がその単位の id 1 件だけで呼ばれる", async () => {
    const user = userEvent.setup();
    const run = makeRun();
    const units = makeUnits({
      checkUnits: [makeCheckUnit({ id: "check-1" }), makeCheckUnit({ id: "check-2" })],
    });
    const onRetryUnit = vi.fn();
    render(<FailedUnits run={run} units={units} onRetryUnit={onRetryUnit} pending={null} />);

    const buttons = screen.getAllByRole("button", { name: "この単位を再試行" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0] as HTMLElement);

    expect(onRetryUnit).toHaveBeenCalledTimes(1);
    expect(onRetryUnit).toHaveBeenCalledWith("check-1");
  });
});

describe("FailedUnits: pending の間はすべての再試行ボタンが disabled（決定 8 と同じ扱い）", () => {
  it("pending が 'stop'（再試行以外の操作）でも再試行ボタンは disabled になる", () => {
    const run = makeRun();
    const units = makeUnits({ checkUnits: [makeCheckUnit()] });
    render(<FailedUnits run={run} units={units} onRetryUnit={vi.fn()} pending="stop" />);
    expect(screen.getByRole("button", { name: "この単位を再試行" })).toBeDisabled();
  });

  it("pending が null なら再試行ボタンは押せる", () => {
    const run = makeRun();
    const units = makeUnits({ checkUnits: [makeCheckUnit()] });
    render(<FailedUnits run={run} units={units} onRetryUnit={vi.fn()} pending={null} />);
    expect(screen.getByRole("button", { name: "この単位を再試行" })).toBeEnabled();
  });
});

describe("FailedUnits: 再確認単位の表示（指摘 → 再確認と分かる表示、指摘の本文は出さない）", () => {
  it("再確認単位は findingId から指摘の再確認だと分かる表示になる", () => {
    const run = makeRun();
    const units = makeUnits({ recheckUnits: [makeRecheckUnit({ findingId: "finding-xyz" })] });
    render(<FailedUnits run={run} units={units} onRetryUnit={vi.fn()} pending={null} />);
    expect(screen.getByText(/再確認/)).toBeInTheDocument();
    expect(screen.getByText(/finding-xyz/)).toBeInTheDocument();
  });
});

describe("FailedUnits: 漏えい検査（決定 12）", () => {
  const MESSAGE_SENTINEL = "leak-sentinel-message-http://leak.invalid";
  const FINISH_REASON_SENTINEL = "leak-sentinel-finish-reason";
  const PENDING_NOTE_SENTINEL = "leak-sentinel-pending-note";
  const RECHECK_REASON_SENTINEL = "leak-sentinel-recheck-reason";

  it("failure.message / finishReason / pendingNote / RecheckUnitDto.reason を番兵で埋めても画面に出ない", () => {
    const run = makeRun();
    const units = makeUnits({
      checkUnits: [
        makeCheckUnit({
          id: "check-1",
          failure: {
            reason: "timeout",
            message: MESSAGE_SENTINEL,
            finishReason: FINISH_REASON_SENTINEL,
            origin: "chat",
          },
          pendingNote: PENDING_NOTE_SENTINEL,
        }),
      ],
      recheckUnits: [
        makeRecheckUnit({
          id: "recheck-1",
          pendingNote: PENDING_NOTE_SENTINEL,
          reason: RECHECK_REASON_SENTINEL,
        }),
      ],
    });
    const { container } = render(
      <FailedUnits run={run} units={units} onRetryUnit={vi.fn()} pending={null} />,
    );

    const text = container.textContent ?? "";
    expect(text).not.toContain(MESSAGE_SENTINEL);
    expect(text).not.toContain(FINISH_REASON_SENTINEL);
    expect(text).not.toContain(PENDING_NOTE_SENTINEL);
    expect(text).not.toContain(RECHECK_REASON_SENTINEL);

    // 空振り防止：許可された項目（決定 12。`failure.reason`・`failure.origin`）は実際に
    // 描画されている。「生成」単独では他の文言に紛れて空振りしうるため、`FailureMeta` が
    // 出す並びそのものを見る。
    expect(text).toContain("タイムアウト / 生成");
  });
});
