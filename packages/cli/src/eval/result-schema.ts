import type { ModelInfo } from "@shuten/server/lmstudio/types.ts";
import type { GenerationSettings } from "@shuten/server/prompts/types.ts";
import type {
  PipelineMode,
  PipelineResult,
  PipelineRunStatus,
  RunConditions,
  RunStop,
  RunTotals,
  StopReason,
  UnitFailure,
} from "@shuten/server/run/result.ts";
import { RESULT_VERSION } from "@shuten/server/run/result.ts";
import type {
  CandidateBase,
  DiagnosticTransform,
  FindingCategory,
  InitialVerdict,
  LlmFinding,
  LlmRecheckOutput,
  LocateFailureReason,
  Perspective,
  Range,
  ReasoningEffort,
  Suppression,
} from "@shuten/shared";
import {
  buildGraphemeIndex,
  FAILURE_REASONS,
  FINDING_CATEGORIES,
  INITIAL_VERDICTS,
  isGraphemeBoundary,
  llmFindingSchema,
  llmRecheckOutputSchema,
} from "@shuten/shared";
import { z } from "zod";

import { formatIssuePath } from "./issue-path.ts";

/**
 * 結果 JSON の検証（決定 18）。
 *
 * `evaluate` / `aggregate` が読むのは、CLI が書いた結果 JSON ファイルである。TypeScript の型は
 * 実行時に何も保証しないため、`JSON.parse` の戻り値をそのまま `PipelineResult` と名乗らせて
 * 集計に渡すと、項目の欠落・未知の enum・壊れた範囲が例外か黙った誤集計になる。
 *
 * `node:fs` には依存しない。ファイルの読み込み・CLI 配線は呼び出し側（Task 6）の責務。
 */

// --- 評価が読む項目だけを表す型 -------------------------------------------------------------

/** 評価が読む元候補の項目（`CandidateBase` と同じ形。`sources[]` は locate を読まない）。 */
type EvaluationCandidateInput = CandidateBase;

/** 評価が読む統合後の指摘（`MergedFinding` の部分集合）。 */
interface EvaluationMergedFindingInput {
  readonly id: string;
  readonly range: Range;
  readonly quote: string;
  readonly category: FindingCategory;
  readonly suggestion: string | null;
  readonly verdict: InitialVerdict;
  readonly sources: readonly EvaluationCandidateInput[];
}

/**
 * 評価が読む再確認の結果（`RecheckResult` の判別可能ユニオンの部分集合）。
 * `done` のときだけ `output` を読む。他の状態の付随項目（attempts・usage・inputRange など）は読まない。
 */
type EvaluationRecheckInput =
  | { readonly status: "disabled" }
  | { readonly status: "suppressed" }
  | { readonly status: "pending" }
  | { readonly status: "failed" }
  | { readonly status: "done"; readonly output: LlmRecheckOutput };

/** 評価が読む指摘 1 件（`FindingResult` の部分集合）。 */
interface EvaluationFindingInput {
  readonly targetIndex: number;
  readonly finding: EvaluationMergedFindingInput;
  readonly suppression: Suppression | null;
  readonly recheck: EvaluationRecheckInput;
}

/**
 * 評価が読む診断候補（`DiagnosticCandidate` の部分集合）。診断変換別の候補取得件数
 * （仕様書 10 節「位置特定失敗」、決定 8 に追記）を数えるのに `transform` だけ読む。
 * `text` と `range` は原文の断片を運ぶので読まない（決定 9 と同じ姿勢）。
 */
interface EvaluationDiagnosticCandidateInput {
  readonly transform: DiagnosticTransform;
}

/** 評価が読む診断（`Diagnostic` の部分集合）。`candidates[]` の `transform` だけ読む。 */
interface EvaluationDiagnosticInput {
  readonly candidates: readonly EvaluationDiagnosticCandidateInput[];
}

/**
 * 評価が読む位置未確定の候補（`UnlocatedCandidate` の部分集合）。`locate` は `reason` と
 * `diagnostic`（診断変換別の候補取得件数の集計に使う。`null` もありうる）だけ読む。
 */
