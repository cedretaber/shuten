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
 */

import type { FindingDto } from "@shuten/shared";
import { RECHECK_STATE_LABELS, recheckStateOf } from "./finding-filter.ts";
import {
  FINDING_CATEGORY_LABELS,
  FINDING_LOCATE_STATUS_LABELS,
  JUDGMENT_STATUS_LABELS,
} from "./labels.ts";
import styles from "./results-page.module.css";

export interface FindingListProps {
  /** 絞り込み後、一覧に出す指摘（呼び出し側が渡した順のまま描く）。 */
  readonly findings: readonly FindingDto[];
  /** 選択中の指摘 ID。無ければ null。 */
  readonly selectedFindingId: string | null;
  readonly onSelectFinding: (findingId: string) => void;
}

export function FindingList(props: FindingListProps) {
  const { findings, selectedFindingId, onSelectFinding } = props;

  if (findings.length === 0) {
    return <p>絞り込みに一致する指摘はありません</p>;
  }

  return (
    <ul className={styles.findingList}>
      {findings.map((finding) => (
        <FindingListItem
          key={finding.id}
          finding={finding}
          selected={finding.id === selectedFindingId}
          onSelectFinding={onSelectFinding}
        />
      ))}
    </ul>
  );
}

function FindingListItem(props: {
  readonly finding: FindingDto;
  readonly selected: boolean;
  readonly onSelectFinding: (findingId: string) => void;
}) {
  const { finding, selected, onSelectFinding } = props;
  const rowClassName = selected
    ? `${styles.findingRow} ${styles.findingRowSelected}`
    : styles.findingRow;

  return (
    <li>
      <button
        type="button"
        className={rowClassName}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelectFinding(finding.id)}
      >
        <span className={styles.findingMeta}>
          <span>{FINDING_CATEGORY_LABELS[finding.category]}</span>
          <span>{JUDGMENT_STATUS_LABELS[finding.judgment.status]}</span>
          <span>{RECHECK_STATE_LABELS[recheckStateOf(finding)]}</span>
          {finding.locateStatus !== "located" && (
            <span className={styles.findingLocateFailure}>
              {FINDING_LOCATE_STATUS_LABELS[finding.locateStatus]}
            </span>
          )}
        </span>
        <span className={styles.findingQuote}>{finding.quote}</span>
      </button>
    </li>
  );
}
