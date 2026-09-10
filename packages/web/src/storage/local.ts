/**
 * `localStorage` の読み書きを安全に包む（決定 6・7）。
 *
 * - 読み出しは必ず zod で検証する。壊れた JSON・スキーマ違反はキーを消して既定値を返す。
 * - `localStorage` が使えない環境（プライベートウィンドウなど）でも例外を外に出さない。
 *   読み書きの全経路（`getItem` / `setItem` / `removeItem`、壊れた値を消すときの `removeItem` を
 *   含む）を try/catch で包む。
 * - API キー・接続先 URL・本文は扱わない（決定 6）。API キーはサーバーのプロセスメモリだけに置く
 *   という PR10 決定 5 を、接続先 URL はサーバーの `settings` 表を正本とする決定を崩さない。
 */

import type { ChunkSettings, Perspective, ReasoningEffort } from "@shuten/shared";
import { z } from "zod";

/** 保存する検査設定一式（許容語を除く）。`StartRunRequest` とは別の形（決定 6）。 */
export interface StoredRunSettings {
  readonly generation: {
    readonly maxTokens: number;
    readonly temperature: number;
    readonly seed?: number | undefined;
    readonly reasoningEffort: ReasoningEffort;
  };
  readonly chunkSettings: ChunkSettings;
  readonly timeouts: { readonly checkMs: number; readonly recheckMs: number };
  readonly perspectives: readonly Perspective[];
  readonly recheckEnabled: boolean;
}

/** 許容語は原稿版と組にして保存する（決定 7）。別の原稿版を確定したら空から始める。 */
export interface StoredAllowedWords {
  readonly manuscriptVersionId: string;
  readonly allowedWordsRaw: string;
}

const perspectiveSchema = z.enum(["typo", "naturalness"]);
const reasoningEffortSchema = z.enum(["none", "low", "medium", "high"]);

const generationSettingsSchema = z.object({
  maxTokens: z.number(),
  temperature: z.number(),
  seed: z.number().optional(),
  reasoningEffort: reasoningEffortSchema,
});

const chunkSettingsSchema = z.object({
  targetGraphemes: z.number(),
  contextGraphemes: z.number(),
  recheckContextGraphemes: z.number(),
  roundingTolerance: z.number(),
  maxInputGraphemes: z.number(),
}) satisfies z.ZodType<ChunkSettings>;

/**
 * `startRunRequestSchema` は流用しない（決定 6）。`startOperationId` / `manuscriptVersionId` /
 * `modelId` / `allowedWordsRaw` を含まない、保存専用の形。
 */
export const storedRunSettingsSchema: z.ZodType<StoredRunSettings> = z.object({
  generation: generationSettingsSchema,
  chunkSettings: chunkSettingsSchema,
  timeouts: z.object({
    checkMs: z.number(),
    recheckMs: z.number(),
  }),
  perspectives: z.array(perspectiveSchema),
  recheckEnabled: z.boolean(),
});

export const storedAllowedWordsSchema: z.ZodType<StoredAllowedWords> = z.object({
  manuscriptVersionId: z.string(),
  allowedWordsRaw: z.string(),
});

/** 壊れた値・スキーマ違反はキーを消して fallback を返す。`localStorage` の例外は外に出さない。 */
export function readStored<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return fallback; // getItem 自体が使えない環境
  }
  if (raw === null) return fallback;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    removeStored(key); // 壊れた JSON。次回のために消す
    return fallback;
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    removeStored(key); // スキーマ違反。次回のために消す
    return fallback;
  }
  return parsed.data;
}

/** `localStorage` が使えない環境でも例外を外に出さない。 */
export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 書き込みに失敗しても画面は落とさない（プライベートウィンドウ、容量超過など）。
  }
}

/** 壊れた値を消すときも例外を外に出さない（`removeItem` が throw する環境を含む）。 */
export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 削除に失敗しても画面は落とさない。
  }
}
