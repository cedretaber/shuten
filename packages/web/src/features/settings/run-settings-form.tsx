/**
 * 検査設定フォームと開始ボタン（決定 7・12・13・15）。
 *
 * 既定表示は仕様 5.2 の 6 項目（検査観点、分割長、初回の参考文脈、再確認の有無、
 * 再確認の参考文脈、許容語）。残り（`maxTokens` / `temperature` / `seed` / `reasoningEffort` /
 * `roundingTolerance` / `maxInputGraphemes` / `checkMs` / `recheckMs`）は折りたたみの
 * 「詳細設定」に入れる（決定 12）。タイムアウトは秒、丸め許容はパーセントで入力させ、
 * 送信時に `units.ts` で API の単位へ変換する。
 *
 * 許容語は原稿版と組で保存し、同じ原稿版のときだけ復元する（決定 7）。復元は
 * `manuscriptVersionId` が変わるたびに効かせる `useEffect` で行い、書き込みは入力の
 * `onChange` で直接行う（restore 用の effect と write 用の effect を両方持つと、マウント時に
 * どちらが先に走るかで復元前の値を上書きしてしまう競合が起きるため、書き込み側は effect にしない）。
 *
 * 検査設定（`runSettings`）は原稿版に依存しないので、初期値は `useState` の遅延初期化子で
 * 一度だけ `localStorage` から読み、変更のたびに `useEffect` で書き戻す。
 *
 * `startOperationId` の生成・接続確認・クライアント検証・スナップショットの固定・再送は
 * すべて `useStartRun`（`use-start-run.ts`）に任せる。ここでは画面の入力を集め、
 * `StartRunRequest`（`startOperationId` を除く）を組み立てて渡すだけ。
 */

import {
  type ChunkSettingsRequest,
  type GenerationSettingsRequest,
  type Perspective,
  type ReasoningEffort,
  RUN_SETTINGS_DEFAULTS,
} from "@shuten/shared";
import { type ChangeEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { ROUTES } from "../../app/routes.ts";
import { STORAGE_KEYS } from "../../storage/keys.ts";
import {
  readStored,
  type StoredAllowedWords,
  type StoredRunSettings,
  storedAllowedWordsSchema,
  storedRunSettingsSchema,
  writeStored,
} from "../../storage/local.ts";
import styles from "./settings.module.css";
import {
  MAX_TIMEOUT_SECONDS,
  msToSeconds,
  percentToTolerance,
  secondsToMs,
  toleranceToPercent,
} from "./units.ts";
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

function readStoredRunSettings(): StoredRunSettings {
  return readStored(STORAGE_KEYS.runSettings, storedRunSettingsSchema, RUN_SETTINGS_DEFAULTS);
}

const PERSPECTIVE_LABELS: Record<Perspective, string> = {
  typo: "誤字・脱字",
  naturalness: "日本語の自然さ",
};

const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "なし",
  low: "弱い",
  medium: "普通",
  high: "強い",
};

