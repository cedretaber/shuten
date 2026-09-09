/**
 * 検査実行・検査単位の状態遷移表（決定 3）と、`RunStop` から実行の終了状態への写像（決定 23）。
 *
 * 状態を書く経路はすべてこの `canTransitionRun` / `canTransitionUnit` を通す
 * （状態の書き手を 1 つにするのが第一の防御。決定 5 の条件付き更新はその裏打ち）。
 * 停止要求そのものは `AbortController` と停止フラグを立てるだけで、ここでの遷移検査を経ない。
 */

import type { RunStop } from "./result.ts";
import type { RunStatus, UnitStatus } from "./status.ts";

/**
 * 検査実行の許容遷移（決定 3 の表）。「（新規）→ running」は生成時の初期値であり
 * 遷移ではないためここには含めない。特に `stopped` → `completed`（停止後に遅れて届いた完了報告）と
 * `completed` → `running`（失敗単位がないので再試行対象がない）は許さない。
 */
const RUN_TRANSITIONS: ReadonlyArray<readonly [RunStatus, RunStatus]> = [
  ["running", "completed"],
  ["running", "partially-failed"],
  ["running", "stopped"],
  ["running", "recovery-waiting"],
  ["stopped", "running"],
  ["recovery-waiting", "running"],
  ["partially-failed", "running"],
];

/**
 * 検査単位・再確認単位の許容遷移（決定 3 の表）。`done` は終端で、再試行でも戻さない。
 * `not-applicable` も原則終端だが、**抑制の解除だけは `pending` に戻せる**（決定 45-4）：
 * 失敗観点の再試行で別分類の候補が加わると統合結果の `category` が変わって抑制が外れることが
 * あり、そのとき 1 度も実行していない再確認単位を起票し直せないと再確認が永久に行われない。
 * `disabled`（実行ごとに固定）と `unlocated`（位置特定の結果は変わらない）は戻さないが、
 * その区別は理由列を見る `reopenSuppressedRecheckUnit` の側で行う（この表は状態しか見ない）。
 * したがって `not-applicable → pending` は「表には有るが専用の入口
 * （`transitions.ts` の `reopenSuppressedRecheckUnitChecked`）からしか通せない」遷移である。
 * 汎用の `claimRecheckUnitChecked` / `finishRecheckUnitChecked` は、表を引く前にこのペアを弾く。
 */
const UNIT_TRANSITIONS: ReadonlyArray<readonly [UnitStatus, UnitStatus]> = [
  ["pending", "running"],
  ["pending", "not-applicable"],
  ["running", "done"],
  ["running", "failed"],
  ["running", "pending"],
  ["failed", "pending"],
  ["not-applicable", "pending"],
];

/**
 * 遷移ペアの配列から「from → to 集合」の入れ子 `Map` を作る。
 * 複合キーを文字列連結で作らないことで、区切り文字の選択自体をなくす。
 */
function buildTransitionMap<T extends string>(
  pairs: ReadonlyArray<readonly [T, T]>,
): ReadonlyMap<T, ReadonlySet<T>> {
  const map = new Map<T, Set<T>>();
  for (const [from, to] of pairs) {
    const destinations = map.get(from) ?? new Set<T>();
    destinations.add(to);
    map.set(from, destinations);
  }
  return map;
}

const RUN_TRANSITION_MAP: ReadonlyMap<RunStatus, ReadonlySet<RunStatus>> = buildTransitionMap(
  RUN_TRANSITIONS,
);

const UNIT_TRANSITION_MAP: ReadonlyMap<UnitStatus, ReadonlySet<UnitStatus>> = buildTransitionMap(
  UNIT_TRANSITIONS,
);

/** 検査実行の状態遷移が許容表にあるかを判定する。表にない遷移はすべて false（決定 3）。 */
export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITION_MAP.get(from)?.has(to) ?? false;
}

/** 検査単位・再確認単位の状態遷移が許容表にあるかを判定する。表にない遷移はすべて false（決定 3）。 */
export function canTransitionUnit(from: UnitStatus, to: UnitStatus): boolean {
  return UNIT_TRANSITION_MAP.get(from)?.has(to) ?? false;
}

/**
 * `RunStop` から実行の終了状態への写像（決定 23）。
 * 規則は 1 行：`generationUnconfirmed` が true なら `recovery-waiting`（生成が LM Studio 側で
 * 走り続けている可能性がある）、false なら `stopped`。`stop.reason` そのものでは分岐しない
 * （`connection-lost` は発生源によって true にも false にもなるため）。
 */
export function runStatusForStop(
  stop: RunStop,
): Extract<RunStatus, "stopped" | "recovery-waiting"> {
  return runStatusForUnconfirmed(stop.generationUnconfirmed);
}

/**
 * 決定 23 の規則そのもの。`RunStop` を作らない経路（`run/orchestrator.ts` の
 * `settleInternalError` と起動時照合）から、同じ規則を書き直さずに使うための入口。
 * 判断材料は「生成が LM Studio 側で走り続けている可能性があるか」の 1 つだけである。
 */
export function runStatusForUnconfirmed(
  generationUnconfirmed: boolean,
): Extract<RunStatus, "stopped" | "recovery-waiting"> {
  return generationUnconfirmed ? "recovery-waiting" : "stopped";
}