interface EvaluationUnlocatedCandidateInput {
  readonly id: string;
  readonly perspective: Perspective;
  readonly llm: LlmFinding;
  readonly locate: {
    readonly reason: LocateFailureReason;
    readonly diagnostic: EvaluationDiagnosticInput | null;
  };
}

/** 評価が読む位置未確定の項目（`UnlocatedResult` の部分集合）。 */
interface EvaluationUnlocatedInput {
  readonly targetIndex: number;
  readonly candidate: EvaluationUnlocatedCandidateInput;
}

/**
 * 評価が読む項目だけを表す型（`PipelineResult` の部分集合）。`targets` と `checkUnits` の配列は
 * 読まない（zod の既定で取り除かれる）。`conditions` と `totals` はまるごと読む
 * （Task 7 の複数回集計が実行条件の一致をこれらで判定するため）。
 */
export interface EvaluationResultInput {
  readonly status: PipelineRunStatus;
  readonly stop: RunStop | null;
  readonly conditions: RunConditions;
  readonly findings: readonly EvaluationFindingInput[];
  readonly unlocated: readonly EvaluationUnlocatedInput[];
  readonly totals: RunTotals;
}

/**
 * コンパイル時の食い違い検出。捕まえるのは「評価が読んでいる項目が `PipelineResult` から
 * 消えた・型が変わった」ときだけで、`PipelineResult` に項目が増えたときは落ちない
 * （増えた項目は評価が読まないので実害もない）。すべての変更を検出するものではない。
 */
const _assignable: EvaluationResultInput = {} as PipelineResult;

// --- 値域の列挙（各型の runtime タプル） ---------------------------------------------------

const PIPELINE_RUN_STATUSES = [
  "completed",
  "partially-failed",
  "stopped",
] as const satisfies readonly PipelineRunStatus[];

const STOP_REASONS = [
  "model-not-loaded",
  "recovery-needed",
  "connection-lost",
  "settings",
  "aborted",
  "internal-error",
  "recovery-blocked",
] as const satisfies readonly StopReason[];

const PIPELINE_MODES = [
  "split",
  "split-recheck",
  "full-text",
] as const satisfies readonly PipelineMode[];

const UNIT_FAILURE_ORIGINS = [
  "ensure-loaded",
  "chat",
  "local",
] as const satisfies readonly UnitFailure["origin"][];

const LOCATE_FAILURE_REASONS = [
  "not-found",
  "ambiguous",
  "outside-target",
] as const satisfies readonly LocateFailureReason[];

const DIAGNOSTIC_TRANSFORMS = [
  "newline",
  "nfc",
  "newline+nfc",
] as const satisfies readonly DiagnosticTransform[];

const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningEffort[];

const PERSPECTIVES = ["typo", "naturalness"] as const satisfies readonly Perspective[];

// --- zod スキーマ ---------------------------------------------------------------------------

// db/json.ts の rangeSchema と同じ規約（start / end は整数）。意味の検証（0 <= start < end <=
// text.length、書記素境界、quote の一致）は zod ではなく validateFindingRanges が行う。
const rangeSchema = z.object({
  start: z.number().int(),
  end: z.number().int(),
}) satisfies z.ZodType<Range>;

const modelInfoSchema = z.object({
  id: z.string(),
  type: z.string().nullable(),
  state: z.string().nullable(),
  quantization: z.string().nullable(),
  maxContextLength: z.number().nullable(),
  loadedContextLength: z.number().nullable(),
}) satisfies z.ZodType<ModelInfo>;

const generationSettingsSchema = z.object({
  model: z.string(),
  maxTokens: z.number(),
  temperature: z.number(),
  seed: z.number().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
}) satisfies z.ZodType<GenerationSettings>;

const chunkSettingsSchema = z.object({
  targetGraphemes: z.number(),
  contextGraphemes: z.number(),
  recheckContextGraphemes: z.number(),
  roundingTolerance: z.number(),
  maxInputGraphemes: z.number(),
}) satisfies z.ZodType<RunConditions["chunkSettings"]>;

const conditionsSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  mode: z.enum(PIPELINE_MODES),
  perspectives: z.array(z.enum(PERSPECTIVES)),
  generation: generationSettingsSchema,
  model: modelInfoSchema.nullable(),
  chunkSettings: chunkSettingsSchema,
  timeouts: z.object({
    checkMs: z.number(),
    recheckMs: z.number(),
  }),
  allowedWords: z.array(z.string()),
  versions: z.object({
    // 形式が変わった結果を古い規則で数えないため、RESULT_VERSION と一致しない値は拒否する。
    result: z.literal(RESULT_VERSION),
    prompt: z.string(),
    allowedWordRule: z.string(),
    diagnosticTransform: z.string(),
  }),
  manuscript: z.object({
    utf16Length: z.number(),
    graphemeCount: z.number(),
    paragraphCount: z.number(),
    targetCount: z.number(),
    bodyHash: z.string(),
  }),
}) satisfies z.ZodType<RunConditions>;

const unitFailureSchema = z.object({
  reason: z.enum(FAILURE_REASONS),
  message: z.string(),
  finishReason: z.string().nullable(),
  origin: z.enum(UNIT_FAILURE_ORIGINS),
}) satisfies z.ZodType<UnitFailure>;

const runStopSchema = z.object({
  reason: z.enum(STOP_REASONS),
  message: z.string(),
  failure: unitFailureSchema.nullable(),
  generationUnconfirmed: z.boolean(),
}) satisfies z.ZodType<RunStop>;

/** `CandidateBase`（id / perspective / llm）。`locate` は読まないのでここに含めない。 */
const candidateBaseSchema = z.object({
  id: z.string(),
  perspective: z.enum(PERSPECTIVES),
  llm: llmFindingSchema,
}) satisfies z.ZodType<EvaluationCandidateInput>;

const mergedFindingSchema = z.object({
  id: z.string(),
  range: rangeSchema,
  quote: z.string(),
  category: z.enum(FINDING_CATEGORIES),
  suggestion: z.string().nullable(),
  verdict: z.enum(INITIAL_VERDICTS),
  sources: z.array(candidateBaseSchema),
}) satisfies z.ZodType<EvaluationMergedFindingInput>;

const suppressionSchema = z
  .object({
    word: z.string(),
    ruleVersion: z.string(),
  })
  .nullable() satisfies z.ZodType<Suppression | null>;

const recheckSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("disabled") }),
  z.object({ status: z.literal("suppressed") }),
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("failed") }),
  z.object({ status: z.literal("done"), output: llmRecheckOutputSchema }),
]) satisfies z.ZodType<EvaluationRecheckInput>;

const findingResultSchema = z.object({
  targetIndex: z.number(),
  finding: mergedFindingSchema,
  suppression: suppressionSchema,
  recheck: recheckSchema,
}) satisfies z.ZodType<EvaluationFindingInput>;

const diagnosticCandidateSchema = z.object({
  transform: z.enum(DIAGNOSTIC_TRANSFORMS),
}) satisfies z.ZodType<EvaluationDiagnosticCandidateInput>;

const diagnosticSchema = z
  .object({
    candidates: z.array(diagnosticCandidateSchema),
  })
  .nullable() satisfies z.ZodType<EvaluationDiagnosticInput | null>;

const unlocatedCandidateSchema = z.object({
  id: z.string(),
  perspective: z.enum(PERSPECTIVES),
  llm: llmFindingSchema,
  locate: z.object({
    reason: z.enum(LOCATE_FAILURE_REASONS),
    diagnostic: diagnosticSchema,
  }),
}) satisfies z.ZodType<EvaluationUnlocatedCandidateInput>;

const unlocatedResultSchema = z.object({
  targetIndex: z.number(),
  candidate: unlocatedCandidateSchema,
}) satisfies z.ZodType<EvaluationUnlocatedInput>;

