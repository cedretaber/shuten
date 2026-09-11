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
 * **PR21 レビュー指摘 1**：`judgment` prop は「最新の状態を取得」のたびに新しい参照で
 * 差し替わりうる（同じ指摘が選ばれたままでも、`results-page.tsx` の `fetchAll` が成功するたびに
 * `getFindings` の応答で `findings` 配列ごと作り直されるため）。**編集していない間**（ラジオ・
 * メモのどちらも触っていない間）は、この新しい `judgment` に追従してラジオ・メモを更新する。
 * 「編集したか」は素直な `dirty` フラグで判定する——ラジオを選ぶ・メモを入力するたびに立て、
 * 保存の成功・失敗のどちらでも下ろす（保存が終われば、入力は「保存前の値」か「今まさに保存した
 * 値」のどちらかに一致するので、もう「編集中」ではない）。
 *
 * 参照比較ではなく `judgment.updatedAt`（サーバーが持つ更新時刻）の変化で「実際に値が変わった
 * か」を判定する（`processedUpdatedAtRef`）。`findings` 配列は再取得のたびに新しい参照で作られる
 * ため、値が同じでも参照だけは毎回変わる——参照比較だと、無関係な再取得のたびに誤って
 * 「別の場所で更新された」表示を出してしまう。
 *
 * 編集中に新しい `judgment` が届いたときは、入力を勝手に上書きしない代わりに
 * `updatedElsewhere` を立てて短い注記を出す（文言は本ファイルの JSX を参照）。保存前の値を
 * 参照する箇所（失敗時の巻き戻し）は `judgment` prop を直接ではなく `latestJudgmentRef`
 * （毎レンダーで同期する ref）から読む——`handleSave` はレンダーごとに作り直されるクロージャで、
 * 保存の応答が返ってくる頃には `judgment` prop がさらに新しくなっている場合があるため、常に
 * 最新の値を読めるようにする。
 *
 * MUST NOT：採否の記録は `judgments` への記録だけで、本文（原稿版）には一切触れない
 * （`docs/reference/invariants.md`）。このコンポーネントは原稿を書き換える経路を持たない。
 */

import type { JudgmentDto, JudgmentStatus } from "@shuten/shared";
import { JUDGMENT_STATUSES } from "@shuten/shared";
import { useEffect, useId, useRef, useState } from "react";
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
  // 編集済みかどうか（PR21 レビュー指摘 1）。ラジオ・メモのどちらかを触ったら true にする、
  // 素直な dirty フラグ。true の間は、新しい `judgment` prop が届いても入力を上書きしない。
  const [dirty, setDirty] = useState(false);
  // 編集中に、別の場所（「最新の状態を取得」による再取得など）で採否が更新されたことを示す注記。
  const [updatedElsewhere, setUpdatedElsewhere] = useState(false);

  // 毎レンダーで同期する「常に最新の judgment」参照（コメント冒頭を参照）。失敗時の巻き戻しで、
  // クロージャに固定された古い `judgment` ではなく常に最新の値を読むために使う。
  const latestJudgmentRef = useRef(judgment);
  latestJudgmentRef.current = judgment;

  // 直近に処理した `judgment.updatedAt`。参照ではなく値（サーバーの更新時刻）で「実際に採否が
  // 変わったか」を判定する（`findings` 配列は再取得のたびに新しい参照で作られるため、参照比較
  // だと無関係な再取得のたびに誤検知する）。
  const processedUpdatedAtRef = useRef(judgment.updatedAt);

  useEffect(() => {
    if (processedUpdatedAtRef.current === judgment.updatedAt) return;
    processedUpdatedAtRef.current = judgment.updatedAt;
    if (dirty) {
      // 編集中は入力を勝手に上書きしない。代わりに「別の場所で更新された」ことだけ示す。
      setUpdatedElsewhere(true);
      return;
    }
    setStatus(judgment.status);
    setNote(judgment.note ?? "");
  }, [judgment, dirty]);

  const handleSave = () => {
    setSaving(true);
    setError(null);
    const noteToSend = note === "" ? null : note;
    onSave(status, noteToSend).then(
      () => {
        setSaving(false);
        // 保存が終われば、入力は「今まさに保存した値」に一致するので、もう編集中ではない。
        // これを下ろしておかないと、この後で届く新しい `judgment` prop（今回の保存自体に
        // よるもの）を「別の場所での更新」と誤検知してしまう。
        setDirty(false);
        setUpdatedElsewhere(false);
      },
      (cause: unknown) => {
        setSaving(false);
        // 失敗時は入力を保存前の値に戻す（「保存したつもりで保存されていない」を作らない）。
        // `judgment` ではなく `latestJudgmentRef.current` を読む——保存の応答が届く頃には
        // `judgment` prop がさらに新しくなっている場合があるため。
        const latest = latestJudgmentRef.current;
        setStatus(latest.status);
        setNote(latest.note ?? "");
        setError(cause instanceof Error ? cause.message : "保存に失敗しました");
        setDirty(false);
        setUpdatedElsewhere(false);
      },
    );
  };

  const handleStatusChange = (value: JudgmentStatus) => {
    setStatus(value);
    setDirty(true);
  };

  const handleNoteChange = (value: string) => {
    setNote(value);
    setDirty(true);
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
              onChange={() => handleStatusChange(value)}
            />
            {JUDGMENT_STATUS_LABELS[value]}
          </label>
        ))}
      </fieldset>

      {/* 決定 13：選んだ状態に関わらず常時表示する。 */}
      <p className={styles.judgmentAdoptPlannedNote}>
        「採用予定」を選んでも本文（原稿）は書き換わりません。本文への反映は別途行ってください。
      </p>

      {/* PR21 レビュー指摘 1：編集中に別の場所で採否が更新されたことを示す注記。 */}
      {updatedElsewhere && (
        <p className={styles.judgmentUpdatedElsewhere}>
          採否が別の場所で更新されました。この入力欄の内容はまだ保存されていません。
        </p>
      )}

      <label className={styles.judgmentNoteLabel}>
        判断メモ（任意）
        <textarea
          className={styles.judgmentNoteTextarea}
          maxLength={2000}
          value={note}
          disabled={saving}
          onChange={(event) => handleNoteChange(event.target.value)}
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
