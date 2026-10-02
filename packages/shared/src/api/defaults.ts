import type { ChunkSettings } from "../chunk/settings.ts";
import type { Perspective } from "../llm/schema.ts";
import type { ReasoningEffort } from "../run/reasoning-effort.ts";

/**
 * `setTimeout` / LM Studio のタイムアウト引数が受け付ける実用上の上限
 * （符号付き 32bit 整数の最大値）。超えると Node はタイマーを即時発火させる。
 *
 * CLI・server（`config.ts` の `parseRecoveryConfirmMs`、`run/orchestrator.ts` の決定 44）・
 * `startRunRequestSchema` の `timeouts` の検証が同じ値を使うため、ここから export して 1 か所に持つ
 * （2 か所に書くと片方だけ直す事故が起きる）。
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * 実行設定の既定値。CLI（`args.ts` の `DEFAULTS`）と web（PR11 の開始フォーム）が共有する。
 * 当初は「実測で決める初期値」の表の暫定値（計画 2026-09-08-pr7-pipeline.md）。PR13b の評価
 * （`docs/decisions/0004-evaluation-settings.md`）で `maxTokens` を 16,000 から 4,000 に下げた。
 * 分割方式の正常な 1 応答は 1,025 トークン程度で、上限は出力が反復する縮退ループの打ち切りを
 * タイムアウト内に収めるためのもの。全文方式（CLI の `--mode full-text`）は 1 応答に全指摘が
 * 入るので `--max-tokens 16000` を明示する。他の値は評価で据え置いた（仮置き。使用の中で見直す）。
 *
 * `recheckEnabled` は仕様書 5.2 節の初期値表「再確認：有効。比較実験のため無効化可能」に従い
 * `true` を既定にした（CLI の `--mode` 既定 `split` は再確認段階を持つパイプラインを選ぶかどうかの
 * 別軸であり、この既定値の根拠にはならない）。
 */
export const RUN_SETTINGS_DEFAULTS = {
  generation: {
    maxTokens: 4_000,
    temperature: 0,
    reasoningEffort: "none",
  },
  chunkSettings: {
    targetGraphemes: 1_500,
    contextGraphemes: 1_000,
    recheckContextGraphemes: 3_000,
    roundingTolerance: 0.2,
    maxInputGraphemes: 12_000,
  },
  timeouts: {
    checkMs: 300_000,
    recheckMs: 300_000,
  },
  perspectives: ["typo", "naturalness"],
  recheckEnabled: true,
} as const satisfies {
  readonly generation: {
    readonly maxTokens: number;
    readonly temperature: number;
    readonly reasoningEffort: ReasoningEffort;
  };
  readonly chunkSettings: ChunkSettings;
  readonly timeouts: { readonly checkMs: number; readonly recheckMs: number };
  readonly perspectives: readonly Perspective[];
  readonly recheckEnabled: boolean;
};
