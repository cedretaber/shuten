import { MAX_TIMEOUT_MS, type ReasoningEffort, RUN_SETTINGS_DEFAULTS } from "@shuten/shared";

import {
  collectRawOptions,
  err,
  ok,
  parseFiniteNumberOption,
  parseIntegerOption,
  type Result,
} from "./common.ts";

/**
 * `full-chat` サブコマンドが受け付ける引数（決定 15・19）。分割・観点・許容語・再確認は
 * この方式には無いので、`args.ts`（`parseArgs`）の `CliArgs` と違い持たない
 * （`--perspectives` / `--mode` / `--allowed-words` / 分割設定 / `--recheck-timeout-ms` は
 * 未知のオプションとして拒否する）。接続先 URL と API キーを含めない理由は `CliArgs` と同じ。
 *
 * `--system-prompt-file` は任意（決定 19）。「現在の全文チャット方式」が指示文を LM Studio の
 * system プロンプトに置き原稿を user メッセージで貼る運用を再現するためのもので、
 * 未指定なら従来どおり system を付けず user 1 通だけを送る。
 */
export interface FullChatArgs {
  readonly manuscriptPath: string;
  readonly model: string;
  readonly promptPath: string;
  /** system プロンプトファイルのパス。未指定なら null（決定 19）。 */
  readonly systemPromptPath: string | null;
  readonly outPath: string | null;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly seed: number | undefined;
  readonly reasoningEffort: ReasoningEffort;
  readonly checkTimeoutMs: number;
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];

/**
 * タイムアウトの整数範囲の上限。`args.ts` の `TIMEOUT_MS_MAX` と同じ値で、どちらも
 * `@shuten/shared` の `MAX_TIMEOUT_MS` を正本にする（2 か所に書くと片方だけ直す事故が起きる）。
 */
const TIMEOUT_MS_MAX = MAX_TIMEOUT_MS;

/**
 * `RUN_SETTINGS_DEFAULTS`（`@shuten/shared`。CLI と web が共有する既定値）のうち、
 * この方式が使う項目だけを取る。数値をここにハードコードしない。
 */
const DEFAULTS = {
  outPath: null as string | null,
  maxTokens: RUN_SETTINGS_DEFAULTS.generation.maxTokens,
  temperature: RUN_SETTINGS_DEFAULTS.generation.temperature,
  reasoningEffort: RUN_SETTINGS_DEFAULTS.generation.reasoningEffort as ReasoningEffort,
  checkTimeoutMs: RUN_SETTINGS_DEFAULTS.timeouts.checkMs,
} as const;

/** 既知のオプション名の集合。値を取る形式（`--flag value`）のみを受け付ける。 */
const KNOWN_OPTIONS = [
  "--manuscript",
  "--model",
  "--prompt-file",
  "--system-prompt-file",
  "--out",
  "--max-tokens",
  "--temperature",
  "--seed",
  "--reasoning-effort",
  "--check-timeout-ms",
] as const;

function parseReasoningEffort(raw: string): Result<ReasoningEffort> {
  if (!(REASONING_EFFORTS as readonly string[]).includes(raw)) {
    return err(`--reasoning-effort が不正です（none | low | medium | high のいずれか）: ${raw}`);
  }
  return ok(raw as ReasoningEffort);
}

/** `full-chat` サブコマンドの引数を解釈する純粋関数。不正な値は例外ではなくエラー値で返す。 */
export function parseFullChatArgs(argv: readonly string[]): Result<FullChatArgs> {
  const collected = collectRawOptions(argv, { known: KNOWN_OPTIONS });
  if (!collected.ok) {
    return collected;
  }
  const raw = collected.value;

  const manuscriptPath = raw.get("--manuscript")?.[0];
  const model = raw.get("--model")?.[0];
  const promptPath = raw.get("--prompt-file")?.[0];

  if (manuscriptPath === undefined || model === undefined || promptPath === undefined) {
    // 欠けているものだけを --manuscript, --model, --prompt-file の順で並べる（`args.ts` と同じ形）。
    const missing: string[] = [];
    if (manuscriptPath === undefined) missing.push("--manuscript");
    if (model === undefined) missing.push("--model");
    if (promptPath === undefined) missing.push("--prompt-file");
    return err(`必須オプションがありません: ${missing.join(", ")}`);
  }

  // 既定は "none"（思考なし）。`args.ts` の既定と同じ暫定の方針（決定記録 0003）。
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
  // 範囲は課さない。`args.ts` と同じ理由（妥当な範囲はモデルごとに異なり、仕様書 13 節の
  // 未決事項に属する）で、構文上の検証（有限数であること）だけを行う。
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

  const checkTimeoutMsRaw = raw.get("--check-timeout-ms")?.[0];
  const checkTimeoutMs =
    checkTimeoutMsRaw === undefined
      ? ok(DEFAULTS.checkTimeoutMs)
      : parseIntegerOption(checkTimeoutMsRaw, "--check-timeout-ms", 1, TIMEOUT_MS_MAX);
  if (!checkTimeoutMs.ok) return checkTimeoutMs;

  return ok({
    manuscriptPath,
    model,
    promptPath,
    systemPromptPath: raw.get("--system-prompt-file")?.[0] ?? null,
    outPath: raw.get("--out")?.[0] ?? DEFAULTS.outPath,
    maxTokens: maxTokens.value,
    temperature: temperature.value,
    seed: seed.value,
    reasoningEffort: reasoningEffort.value,
    checkTimeoutMs: checkTimeoutMs.value,
  });
}
