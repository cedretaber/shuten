import type { PipelineMode } from "@shuten/server/run/result.ts";
import {
  type ChunkSettings,
  MAX_TIMEOUT_MS,
  type Perspective,
  type ReasoningEffort,
  RUN_SETTINGS_DEFAULTS,
} from "@shuten/shared";

import {
  collectRawOptions,
  err,
  ok,
  parseFiniteNumberOption,
  parseIntegerOption,
  parseRangedNumberOption,
  type Result,
} from "./args/common.ts";

/**
 * CLI が受け付ける引数（決定 12）。接続先 URL と API キーはここに含めない
 * （シェル履歴に残さないため環境変数からだけ読む。main.ts の責務）。
 */
export interface CliArgs {
  readonly manuscriptPath: string;
  readonly model: string;
  readonly allowedWordsPath: string | null;
  readonly outPath: string | null;
  readonly mode: PipelineMode;
  readonly perspectives: readonly Perspective[];
  readonly maxTokens: number;
  readonly temperature: number;
  readonly seed: number | undefined;
  readonly reasoningEffort: ReasoningEffort;
  readonly chunkSettings: ChunkSettings;
  readonly checkTimeoutMs: number;
  readonly recheckTimeoutMs: number;
}

export type ParseArgsResult =
  | { readonly ok: true; readonly value: CliArgs }
  | { readonly ok: false; readonly error: string };

const MODES: readonly PipelineMode[] = ["split", "split-recheck", "full-text"];
const PERSPECTIVES: readonly Perspective[] = ["typo", "naturalness"];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];

/**
 * タイムアウトの整数範囲の上限。`packages/server/src/lmstudio/client.ts` の `validateTimeoutMs` と
 * 同じ値で、どちらも `@shuten/shared` の `MAX_TIMEOUT_MS` を正本にする（2 か所に書くと片方だけ
 * 直す事故が起きるため）。
 */
const TIMEOUT_MS_MAX = MAX_TIMEOUT_MS;

/**
 * 「実測で決める初期値」の表の暫定値（計画 2026-09-08-pr7-pipeline.md）。CLI に無い設定
 * （`mode` / `outPath` / `allowedWordsPath`）を除き、`RUN_SETTINGS_DEFAULTS`（`@shuten/shared`。
 * web と共有する既定値）から取る（PR10 決定 2・9）。
 */
const DEFAULTS = {
  outPath: null as string | null,
  allowedWordsPath: null as string | null,
  mode: "split" as PipelineMode,
  perspectives: RUN_SETTINGS_DEFAULTS.perspectives as readonly Perspective[],
  maxTokens: RUN_SETTINGS_DEFAULTS.generation.maxTokens,
  temperature: RUN_SETTINGS_DEFAULTS.generation.temperature,
  reasoningEffort: RUN_SETTINGS_DEFAULTS.generation.reasoningEffort as ReasoningEffort,
  targetGraphemes: RUN_SETTINGS_DEFAULTS.chunkSettings.targetGraphemes,
  contextGraphemes: RUN_SETTINGS_DEFAULTS.chunkSettings.contextGraphemes,
  recheckContextGraphemes: RUN_SETTINGS_DEFAULTS.chunkSettings.recheckContextGraphemes,
  roundingTolerance: RUN_SETTINGS_DEFAULTS.chunkSettings.roundingTolerance,
  maxInputGraphemes: RUN_SETTINGS_DEFAULTS.chunkSettings.maxInputGraphemes,
  checkTimeoutMs: RUN_SETTINGS_DEFAULTS.timeouts.checkMs,
  recheckTimeoutMs: RUN_SETTINGS_DEFAULTS.timeouts.recheckMs,
} as const;

/** 既知のオプション名の集合。値を取る形式（`--flag value`）のみを受け付ける。 */
const KNOWN_OPTIONS = [
  "--manuscript",
  "--model",
  "--allowed-words",
  "--out",
  "--mode",
  "--perspectives",
  "--max-tokens",
  "--temperature",
  "--seed",
  "--reasoning-effort",
  "--target-graphemes",
  "--context-graphemes",
  "--recheck-context-graphemes",
  "--rounding-tolerance",
  "--max-input-graphemes",
  "--check-timeout-ms",
  "--recheck-timeout-ms",
] as const;

