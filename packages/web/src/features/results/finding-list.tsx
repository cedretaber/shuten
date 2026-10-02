/**
 * 指摘一覧（Task 6、決定 7・8・10）。
 *
 * 並びは呼び出し側（`results-page.tsx`）が渡した順のまま描く（サーバーの順＝本文位置 `start`
 * 昇順、位置未確定は最後。ここでは再ソートしない）。
 *
 * 行は `<button type="button">` にする（決定 6）。本文の強調 `<span>`（`body-view.tsx`）は
 * キーボード操作の対象にしない方針なので、キーボードの経路はこの一覧が担う。指摘が最大 800 件
 * になりうるため、行以外にタブ止まりを増やさない（行の中に別のフォーカス可能要素を置かない）。
 *
 * 引用（`finding.quote`）は全文をそのまま DOM に置く。見出しでの省略は CSS
 * （`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`、
 * `results-page.module.css` の `.findingQuote`）に任せ、JS 側で文字列を切らない。
 * `String.prototype.slice` はコード単位、`Array.from(...).slice(...)` はコードポイント単位で、
 * どちらも書記素境界ではなく、結合文字・異体字セレクタ・ZWJ の絵文字を途中で割りうる。
 * 書記素境界を計算する道（`Intl.Segmenter`）はこのリポジトリでは閉じているので、
 * 「切らない」のが唯一の整合した解になる。
 *
 * PR14b：同じ範囲の指摘は 1 つの「まとめ」（`finding-group.ts`）として 1 行で描く。行と選択は
 * まとめの先頭の ID で表し、引用の横に「n 案」を添える。分類・採否・再確認状態は、まとめの中で
 * 違えば要約して並べる。
 */

import controls from "../../styles/controls.module.css";
import type { FindingGroup } from "./finding-group.ts";
import {
  summarizeCategories,
  summarizeJudgments,
  summarizeRecheckStates,
} from "./finding-group.ts";
import { FINDING_LOCATE_STATUS_LABELS } from "./labels.ts";
import styles from "./results-page.module.css";

export interface FindingListProps {
  /** 絞り込み後の指摘を同じ範囲ごとにまとめたもの（呼び出し側が渡した順のまま描く）。 */
  readonly groups: readonly FindingGroup[];
  /** 選択中の指摘 ID（まとめの先頭の ID）。無ければ null。 */
  readonly selectedFindingId: string | null;
  readonly onSelectFinding: (findingId: string) => void;
}

export function FindingList(props: FindingListProps) {
  const { groups, selectedFindingId, onSelectFinding } = props;

  if (groups.length === 0) {
    return <p>絞り込みに一致する指摘はありません</p>;
  }

  return (
    <ul className={styles.findingList}>
      {groups.map((group) => (
        <FindingListItem
          key={group.head.id}
          group={group}
          selected={group.head.id === selectedFindingId}
          onSelectFinding={onSelectFinding}
        />
      ))}
    </ul>
  );
}

function FindingListItem(props: {
  readonly group: FindingGroup;
  readonly selected: boolean;
  readonly onSelectFinding: (findingId: string) => void;
}) {
  const { group, selected, onSelectFinding } = props;
  const { head, members } = group;
  const rowClassName = selected
    ? `${styles.findingRow} ${styles.findingRowSelected}`
    : styles.findingRow;

  return (
    <li data-finding-id={head.id}>
      <button
        type="button"
        className={rowClassName}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelectFinding(head.id)}
      >
        <span className={styles.findingMeta}>
          <span>{summarizeCategories(members)}</span>
          <span>{summarizeJudgments(members)}</span>
          <span>{summarizeRecheckStates(members)}</span>
          {head.locateStatus !== "located" && (
            <span className={controls.dangerNote}>
              {FINDING_LOCATE_STATUS_LABELS[head.locateStatus]}
            </span>
          )}
        </span>
        <span className={styles.findingQuoteLine}>
          <span className={styles.findingQuote}>{head.quote}</span>
          {members.length > 1 && (
            <span className={styles.findingGroupCount}>{members.length} 案</span>
          )}
        </span>
      </button>
    </li>
  );
}