const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];

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
  const [initialRunSettings] = useState(readStoredRunSettings);

  const [perspectives, setPerspectives] = useState<readonly Perspective[]>(
    initialRunSettings.perspectives,
  );
  const [targetGraphemes, setTargetGraphemes] = useState(
    initialRunSettings.chunkSettings.targetGraphemes,
  );
  const [contextGraphemes, setContextGraphemes] = useState(
    initialRunSettings.chunkSettings.contextGraphemes,
  );
  const [recheckEnabled, setRecheckEnabled] = useState(initialRunSettings.recheckEnabled);
  const [recheckContextGraphemes, setRecheckContextGraphemes] = useState(
    initialRunSettings.chunkSettings.recheckContextGraphemes,
  );

  // 詳細設定（決定 12）。
  const [maxTokens, setMaxTokens] = useState(initialRunSettings.generation.maxTokens);
  const [temperature, setTemperature] = useState(initialRunSettings.generation.temperature);
  const [seedInput, setSeedInput] = useState(
    initialRunSettings.generation.seed === undefined
      ? ""
      : String(initialRunSettings.generation.seed),
  );
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    initialRunSettings.generation.reasoningEffort,
  );
  const [roundingTolerancePercent, setRoundingTolerancePercent] = useState(
    toleranceToPercent(initialRunSettings.chunkSettings.roundingTolerance),
  );
  const [maxInputGraphemes, setMaxInputGraphemes] = useState(
    initialRunSettings.chunkSettings.maxInputGraphemes,
  );
  const [checkSeconds, setCheckSeconds] = useState(
    msToSeconds(initialRunSettings.timeouts.checkMs),
  );
  const [recheckSeconds, setRecheckSeconds] = useState(
    msToSeconds(initialRunSettings.timeouts.recheckMs),
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // 許容語は原稿版と組で保存する（決定 7）。遅延初期化子で最初の一度だけ読み、
  // `manuscriptVersionId` が変わるたびに復元し直す。書き込みは textarea の onChange で行う
  // （effect にすると、マウント直後の復元 effect と競合して復元前の値を上書きしうる）。
  const [allowedWordsRaw, setAllowedWordsRaw] = useState<string>(() =>
    restoreAllowedWords(manuscriptVersionId),
  );
  useEffect(() => {
    setAllowedWordsRaw(restoreAllowedWords(manuscriptVersionId));
  }, [manuscriptVersionId]);

  // 検査設定は変更のたびに保存する（W7-19）。原稿版に依存しないため、復元用の effect は無い
  // （初期値は上の useState の遅延初期化子で読み込み済み）。
  useEffect(() => {
    const settings: StoredRunSettings = {
      generation: {
        maxTokens,
        temperature,
        reasoningEffort,
        ...(seedInput.trim() === "" ? {} : { seed: Number(seedInput) }),
      },
      chunkSettings: {
        targetGraphemes,
        contextGraphemes,
        recheckContextGraphemes,
        roundingTolerance: percentToTolerance(roundingTolerancePercent),
        maxInputGraphemes,
      },
      timeouts: { checkMs: secondsToMs(checkSeconds), recheckMs: secondsToMs(recheckSeconds) },
      perspectives,
      recheckEnabled,
    };
    writeStored(STORAGE_KEYS.runSettings, settings);
  }, [
    maxTokens,
    temperature,
    seedInput,
    reasoningEffort,
    targetGraphemes,
    contextGraphemes,
    recheckContextGraphemes,
    roundingTolerancePercent,
    maxInputGraphemes,
    checkSeconds,
    recheckSeconds,
    perspectives,
    recheckEnabled,
  ]);

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

  const advancedChanged =
    maxTokens !== RUN_SETTINGS_DEFAULTS.generation.maxTokens ||
    temperature !== RUN_SETTINGS_DEFAULTS.generation.temperature ||
    seedInput.trim() !== "" ||
    reasoningEffort !== RUN_SETTINGS_DEFAULTS.generation.reasoningEffort ||
    roundingTolerancePercent !==
      toleranceToPercent(RUN_SETTINGS_DEFAULTS.chunkSettings.roundingTolerance) ||
    maxInputGraphemes !== RUN_SETTINGS_DEFAULTS.chunkSettings.maxInputGraphemes ||
    checkSeconds !== msToSeconds(RUN_SETTINGS_DEFAULTS.timeouts.checkMs) ||
    recheckSeconds !== msToSeconds(RUN_SETTINGS_DEFAULTS.timeouts.recheckMs);

  const startDisabled =
    restoring ||
    manuscriptVersionId === null ||
    modelId === null ||
    startApi.outcome.kind === "sending";

  const handleStart = () => {
    if (manuscriptVersionId === null || modelId === null) return;

    const generation: GenerationSettingsRequest = {
      maxTokens,
      temperature,
      reasoningEffort,
      ...(seedInput.trim() === "" ? {} : { seed: Number(seedInput) }),
    };
    const chunkSettings: ChunkSettingsRequest = {
      targetGraphemes,
      contextGraphemes,
      recheckContextGraphemes,
      roundingTolerance: percentToTolerance(roundingTolerancePercent),
      maxInputGraphemes,
    };

    void startApi.start({
      manuscriptVersionId,
      modelId,
      generation,
      chunkSettings,
      timeouts: { checkMs: secondsToMs(checkSeconds), recheckMs: secondsToMs(recheckSeconds) },
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
        />
      </div>

      <details
        className={styles.advanced}
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary className={styles.advancedSummary}>
          詳細設定
          {advancedChanged && <span className={styles.advancedBadge}>（既定値から変更あり）</span>}
        </summary>

        <div className={styles.advancedFields}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="settings-max-tokens">
              最大トークン数
            </label>
            <input
              id="settings-max-tokens"
              className={styles.input}
              type="number"
              min={1}
              value={maxTokens}
              onChange={numberField(setMaxTokens)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="settings-temperature">
              温度
            </label>
            <input
              id="settings-temperature"
              className={styles.input}
              type="number"
              step="any"
              value={temperature}
              onChange={numberField(setTemperature)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="settings-seed">
              シード（空欄で省略）
            </label>
            <input
              id="settings-seed"
              className={styles.input}
              type="number"
              min={0}
              value={seedInput}
              onChange={(event) => setSeedInput(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="settings-reasoning-effort">
              思考の強さ
            </label>
            <select
              id="settings-reasoning-effort"
              className={styles.select}
              value={reasoningEffort}
              onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
            >
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {REASONING_EFFORT_LABELS[effort]}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="settings-rounding-tolerance">
              段落境界への丸め許容（%）
            </label>
            <input
              id="settings-rounding-tolerance"
              className={styles.input}
              type="number"
              min={0}
              max={99}
              value={roundingTolerancePercent}
              onChange={numberField(setRoundingTolerancePercent)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="settings-max-input-graphemes">
              入力上限（字）
            </label>
            <input
              id="settings-max-input-graphemes"
              className={styles.input}
              type="number"
              min={1}
              value={maxInputGraphemes}
              onChange={numberField(setMaxInputGraphemes)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="settings-check-seconds">
              初回検査のタイムアウト（秒）
            </label>
            <input
              id="settings-check-seconds"
              className={styles.input}
              type="number"
              min={1}
              max={MAX_TIMEOUT_SECONDS}
              value={checkSeconds}
              onChange={numberField(setCheckSeconds)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="settings-recheck-seconds">
              再確認のタイムアウト（秒）
            </label>
            <input
              id="settings-recheck-seconds"
              className={styles.input}
              type="number"
              min={1}
              max={MAX_TIMEOUT_SECONDS}
              value={recheckSeconds}
              onChange={numberField(setRecheckSeconds)}
            />
          </div>
        </div>
      </details>

      {modelId === null && (
        <p className={styles.modelNote}>
          モデルが未選択です。<Link to={ROUTES.connectionSettings}>接続設定</Link>
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
          {startApi.outcome.retryable && (
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => {
                void startApi.retry();
              }}
            >
              再試行
            </button>
          )}
        </div>
      )}
    </div>
  );
}
