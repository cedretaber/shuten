/**
 * 採否と判断メモの操作子（Task 8、決定 13。仕様書 5.3・5.4）。
 *
 * 仕様書 5.3 節「『未判断』『採用予定』『却下』『保留』を区別し、判断は変更できる」に従い
 * 4 状態をラジオで、判断メモを `<textarea maxLength={2000}>`（サーバー側スキーマの上限と同じ）で
 * 入力させる。
 *
 * **操作した時点で保存する**（保存ボタンは持たない）。ラジオを選んだら、その場で `onSave` を
 * 呼ぶ。判断メモは入力欄から離れた（blur の）時点で、直近に保存した（または保存中の）値と
 * 違うときだけ `onSave` を呼ぶ。以前は保存ボタンを押すまで送らなかったが、v1 前の Windows の
 * 実機確認で、保存を押さずに別の指摘を選ぶと選んだ採否が知らないうちに失われることが分かった
 * （このコンポーネントは指摘ごとに作り直されるため）。そこで操作した時点で保存することにした
 * （ユーザーの決定 2026-10-02）。別の指摘をクリックすると、操作子がアンマウントされる前に
 * 入力欄の blur が起きるので、書きかけのメモもその時点で保存される。
 *
 * ラジオだけを送るときも、**その時点の入力欄のメモを必ず一緒に送る**。API は `note` を省略すると
 * メモを null に置き換えるため、状態だけを送るとメモが消える。空欄は `null` で送る。
 *
 * 保存中もラジオ・入力欄は無効にしない。メモを入力したままラジオをクリックすると、先に入力欄の
 * blur が起きて保存が始まるので、ラジオを無効にするとそのクリックが失われる。代わりに保存を
 * 直列にする：`onSave` の実行は同時に 1 つまで。実行中に次の保存を求められたら、最後に求められた
 * 値だけを覚えておき（間の値は捨てる。後の操作を優先する）、実行中の保存が終わってから送る。
 * 求められた値が直近に保存した（または保存中・送信待ちの）値と同じなら送らない。保存の状況は
 * 操作子の下に「保存中…」「保存しました」の 1 行（`role="status"`）で知らせる。「保存しました」は
 * 次にメモを書き換えるまで出す。
 *
 * 保存の実行（`putJudgment` の呼び出しと、一覧・詳細への反映）はこの操作子の責務ではなく、
 * 呼び出し側（`results-page.tsx`）が `onSave` を通じて行う（状態の持ち主を 1 か所にするため）。
 * `onSave` が reject したら、その場にエラーを出し、入力をサーバーで確定している最新の値
 * （`lastConfirmedRef`）に戻し、送信待ちの値も送らずに捨てる——「保存したつもりで保存されて
 * いない」を作らないため。
 *
 * 別の指摘を選び直したときに前の指摘の入力が残らないようにする責務は、呼び出し側が
 * `key={finding.id}` を付けて指摘ごとにこのコンポーネントを作り直すことで満たす
 * （`finding-detail.tsx` を参照）。アンマウントの後に実行中の保存が終わっても、送信待ちの値は
 * 送る（`onSaveRef` から最新の `onSave` を読む）。失敗の表示は呼び出し側がヘッダー直下にも出す
 * （PR21 レビュー指摘 2）。
 *
 * 「採用予定を選んでも本文は書き換わりません」（決定 13。仕様書 5.3「『採用予定』は本文を
 * 書き換えないことを操作付近に明示する」）は、選んだ状態に関わらず操作子の直下に常時表示する
 * （採用予定を選んだときだけ出す、にはしない——選ぶ前に知っておくべき情報のため）。
 *
 * **PR21 レビュー指摘 1**：`judgment` prop は「最新の状態を取得」のたびに新しい参照で
 * 差し替わりうる（同じ指摘が選ばれたままでも、`results-page.tsx` の `fetchAll` が成功するたびに
 * `getFindings` の応答で `findings` 配列ごと作り直されるため）。**編集していない間**は、この新しい
 * `judgment` に追従してラジオ・メモを更新する。ラジオは選んだ時点で保存されるので、「編集中」は
 * 「メモを書き換えたが、まだ保存を求めていない」ことを指す（`dirty`）。メモを入力するたびに立て、
 * メモを含む保存を求めた時点（blur・ラジオの選択）と、保存の失敗で巻き戻した時点で下ろす。
 *
 * 参照比較ではなく `judgment.updatedAt`（サーバーが持つ更新時刻）の変化で「実際に値が変わった
 * か」を判定する（`processedUpdatedAtRef`）。`findings` 配列は再取得のたびに新しい参照で作られる
 * ため、値が同じでも参照だけは毎回変わる——参照比較だと、無関係な再取得のたびに誤って
 * 「別の場所で更新された」表示を出してしまう。届いた値が直近に保存した値と同じ（＝自分の保存の
 * 応答が反映されただけ）か、保存の実行中・送信待ちの間は、入力を上書きしない（後の操作を優先する）。
 *
 * 編集中に新しい `judgment` が届いたときは、入力を勝手に上書きしない代わりに
 * `updatedElsewhere` を立てて短い注記を出す（文言は本ファイルの JSX を参照）。その後メモから
 * 離れたとき、入力が確定済みの値と同じで送る必要がなければ、注記も下ろす（PR #41 レビュー指摘 2）。
 *
 * 失敗時の巻き戻し先は `lastConfirmedRef`（サーバーで確定している最新の値）から読む。
 * `judgment` prop だけを見ると、直列化した 1 本目が成功し、親の再描画が届く前に 2 本目が失敗した
 * とき、1 本目より前の値へ戻してしまう（`onSave` の契約は、resolve の前に新しい `judgment` prop が
 * 届くことを定めていない。PR #41 レビュー指摘 1）。そこで `lastConfirmedRef` を、保存の成功時と、
 * 新しい `judgment` prop が届いた時点（保存の実行中も含む）の両方で、後に起きた方の値に更新する。
 *
 * MUST NOT：採否の記録は `judgments` への記録だけで、本文（原稿版）には一切触れない
 * （`docs/reference/invariants.md`）。このコンポーネントは原稿を書き換える経路を持たない。
 */

