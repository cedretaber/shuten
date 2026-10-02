/**
 * 同じ範囲の指摘のまとめ（PR14b。UI の見直し 2 節）の純関数。
 *
 * 位置が確定していて、範囲（UTF-16 の `[start, end)`）が完全に一致する指摘だけを 1 つの
 * 「まとめ」にする。一部だけ重なる指摘と、位置が特定できなかった指摘はまとめず、1 件ずつの
 * まとめとして扱う。表示だけの変更なので、仕様 6.4 節の統合規則・採否の単位・件数の数え方は
 * 変えない（採否は指摘 1 件ずつ保存し、件数は指摘の数で数える）。
 *
 * まとめるのは、絞り込みを通った指摘（`visibleFindings` の結果）の中だけ。並び順は渡された順
 * （サーバーの順＝本文の位置順）のままで、まとめは先頭の指摘の位置に置く。同じ範囲なら本文の
 * 位置も同じなので、先頭は「渡された順で最初」の指摘になる。
 *
 * DOM は持たない。一覧（`finding-list.tsx`）・詳細（`finding-detail.tsx`）・結果画面
 * （`results-page.tsx`）がここを使う。
 */

import type { FindingDto, JudgmentStatus } from "@shuten/shared";
import { JUDGMENT_STATUSES } from "@shuten/shared";
import {
  RECHECK_STATE_LABELS,
  RECHECK_STATES,
  type RecheckState,
  recheckStateOf,
} from "./finding-filter.ts";
import { FINDING_CATEGORY_LABELS, JUDGMENT_STATUS_LABELS } from "./labels.ts";

export interface FindingGroup {
  /** まとめの先頭。一覧の行と選択は、この指摘の ID で表す。 */
  readonly head: FindingDto;
  /** まとめた指摘（先頭を含む）。絞り込みを通った指摘だけで、渡された順のまま。 */
  readonly members: readonly FindingDto[];
}

/**
 * 同じ範囲かどうかを比べるためのキー。位置が確定していなければ null（まとめない）。
 * `toHighlights` と同じく、`locateStatus` と `range` の両方を見る。
 */
export function sameRangeKey(finding: FindingDto): string | null {
  if (finding.locateStatus !== "located" || finding.range === null) {
    return null;
  }
  return `${finding.range.start}:${finding.range.end}`;
}

/** 絞り込みを通った指摘を、同じ範囲ごとにまとめる。 */
export function groupFindings(visible: readonly FindingDto[]): FindingGroup[] {
  const groups: { head: FindingDto; members: FindingDto[] }[] = [];
  const byKey = new Map<string, { head: FindingDto; members: FindingDto[] }>();
  for (const finding of visible) {
    const key = sameRangeKey(finding);
    if (key !== null) {
      const existing = byKey.get(key);
      if (existing !== undefined) {
        existing.members.push(finding);
        continue;
      }
    }
    const group = { head: finding, members: [finding] };
    groups.push(group);
    if (key !== null) {
      byKey.set(key, group);
    }
  }
  return groups;
}

/** その指摘を含むまとめ。先頭でない指摘の ID からも引ける。無ければ null。 */
export function groupContaining(
  groups: readonly FindingGroup[],
  findingId: string,
): FindingGroup | null {
  return groups.find((group) => group.members.some((member) => member.id === findingId)) ?? null;
}

/**
 * 選択中の指摘 ID を、今のまとめに合わせて決め直す（UI の見直し 2 節「選択中の指摘が
 * 絞り込みから外れたとき」）。
 *
 * - 表示中のまとめに入っていれば、そのまとめの先頭。
 * - 絞り込みから外れていても、同じ範囲で表示中の指摘が残っていれば、そのまとめの先頭。
 * - どちらでもなければ null（今どおり選択を外す）。
 *
 * `all` は絞り込み前の全件。外れた指摘の範囲を知るために使う。
 */
export function nextSelection(
  selectedId: string | null,
  all: readonly FindingDto[],
  groups: readonly FindingGroup[],
): string | null {
  if (selectedId === null) {
    return null;
  }
  const containing = groupContaining(groups, selectedId);
  if (containing !== null) {
    return containing.head.id;
  }
  const selected = all.find((finding) => finding.id === selectedId);
  if (selected === undefined) {
    return null;
  }
  const key = sameRangeKey(selected);
  if (key === null) {
    return null;
  }
  const successor = groups.find((group) => sameRangeKey(group.head) === key);
  return successor === undefined ? null : successor.head.id;
}

/** 同じ範囲なのに、絞り込みで隠れてまとめに入っていない指摘の数。 */
export function hiddenSameRangeCount(group: FindingGroup, all: readonly FindingDto[]): number {
  const key = sameRangeKey(group.head);
  if (key === null) {
    return 0;
  }
  const memberIds = new Set(group.members.map((member) => member.id));
  let count = 0;
  for (const finding of all) {
    if (!memberIds.has(finding.id) && sameRangeKey(finding) === key) {
      count += 1;
    }
  }
  return count;
}

/**
 * 範囲が一部だけ重なる、ほかのまとめ。隣り合うだけ（`[0,5)` と `[5,10)`）は含めない。
 * 範囲が完全に一致するものは同じまとめに入っているので、ここには出てこない。
 */
export function overlappingGroups(
  group: FindingGroup,
  groups: readonly FindingGroup[],
): FindingGroup[] {
  const range = group.head.range;
  if (sameRangeKey(group.head) === null || range === null) {
    return [];
  }
  return groups.filter((other) => {
    if (other.head.id === group.head.id) {
      return false;
    }
    const otherRange = other.head.range;
    if (sameRangeKey(other.head) === null || otherRange === null) {
      return false;
    }
    return otherRange.start < range.end && range.start < otherRange.end;
  });
}

/**
 * 分類の要約。重複を除き、並びの順に「／」でつなぐ。分類のラベルには「誤字・表記」のように
 * 「・」を含むものがあるので、区切りに「・」は使わない。
 */
export function summarizeCategories(members: readonly FindingDto[]): string {
  const labels: string[] = [];
  for (const member of members) {
    const label = FINDING_CATEGORY_LABELS[member.category];
    if (!labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels.join("／");
}

/**
 * 値の要約。全員が同じならそのラベルだけ、違えば `order` の順に「ラベル 件数」を「・」で
 * つなぐ（例：「未判断 1・却下 1」）。
 */
function summarizeCounts<T extends string>(
  values: readonly T[],
  order: readonly T[],
  labels: Readonly<Record<T, string>>,
): string {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const present = order.filter((value) => counts.has(value));
  const [only] = present;
  if (present.length === 1 && only !== undefined) {
    return labels[only];
  }
  return present.map((value) => `${labels[value]} ${counts.get(value) ?? 0}`).join("・");
}

export function summarizeJudgments(members: readonly FindingDto[]): string {
  return summarizeCounts<JudgmentStatus>(
    members.map((member) => member.judgment.status),
    JUDGMENT_STATUSES,
    JUDGMENT_STATUS_LABELS,
  );
}

export function summarizeRecheckStates(members: readonly FindingDto[]): string {
  return summarizeCounts<RecheckState>(
    members.map((member) => recheckStateOf(member)),
    RECHECK_STATES,
    RECHECK_STATE_LABELS,
  );
}
