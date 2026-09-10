/**
 * 検査設定フォームと開始ボタン（決定 7・12・13・15）。
 *
 * ここに出すのは仕様 5.2 の 6 項目（検査観点、分割長、初回の参考文脈、再確認の有無、
 * 再確認の参考文脈、許容語）だけ。残りの 8 項目（`maxTokens` / `temperature` / `seed` /
 * `reasoningEffort` / `roundingTolerance` / `maxInputGraphemes` / `checkMs` / `recheckMs`）は
 * 設定画面（`/settings`）の「詳細な検査設定」へ移した（PR11c 決定 1）。この画面には
 * `AdvancedSettingsSummary` で**要約と入口だけ**を残す。要約を残すのは、詳細を別画面へ移した
 * だけだと「自分が変えた覚えの無い設定で検査が走る」状態を作れてしまうため。
 *
 * 詳細設定は `advanced` という 1 つの state に**保存形式のまま**（丸め許容は 0〜1、
 * タイムアウトはミリ秒）持ち、マウント時に一度だけ読む（決定 7）。要約に出す値と開始要求に
 * 載せる値はどちらもこの `advanced` から作る。開始の直前に `localStorage` を読み直すと、
 * 画面に出ている要約と実際に送る値が食い違いうる。単位の変換（秒・パーセント）は
 * 設定画面の入力欄側が担い、ここでは行わない。
 *
 * 許容語は原稿版と組で保存し、同じ原稿版のときだけ復元する（決定 7）。復元は
 * `manuscriptVersionId` が変わるたびに効かせる `useEffect` で行い、書き込みは入力の
 * `onChange` で直接行う（restore 用の effect と write 用の effect を両方持つと、マウント時に
 * どちらが先に走るかで復元前の値を上書きしてしまう競合が起きるため、書き込み側は effect にしない）。
 *
 * 基本の検査設定（`runSettings` の自分の持ち分）は原稿版に依存しないので、初期値は `useState` の
 * 遅延初期化子で一度だけ `localStorage` から読み、変更のたびに `useEffect` で書き戻す。
 *
 * `startOperationId` の生成・接続確認・クライアント検証・スナップショットの固定・再送は
 * すべて `useStartRun`（`use-start-run.ts`）に任せる。ここでは画面の入力を集め、
 * `StartRunRequest`（`startOperationId` を除く）を組み立てて渡すだけ。
 */

