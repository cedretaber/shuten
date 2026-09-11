import type { ProgressDto, RunUnitsDto, UnitStatusCounts } from "@shuten/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunProgress } from "./run-progress.tsx";

/**
 * 進捗の描画（Task 3、決定 5・10・11。仕様書 9 節）の DOM 検査。
 * 純関数（`tallyOf` など）の検査は `run-progress.test.ts` にある。
 */

function makeCounts(overrides: Partial<UnitStatusCounts> = {}): UnitStatusCounts {
  return {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    "not-applicable": 0,
    ...overrides,
  };
}

function makeProgress(overrides: Partial<ProgressDto> = {}): ProgressDto {
  return {
    checkUnits: makeCounts(),
    recheckUnits: makeCounts(),
    ...overrides,
  };
}

describe("RunProgress: 件数の表示", () => {
  it("検査の完了 n / 全 m 件が出る", () => {
    const progress = makeProgress({
      checkUnits: makeCounts({ done: 3, running: 1, pending: 6 }),
    });
    render(
      <RunProgress progress={progress} units={null} recheckEnabled={true} slowUnitCount={0} />,
    );
    expect(screen.getByText(/完了 3 \/ 全 10 件/)).toBeInTheDocument();
  });

  it("total === 0 は「準備中」と出す（0 / 0 を完了に見せない）", () => {
    const progress = makeProgress();
    render(
      <RunProgress progress={progress} units={null} recheckEnabled={true} slowUnitCount={0} />,
    );
    expect(screen.getAllByText(/準備中/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/0 \/ 0/)).not.toBeInTheDocument();
  });

  it("not-applicable は分母に含めたうえで内訳として別に出す（決定 11）", () => {
    const progress = makeProgress({
      checkUnits: makeCounts({ done: 2, "not-applicable": 3 }),
    });
    render(
      <RunProgress progress={progress} units={null} recheckEnabled={true} slowUnitCount={0} />,
    );
    // 分母（m）は 5 件（done 2 + not-applicable 3）
    expect(screen.getByText(/完了 2 \/ 全 5 件/)).toBeInTheDocument();
    expect(screen.getByText(/対象外 3 件/)).toBeInTheDocument();
  });
});

describe("RunProgress: 再確認の有無", () => {
  it("recheckEnabled === false のとき「再確認なし」とだけ出る", () => {
    const progress = makeProgress({
      recheckUnits: makeCounts({ done: 5 }),
    });
    render(
      <RunProgress progress={progress} units={null} recheckEnabled={false} slowUnitCount={0} />,
    );
    expect(screen.getByText("再確認なし")).toBeInTheDocument();
    // 無効なら再確認単位の件数（5 件）は出さない
    expect(screen.queryByText(/完了 5/)).not.toBeInTheDocument();
  });

  it("recheckEnabled === true なら再確認の件数が出る", () => {
    const progress = makeProgress({
      recheckUnits: makeCounts({ done: 2, pending: 1 }),
    });
    render(
      <RunProgress progress={progress} units={null} recheckEnabled={true} slowUnitCount={0} />,
    );
    expect(screen.getByText(/完了 2 \/ 全 3 件/)).toBeInTheDocument();
    expect(screen.queryByText("再確認なし")).not.toBeInTheDocument();
  });
});

describe("RunProgress: 観点別の内訳", () => {
  it("units から観点別の件数が出る（決定 5）", () => {
    const progress = makeProgress();
    const units: RunUnitsDto = {
      checkUnits: [
        {
          id: "c1",
          targetId: "target-1",
          targetIndex: 0,
          perspective: "typo",
          status: "done",
          attempts: 1,
          failure: null,
          pendingNote: null,
          elapsedMs: 100,
          startedAt: "2026-09-10T00:00:00.000Z",
          finishedAt: "2026-09-10T00:00:01.000Z",
        },
        {
          id: "c2",
          targetId: "target-1",
          targetIndex: 0,
          perspective: "naturalness",
          status: "running",
          attempts: 1,
          failure: null,
          pendingNote: null,
          elapsedMs: null,
          startedAt: "2026-09-10T00:00:00.000Z",
          finishedAt: null,
        },
      ],
      recheckUnits: [],
    };
    render(
      <RunProgress progress={progress} units={units} recheckEnabled={true} slowUnitCount={0} />,
    );
    expect(screen.getByText(/誤字・脱字: 完了 1 \/ 全 1 件/)).toBeInTheDocument();
    expect(screen.getByText(/日本語の自然さ: 完了 0 \/ 全 1 件/)).toBeInTheDocument();
  });

  it("units が null のときは観点別の内訳を出さない", () => {
    const progress = makeProgress();
    render(
      <RunProgress progress={progress} units={null} recheckEnabled={true} slowUnitCount={0} />,
    );
    expect(screen.queryByText(/誤字・脱字/)).not.toBeInTheDocument();
    expect(screen.queryByText(/日本語の自然さ/)).not.toBeInTheDocument();
  });
});

describe("RunProgress: 遅延通知（決定 10）", () => {
  it("slowUnitCount が 0 より大きいとき通知が出る", () => {
    const progress = makeProgress();
    render(
      <RunProgress progress={progress} units={null} recheckEnabled={true} slowUnitCount={2} />,
    );
    expect(
      screen.getByText("生成が遅延しています（2 件）。応答を待っています。"),
    ).toBeInTheDocument();
  });

  it("slowUnitCount が 0 のときは通知が出ない", () => {
    const progress = makeProgress();
    render(
      <RunProgress progress={progress} units={null} recheckEnabled={true} slowUnitCount={0} />,
    );
    expect(screen.queryByText(/生成が遅延しています/)).not.toBeInTheDocument();
  });
});

describe("RunProgress: 仕様 9 節の担保（割合・残り時間・<progress> を出さない）", () => {
  it("%（割合）を示す文字がどこにも出ない", () => {
    const progress = makeProgress({
      checkUnits: makeCounts({ done: 3, pending: 7 }),
      recheckUnits: makeCounts({ done: 1, pending: 1 }),
    });
    const units: RunUnitsDto = {
      checkUnits: [
        {
          id: "c1",
          targetId: "target-1",
          targetIndex: 0,
          perspective: "typo",
          status: "done",
          attempts: 1,
          failure: null,
          pendingNote: null,
          elapsedMs: 100,
          startedAt: "2026-09-10T00:00:00.000Z",
          finishedAt: "2026-09-10T00:00:01.000Z",
        },
      ],
      recheckUnits: [],
    };
    const { container } = render(
      <RunProgress progress={progress} units={units} recheckEnabled={true} slowUnitCount={3} />,
    );
    expect(container.textContent).not.toContain("%");
  });

  it("「残り」という語がどこにも出ない", () => {
    const progress = makeProgress({
      checkUnits: makeCounts({ done: 3, pending: 7 }),
      recheckUnits: makeCounts({ done: 1, pending: 1 }),
    });
    const { container } = render(
      <RunProgress progress={progress} units={null} recheckEnabled={true} slowUnitCount={3} />,
    );
    expect(container.textContent).not.toContain("残り");
  });

  it("<progress> 要素を使わない", () => {
    const progress = makeProgress({
      checkUnits: makeCounts({ done: 3, pending: 7 }),
    });
    const { container } = render(
      <RunProgress progress={progress} units={null} recheckEnabled={true} slowUnitCount={0} />,
    );
    expect(container.querySelector("progress")).toBeNull();
  });
});