const runTotalsSchema = z.object({
  targets: z.number(),
  checkUnits: z.object({
    done: z.number(),
    failed: z.number(),
    pending: z.number(),
  }),
  requests: z.number(),
  candidates: z.number(),
  located: z.number(),
  unlocated: z.object({
    notFound: z.number(),
    ambiguous: z.number(),
    outsideTarget: z.number(),
  }),
  findings: z.number(),
  suppressed: z.number(),
  rechecks: z.object({
    done: z.number(),
    failed: z.number(),
    pending: z.number(),
    suppressed: z.number(),
    disabled: z.number(),
  }),
  elapsedMs: z.number(),
}) satisfies z.ZodType<RunTotals>;

/**
 * 結果 JSON 全体のスキーマ。`.strict()` は使わない。評価が読むのは `PipelineResult` の一部で、
 * 実データには `targets` や `checkUnits` などここに書いていないキーが必ずある。`.strict()` を
 * 付けると正しい結果 JSON が検証に落ちる。zod の既定（未知のキーを取り除く）をそのまま使い、
 * `parse` の戻り値をそのまま `EvaluationResultInput` として扱う。これが「外形を検証したうえでの
 * 明示的な射影」になる。未知のキーを弾く役目は、`versions.result` の照合と必須項目の検査が果たす。
 */
const resultSchema: z.ZodType<EvaluationResultInput> = z.object({
  status: z.enum(PIPELINE_RUN_STATUSES),
  stop: runStopSchema.nullable(),
  conditions: conditionsSchema,
  findings: z.array(findingResultSchema),
  unlocated: z.array(unlocatedResultSchema),
  totals: runTotalsSchema,
});

export type ResultValidateResult =
  | { readonly ok: true; readonly value: EvaluationResultInput }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * zod の issues を安全な文字列に写す。**path と code だけ**を使い、値そのものは含めない
 * （受け取った JSON の内容、とくに原稿の断片が混ざりうるため。決定 9）。
 */
function formatIssues(issues: readonly { path: readonly PropertyKey[]; code: string }[]): string[] {
  return issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.code}`);
}

/** 結果 JSON（`JSON.parse` の戻り値）を検証する。`versions.result` の照合を含む。 */
export function parseResultJson(json: unknown): ResultValidateResult {
  const result = resultSchema.safeParse(json);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, errors: formatIssues(result.error.issues) };
}

// --- 意味の検証（決定 18） -------------------------------------------------------------------

/**
 * 位置確定済みの指摘の範囲を本文と突き合わせる（決定 18 の意味の検証）。
 *
 * ハッシュが一致していても、範囲が壊れた指摘をそのまま採点すると、その指摘が別の正解項目を
 * 検出したことにできてしまう。位置確定済みの指摘（`result.findings[]`）それぞれについて、
 * 次をすべて確かめる。1 件でも破れていれば集計せずエラー終了する（全件を集めてから返す）。
 *
 * - `0 <= start < end <= text.length`（`start === end` のゼロ長も拒否）
 * - `start` と `end` の両方が書記素境界にある
 * - `text.slice(start, end) === finding.quote`
 *
 * 位置未確定の候補（`unlocated`）は範囲を持たないためこの検査の対象外。
 * エラーには指摘の `id` と `range` を含めてよいが、`quote` と本文の断片は含めない（決定 9）。
 */
export function validateFindingRanges(
  result: EvaluationResultInput,
  text: string,
): { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] } {
  const index = buildGraphemeIndex(text);
  const errors: string[] = [];

  for (const findingResult of result.findings) {
    const { finding } = findingResult;
    const { id, quote } = finding;
    const { start, end } = finding.range;
    const label = `finding ${id}（range: ${String(start)}-${String(end)}）`;

    if (!(start >= 0 && start < end && end <= text.length)) {
      errors.push(`${label}: range が不正です（0 <= start < end <= text.length を満たしません）`);
      // 範囲自体が壊れていると書記素境界・quote の照合は意味を持たないため、この指摘については打ち切る。
      continue;
    }
    if (!isGraphemeBoundary(index, start) || !isGraphemeBoundary(index, end)) {
      errors.push(`${label}: range の端が書記素境界にありません`);
      continue;
    }
    if (text.slice(start, end) !== quote) {
      errors.push(`${label}: quote が本文の該当範囲と一致しません`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}
