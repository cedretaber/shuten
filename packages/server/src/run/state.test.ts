import { describe, expect, it } from "vitest";

import type { RunStop, StopReason, UnitFailure } from "./result.ts";
import { canTransitionRun, canTransitionUnit, runStatusForStop } from "./state.ts";
import { RUN_STATUSES, type RunStatus, UNIT_STATUSES, type UnitStatus } from "./status.ts";

/**
 * 決定 3 の「実行（RunStatus）」表そのもの。「（新規）→ running」は生成時の初期値で
 * 遷移ではないため含めない。`stopped` → `running`（再開／失敗単位の個別再試行）は表に 2 行
 * あるが同じペアなので 1 つにまとめてある。
 */
const RUN_TABLE: ReadonlyArray<readonly [RunStatus, RunStatus]> = [
  ["running", "completed"],
  ["running", "partially-failed"],
  ["running", "stopped"],
  ["running", "recovery-waiting"],
  ["stopped", "running"],
  ["recovery-waiting", "running"],
  ["partially-failed", "running"],
];

/**
 * 決定 3 の「単位（UnitStatus）」表そのもの。`done` は終端。`not-applicable` も原則終端だが、
 * 抑制が外れた再確認単位を戻す 1 本（`not-applicable` → `pending`）だけがある（決定 45-4）。
 */
const UNIT_TABLE: ReadonlyArray<readonly [UnitStatus, UnitStatus]> = [
  ["pending", "running"],
  ["pending", "not-applicable"],
  ["running", "done"],
  ["running", "failed"],
  ["running", "pending"],
  ["failed", "pending"],
  ["not-applicable", "pending"],
];

function tableHas<T extends string>(
  table: ReadonlyArray<readonly [T, T]>,
  from: T,
  to: T,
): boolean {
  return table.some(([f, t]) => f === from && t === to);
}

describe("canTransitionRun", () => {
  it("S1/S2: 決定 3 の表にある遷移がすべて true、表にない遷移がすべて false（全組み合わせ網羅）", () => {
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        const expected = tableHas(RUN_TABLE, from, to);
        expect(
          canTransitionRun(from, to),
          `canTransitionRun(${from}, ${to}) は ${expected} であるべき`,
        ).toBe(expected);
      }
    }
  });

  it("S2: stopped → completed（停止後に遅れて届いた完了報告）は false", () => {
    expect(canTransitionRun("stopped", "completed")).toBe(false);
  });

  it("S2: completed → running（失敗単位がないので再試行対象がない）は false", () => {
    expect(canTransitionRun("completed", "running")).toBe(false);
  });
});

describe("canTransitionUnit", () => {
  it("S1/S2: 決定 3 の表にある遷移がすべて true、表にない遷移がすべて false（全組み合わせ網羅）", () => {
    for (const from of UNIT_STATUSES) {
      for (const to of UNIT_STATUSES) {
        const expected = tableHas(UNIT_TABLE, from, to);
        expect(
          canTransitionUnit(from, to),
          `canTransitionUnit(${from}, ${to}) は ${expected} であるべき`,
        ).toBe(expected);
      }
    }
  });

  it("S2: done からの遷移はすべて false（終端。再試行でも戻さない）", () => {
    for (const to of UNIT_STATUSES) {
      expect(canTransitionUnit("done", to)).toBe(false);
    }
  });

  it("S2: not-applicable から戻せるのは pending だけ（抑制の解除。決定 45-4）", () => {
    expect(canTransitionUnit("not-applicable", "pending")).toBe(true);
    for (const to of UNIT_STATUSES) {
      if (to === "pending") {
        continue;
      }
      expect(canTransitionUnit("not-applicable", to)).toBe(false);
    }
  });
});

function makeStop(
  reason: StopReason,
  generationUnconfirmed: boolean,
  failure: UnitFailure | null = null,
): RunStop {
  return { reason, message: "test", failure, generationUnconfirmed };
}

describe("runStatusForStop", () => {
  // 決定 23 の写像表 10 行。
  const TABLE: ReadonlyArray<{
    readonly label: string;
    readonly stop: RunStop;
    readonly expected: "stopped" | "recovery-waiting";
  }> = [
    {
      label: "settings：分割設定・入力上限・モデル種別",
      stop: makeStop("settings", false),
      expected: "stopped",
    },
    {
      label: "model-not-loaded：ensureLoaded / 生成中のアンロード",
      stop: makeStop("model-not-loaded", false),
      expected: "stopped",
    },
    {
      label: "connection-lost：HTTP 応答あり（4xx・5xx）",
      stop: makeStop("connection-lost", false),
      expected: "stopped",
    },
    {
      label: "connection-lost：応答を受け取れずに切断（status が null）",
      stop: makeStop("connection-lost", true),
      expected: "recovery-waiting",
    },
    {
      label: "connection-lost：ensureLoaded の失敗（生成は送っていない）",
      stop: makeStop("connection-lost", false),
      expected: "stopped",
    },
    {
      label: "recovery-needed：生成のハード上限超過",
      stop: makeStop("recovery-needed", true),
      expected: "recovery-waiting",
    },
    {
      label: "aborted：停止操作で上限内に応答が届いた",
      stop: makeStop("aborted", false),
      expected: "stopped",
    },
    {
      label: "aborted：停止操作で上限を超えた",
      stop: makeStop("aborted", true),
      expected: "recovery-waiting",
    },
    {
      label: "internal-error：想定外の例外",
      stop: makeStop("internal-error", false),
      expected: "stopped",
    },
    {
      label: "internal-error：復旧ゲートが閉じている実行の想定外の例外",
      stop: makeStop("internal-error", true),
      expected: "recovery-waiting",
    },
    {
      label: "recovery-blocked：別の実行が復旧待ちのため送信ゲートに止められた",
      stop: makeStop("recovery-blocked", false),
      expected: "stopped",
    },
  ];

  it.each(TABLE.map((row) => [row.label, row.stop, row.expected] as const))(
    "S6: %s → %s",
    (_label, stop, expected) => {
      expect(runStatusForStop(stop)).toBe(expected);
    },
  );

  it("S6: 表が 11 行である（決定 23 の全行を網羅していることの保証）", () => {
    expect(TABLE).toHaveLength(11);
  });

  it("S6: connection-lost かつ generationUnconfirmed: true は stopped ではなく recovery-waiting（生成が LM Studio 側で走り続けている可能性があるため）", () => {
    const stop = makeStop("connection-lost", true);
    expect(runStatusForStop(stop)).not.toBe("stopped");
    expect(runStatusForStop(stop)).toBe("recovery-waiting");
  });
});
