/**
 * 指摘から本文への移動先を決める・DOM から探す・スクロールする（Task 9、決定 9、申し送り 3。
 * 仕様書 4 の手順 5「指摘を選ぶと本文の該当箇所へ移動する」、仕様書 5.3）。
 *
 * 移動先の決定（`navigationTargetOf`）：
 * - 位置が確定した指摘（`locateStatus === "located" && range !== null`）は、本文中の強調
 *   （`body-view.tsx` が描く `<span data-findings="id1 id2">`）へ移動する。
 * - 位置特定に失敗した指摘（`not-found` / `ambiguous`。`located` だが `range === null` という
 *   型上ありうる組み合わせも含む）は強調が無いため、`finding.targetId` で引いた検査対象
 *   （`RunTargetDto`）の `target.start` を `splitParagraphs(body)` に通して求めた、
 *   その位置を含む段落へ移動する（仕様 5.3「元の検査対象範囲へ移動」）。
 * - `finding.paragraphId` は使わない。位置未確定の指摘のそれは LLM の申告値で、本文の段落と
 *   対応している保証が無いため（決定 9）。
 * - 該当する検査対象が `targets` に無ければ `null` を返す。呼び出し側はこれを「移動の操作子を
 *   出さない」の合図として使う（押しても何も起きないボタンを作らない）。
 *
 * 要素検索（`findTargetElement`）と `scrollIntoViewIfPossible` は純粋に DOM 操作。
 * jsdom には `scrollIntoView` が無い（申し送り 3）ため、関数として存在するときだけ呼ぶ。
 * `getBoundingClientRect` は使わない（jsdom では常に 0 を返し、幾何の検査ができないため）。
 */

import type { FindingDto, RunTargetDto } from "@shuten/shared";
import { splitParagraphs } from "@shuten/shared";

export type NavigationTarget =
  | { readonly kind: "finding"; readonly findingId: string }
  | { readonly kind: "paragraph"; readonly paragraphId: number };

/** 指摘の移動先を決める。位置未確定なら検査対象範囲を含む段落（決定 9）。見つからなければ null。 */
export function navigationTargetOf(
  finding: FindingDto,
  targets: readonly RunTargetDto[],
  body: string,
): NavigationTarget | null {
  if (finding.locateStatus === "located" && finding.range !== null) {
    return { kind: "finding", findingId: finding.id };
  }

  const target = targets.find((t) => t.id === finding.targetId);
  if (target === undefined) {
    return null;
  }

  const start = target.target.start;
  const paragraph = splitParagraphs(body).find(
    (p) => p.range.start <= start && start < p.range.end,
  );
  if (paragraph === undefined) {
    return null;
  }

  return { kind: "paragraph", paragraphId: paragraph.id };
}

/**
 * ID を CSS 属性セレクターへ安全に埋め込む。指摘 ID は UUID、段落 ID は非負整数の文字列化で
 * どちらも元々エスケープ不要な文字集合に収まるが、セレクター構築の作法として `CSS.escape` を
 * 優先して使う。`CSS.escape` が無い環境（テスト環境の設定次第では jsdom にも無いことがある）では
 * 素の文字列のまま組み立てる（上記のとおり ID の文字集合的に実害は出ない）。
 */
function escapeForSelector(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value;
}

export function findTargetElement(
  container: HTMLElement,
  target: NavigationTarget,
): HTMLElement | null {
  const selector =
    target.kind === "finding"
      ? `[data-findings~="${escapeForSelector(target.findingId)}"]`
      : `[data-paragraph-id="${escapeForSelector(String(target.paragraphId))}"]`;
  return container.querySelector<HTMLElement>(selector);
}

/** jsdom には scrollIntoView が無い（申し送り 3）。有るときだけ呼ぶ。 */
export function scrollIntoViewIfPossible(element: Element): void {
  if (typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ block: "nearest" });
  }
}
