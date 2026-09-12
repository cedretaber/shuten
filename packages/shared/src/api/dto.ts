import { z } from "zod";

// `../index.ts` から import しない（index.ts が `api/` を再エクスポートするので循環になる）。
// 各ソースから直接引く。
import type { ChunkSettings } from "../chunk/settings.ts";
import {
  FINDING_CATEGORIES,
  INITIAL_VERDICTS,
  llmFindingSchema,
  RECHECK_REASON_KINDS,
  RECHECK_VERDICTS,
} from "../llm/schema.ts";
import { FAILURE_REASONS } from "../run/failure-reason.ts";
import { JUDGMENT_STATUSES } from "../run/judgment.ts";
import { RUN_STATUSES, UNIT_STATUSES } from "../run/status.ts";
import {
  CANDIDATE_LOCATE_STATUSES,
  FINDING_LOCATE_STATUSES,
  RECHECK_NOT_APPLICABLE_REASONS,
  RUN_STOP_REASONS,
} from "../run/stop-reason.ts";

/**
 * DTO（本書「DTO」節）。zod スキーマを正本とし、型は `z.infer` で導く（決定記録 0001）。
 * すべて `.strict()` で、余分なキー（`endpointUrl` など）を黙って除去せず不正とする。
 *
 * 写し方：`readonly` は落とす、`| null` は `.nullable()`、`?:` は `.optional()`、
 * ISO 日時は `z.iso.datetime()`、`Range` は下記 `rangeSchema`、列挙は shared の定数配列から
 * `z.enum(...)`（定数配列が無い列挙は本書「要求」節の型と同じ値をそのまま `z.enum([...])` に書く）、
 * `CandidateDto.llm` は `llmCheckOutputSchema` の要素スキーマ（`llmFindingSchema`）を再利用する。
 */

/** UTF-16 コード単位の範囲。開始・終了とも 0 以上の整数。 */
const rangeSchema = z.object({ start: z.int().min(0), end: z.int().min(0) }).strict();

const perspectiveSchema = z.enum(["typo", "naturalness"]);
const reasoningEffortSchema = z.enum(["none", "low", "medium", "high"]);
const locateFailureReasonSchema = z.enum(["not-found", "ambiguous", "outside-target"]);
const diagnosticTransformSchema = z.enum(["newline", "nfc", "newline+nfc"]);

/** 接続設定。キー本体は決して返さない（決定 5）。 */
export const connectionSettingsDtoSchema = z
  .object({
    endpointUrl: z.string(),
    hasApiKey: z.boolean(),
  })
  .strict();
export type ConnectionSettingsDto = z.infer<typeof connectionSettingsDtoSchema>;

/** `/api/v0/models` の 1 要素。server の `ModelInfo` と同形（欠けうる値は null）。 */
export const modelInfoDtoSchema = z
  .object({
    id: z.string(),
    type: z.string().nullable(),
    state: z.string().nullable(),
    quantization: z.string().nullable(),
    maxContextLength: z.number().nullable(),
    loadedContextLength: z.number().nullable(),
  })
  .strict();
export type ModelInfoDto = z.infer<typeof modelInfoDtoSchema>;

