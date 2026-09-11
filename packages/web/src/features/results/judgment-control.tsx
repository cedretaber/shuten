/**
 * 採否と判断メモの操作子（Task 8、決定 13。仕様書 5.3・5.4）。
 *
 * 仕様書 5.3 節「『未判断』『採用予定』『却下』『保留』を区別し、判断は変更できる」に従い
 * 4 状態をラジオで、判断メモを `<textarea maxLength={2000}>`（サーバー側スキーマの上限と同じ）で
 * 入力させる。**保存ボタンを押すまで `onSave` を呼ばない**（ラジオ・メモの変更はこの操作子の中に
 * だけ留め、送信しない）。保存中はボタンを無効にする。
 *
 * 保存の実行（`putJudgment` の呼び出しと、一覧・詳細への反映）はこの操作子の責務ではなく、
 * 呼び出し側（`results-page.tsx`）が `onSave` を通じて行う（状態の持ち主を 1 か所にするため）。
 * `onSave` が reject したら、その場にエラーを出し、入力を保存前の値（`judgment` prop）に戻す
 * ——「保存したつもりで保存されていない」を作らないため。
 *
 * 別の指摘を選び直したときに前の指摘の入力が残らないようにする責務は、呼び出し側が
 * `key={finding.id}` を付けて指摘ごとにこのコンポーネントを作り直すことで満たす
 * （`finding-detail.tsx` を参照）。
 *
 * 「採用予定を選んでも本文は書き換わりません」（決定 13。仕様書 5.3「『採用予定』は本文を
 * 書き換えないことを操作付近に明示する」）は、選んだ状態に関わらず操作子の直下に常時表示する
 * （採用予定を選んだときだけ出す、にはしない——選ぶ前に知っておくべき情報のため）。
 *
 * MUST NOT：採否の記録は `judgments` への記録だけで、本文（原稿版）には一切触れない
 * （`docs/reference/invariants.md`）。このコンポーネントは原稿を書き換える経路を持たない。
 */

import type { JudgmentDto, JudgmentStatus } from "@shuten/shared";
import { JUDGMENT_STATUSES } from "@shuten/shared";
import { useId, useState } from "react";
import { JUDGMENT_STATUS_LABELS } from "./labels.ts";
import styles from "./results-page.module.css";

export interface JudgmentControlProps {
  readonly judgment: JudgmentDto;
  /** 保存を試みる。失敗したら reject する（呼び出し側が握りつぶさない）。 */
  readonly onSave: (status: JudgmentStatus, note: string | null) => Promise<void>;
}

export function JudgmentControl(props: JudgmentControlProps) {
  const { judgment, onSave } = props;
  const groupName = useId();

  const [status, setStatus] = useState<JudgmentStatus>(judgment.status);
  const [note, setNote] = useState<string>(judgment.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = () => {
    setSaving(true);
    setError(null);
    const noteToSend = note === "" ? null : note;
    onSave(status, noteToSend).then(
      () => {
        setSaving(false);
      },
      (cause: unknown) => {
        setSaving(false);
        // 失敗時は入力を保存前の値（judgment prop）に戻す（「保存したつもりで保存されていない」
        // を作らない）。
        setStatus(judgment.status);
        setNote(judgment.note ?? "");
        setError(cause instanceof Error ? cause.message : "保存に失敗しました");
      },
    );
  };

  return (
    <div className={styles.judgmentControl}>
      <fieldset className={styles.judgmentStatusGroup}>
        <legend>採否</legend>
        {JUDGMENT_STATUSES.map((value) => (
          <label key={value} className={styles.judgmentStatusOption}>
            <input
              type="radio"
              name={groupName}
              value={value}
              checked={status === value}
              disabled={saving}
              onChange={() => setStatus(value)}
            />
            {JUDGMENT_STATUS_LABELS[value]}
          </label>
        ))}
      </fieldset>

      {/* 決定 13：選んだ状態に関わらず常時表示する。 */}
      <p className={styles.judgmentAdoptPlannedNote}>
        「採用予定」を選んでも本文（原稿）は書き換わりません。本文への反映は別途行ってください。
      </p>

      <label className={styles.judgmentNoteLabel}>
        判断メモ（任意）
        <textarea
          className={styles.judgmentNoteTextarea}
          maxLength={2000}
          value={note}
          disabled={saving}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      {error !== null && <p className={styles.error}>{error}</p>}

      <button
        type="button"
        className={styles.judgmentSaveButton}
        disabled={saving}
        onClick={handleSave}
      >
        {saving ? "保存中…" : "保存"}
      </button>
    </div>
  );
}
