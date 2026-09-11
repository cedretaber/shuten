/**
 * 検査進捗の集計（Task 3、決定 5・10・11）。
 *
 * ここに置くのは純関数だけ（DOM は `run-progress.tsx` の責務）。
 * - `tallyOf`：`UnitStatusCounts`（`progress.checkUnits` / `progress.recheckUnits`）を
 *   `UnitTally` に変換する。合計は 5 状態の和（決定 11）。
 * - `perspectiveTallies`：観点別の内訳（決定 5）。`RunUnitsDto.checkUnits` を `perspective` で
 *   分けて数える。`units` が null（未取得・失敗）のときは空配列を返す。
 * - `pruneSlowUnitIds`：`generation-slow` の遅延通知の集合から、まだ `running` の単位だけを残す
 *   （決定 10）。`unitId` は検査単位・再確認単位のどちらでもありうるので両方を見る。
 */

import type { CheckUnitDto, Perspective, RunUnitsDto, UnitStatusCounts } from "@shuten/shared";

/** 観点の表示順（`finding-detail.tsx` の `PERSPECTIVE_ORDER` と同じ順）。 */
export const PERSPECTIVE_ORDER: readonly Perspective[] = ["typo", "naturalness"];

export interface UnitTally {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly running: number;
  readonly pending: number;
  readonly notApplicable: number;
}

/** `UnitStatusCounts`（`progress` の合計）から作る。合計は 5 状態の和（決定 11）。 */
export function tallyOf(counts: UnitStatusCounts): UnitTally {
  const done = counts.done;
  const failed = counts.failed;
  const running = counts.running;
  const pending = counts.pending;
  const notApplicable = counts["not-applicable"];
  return {
    total: done + failed + running + pending + notApplicable,
    done,
    failed,
    running,
    pending,
    notApplicable,
  };
}

function emptyTally(): UnitTally {
  return { total: 0, done: 0, failed: 0, running: 0, pending: 0, notApplicable: 0 };
}

/** `checkUnits` を観点ごとに数え上げた `UnitTally` を積む。 */
function addToTally(tally: UnitTally, status: CheckUnitDto["status"]): UnitTally {
  switch (status) {
    case "done":
      return { ...tally, total: tally.total + 1, done: tally.done + 1 };
    case "failed":
      return { ...tally, total: tally.total + 1, failed: tally.failed + 1 };
    case "running":
      return { ...tally, total: tally.total + 1, running: tally.running + 1 };
    case "pending":
      return { ...tally, total: tally.total + 1, pending: tally.pending + 1 };
    case "not-applicable":
      return { ...tally, total: tally.total + 1, notApplicable: tally.notApplicable + 1 };
  }
}

/**
 * 観点ごとの内訳（決定 5）。`units` が null（未取得・失敗）なら空配列。
 * 観点の並びは `PERSPECTIVE_ORDER` に従う。`units` に現れない観点は出さない。
 */
export function perspectiveTallies(
  units: RunUnitsDto | null,
): readonly { readonly perspective: Perspective; readonly tally: UnitTally }[] {
  if (units === null) {
    return [];
  }
  const tallies = new Map<Perspective, UnitTally>();
  for (const unit of units.checkUnits) {
    const current = tallies.get(unit.perspective) ?? emptyTally();
    tallies.set(unit.perspective, addToTally(current, unit.status));
  }
  const result: { readonly perspective: Perspective; readonly tally: UnitTally }[] = [];
  for (const perspective of PERSPECTIVE_ORDER) {
    const tally = tallies.get(perspective);
    if (tally !== undefined) {
      result.push({ perspective, tally });
    }
  }
  return result;
}

/**
 * 決定 10：遅延通知の集合から、まだ `running` の単位だけを残す。
 * `unitId` は検査単位と再確認単位のどちらでもありうるので、`checkUnits` と `recheckUnits` の
 * 両方を見る（片方しか見ないと、再確認の遅延通知が永久に消えない）。
 * `units` が null（未取得・失敗）のときは、対応が取れないので集合をそのまま返す。
 */
export function pruneSlowUnitIds(
  slowUnitIds: ReadonlySet<string>,
  units: RunUnitsDto | null,
): ReadonlySet<string> {
  if (slowUnitIds.size === 0) {
    return slowUnitIds;
  }
  if (units === null) {
    return slowUnitIds;
  }
  const runningIds = new Set<string>();
  for (const unit of units.checkUnits) {
    if (unit.status === "running") {
      runningIds.add(unit.id);
    }
  }
  for (const unit of units.recheckUnits) {
    if (unit.status === "running") {
      runningIds.add(unit.id);
    }
  }
  const pruned = new Set<string>();
  for (const unitId of slowUnitIds) {
    if (runningIds.has(unitId)) {
      pruned.add(unitId);
    }
  }
  return pruned;
}