/** 接続確認の結果（決定 8）。到達不能でも 200 で返す。生成要求は送らない。 */
export const connectionCheckDtoSchema = z
  .object({
    reachable: z.boolean(),
    /** `reachable: false` のときだけ非 null。`message` は `reason` ごとの定型文で、URL は入れない。 */
    error: z
      .object({ reason: z.enum(FAILURE_REASONS), message: z.string() })
      .strict()
      .nullable(),
    models: z.array(modelInfoDtoSchema),
    /** 要求に `modelId` が無ければ null。 */
    model: z
      .object({
        id: z.string(),
        found: z.boolean(),
        state: z.string().nullable(),
        /** `state === "loaded"` と厳密に一致するときだけ true（`LOADED_STATE`）。 */
        loaded: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ConnectionCheckDto = z.infer<typeof connectionCheckDtoSchema>;

export const manuscriptVersionDtoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    body: z.string(),
    bodyHash: z.string(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type ManuscriptVersionDto = z.infer<typeof manuscriptVersionDtoSchema>;

export const generationSettingsDtoSchema = z
  .object({
    maxTokens: z.number(),
    temperature: z.number(),
    seed: z.number().optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
  })
  .strict();
export type GenerationSettingsDto = z.infer<typeof generationSettingsDtoSchema>;

/** `ChunkSettings`（`../chunk/settings.ts`）と同形。分割・参考文脈の設定。 */
const chunkSettingsDtoSchema = z
  .object({
    targetGraphemes: z.number(),
    contextGraphemes: z.number(),
    recheckContextGraphemes: z.number(),
    roundingTolerance: z.number(),
    maxInputGraphemes: z.number(),
  })
  .strict() satisfies z.ZodType<ChunkSettings>;

export const runDtoSchema = z
  .object({
    id: z.string(),
    manuscriptVersionId: z.string(),
    modelId: z.string(),
    modelInfo: modelInfoDtoSchema.nullable(),
    generationSettings: generationSettingsDtoSchema,
    chunkSettings: chunkSettingsDtoSchema,
    timeouts: z.object({ checkMs: z.number(), recheckMs: z.number() }).strict(),
    perspectives: z.array(perspectiveSchema),
    recheckEnabled: z.boolean(),
    allowedWords: z.array(z.string()),
    allowedWordRuleVersion: z.string(),
    promptVersion: z.string(),
    diagnosticTransformVersion: z.string(),
    status: z.enum(RUN_STATUSES),
    stopReason: z.enum(RUN_STOP_REASONS).nullable(),
    stopMessage: z.string().nullable(),
    generationUnconfirmed: z.boolean(),
    stopRequestedAt: z.iso.datetime().nullable(),
    /** 復旧確認を受けた時刻（決定 11）。`recovery-waiting` 以外では null。 */
    recoveryConfirmedAt: z.iso.datetime().nullable(),
    recoveryConfirmMs: z.number(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type RunDto = z.infer<typeof runDtoSchema>;

export const runSummaryDtoSchema = z
  .object({
    id: z.string(),
    manuscriptVersionId: z.string(),
    manuscriptName: z.string(),
    modelId: z.string(),
    status: z.enum(RUN_STATUSES),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type RunSummaryDto = z.infer<typeof runSummaryDtoSchema>;

/** 状態別件数（仕様 9「完了した検査単位数と再確認件数」）。5 状態すべてを 0 でも持つ。 */
const unitStatusCountsDtoSchema = z
  .object({
    pending: z.number(),
    running: z.number(),
    done: z.number(),
    failed: z.number(),
    "not-applicable": z.number(),
  })
  .strict() satisfies z.ZodType<{ readonly [status in (typeof UNIT_STATUSES)[number]]: number }>;
export type UnitStatusCounts = z.infer<typeof unitStatusCountsDtoSchema>;

export const progressDtoSchema = z
  .object({
    checkUnits: unitStatusCountsDtoSchema,
    recheckUnits: unitStatusCountsDtoSchema,
  })
  .strict();
export type ProgressDto = z.infer<typeof progressDtoSchema>;

export const runTargetDtoSchema = z
  .object({
    id: z.string(),
    targetIndex: z.number(),
    target: rangeSchema,
    contextBefore: rangeSchema.nullable(),
    contextAfter: rangeSchema.nullable(),
    input: rangeSchema,
    paragraphIds: z.array(z.number()),
  })
  .strict();
export type RunTargetDto = z.infer<typeof runTargetDtoSchema>;

export const runDetailDtoSchema = z
  .object({
    run: runDtoSchema,
    progress: progressDtoSchema,
    targets: z.array(runTargetDtoSchema),
  })
  .strict();
export type RunDetailDto = z.infer<typeof runDetailDtoSchema>;

export const unitFailureDtoSchema = z
  .object({
    reason: z.enum(FAILURE_REASONS),
    message: z.string(),
    finishReason: z.string().nullable(),
    origin: z.enum(["ensure-loaded", "chat", "local"]),
  })
  .strict();
export type UnitFailureDto = z.infer<typeof unitFailureDtoSchema>;

export const checkUnitDtoSchema = z
  .object({
    id: z.string(),
    targetId: z.string(),
    targetIndex: z.number(),
    perspective: perspectiveSchema,
    status: z.enum(UNIT_STATUSES),
    attempts: z.number(),
    failure: unitFailureDtoSchema.nullable(),
    pendingNote: z.string().nullable(),
    elapsedMs: z.number().nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type CheckUnitDto = z.infer<typeof checkUnitDtoSchema>;

export const recheckUnitDtoSchema = z
  .object({
    id: z.string(),
    findingId: z.string(),
    inputRange: rangeSchema.nullable(),
    status: z.enum(UNIT_STATUSES),
    notApplicableReason: z.enum(RECHECK_NOT_APPLICABLE_REASONS).nullable(),
    attempts: z.number(),
    failure: unitFailureDtoSchema.nullable(),
    pendingNote: z.string().nullable(),
    verdict: z.enum(RECHECK_VERDICTS).nullable(),
    reasonKind: z.enum(RECHECK_REASON_KINDS).nullable(),
    reason: z.string().nullable(),
    suggestionValid: z.boolean().nullable(),
    elapsedMs: z.number().nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type RecheckUnitDto = z.infer<typeof recheckUnitDtoSchema>;

export const runUnitsDtoSchema = z
  .object({
    checkUnits: z.array(checkUnitDtoSchema),
    recheckUnits: z.array(recheckUnitDtoSchema),
  })
  .strict();
export type RunUnitsDto = z.infer<typeof runUnitsDtoSchema>;

export const recoveryDtoSchema = z
  .object({
    blocked: z.boolean(),
    runIds: z.array(z.string()),
  })
  .strict();
export type RecoveryDto = z.infer<typeof recoveryDtoSchema>;

export const findingReasonDtoSchema = z
  .object({
    candidateId: z.string(),
    perspective: perspectiveSchema,
    reason: z.string(),
  })
  .strict();
export type FindingReasonDto = z.infer<typeof findingReasonDtoSchema>;

/** 指摘に付く再確認の要約。`RecheckUnitDto` から usage・時刻を除いたもの。 */
export const recheckSummaryDtoSchema = z
  .object({
    id: z.string(),
    status: z.enum(UNIT_STATUSES),
    notApplicableReason: z.enum(RECHECK_NOT_APPLICABLE_REASONS).nullable(),
    verdict: z.enum(RECHECK_VERDICTS).nullable(),
    reasonKind: z.enum(RECHECK_REASON_KINDS).nullable(),
    reason: z.string().nullable(),
    suggestionValid: z.boolean().nullable(),
    failure: unitFailureDtoSchema.nullable(),
  })
  .strict();
export type RecheckSummaryDto = z.infer<typeof recheckSummaryDtoSchema>;

export const judgmentDtoSchema = z
  .object({
    findingId: z.string(),
    status: z.enum(JUDGMENT_STATUSES),
    note: z.string().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type JudgmentDto = z.infer<typeof judgmentDtoSchema>;

export const findingDtoSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    targetId: z.string(),
    locateStatus: z.enum(FINDING_LOCATE_STATUSES),
    range: rangeSchema.nullable(),
    paragraphId: z.number(),
    quote: z.string(),
    suggestion: z.string().nullable(),
    category: z.enum(FINDING_CATEGORIES),
    initialVerdict: z.enum(INITIAL_VERDICTS),
    suppression: z.object({ word: z.string(), ruleVersion: z.string() }).strict().nullable(),
    reasons: z.array(findingReasonDtoSchema),
    /** 再確認単位が無ければ null（再確認を無効にした実行では起票されない）。 */
    recheck: recheckSummaryDtoSchema.nullable(),
    /**
     * 常に非 null。指摘の作成と同時に `undecided` の行が作られる（PR8 決定 5）。行が無ければ
     * DB 不整合として 500（`.nullable()` を付けない）。
     */
    judgment: judgmentDtoSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type FindingDto = z.infer<typeof findingDtoSchema>;

export const candidateDtoSchema = z
  .object({
    id: z.string(),
    checkUnitId: z.string(),
    perspective: perspectiveSchema,
    candidateIndex: z.number(),
    llm: llmFindingSchema,
    locateStatus: z.enum(CANDIDATE_LOCATE_STATUSES),
    range: rangeSchema.nullable(),
  })
  .strict();
export type CandidateDto = z.infer<typeof candidateDtoSchema>;

const diagnosticCandidateDtoSchema = z
  .object({
    transform: diagnosticTransformSchema,
    text: z.string(),
    range: rangeSchema.nullable(),
  })
  .strict();

export const diagnosticDtoSchema = z
  .object({
    candidateId: z.string(),
    quote: z.string(),
    reason: locateFailureReasonSchema,
    searchRange: rangeSchema,
    exactMatches: z.array(rangeSchema),
    transformVersion: z.string().nullable(),
    transformCandidates: z.array(diagnosticCandidateDtoSchema).nullable(),
    omitted: z.number().nullable(),
    tied: z.boolean().nullable(),
  })
  .strict();
export type DiagnosticDto = z.infer<typeof diagnosticDtoSchema>;

/** 指摘の詳細。一覧の項目に元候補と位置診断を足す（決定 15）。 */
export const findingDetailDtoSchema = findingDtoSchema.extend({
  candidates: z.array(candidateDtoSchema),
  diagnostics: z.array(diagnosticDtoSchema),
});
export type FindingDetailDto = z.infer<typeof findingDetailDtoSchema>;

/**
 * `GET /api/runs/:id/export` の応答（PR13a-2 決定 16・23・24・32）。
 *
 * 実行 1 件ぶんの全量を、既存の DTO 射影だけを使って並べたもの。新しい射影は作らない。
 * `unlocatedCandidates` / `unlocatedDiagnostics` は `finding_id` が null の候補
 * （`outside-target` だけ。決定 23）とその診断で、`not-found` / `ambiguous` の候補は
 * 位置 null の指摘として `findings[]` 側（`candidates` / `diagnostics`）に入る。
 * `recheckUnits` は再確認単位を全項目で運ぶ（決定 32）。`findings[].recheck`
 * （`RecheckSummaryDto`）は画面向けの要約で `attempts` / `inputRange` / `elapsedMs` / 時刻を
 * 落としているため、可搬用の控えとしてはここに全項目の控えを別に持つ。重複は許容する。
 */
export const runExportDtoSchema = z
  .object({
    formatVersion: z.literal("1"),
    exportedAt: z.iso.datetime(),
    run: runDtoSchema,
    manuscript: manuscriptVersionDtoSchema,
    targets: z.array(runTargetDtoSchema),
    checkUnits: z.array(checkUnitDtoSchema),
    recheckUnits: z.array(recheckUnitDtoSchema),
    findings: z.array(findingDetailDtoSchema),
    unlocatedCandidates: z.array(candidateDtoSchema),
    unlocatedDiagnostics: z.array(diagnosticDtoSchema),
  })
  .strict();
export type RunExportDto = z.infer<typeof runExportDtoSchema>;
