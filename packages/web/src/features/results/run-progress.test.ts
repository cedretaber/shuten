import type { CheckUnitDto, RecheckUnitDto, RunUnitsDto, UnitStatusCounts } from "@shuten/shared";
import { describe, expect, it } from "vitest";
import { perspectiveTallies, pruneSlowUnitIds, tallyOf } from "./run-progress.ts";

/**
 * 進捗の集計（Task 3、決定 5・10・11）の純関数の検査。DOM は `run-progress.test.tsx` の役割。
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

function makeRecheckUnit(overrides: Partial<RecheckUnitDto> = {}): RecheckUnitDto {
  return {
    id: "recheck-1",
    findingId: "finding-1",
    inputRange: null,
    status: "pending",
    notApplicableReason: null,
    attempts: 0,
    failure: null,
    pendingNote: null,
    verdict: null,
    reasonKind: null,
    reason: null,
    suggestionValid: null,
    elapsedMs: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe("tallyOf", () => {
  it("5 状態の和を total にする（決定 11）", () => {
    const counts = makeCounts({ pending: 1, running: 2, done: 3, failed: 4, "not-applicable": 5 });
    expect(tallyOf(counts)).toEqual({
      total: 15,
      pending: 1,
      running: 2,
      done: 3,
      failed: 4,
      notApplicable: 5,
    });
  });

  it("すべて 0 なら total も 0", () => {
    expect(tallyOf(makeCounts())).toEqual({
      total: 0,
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      notApplicable: 0,
    });
  });
});

describe("perspectiveTallies", () => {
  it("units が null なら空配列", () => {
    expect(perspectiveTallies(null)).toEqual([]);
  });

  it("checkUnits を perspective で分けて状態別に数える", () => {
    const units: RunUnitsDto = {
      checkUnits: [
        makeCheckUnit({ id: "c1", perspective: "typo", status: "done" }),
        makeCheckUnit({ id: "c2", perspective: "typo", status: "failed" }),
        makeCheckUnit({ id: "c3", perspective: "naturalness", status: "running" }),
      ],
      recheckUnits: [],
    };
    expect(perspectiveTallies(units)).toEqual([
      {
        perspective: "typo",
        tally: { total: 2, done: 1, failed: 1, running: 0, pending: 0, notApplicable: 0 },
      },
      {
        perspective: "naturalness",
        tally: { total: 1, done: 0, failed: 0, running: 1, pending: 0, notApplicable: 0 },
      },
    ]);
  });

  it("並びは PERSPECTIVE_ORDER（typo → naturalness）。checkUnits の登場順に関わらない", () => {
    const units: RunUnitsDto = {
      checkUnits: [
        makeCheckUnit({ id: "c1", perspective: "naturalness", status: "done" }),
        makeCheckUnit({ id: "c2", perspective: "typo", status: "done" }),
      ],
      recheckUnits: [],
    };
    expect(perspectiveTallies(units).map((entry) => entry.perspective)).toEqual([
      "typo",
      "naturalness",
    ]);
  });

  it("units に現れない観点は出さない", () => {
    const units: RunUnitsDto = {
      checkUnits: [makeCheckUnit({ id: "c1", perspective: "typo", status: "done" })],
      recheckUnits: [],
    };
    expect(perspectiveTallies(units).map((entry) => entry.perspective)).toEqual(["typo"]);
  });

  it("recheckUnits は観点別の内訳に含めない（決定 5 は checkUnits を対象にする）", () => {
    const units: RunUnitsDto = {
      checkUnits: [],
      recheckUnits: [makeRecheckUnit({ id: "r1", status: "done" })],
    };
    expect(perspectiveTallies(units)).toEqual([]);
  });
});

describe("pruneSlowUnitIds", () => {
  it("units が null なら集合をそのまま返す（対応が取れないため）", () => {
    const slowUnitIds = new Set(["u1"]);
    expect(pruneSlowUnitIds(slowUnitIds, null)).toBe(slowUnitIds);
  });

  it("空集合はそのまま返す", () => {
    const slowUnitIds = new Set<string>();
    expect(pruneSlowUnitIds(slowUnitIds, null)).toBe(slowUnitIds);
  });

  it("対応する検査単位が running でなくなったら落ちる", () => {
    const units: RunUnitsDto = {
      checkUnits: [makeCheckUnit({ id: "c1", status: "done" })],
      recheckUnits: [],
    };
    const result = pruneSlowUnitIds(new Set(["c1"]), units);
    expect(result.has("c1")).toBe(false);
  });

  it("対応する検査単位がまだ running なら残る", () => {
    const units: RunUnitsDto = {
      checkUnits: [makeCheckUnit({ id: "c1", status: "running" })],
      recheckUnits: [],
    };
    const result = pruneSlowUnitIds(new Set(["c1"]), units);
    expect(result.has("c1")).toBe(true);
  });

  it("unitId が再確認単位のものでも見る（決定 10：checkUnits と recheckUnits の両方）", () => {
    const units: RunUnitsDto = {
      checkUnits: [],
      recheckUnits: [makeRecheckUnit({ id: "r1", status: "running" })],
    };
    const result = pruneSlowUnitIds(new Set(["r1"]), units);
    expect(result.has("r1")).toBe(true);
  });

  it("再確認単位が running でなくなったら落ちる", () => {
    const units: RunUnitsDto = {
      checkUnits: [],
      recheckUnits: [makeRecheckUnit({ id: "r1", status: "failed" })],
    };
    const result = pruneSlowUnitIds(new Set(["r1"]), units);
    expect(result.has("r1")).toBe(false);
  });

  it("どちらの一覧にも見つからない unitId は落ちる", () => {
    const units: RunUnitsDto = { checkUnits: [], recheckUnits: [] };
    const result = pruneSlowUnitIds(new Set(["missing"]), units);
    expect(result.has("missing")).toBe(false);
  });

  it("複数件のうち running のものだけを残す", () => {
    const units: RunUnitsDto = {
      checkUnits: [
        makeCheckUnit({ id: "c1", status: "running" }),
        makeCheckUnit({ id: "c2", status: "done" }),
      ],
      recheckUnits: [makeRecheckUnit({ id: "r1", status: "running" })],
    };
    const result = pruneSlowUnitIds(new Set(["c1", "c2", "r1"]), units);
    expect([...result].sort()).toEqual(["c1", "r1"]);
  });
});