/**
 * `--perspectives typo,naturalness` を分割し、未知の観点を拒否する。
 * 重複は出現順を保って除く（許容語の重複除去と方針をそろえる）。同じ観点を 2 回渡すと
 * 同じ要求を 2 回送ることになり、`sources` が水増しされるため。
 */
function parsePerspectives(raw: string): Result<readonly Perspective[]> {
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part === "")) {
    return err(`--perspectives の形式が不正です: ${JSON.stringify(raw)}`);
  }
  const perspectives: Perspective[] = [];
  for (const part of parts) {
    if (!(PERSPECTIVES as readonly string[]).includes(part)) {
      return err(`--perspectives に未知の観点があります: ${part}`);
    }
    perspectives.push(part as Perspective);
  }
  // 未知の観点の検出を先に済ませてから重複を除く（`typo,unknown,typo` は unknown で拒否する）。
  return ok([...new Set(perspectives)]);
}

function parseMode(raw: string): Result<PipelineMode> {
  if (!(MODES as readonly string[]).includes(raw)) {
    return err(`--mode が不正です（split | split-recheck | full-text のいずれか）: ${raw}`);
  }
  return ok(raw as PipelineMode);
}

function parseReasoningEffort(raw: string): Result<ReasoningEffort> {
  if (!(REASONING_EFFORTS as readonly string[]).includes(raw)) {
    return err(`--reasoning-effort が不正です（none | low | medium | high のいずれか）: ${raw}`);
  }
  return ok(raw as ReasoningEffort);
}

