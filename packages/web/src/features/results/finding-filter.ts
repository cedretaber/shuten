/**
 * 指摘一覧の絞り込み（Task 6、決定 7・8・10）。
 *
 * 絞り込みの状態（`FindingFilter`）は `results-page.tsx` がローカル状態として持つ。ここには
 * 型・既定値・述語という純関数だけを置き、DOM は `finding-filter.tsx`（操作子）・
 * `finding-list.tsx`（一覧）の責務にする。
 *
 * 絞り込みは URL にも `localStorage` にも保存しない（画面を離れれば消える、セッション内だけの
 * 状態）。一覧の並びはサーバーの順（本文位置 `start` 昇順、位置未確定は最後）のままで、
 * クライアントで再ソートしない。
 */

import type { FindingCategory, FindingDto, JudgmentStatus } from "@shuten/shared";
import { FINDING_CATEGORIES, JUDGMENT_STATUSES } from "@shuten/shared";
import type { Highlight } from "./body-view.ts";

/**
 * 再確認の状態（決定 10）。`recheck` が null（再確認単位そのものが作られていない。無効な実行、
 * または位置未確定など）は `"none"`。`pending` / `running` は合わせて `"waiting"` とする。
 */
export type RecheckState = "none" | "waiting" | "done" | "failed" | "not-applicable";

/** 絞り込みの選択肢一覧（チェックボックス描画用）。順序がそのままチェックボックスの並びになる。 */
export const RECHECK_STATES: readonly RecheckState[] = [
  "none",
  "waiting",
  "done",
  "failed",
  "not-applicable",
];

/** 位置特定状態を絞り込み用に 2 値へ統合したもの。`not-found` / `ambiguous` はどちらも `"unlocated"`。 */
export type LocateState = "located" | "unlocated";

export const LOCATE_STATES: readonly LocateState[] = ["located", "unlocated"];

export interface FindingFilter {
  /** null は「すべて」。空配列は「どれも選んでいない」＝ 0 件。 */
  readonly categories: readonly FindingCategory[] | null;
  readonly judgments: readonly JudgmentStatus[] | null;
  readonly recheckStates: readonly RecheckState[] | null;
  readonly locateStates: readonly LocateState[] | null;
  readonly showSuppressed: boolean;
  readonly showWithdrawn: boolean;
}

/** すべて null（絞り込みなし）、`showSuppressed` / `showWithdrawn` は false（抑制・撤回を隠す）。 */
export const DEFAULT_FINDING_FILTER: FindingFilter = {
  categories: null,
  judgments: null,
  recheckStates: null,
  locateStates: null,
  showSuppressed: false,
  showWithdrawn: false,
};

export function recheckStateOf(finding: FindingDto): RecheckState {
  const { recheck } = finding;
  if (recheck === null) {
    return "none";
  }
  if (recheck.status === "pending" || recheck.status === "running") {
    return "waiting";
  }
  // ここに来ると recheck.status は "done" | "failed" | "not-applicable" しかありえない
  // （UnitStatus は 5 値で、pending・running は上で捌いている）。RecheckState と同じ語なので
  // そのまま返せる。
  return recheck.status;
}

/** 絞り込みの述語。6 項目の積。 */
export function matchesFilter(finding: FindingDto, filter: FindingFilter): boolean {
  if (filter.categories !== null && !filter.categories.includes(finding.category)) {
    return false;
  }
  if (filter.judgments !== null && !filter.judgments.includes(finding.judgment.status)) {
    return false;
  }
  if (filter.recheckStates !== null && !filter.recheckStates.includes(recheckStateOf(finding))) {
    return false;
  }
  if (filter.locateStates !== null) {
    const locateState: LocateState = finding.locateStatus === "located" ? "located" : "unlocated";
    if (!filter.locateStates.includes(locateState)) {
      return false;
    }
  }
  if (!filter.showSuppressed && finding.suppression !== null) {
    return false;
  }
  if (!filter.showWithdrawn && finding.recheck?.verdict === "withdraw") {
    return false;
  }
  return true;
}

/**
 * 絞り込みを通った指摘だけを、サーバーが返した順のまま返す（クライアントで再ソートしない）。
 */
export function visibleFindings(
  findings: readonly FindingDto[],
  filter: FindingFilter,
): FindingDto[] {
  return findings.filter((finding) => matchesFilter(finding, filter));
}

/**
 * 決定 7：位置が確定した指摘だけを強調に渡す。`locateStatus === "located"` と `range !== null` の
 * 両方を見る（型上は locateStatus === "located" のとき range は非 null のはずだが、DTO は
 * `range: rangeSchema.nullable()` で独立しているため、念のため両方を確認する）。
 */
export function toHighlights(findings: readonly FindingDto[]): Highlight[] {
  const highlights: Highlight[] = [];
  for (const finding of findings) {
    if (finding.locateStatus === "located" && finding.range !== null) {
      highlights.push({ id: finding.id, range: finding.range });
    }
  }
  return highlights;
}

/**
 * チェックボックス 1 個の切り替え。`current`（null は「すべて」）と選択肢全体 `all` から、
 * `value` の有無を反転した次の状態を返す。全選択に戻ったら `null` に正規化する
 * （`DEFAULT_FINDING_FILTER` と同じ表現に揃え、「すべて」を配列の長さで判定しなくて済むように
 * する）。返す配列の順序は `all` の順序に揃える。
 */
export function toggleFilterValue<T>(
  current: readonly T[] | null,
  all: readonly T[],
  value: T,
): readonly T[] | null {
  const set = new Set<T>(current ?? all);
  if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
  const next = all.filter((option) => set.has(option));
  return next.length === all.length ? null : next;
}

/** 分類・採否の選択肢一覧（`@shuten/shared` の定数をそのまま再エクスポートし、呼び出し側を短くする）。 */
export const FILTER_CATEGORY_OPTIONS: readonly FindingCategory[] = FINDING_CATEGORIES;
export const FILTER_JUDGMENT_OPTIONS: readonly JudgmentStatus[] = JUDGMENT_STATUSES;

/**
 * `RecheckState` の日本語ラベル。`RecheckState` はこのファイルで定義した絞り込み専用の型
 * （`UnitStatus` そのものではない）なので、`labels.ts`（変更禁止）ではなくここに置く。
 */
export const RECHECK_STATE_LABELS: Record<RecheckState, string> = {
  none: "再確認なし",
  waiting: "再確認待ち",
  done: "再確認済み",
  failed: "再確認失敗",
  "not-applicable": "再確認対象外",
};

/** `LocateState`（絞り込み用に統合した 2 値）の日本語ラベル。 */
export const LOCATE_STATE_LABELS: Record<LocateState, string> = {
  located: "位置確定",
  unlocated: "位置未確定",
};