import type { ChunkSettingsRequest, GenerationSettingsRequest, Perspective } from "@shuten/shared";
import { type ChangeEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { ROUTES } from "../../app/routes.ts";
import { STORAGE_KEYS } from "../../storage/keys.ts";
import {
  readStored,
  type StoredAllowedWords,
  storedAllowedWordsSchema,
  writeStored,
} from "../../storage/local.ts";
import {
  readAdvancedRunSettings,
  readBasicRunSettings,
  resetAdvancedRunSettings,
  writeBasicRunSettings,
} from "../../storage/run-settings.ts";
import { AdvancedSettingsSummary } from "./advanced-settings-summary.tsx";
import styles from "./settings.module.css";
import type { StartRunApi } from "./use-start-run.ts";

const EMPTY_ALLOWED_WORDS: StoredAllowedWords = { manuscriptVersionId: "", allowedWordsRaw: "" };

/** 同じ原稿版のときだけ復元し、それ以外は空から始める（決定 7）。 */
function restoreAllowedWords(manuscriptVersionId: string | null): string {
  if (manuscriptVersionId === null) return "";
  const stored = readStored(
    STORAGE_KEYS.allowedWords,
    storedAllowedWordsSchema,
    EMPTY_ALLOWED_WORDS,
  );
  return stored.manuscriptVersionId === manuscriptVersionId ? stored.allowedWordsRaw : "";
}

const PERSPECTIVE_LABELS: Record<Perspective, string> = {
  typo: "誤字・脱字",
  naturalness: "日本語の自然さ",
};

export interface RunSettingsFormProps {
  /** 確定済みの原稿版 ID。未確定なら null（このとき開始ボタンは disabled）。 */
  readonly manuscriptVersionId: string | null;
  /** 選択中のモデル ID。未選択なら null（このとき開始ボタンは disabled）。 */
  readonly modelId: string | null;
  /** 原稿の復元 GET が進行中かどうか。true の間は開始させない。 */
  readonly restoring: boolean;
  readonly startApi: StartRunApi;
}

export function RunSettingsForm(props: RunSettingsFormProps): React.JSX.Element {
  const { manuscriptVersionId, modelId, restoring, startApi } = props;

  // 遅延初期化子でマウント時に一度だけ読む（毎レンダーで localStorage を読み直さない）。
  const [initialBasic] = useState(readBasicRunSettings);

  const [perspectives, setPerspectives] = useState<readonly Perspective[]>(
    initialBasic.perspectives,
  );
  const [targetGraphemes, setTargetGraphemes] = useState(initialBasic.targetGraphemes);
  const [contextGraphemes, setContextGraphemes] = useState(initialBasic.contextGraphemes);
  const [recheckEnabled, setRecheckEnabled] = useState(initialBasic.recheckEnabled);
  const [recheckContextGraphemes, setRecheckContextGraphemes] = useState(
    initialBasic.recheckContextGraphemes,
  );

  // 詳細設定は設定画面が編集する。ここは要約の表示と開始要求の組み立てのために、
  // 保存形式のまま 1 つの state として持つだけ（決定 7）。入力欄はこの画面には無いので、
  // 保存の書き戻し（`useEffect`）も持たない。書くのは「既定値に戻す」のときだけ。
  const [advanced, setAdvanced] = useState(readAdvancedRunSettings);

  // 許容語は原稿版と組で保存する（決定 7）。遅延初期化子で最初の一度だけ読み、
  // `manuscriptVersionId` が変わるたびに復元し直す。書き込みは textarea の onChange で行う
  // （effect にすると、マウント直後の復元 effect と競合して復元前の値を上書きしうる）。
  const [allowedWordsRaw, setAllowedWordsRaw] = useState<string>(() =>
    restoreAllowedWords(manuscriptVersionId),
  );
  useEffect(() => {
    setAllowedWordsRaw(restoreAllowedWords(manuscriptVersionId));
  }, [manuscriptVersionId]);

  // 基本の検査設定は変更のたびに保存する（W7-19）。原稿版に依存しないため、復元用の effect は無い
  // （初期値は上の useState の遅延初期化子で読み込み済み）。詳細の持ち分には触らない
  // （`writeBasicRunSettings` が保存値の自分の持ち分だけを差し替える）。
  useEffect(() => {
    writeBasicRunSettings({
      perspectives,
      recheckEnabled,
      targetGraphemes,
      contextGraphemes,
      recheckContextGraphemes,
    });
  }, [perspectives, recheckEnabled, targetGraphemes, contextGraphemes, recheckContextGraphemes]);

  /**
   * 詳細設定を既定値に戻す（決定 5）。`localStorage` を書くだけにすると、この画面が持っている
   * `advanced` が古いまま残り、要約と次の開始要求だけが「戻す前」に取り残される。
   * `resetAdvancedRunSettings()` の**戻り値**で state も同時に更新する。
   */
  const handleResetAdvanced = () => {
    setAdvanced(resetAdvancedRunSettings());
  };

  const handleAllowedWordsChange = (value: string) => {
    setAllowedWordsRaw(value);
    if (manuscriptVersionId !== null) {
      writeStored(STORAGE_KEYS.allowedWords, { manuscriptVersionId, allowedWordsRaw: value });
    }
  };

  const togglePerspective = (perspective: Perspective) => {
    setPerspectives((prev) => {
      if (prev.includes(perspective)) {
        if (prev.length <= 1) return prev; // 最後の 1 つは外せない（W7-4）
        return prev.filter((item) => item !== perspective);
      }
      return [...prev, perspective];
    });
  };

  const numberField =
    (setter: (value: number) => void) => (event: ChangeEvent<HTMLInputElement>) => {
      setter(Number(event.target.value));
    };

  const startDisabled =
    restoring ||
    manuscriptVersionId === null ||
    modelId === null ||
    startApi.outcome.kind === "sending";

  const handleStart = () => {
    if (manuscriptVersionId === null || modelId === null) return;

    // 詳細の持ち分は、要約に出しているのと同じ `advanced` から取る（決定 7）。
    // ここで `localStorage` を読み直すと、画面に出ている要約と送る値が食い違いうる。
    const generation: GenerationSettingsRequest = { ...advanced.generation };
    const chunkSettings: ChunkSettingsRequest = {
      targetGraphemes,
      contextGraphemes,
      recheckContextGraphemes,
      roundingTolerance: advanced.roundingTolerance,
      maxInputGraphemes: advanced.maxInputGraphemes,
    };

    void startApi.start({
      manuscriptVersionId,
      modelId,
      generation,
      chunkSettings,
      timeouts: { checkMs: advanced.timeouts.checkMs, recheckMs: advanced.timeouts.recheckMs },
      perspectives: [...perspectives],
      recheckEnabled,
      allowedWordsRaw,
    });
  };

  return (
    <div className={styles.form}>
      <h2>検査設定</h2>

      <fieldset className={styles.section}>
        <legend className={styles.legend}>検査観点</legend>
        <div className={styles.perspectiveChoice}>
          {(Object.keys(PERSPECTIVE_LABELS) as Perspective[]).map((perspective) => (
            <label key={perspective} className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={perspectives.includes(perspective)}
                onChange={() => togglePerspective(perspective)}
              />
              {PERSPECTIVE_LABELS[perspective]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="settings-target-graphemes">
          検査対象の分割長（字）
        </label>
        <input
          id="settings-target-graphemes"
          className={styles.input}
          type="number"
          min={1}
          value={targetGraphemes}
          onChange={numberField(setTargetGraphemes)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="settings-context-graphemes">
          初回の参考文脈（字）
        </label>
        <input
          id="settings-context-graphemes"
          className={styles.input}
          type="number"
          min={0}
          value={contextGraphemes}
          onChange={numberField(setContextGraphemes)}
        />
      </div>

      <label className={styles.checkboxField}>
        <input
          id="settings-recheck-enabled"
          type="checkbox"
          checked={recheckEnabled}
          onChange={(event) => setRecheckEnabled(event.target.checked)}
        />
        再確認を行う
      </label>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="settings-recheck-context-graphemes">
          再確認の参考文脈（字）
        </label>
        <input
          id="settings-recheck-context-graphemes"
          className={styles.input}
          type="number"
          min={0}
          value={recheckContextGraphemes}
          onChange={numberField(setRecheckContextGraphemes)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="settings-allowed-words">
          許容語（改行区切り）
        </label>
        <textarea
          id="settings-allowed-words"
          className={styles.textarea}
          value={allowedWordsRaw}
          onChange={(event) => handleAllowedWordsChange(event.target.value)}
          disabled={manuscriptVersionId === null}
        />
        {manuscriptVersionId === null && (
          <p className={styles.modelNote}>
            原稿を確定すると入力できます（原稿版ごとに保存されるため）。
          </p>
        )}
      </div>

      <AdvancedSettingsSummary settings={advanced} onReset={handleResetAdvanced} />

      {modelId === null && (
        <p className={styles.modelNote}>
          モデルが未選択です。<Link to={ROUTES.settings}>設定</Link>
          で検査に使うモデルを選んでください。
        </p>
      )}

      <button
        type="button"
        className={styles.startButton}
        disabled={startDisabled}
        onClick={handleStart}
      >
        検査を開始する
      </button>

      {startApi.outcome.kind === "failed" && (
        <div role="alert" className={styles.error}>
          <p>{startApi.outcome.message}</p>
          {startApi.outcome.hint === "settings" && (
            <p>
              値を見直すには<Link to={ROUTES.settings}>設定</Link>を開いてください。
            </p>
          )}
        </div>
      )}

      {/*
        再試行の案内は失敗メッセージとは別の塊にする（レビュー対応）。結果不明のあとに
        もう一度「検査を開始する」を押して送信前に失敗した場合、上のメッセージは新しい失敗の
        ものになるが、再送できるのは前回の（結果不明のままの）開始操作である。
      */}
      {startApi.canRetry && startApi.outcome.kind !== "sending" && (
        <div role="alert" className={styles.retryNotice}>
          <p>前回の開始操作は結果が不明のままです。同じ内容で再送できます。</p>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => {
              void startApi.retry();
            }}
          >
            再試行
          </button>
        </div>
      )}
    </div>
  );
}
