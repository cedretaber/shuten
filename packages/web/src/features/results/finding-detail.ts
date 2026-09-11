/**
 * 指摘詳細の表示規則（Task 7、決定 3・9・12。仕様書 5.4）の純関数。
 *
 * DOM は `finding-detail.tsx` の責務で、ここには「`FindingDto` から何を最終判定として見せるか」
 * 「修正案を有効な修正案として出してよいか」「選択中の指摘に関連する他の指摘をどう 2 群に分けるか」
 * という判断だけを置く。
 *
 * 決定 12 の表（`recheck` を軸にした 5 行）をそのまま `describeRecheck` に落とす。
 * 仕様書 5.4「初回判定は履歴に保持し、再確認待ち・失敗・無効の場合は未検証の初回判定とその状態を
 * 示す」に対応するため、`finalVerdict` が再確認の判定でないときは常に「未検証の初回判定」
 * （`recheck === null` のときだけ「再確認そのものが無い」という別の意味の `"initial"` になる）を返し、
 * `initialVerdict` は `finalVerdict` の種類に関わらず必ず含める（履歴として失わない）。
 */

import type { FindingDto, InitialVerdict, RecheckVerdict } from "@shuten/shared";
import {
  FAILURE_REASON_LABELS,
  RECHECK_NOT_APPLICABLE_REASON_LABELS,
  RECHECK_REASON_KIND_LABELS,
} from "./labels.ts";

/**
 * 表示上の最終判定（決定 12 の表の「表示上の最終判定」列）。
 * - `"recheck"`：再確認が正常終了し、その判定を最終判定とする（`recheck` の値）。
 * - `"initial"`：再確認そのものが無い（`recheck === null`）ので、初回判定をそのまま最終判定とする。
 * - `"initial-unverified"`：再確認待ち・失敗・対象外のため、初回判定は残すが「未検証」であることを
 *   示す。
 */
export type VerdictDisplay =
  | { readonly kind: "recheck"; readonly verdict: RecheckVerdict }
  | { readonly kind: "initial"; readonly verdict: InitialVerdict }
  | { readonly kind: "initial-unverified"; readonly verdict: InitialVerdict };

export interface RecheckDisplay {
  /** 「再確認済み」「再確認待ち」「再確認失敗」「再確認なし」など。 */
  readonly stateLabel: string;
  /** 表示上の最終判定（決定 12 の表）。 */
  readonly finalVerdict: VerdictDisplay;
  /** 初回判定。`finalVerdict` が recheck のときは履歴として併記する。 */
  readonly initialVerdict: InitialVerdict;
  /** 修正案を「有効な修正案」として出してよいか（決定 12）。 */
  readonly suggestionUsable: boolean;
}

/**
 * 修正案を有効な修正案として表示してよいか（決定 12）。
 * `recheck?.suggestionValid === false` または `recheck?.reasonKind === "suggestion-inappropriate"`
 * のいずれかが成り立てば false。
 */
function isSuggestionUsable(finding: FindingDto): boolean {
  const { recheck } = finding;
  if (recheck === null) {
    return true;
  }
  if (recheck.suggestionValid === false) {
    return false;
  }
  if (recheck.reasonKind === "suggestion-inappropriate") {
    return false;
  }
  return true;
}

export function describeRecheck(finding: FindingDto): RecheckDisplay {
  const { recheck, initialVerdict } = finding;
  const suggestionUsable = isSuggestionUsable(finding);

  // 表の行 1：`recheck` が無い（再確認を無効にした実行では起票されない）。
  if (recheck === null) {
    return {
      stateLabel: "再確認なし",
      finalVerdict: { kind: "initial", verdict: initialVerdict },
      initialVerdict,
      suggestionUsable,
    };
  }

  // 表の行 2：再確認が正常終了し、判定が付いている。
  if (recheck.status === "done" && recheck.verdict !== null) {
    const reasonSuffix =
      recheck.reasonKind !== null ? `（${RECHECK_REASON_KIND_LABELS[recheck.reasonKind]}）` : "";
    return {
      stateLabel: `再確認済み${reasonSuffix}`,
      finalVerdict: { kind: "recheck", verdict: recheck.verdict },
      initialVerdict,
      suggestionUsable,
    };
  }

  // 表の行 3：再確認待ち（pending / running はまとめる）。
  if (recheck.status === "pending" || recheck.status === "running") {
    return {
      stateLabel: "再確認待ち",
      finalVerdict: { kind: "initial-unverified", verdict: initialVerdict },
      initialVerdict,
      suggestionUsable,
    };
  }

  // 表の行 4：再確認失敗。
  if (recheck.status === "failed") {
    const reasonSuffix =
      recheck.failure !== null ? `（${FAILURE_REASON_LABELS[recheck.failure.reason]}）` : "";
    return {
      stateLabel: `再確認失敗${reasonSuffix}`,
      finalVerdict: { kind: "initial-unverified", verdict: initialVerdict },
      initialVerdict,
      suggestionUsable,
    };
  }

  // 表の行 5：`status === "not-applicable"`（無効・抑制・位置未確定のいずれか）。
  // `status === "done"` なのに `verdict === null` という型上ありうるが実際には起きない組み合わせも
  // 防御的にここへ落とす（例外にせず、未検証の初回判定として扱う）。
  const stateLabel =
    recheck.notApplicableReason !== null
      ? RECHECK_NOT_APPLICABLE_REASON_LABELS[recheck.notApplicableReason]
      : "再確認対象外";
  return {
    stateLabel,
    finalVerdict: { kind: "initial-unverified", verdict: initialVerdict },
    initialVerdict,
    suggestionUsable,
  };
}

/**
 * 決定 8 の 2 群を選択中の指摘から作る。自分自身は含めない。
 *
 * - 「同じ範囲の他の指摘」＝ `range.start` と `range.end` が完全に一致するもの。
 * - 「範囲が重なる他の指摘」＝重なるが一致しないもの（`[0,10)` と `[9,20)` は重なるが一致しない）。
 * - 隣接するだけ（`[0,10)` と `[10,20)`）はどちらにも含めない。
 *
 * `visible`（絞り込み後に見えている指摘）だけから作る。`selected` の位置が未確定
 * （`range === null`）のときも、`visible` の要素が位置未確定のときも対象にしない
 * （比較する範囲が無いため）。
 */
export function relatedFindings(
  selected: FindingDto,
  visible: readonly FindingDto[],
): { readonly sameRange: FindingDto[]; readonly overlapping: FindingDto[] } {
  const sameRange: FindingDto[] = [];
  const overlapping: FindingDto[] = [];
  const selectedRange = selected.range;
  if (selectedRange === null) {
    return { sameRange, overlapping };
  }

  for (const finding of visible) {
    if (finding.id === selected.id) {
      continue;
    }
    const range = finding.range;
    if (range === null) {
      continue;
    }
    if (range.start === selectedRange.start && range.end === selectedRange.end) {
      sameRange.push(finding);
    } else if (range.start < selectedRange.end && selectedRange.start < range.end) {
      overlapping.push(finding);
    }
  }

  return { sameRange, overlapping };
}
