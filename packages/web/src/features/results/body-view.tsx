/**
 * 本文の描画（Task 4、決定 6・申し送り 3・4）。
 *
 * `buildBodyView`（`body-view.ts`）が保存済みの UTF-16 範囲から作った段落・セグメント列を、
 * 改行文字を DOM に入れずに描く。段落ブロック（`<p data-paragraph-id>`）が改行を担い、
 * 容器（`.body`）は `white-space: pre-wrap` で段落内の空白・全角字下げを保つ
 * （仕様書 9「本文とモデル出力は HTML として実行せず、テキストとして表示する」）。
 *
 * 選択中の指摘の塗り分けは DOM を手で書き換えず、props（`selectedIdHere`）として
 * React に渡して描かせる（決定 6）。強調の集合は後続タスク（絞り込み）に応じて
 * 作り直されるため、`ref` から class を付け外しする実装は選択肢から外している。
 *
 * `BodyParagraphView` は `React.memo` を明示の比較関数 `paragraphPropsEqual` で包む。
 * 呼び出し側（`BodyView` の利用者）は `paragraphs` を `useMemo`（`body` と `highlights` に
 * 依存）、`onSelectFinding` を `useCallback` で作って参照を安定させること。参照が
 * 安定していなければ `paragraphPropsEqual` は常に false を返し、`React.memo` は
 * 何も抑止しない。
 */

import type { ReactNode } from "react";
import { memo } from "react";
import type { BodyParagraph, BodySegment } from "./body-view.ts";
import styles from "./results.module.css";

export interface BodyViewProps {
  readonly paragraphs: readonly BodyParagraph[];
  /** 選択中の指摘 ID。無ければ null。 */
  readonly selectedFindingId: string | null;
  /** 強調をクリックしたとき。複数の指摘が重なる場合は先頭の ID が渡る（決定 8）。 */
  readonly onSelectFinding: (findingId: string) => void;
}

export function BodyView(props: BodyViewProps) {
  const { paragraphs, selectedFindingId, onSelectFinding } = props;

  return (
    <div className={styles.body}>
      {paragraphs.map((paragraph) => (
        <BodyParagraphView
          key={paragraph.id}
          paragraph={paragraph}
          selectedIdHere={selectedIdInParagraph(paragraph, selectedFindingId)}
          onSelectFinding={onSelectFinding}
        />
      ))}
    </div>
  );
}

/**
 * その段落に `selectedFindingId` を含むセグメントがあれば `selectedFindingId`、無ければ `null`。
 * `BodyParagraphProps.selectedIdHere` の定義そのもの。
 */
function selectedIdInParagraph(
  paragraph: BodyParagraph,
  selectedFindingId: string | null,
): string | null {
  if (selectedFindingId === null) {
    return null;
  }
  const hasSelected = paragraph.segments.some((segment) =>
    segment.findingIds.includes(selectedFindingId),
  );
  return hasSelected ? selectedFindingId : null;
}

/** 段落コンポーネントの props。 */
export interface BodyParagraphProps {
  readonly paragraph: BodyParagraph;
  readonly selectedIdHere: string | null;
  readonly onSelectFinding: (findingId: string) => void;
}

/**
 * `React.memo` に渡す比較関数。3 つの props をすべて参照等価で比べる。
 *
 * `selectedIdHere` は文字列（プリミティブ）なので `===` は値の比較になるが、
 * `paragraph` と `onSelectFinding` は参照比較になる——呼び出し側が参照を安定させて
 * いない限り、内容が同じでも別インスタンスなら false になる（それが意図どおり。
 * 単体テストの R2-3 で検査する）。
 */
export function paragraphPropsEqual(a: BodyParagraphProps, b: BodyParagraphProps): boolean {
  return (
    a.paragraph === b.paragraph &&
    a.selectedIdHere === b.selectedIdHere &&
    a.onSelectFinding === b.onSelectFinding
  );
}

const BodyParagraphView = memo(function BodyParagraphView(props: BodyParagraphProps): ReactNode {
  const { paragraph, selectedIdHere, onSelectFinding } = props;

  return (
    <p data-paragraph-id={paragraph.id} className={styles.paragraph}>
      {paragraph.segments.map((segment) => renderSegment(segment, selectedIdHere, onSelectFinding))}
    </p>
  );
}, paragraphPropsEqual);

/**
 * セグメント 1 つ分を描く。
 *
 * 素のセグメント（`findingIds` が空）は `<span>` で包まずテキストノードのまま返す。
 * 強調は `<span data-findings="id1 id2">`（`~=` 属性セレクターで 1 つの ID を引ける
 * 空白区切り）で、クリックのハンドラーはこの `<span>` に直接付ける（容器への委譲にしない）。
 */
function renderSegment(
  segment: BodySegment,
  selectedIdHere: string | null,
  onSelectFinding: (findingId: string) => void,
): ReactNode {
  const firstId = segment.findingIds[0];
  if (firstId === undefined) {
    return segment.text;
  }

  const isSelected = selectedIdHere !== null && segment.findingIds.includes(selectedIdHere);
  const className = isSelected
    ? `${styles.highlight} ${styles.highlightSelected}`
    : styles.highlight;

  return (
    // 強調は Task 4 のブリーフどおり素の <span> + onClick で描く。キーボード操作・
    // フォーカス管理（role / tabIndex / onKeyDown）は本文中の移動を実装する Task 9 が
    // 選択操作全体の設計と合わせて決める（Task 4 のブリーフは対象外）。
    // biome-ignore lint/a11y/noStaticElementInteractions: 上記の理由
    // biome-ignore lint/a11y/useKeyWithClickEvents: 上記の理由
    <span
      key={segment.start}
      data-findings={segment.findingIds.join(" ")}
      className={className}
      onClick={() => onSelectFinding(firstId)}
    >
      {segment.text}
    </span>
  );
}