import type { JudgmentDto, JudgmentStatus } from "@shuten/shared";
import { JUDGMENT_STATUSES } from "@shuten/shared";
import { useEffect, useId, useRef, useState } from "react";
import controls from "../../styles/controls.module.css";
import { JUDGMENT_STATUS_LABELS } from "./labels.ts";
import styles from "./results-page.module.css";

export interface JudgmentControlProps {
  readonly judgment: JudgmentDto;
  /** 保存を試みる。失敗したら reject する（呼び出し側が握りつぶさない）。 */
  readonly onSave: (status: JudgmentStatus, note: string | null) => Promise<void>;
}

/** 保存する値の組。`note` は送る形（空欄は `null`）で持つ。 */
interface SaveValue {
  readonly status: JudgmentStatus;
  readonly note: string | null;
}

function toSaveValue(status: JudgmentStatus, note: string): SaveValue {
  return { status, note: note === "" ? null : note };
}

function sameValue(a: SaveValue, b: SaveValue): boolean {
  return a.status === b.status && a.note === b.note;
}

type SaveState = "idle" | "saving" | "saved";

export function JudgmentControl(props: JudgmentControlProps) {
  const { judgment, onSave } = props;
  const groupName = useId();

  const [status, setStatus] = useState<JudgmentStatus>(judgment.status);
  const [note, setNote] = useState<string>(judgment.note ?? "");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  // 編集中かどうか（PR21 レビュー指摘 1）。メモを書き換えたが、まだ保存を求めていない間だけ true。
  // true の間は、新しい `judgment` prop が届いても入力を上書きしない。
  const [dirty, setDirty] = useState(false);
  // 編集中に、別の場所（「最新の状態を取得」による再取得など）で採否が更新されたことを示す注記。
  const [updatedElsewhere, setUpdatedElsewhere] = useState(false);

  // 送信待ちの値を後から送るとき（アンマウントの後を含む）に、最新の `onSave` を読むための参照。
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // 直近に処理した `judgment.updatedAt`。参照ではなく値（サーバーの更新時刻）で「実際に採否が
  // 変わったか」を判定する（`findings` 配列は再取得のたびに新しい参照で作られるため、参照比較
  // だと無関係な再取得のたびに誤検知する）。
  const processedUpdatedAtRef = useRef(judgment.updatedAt);

  // 保存の直列化（コメント冒頭を参照）。描画に使わないので ref で持つ。
  // 直近に保存に成功した、または実行中の値。送るかどうかの比較の基準。
  const lastSentRef = useRef<SaveValue>(toSaveValue(judgment.status, judgment.note ?? ""));
  // サーバーで確定している最新の値。失敗時の巻き戻し先（コメント冒頭を参照）。
  const lastConfirmedRef = useRef<SaveValue>(toSaveValue(judgment.status, judgment.note ?? ""));
  const inFlightRef = useRef(false);
  // 実行中に求められた保存のうち、最後のものだけ。
  const queuedRef = useRef<SaveValue | null>(null);

  useEffect(() => {
    if (processedUpdatedAtRef.current === judgment.updatedAt) return;
    processedUpdatedAtRef.current = judgment.updatedAt;
    const incoming = toSaveValue(judgment.status, judgment.note ?? "");
    lastConfirmedRef.current = incoming;
    // 保存の実行中・送信待ちの間は、届いた値で入力を上書きしない（後の操作を優先する）。
    // 直近に保存した値と同じなら、自分の保存の応答が反映されただけなので何もしない。
    if (inFlightRef.current || queuedRef.current !== null) return;
    if (sameValue(incoming, lastSentRef.current)) return;
    lastSentRef.current = incoming;
    if (dirty) {
      // 編集中は入力を勝手に上書きしない。代わりに「別の場所で更新された」ことだけ示す。
      setUpdatedElsewhere(true);
      return;
    }
    setStatus(judgment.status);
    setNote(judgment.note ?? "");
  }, [judgment, dirty]);

  const send = (value: SaveValue) => {
    inFlightRef.current = true;
    lastSentRef.current = value;
    setSaveState("saving");
    setError(null);
    onSaveRef.current(value.status, value.note).then(
      () => {
        inFlightRef.current = false;
        // 次を送る前に、成功した値を確定値として持つ（次が失敗したときの巻き戻し先）。
        lastConfirmedRef.current = value;
        const next = queuedRef.current;
        queuedRef.current = null;
        if (next !== null) {
          send(next);
          return;
        }
        setSaveState("saved");
        setUpdatedElsewhere(false);
      },
      (cause: unknown) => {
        inFlightRef.current = false;
        // 失敗したら送信待ちの値は送らずに捨てる。
        queuedRef.current = null;
        // 入力をサーバーで確定している最新の値に戻す（「保存したつもりで保存されていない」を
        // 作らない）。`judgment` prop ではなく `lastConfirmedRef` を読む（コメント冒頭を参照）。
        const confirmed = lastConfirmedRef.current;
        lastSentRef.current = confirmed;
        setStatus(confirmed.status);
        setNote(confirmed.note ?? "");
        setError(cause instanceof Error ? cause.message : "保存に失敗しました");
        setSaveState("idle");
        setDirty(false);
        setUpdatedElsewhere(false);
      },
    );
  };

  const requestSave = (value: SaveValue) => {
    // メモを含めて保存を求めたので、もう「編集中」ではない。
    setDirty(false);
    const target = queuedRef.current ?? lastSentRef.current;
    if (sameValue(value, target)) {
      // 保存の実行中・送信待ちでなければ、入力はサーバーの値と同じなので、「まだ保存されて
      // いません」の注記も下ろす（PR #41 レビュー指摘 2）。
      if (!inFlightRef.current && queuedRef.current === null) setUpdatedElsewhere(false);
      return;
    }
    if (inFlightRef.current) {
      // 実行中の値と同じなら、送信待ちを取り消すだけでよい（実行中の保存がその値になる）。
      queuedRef.current = sameValue(value, lastSentRef.current) ? null : value;
      return;
    }
    send(value);
  };

  const handleStatusChange = (value: JudgmentStatus) => {
    setStatus(value);
    // 状態だけでなく、その時点の入力欄のメモも必ず一緒に送る（API は note の省略を null とみなす）。
    requestSave(toSaveValue(value, note));
  };

  const handleNoteChange = (value: string) => {
    setNote(value);
    setDirty(true);
    // 「保存しました」は次にメモを書き換えるまで出す（保存中の表示はそのまま残す）。
    setSaveState((prev) => (prev === "saved" ? "idle" : prev));
  };

  const handleNoteBlur = () => {
    requestSave(toSaveValue(status, note));
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
          className={`${controls.input} ${styles.judgmentNoteTextarea}`}
          maxLength={2000}
          value={note}
          onChange={(event) => handleNoteChange(event.target.value)}
          onBlur={handleNoteBlur}
        />
      </label>

      {error !== null && <p className={controls.errorBox}>{error}</p>}

      {/* 保存の状況。読み上げのため、空のときも要素は置いておく。 */}
      <p role="status" className={styles.judgmentSaveStatus}>
        {saveState === "saving" ? "保存中…" : saveState === "saved" ? "保存しました" : ""}
      </p>
    </div>
  );
}