/** 引数を解釈する純粋関数。不正な値は例外ではなくエラー値で返す。 */
export function parseArgs(argv: readonly string[]): ParseArgsResult {
  const collected = collectRawOptions(argv, { known: KNOWN_OPTIONS });
  if (!collected.ok) {
    return collected;
  }
  const raw = collected.value;

  const manuscriptPath = raw.get("--manuscript")?.[0];
  const model = raw.get("--model")?.[0];
  if (manuscriptPath === undefined && model === undefined) {
    return err("必須オプションがありません: --manuscript, --model");
  }
  if (manuscriptPath === undefined) {
    return err("必須オプションがありません: --manuscript");
  }
  if (model === undefined) {
    return err("必須オプションがありません: --model");
  }

  const perspectivesRaw = raw.get("--perspectives")?.[0];
  const perspectives =
    perspectivesRaw === undefined ? ok(DEFAULTS.perspectives) : parsePerspectives(perspectivesRaw);
  if (!perspectives.ok) return perspectives;

  const modeRaw = raw.get("--mode")?.[0];
  const mode = modeRaw === undefined ? ok(DEFAULTS.mode) : parseMode(modeRaw);
  if (!mode.ok) return mode;

  // 既定は "none"（思考なし）。決定記録 0003 の 2026-09-09 の追記による暫定の方針で、
  // 思考ありで動かすときは --reasoning-effort low|medium|high を明示的に渡す。
  const reasoningEffortRaw = raw.get("--reasoning-effort")?.[0];
  const reasoningEffort =
    reasoningEffortRaw === undefined
      ? ok(DEFAULTS.reasoningEffort)
      : parseReasoningEffort(reasoningEffortRaw);
  if (!reasoningEffort.ok) return reasoningEffort;

  const maxTokensRaw = raw.get("--max-tokens")?.[0];
  const maxTokens =
    maxTokensRaw === undefined
      ? ok(DEFAULTS.maxTokens)
      : parseIntegerOption(maxTokensRaw, "--max-tokens", 1, Number.MAX_SAFE_INTEGER);
  if (!maxTokens.ok) return maxTokens;

  const temperatureRaw = raw.get("--temperature")?.[0];
  // 範囲は課さない。妥当な範囲はモデルごとに異なり、仕様書 13 節の未決事項（モデルごとの
  // 生成パラメーター）に属するため、CLI では構文上の検証（有限数であること）だけを行う。
  const temperature =
    temperatureRaw === undefined
      ? ok(DEFAULTS.temperature)
      : parseFiniteNumberOption(temperatureRaw, "--temperature");
  if (!temperature.ok) return temperature;

  const seedRaw = raw.get("--seed")?.[0];
  const seed =
    seedRaw === undefined
      ? ok<number | undefined>(undefined)
      : parseIntegerOption(seedRaw, "--seed", 0, Number.MAX_SAFE_INTEGER);
  if (!seed.ok) return seed;

  const targetGraphemesRaw = raw.get("--target-graphemes")?.[0];
  const targetGraphemes =
    targetGraphemesRaw === undefined
      ? ok(DEFAULTS.targetGraphemes)
      : parseIntegerOption(targetGraphemesRaw, "--target-graphemes", 1, Number.MAX_SAFE_INTEGER);
  if (!targetGraphemes.ok) return targetGraphemes;

  const contextGraphemesRaw = raw.get("--context-graphemes")?.[0];
  const contextGraphemes =
    contextGraphemesRaw === undefined
      ? ok(DEFAULTS.contextGraphemes)
      : parseIntegerOption(contextGraphemesRaw, "--context-graphemes", 0, Number.MAX_SAFE_INTEGER);
  if (!contextGraphemes.ok) return contextGraphemes;

  // --mode full-text でも検証する（使われないだけ）。conditions.chunkSettings に記録される。
  const recheckContextGraphemesRaw = raw.get("--recheck-context-graphemes")?.[0];
  const recheckContextGraphemes =
    recheckContextGraphemesRaw === undefined
      ? ok(DEFAULTS.recheckContextGraphemes)
      : parseIntegerOption(
          recheckContextGraphemesRaw,
          "--recheck-context-graphemes",
          0,
          Number.MAX_SAFE_INTEGER,
        );
  if (!recheckContextGraphemes.ok) return recheckContextGraphemes;

  const roundingToleranceRaw = raw.get("--rounding-tolerance")?.[0];
  const roundingTolerance =
    roundingToleranceRaw === undefined
      ? ok(DEFAULTS.roundingTolerance)
      : parseRangedNumberOption(roundingToleranceRaw, "--rounding-tolerance", 0, 1, false);
  if (!roundingTolerance.ok) return roundingTolerance;

  const maxInputGraphemesRaw = raw.get("--max-input-graphemes")?.[0];
  const maxInputGraphemes =
    maxInputGraphemesRaw === undefined
      ? ok(DEFAULTS.maxInputGraphemes)
      : parseIntegerOption(
          maxInputGraphemesRaw,
          "--max-input-graphemes",
          1,
          Number.MAX_SAFE_INTEGER,
        );
  if (!maxInputGraphemes.ok) return maxInputGraphemes;

  const checkTimeoutMsRaw = raw.get("--check-timeout-ms")?.[0];
  const checkTimeoutMs =
    checkTimeoutMsRaw === undefined
      ? ok(DEFAULTS.checkTimeoutMs)
      : parseIntegerOption(checkTimeoutMsRaw, "--check-timeout-ms", 1, TIMEOUT_MS_MAX);
  if (!checkTimeoutMs.ok) return checkTimeoutMs;

  const recheckTimeoutMsRaw = raw.get("--recheck-timeout-ms")?.[0];
  const recheckTimeoutMs =
    recheckTimeoutMsRaw === undefined
      ? ok(DEFAULTS.recheckTimeoutMs)
      : parseIntegerOption(recheckTimeoutMsRaw, "--recheck-timeout-ms", 1, TIMEOUT_MS_MAX);
  if (!recheckTimeoutMs.ok) return recheckTimeoutMs;

  const chunkSettings: ChunkSettings = {
    targetGraphemes: targetGraphemes.value,
    contextGraphemes: contextGraphemes.value,
    recheckContextGraphemes: recheckContextGraphemes.value,
    roundingTolerance: roundingTolerance.value,
    maxInputGraphemes: maxInputGraphemes.value,
  };

  return ok({
    manuscriptPath,
    model,
    allowedWordsPath: raw.get("--allowed-words")?.[0] ?? DEFAULTS.allowedWordsPath,
    outPath: raw.get("--out")?.[0] ?? DEFAULTS.outPath,
    mode: mode.value,
    perspectives: perspectives.value,
    maxTokens: maxTokens.value,
    temperature: temperature.value,
    seed: seed.value,
    reasoningEffort: reasoningEffort.value,
    chunkSettings,
    checkTimeoutMs: checkTimeoutMs.value,
    recheckTimeoutMs: recheckTimeoutMs.value,
  });
}
