/**
 * 確定済みの原稿の表示（決定 11・17）。
 *
 * 原稿名・書記素数・確定日時と「確定後の本文は変更できない」旨を出す。書記素数は
 * `countGraphemes` を `useMemo` で `version.body` が変わったとき（＝別の原稿版になったとき）だけ
 * 数え、再描画のたびには数えない。
 *
 * プレビューは書記素境界で切った先頭 500 書記素（`buildPreview`）。本文が 500 書記素以下なら
 * `truncated: false` になり、全文展開の操作自体を出さない。500 書記素を超えるときだけ折りたたみを
 * 出し、**開いているときだけ**全文を DOM に足す（閉じているときは `<details>` の子に何も置かない）。
 */

import type { ManuscriptVersionDto } from "@shuten/shared";
import { countGraphemes } from "@shuten/shared";
import { useMemo, useState } from "react";
import styles from "./manuscript.module.css";
import { buildPreview } from "./preview.ts";

export function ManuscriptConfirmed(props: {
  version: ManuscriptVersionDto;
  onReset: () => void;
}): React.JSX.Element {
  const { version, onReset } = props;

  // `version.body` が同じ間は再計算しない（確定後に 1 回だけ数える、という要件）。
  const graphemeCount = useMemo(() => countGraphemes(version.body), [version.body]);
  const preview = useMemo(() => buildPreview(version.body), [version.body]);
  const createdAtLabel = useMemo(
    () => new Date(version.createdAt).toLocaleString("ja-JP"),
    [version.createdAt],
  );

  const [expanded, setExpanded] = useState(false);

  return (
    <div className={styles.confirmed}>
      <h2>確定済みの原稿</h2>

      <dl className={styles.summary}>
        <dt>原稿名</dt>
        <dd>{version.name}</dd>
        <dt>文字数</dt>
        <dd>{graphemeCount} 字</dd>
        <dt>確定日時</dt>
        <dd>{createdAtLabel}</dd>
      </dl>

      <p className={styles.note}>確定後の本文は変更できません。</p>

      <pre className={styles.preview}>{preview.text}</pre>

      {preview.truncated && (
        <details
          className={styles.fullTextDetails}
          open={expanded}
          onToggle={(event) => {
            // 開閉状態は常に React（useState）が持つ（決定 17）。ネイティブの開閉イベントを
            // 拾って同期するだけで、開閉そのものはブラウザの既定動作に任せる。
            setExpanded(event.currentTarget.open);
          }}
        >
          <summary>{expanded ? "全文を閉じる" : "全文を表示する"}</summary>
          {/* 閉じている間は下の全文を DOM に足さない：<details> に入れっぱなしにすると、
              閉じていても子要素は DOM に存在し続け、10 万字級の描画を避けられない。 */}
          {expanded && <pre className={styles.fullText}>{version.body}</pre>}
        </details>
      )}

      <button type="button" className={styles.resetButton} onClick={onReset}>
        別の原稿を選ぶ
      </button>
    </div>
  );
}
