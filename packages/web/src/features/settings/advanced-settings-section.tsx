/**
 * 設定画面（`/settings`）の「詳細な検査設定」節の中身（PR11c 決定 1）。
 *
 * メイン画面の折りたたみ「詳細設定」にあった 8 項目（`maxTokens` / `temperature` / `seed` /
 * `reasoningEffort` / `roundingTolerance` / `maxInputGraphemes` / `checkMs` / `recheckMs`）を
 * そのままここへ移した。ラベル文言・入力欄の `id`・単位の扱いは変えていない。
 *
 * 保存は接続設定（サーバー保存・「保存」ボタン）とは異なり、**変更した時点で `localStorage` へ
 * 書く**。保存ボタンは置かず、`<form>` でも包まない（この節に送信は無い）。書き込みは
 * `writeAdvancedRunSettings` を通し、メイン画面の持ち分（検査観点・分割長など）を踏みつぶさない。
 *
 * 初期値は `useState` の遅延初期化子で**マウント時に一度だけ** `localStorage` から読む
 * （毎レンダーで読み直さない）。タイムアウトは秒、丸め許容はパーセントで入力させ、保存時に
 * `units.ts` で保存形式（ミリ秒・0〜1）へ直す。
 *
 * 見出し「詳細な検査設定」と効き方の 1 行は `app/settings-page.tsx` が持つ。ここには書かない。
 */

import type { ReasoningEffort } from "@shuten/shared";
import { type ChangeEvent, useEffect, useState } from "react";
import { readAdvancedRunSettings, writeAdvancedRunSettings } from "../../storage/run-settings.ts";
import { REASONING_EFFORT_LABELS, REASONING_EFFORTS } from "./advanced-settings-description.ts";
import styles from "./settings.module.css";
import {
  MAX_TIMEOUT_SECONDS,
  msToSeconds,
  percentToTolerance,
  secondsToMs,
  toleranceToPercent,
} from "./units.ts";

export function AdvancedSettingsSection(): React.JSX.Element {
  // 遅延初期化子でマウント時に一度だけ読む（毎レンダーで localStorage を読み直さない）。
  const [initial] = useState(readAdvancedRunSettings);

  const [maxTokens, setMaxTokens] = useState(initial.generation.maxTokens);
  const [temperature, setTemperature] = useState(initial.generation.temperature);
  // シードは「空欄で省略」を表せるよう文字列で持つ（数値にすると未設定を表せない）。
  const [seedInput, setSeedInput] = useState(
    initial.generation.seed === undefined ? "" : String(initial.generation.seed),
  );
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    initial.generation.reasoningEffort,
  );
  const [roundingTolerancePercent, setRoundingTolerancePercent] = useState(
    toleranceToPercent(initial.roundingTolerance),
  );
  const [maxInputGraphemes, setMaxInputGraphemes] = useState(initial.maxInputGraphemes);
  const [checkSeconds, setCheckSeconds] = useState(msToSeconds(initial.timeouts.checkMs));
  const [recheckSeconds, setRecheckSeconds] = useState(msToSeconds(initial.timeouts.recheckMs));

  // 変更のたびに保存する。復元用の effect は無い（初期値は上の遅延初期化子で読み込み済み）。
  useEffect(() => {
    writeAdvancedRunSettings({
      generation: {
        maxTokens,
        temperature,
        reasoningEffort,
        // 空欄なら `seed` はキーごと現れない（`exactOptionalPropertyTypes`）。
        ...(seedInput.trim() === "" ? {} : { seed: Number(seedInput) }),
      },
      roundingTolerance: percentToTolerance(roundingTolerancePercent),
      maxInputGraphemes,
      timeouts: { checkMs: secondsToMs(checkSeconds), recheckMs: secondsToMs(recheckSeconds) },
    });
  }, [
    maxTokens,
    temperature,
    seedInput,
    reasoningEffort,
    roundingTolerancePercent,
    maxInputGraphemes,
    checkSeconds,
    recheckSeconds,
  ]);

  const numberField =
    (setter: (value: number) => void) => (event: ChangeEvent<HTMLInputElement>) => {
      setter(Number(event.target.value));
    };

  return (
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
  );
}
