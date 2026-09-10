/**
 * 検査設定（`shuten.v1.runSettings`）の所有者ごとの部分更新（PR11c 決定 4）。
 *
 * `localStorage` の保存値は 1 つ（`StoredRunSettings`）だが、これを読み書きする画面は
 * メイン画面（基本設定）と設定画面（詳細設定）の 2 つに分かれる。各画面は保存値のうち
 * 自分の持ち分しか知らない。素朴に「自分が知っている全項目を書き戻す」実装のままだと、
 * 片方の画面の保存が、もう片方の画面の持ち分を古い値・既定値で踏みつぶしてしまう。
 *
 * それを避けるため、書き込みは常に
 * 「現在の保存値を読む → 自分の持ち分だけ差し替える → 書き戻す」
 * という手順を踏む。`chunkSettings` は基本・詳細の両方にまたがるフィールドを持つため、
 * オブジェクトごと置き換えるのではなく**項目単位**で差し替える。
 *
 * 保存形式（`StoredRunSettings` / `storedRunSettingsSchema`）は変えない。ここはその上に立つ
 * 読み書きの窓口を 2 系統（基本・詳細）用意するだけの層。
 *
 * 持ち分：
 * - 基本（メイン画面）：`perspectives`、`recheckEnabled`、
 *   `chunkSettings.targetGraphemes` / `contextGraphemes` / `recheckContextGraphemes`
 * - 詳細（設定画面）：`generation.*`、
 *   `chunkSettings.roundingTolerance` / `maxInputGraphemes`、`timeouts.*`
 */

import type { Perspective } from "@shuten/shared";
import { RUN_SETTINGS_DEFAULTS } from "@shuten/shared";
import { STORAGE_KEYS } from "./keys.ts";
import {
  readStored,
  type StoredRunSettings,
  storedRunSettingsSchema,
  writeStored,
} from "./local.ts";

/** メイン画面が持つ検査設定。単位は保存形式のまま（変換は画面側の units.ts）。 */
export interface BasicRunSettings {
  readonly perspectives: readonly Perspective[];
  readonly recheckEnabled: boolean;
  readonly targetGraphemes: number;
  readonly contextGraphemes: number;
  readonly recheckContextGraphemes: number;
}

/** 設定画面が持つ詳細設定。単位は保存形式のまま（丸め許容は 0〜1、タイムアウトはミリ秒）。 */
export interface AdvancedRunSettings {
  readonly generation: StoredRunSettings["generation"];
  readonly roundingTolerance: number;
  readonly maxInputGraphemes: number;
  readonly timeouts: StoredRunSettings["timeouts"];
}

export const BASIC_RUN_SETTINGS_DEFAULTS: BasicRunSettings = {
  perspectives: RUN_SETTINGS_DEFAULTS.perspectives,
  recheckEnabled: RUN_SETTINGS_DEFAULTS.recheckEnabled,
  targetGraphemes: RUN_SETTINGS_DEFAULTS.chunkSettings.targetGraphemes,
  contextGraphemes: RUN_SETTINGS_DEFAULTS.chunkSettings.contextGraphemes,
  recheckContextGraphemes: RUN_SETTINGS_DEFAULTS.chunkSettings.recheckContextGraphemes,
};

export const ADVANCED_RUN_SETTINGS_DEFAULTS: AdvancedRunSettings = {
  generation: RUN_SETTINGS_DEFAULTS.generation,
  roundingTolerance: RUN_SETTINGS_DEFAULTS.chunkSettings.roundingTolerance,
  maxInputGraphemes: RUN_SETTINGS_DEFAULTS.chunkSettings.maxInputGraphemes,
  timeouts: RUN_SETTINGS_DEFAULTS.timeouts,
};

function readStoredRunSettings(): StoredRunSettings {
  return readStored(STORAGE_KEYS.runSettings, storedRunSettingsSchema, RUN_SETTINGS_DEFAULTS);
}

export function readBasicRunSettings(): BasicRunSettings {
  const stored = readStoredRunSettings();
  return {
    perspectives: stored.perspectives,
    recheckEnabled: stored.recheckEnabled,
    targetGraphemes: stored.chunkSettings.targetGraphemes,
    contextGraphemes: stored.chunkSettings.contextGraphemes,
    recheckContextGraphemes: stored.chunkSettings.recheckContextGraphemes,
  };
}

export function readAdvancedRunSettings(): AdvancedRunSettings {
  const stored = readStoredRunSettings();
  return {
    generation: stored.generation,
    roundingTolerance: stored.chunkSettings.roundingTolerance,
    maxInputGraphemes: stored.chunkSettings.maxInputGraphemes,
    timeouts: stored.timeouts,
  };
}

/** 基本の持ち分だけを差し替えて書き戻す。詳細の持ち分（`generation` 等）はそのまま残す。 */
export function writeBasicRunSettings(next: BasicRunSettings): void {
  const stored = readStoredRunSettings();
  const updated: StoredRunSettings = {
    ...stored,
    perspectives: next.perspectives,
    recheckEnabled: next.recheckEnabled,
    chunkSettings: {
      ...stored.chunkSettings,
      targetGraphemes: next.targetGraphemes,
      contextGraphemes: next.contextGraphemes,
      recheckContextGraphemes: next.recheckContextGraphemes,
    },
  };
  writeStored(STORAGE_KEYS.runSettings, updated);
}

/**
 * 詳細の持ち分だけを差し替えて書き戻す。基本の持ち分（`perspectives` 等）はそのまま残す。
 *
 * `generation` は詳細が丸ごと所有するフィールドなので、`next.generation` でまるごと置き換える
 * （`{ ...stored.generation, ...next.generation }` のような合成はしない）。`seed` は省略可能
 * （`exactOptionalPropertyTypes`）で、`next.generation` にキーが無ければ書き戻す値にもキーが
 * 現れない。これにより、シードを消した詳細設定を保存すると保存値からも `seed` が消える。
 */
export function writeAdvancedRunSettings(next: AdvancedRunSettings): void {
  const stored = readStoredRunSettings();
  const updated: StoredRunSettings = {
    ...stored,
    generation: next.generation,
    chunkSettings: {
      ...stored.chunkSettings,
      roundingTolerance: next.roundingTolerance,
      maxInputGraphemes: next.maxInputGraphemes,
    },
    timeouts: next.timeouts,
  };
  writeStored(STORAGE_KEYS.runSettings, updated);
}

/**
 * 詳細の持ち分だけを既定値へ戻し、**書き込んだ既定値を返す**。
 * 呼び出し側はこの戻り値で state を更新する。`localStorage` を書くだけにすると、
 * 画面が持っている値が古いまま残り、要約と次の開始要求だけが「戻す前」に取り残される。
 * キーごと消さないのは、メイン画面の持ち分（検査観点・分割長）まで巻き添えになるため。
 */
export function resetAdvancedRunSettings(): AdvancedRunSettings {
  writeAdvancedRunSettings(ADVANCED_RUN_SETTINGS_DEFAULTS);
  return ADVANCED_RUN_SETTINGS_DEFAULTS;
}
