/**
 * 詳細設定のうち「既定値と違う項目」を、画面に出せる文字列へ変換する（PR11c 決定 6）。
 *
 * 詳細設定は設定画面（`/settings`）へ移したが、メイン画面には**何が既定値と違うか**を
 * 名前と値で出す。件数だけを出すと、以前に上げた温度や伸ばしたタイムアウトを見落としたまま
 * 検査を開始してしまう（「自分が変えた覚えの無い設定で検査が走る」状態を作らない）。
 *
 * ここは DOM に依存しない純関数だけを置く。出力が入力だけで決まるよう、並び順は固定にする
 * （オブジェクトのキー順や `Object.entries` の結果には依存しない）。
 *
 * 値は**画面の表示単位**へ直す（タイムアウトは秒、丸め許容はパーセント）。保存形式のまま
 * 出すと、設定画面の入力欄に出ている数字と要約の数字が食い違う。
 */

import type { ReasoningEffort } from "@shuten/shared";
import {
  ADVANCED_RUN_SETTINGS_DEFAULTS,
  type AdvancedRunSettings,
} from "../../storage/run-settings.ts";
import { msToSeconds, toleranceToPercent } from "./units.ts";

/**
 * 思考の強さの画面向け文言。詳細設定の入力欄（`advanced-settings-section.tsx`）と
 * メイン画面の要約（`advanced-settings-summary.tsx`）の両方が使うのでここに置く。
 */
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "なし",
  low: "弱い",
  medium: "普通",
  high: "強い",
};

/** 選択肢の並び順。弱いほうから強いほうへ並べる。 */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];

/** 既定値と違う項目 1 件。`label` は項目名、`value` は表示単位まで直した値。 */
export interface AdvancedChange {
  readonly label: string;
  readonly value: string;
}

/**
 * 既定値と違う項目だけを、画面の表示単位で並べる。すべて既定値なら空配列。
 *
 * 並び順は固定：最大トークン数 → 温度 → シード → 思考の強さ → 丸め許容 → 入力上限 →
 * 初回検査のタイムアウト → 再確認のタイムアウト。
 *
 * シードは既定値では**キーごと無い**（`exactOptionalPropertyTypes`）。他の 7 項目と同じく
 * 既定値（`defaults.generation.seed`＝`undefined`）と比べるので、`undefined` が入っている
 * 場合も「未設定＝既定値」として扱い、要約には出さない。
 */
export function describeAdvancedChanges(settings: AdvancedRunSettings): readonly AdvancedChange[] {
  const defaults = ADVANCED_RUN_SETTINGS_DEFAULTS;
  const changes: AdvancedChange[] = [];

  if (settings.generation.maxTokens !== defaults.generation.maxTokens) {
    changes.push({ label: "最大トークン数", value: String(settings.generation.maxTokens) });
  }
  if (settings.generation.temperature !== defaults.generation.temperature) {
    changes.push({ label: "温度", value: String(settings.generation.temperature) });
  }
  if (settings.generation.seed !== defaults.generation.seed) {
    changes.push({ label: "シード", value: String(settings.generation.seed) });
  }
  if (settings.generation.reasoningEffort !== defaults.generation.reasoningEffort) {
    changes.push({
      label: "思考の強さ",
      value: REASONING_EFFORT_LABELS[settings.generation.reasoningEffort],
    });
  }
  if (settings.roundingTolerance !== defaults.roundingTolerance) {
    changes.push({
      label: "丸め許容",
      value: `${toleranceToPercent(settings.roundingTolerance)}%`,
    });
  }
  if (settings.maxInputGraphemes !== defaults.maxInputGraphemes) {
    changes.push({ label: "入力上限", value: `${settings.maxInputGraphemes} 字` });
  }
  if (settings.timeouts.checkMs !== defaults.timeouts.checkMs) {
    changes.push({
      label: "初回検査のタイムアウト",
      value: `${msToSeconds(settings.timeouts.checkMs)} 秒`,
    });
  }
  if (settings.timeouts.recheckMs !== defaults.timeouts.recheckMs) {
    changes.push({
      label: "再確認のタイムアウト",
      value: `${msToSeconds(settings.timeouts.recheckMs)} 秒`,
    });
  }

  return changes;
}
