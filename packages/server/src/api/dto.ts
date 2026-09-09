/**
 * レコード → 公開 DTO の射影（PR10 決定 3）。
 *
 * 射影は**ここ 1 か所**にだけ書く。ハンドラーはレコードをそのまま応答に渡さない。
 * `RunRecord.endpointUrl` と `startOperationId` はここで落ちる（不変条件「接続先 URL は
 * 接続設定の応答以外に出さない」、PR9b 決定 24）。`usage` / `inputGraphemes` / `mergeKey` の
 * ような内部だけの列も同様に落とす。
 *
 * 各 DTO の形の正本は `@shuten/shared` の zod スキーマで、`respond` が応答の直前に
 * `.strict()` で検査する。ここでは「落とす」ではなく「必要な項目だけを並べる」書き方に
 * 統一する（スプレッドを使わない。項目が増えたときに黙って漏れないようにするため）。
 */

import type {
  CandidateDto,
  CheckUnitDto,
  DiagnosticDto,
  FindingDto,
  FindingReasonDto,
  GenerationSettingsDto,
  JudgmentDto,
  ManuscriptVersionDto,
  ModelInfoDto,
  Perspective,
  Range,
  RecheckSummaryDto,
  RecheckUnitDto,
  RunDto,
  RunSummaryDto,
  RunTargetDto,
  UnitFailureDto,
} from "@shuten/shared";

import type {
  CandidateRecord,
  CheckUnitRecord,
  DiagnosticRecord,
  JudgmentRecord,
  ManuscriptVersionRecord,
  RecheckUnitRecord,
  RunRecord,
  RunTargetRecord,
  UnitFailureRecord,
} from "../db/records.ts";
import type { FindingReason, FindingWithReasons } from "../db/repositories/findings.ts";
import type { ModelInfo } from "../lmstudio/types.ts";

/** DTO の日時は ISO 文字列（`z.iso.datetime()`）。 */
function toIso(at: Date): string {
  return at.toISOString();
}

function toIsoOrNull(at: Date | null): string | null {
  return at === null ? null : at.toISOString();
}

/** 範囲は新しいオブジェクトに写す（レコードの参照を応答に貸さない）。 */
function toRange(range: Range): { start: number; end: number } {
  return { start: range.start, end: range.end };
}

function toRangeOrNull(range: Range | null): { start: number; end: number } | null {
  return range === null ? null : toRange(range);
}

export function toModelInfoDto(info: ModelInfo): ModelInfoDto {
  return {
    id: info.id,
    type: info.type,
    state: info.state,
    quantization: info.quantization,
    maxContextLength: info.maxContextLength,
    loadedContextLength: info.loadedContextLength,
  };
}

export function toManuscriptVersionDto(record: ManuscriptVersionRecord): ManuscriptVersionDto {
  return {
    id: record.id,
    name: record.name,
    body: record.body,
    bodyHash: record.bodyHash,
    createdAt: toIso(record.createdAt),
  };
}

/**
 * 生成設定。`seed` / `reasoningEffort` は省略可なので、`undefined` のときはキー自体を作らない
 * （`exactOptionalPropertyTypes` と `.strict()` の両方に合わせる）。
 */
function toGenerationSettingsDto(settings: RunRecord["generationSettings"]): GenerationSettingsDto {
  return {
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    ...(settings.seed === undefined ? {} : { seed: settings.seed }),
    ...(settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: settings.reasoningEffort }),
  };
}

/** `endpointUrl` と `startOperationId` はここで落とす（決定 3・PR9b 決定 24）。 */
export function toRunDto(run: RunRecord): RunDto {
  return {
    id: run.id,
    manuscriptVersionId: run.manuscriptVersionId,
    modelId: run.modelId,
    modelInfo: run.modelInfo === null ? null : toModelInfoDto(run.modelInfo),
    generationSettings: toGenerationSettingsDto(run.generationSettings),
    chunkSettings: {
      targetGraphemes: run.chunkSettings.targetGraphemes,
      contextGraphemes: run.chunkSettings.contextGraphemes,
      recheckContextGraphemes: run.chunkSettings.recheckContextGraphemes,
      roundingTolerance: run.chunkSettings.roundingTolerance,
      maxInputGraphemes: run.chunkSettings.maxInputGraphemes,
    },
    timeouts: { checkMs: run.timeouts.checkMs, recheckMs: run.timeouts.recheckMs },
    perspectives: [...run.perspectives],
    recheckEnabled: run.recheckEnabled,
    allowedWords: [...run.allowedWords],
    allowedWordRuleVersion: run.allowedWordRuleVersion,
    promptVersion: run.promptVersion,
    diagnosticTransformVersion: run.diagnosticTransformVersion,
    status: run.status,
    stopReason: run.stopReason,
    stopMessage: run.stopMessage,
    generationUnconfirmed: run.generationUnconfirmed,
    stopRequestedAt: toIsoOrNull(run.stopRequestedAt),
    recoveryConfirmedAt: toIsoOrNull(run.recoveryConfirmedAt),
    recoveryConfirmMs: run.recoveryConfirmMs,
    startedAt: toIso(run.startedAt),
    finishedAt: toIsoOrNull(run.finishedAt),
  };
}

/** 一覧の 1 行。原稿名は呼び出し元が原稿版から引いて渡す。 */
export function toRunSummaryDto(entry: { run: RunRecord; manuscriptName: string }): RunSummaryDto {
  return {
    id: entry.run.id,
    manuscriptVersionId: entry.run.manuscriptVersionId,
    manuscriptName: entry.manuscriptName,
    modelId: entry.run.modelId,
    status: entry.run.status,
    startedAt: toIso(entry.run.startedAt),
    finishedAt: toIsoOrNull(entry.run.finishedAt),
  };
}

export function toRunTargetDto(record: RunTargetRecord): RunTargetDto {
  return {
    id: record.id,
    targetIndex: record.targetIndex,
    target: toRange(record.target),
    contextBefore: toRangeOrNull(record.contextBefore),
    contextAfter: toRangeOrNull(record.contextAfter),
    input: toRange(record.input),
    paragraphIds: [...record.paragraphIds],
  };
}

function toUnitFailureDto(failure: UnitFailureRecord): UnitFailureDto {
  return {
    reason: failure.reason,
    message: failure.message,
    finishReason: failure.finishReason,
    origin: failure.origin,
  };
}

function toUnitFailureDtoOrNull(failure: UnitFailureRecord | null): UnitFailureDto | null {
  return failure === null ? null : toUnitFailureDto(failure);
}

/**
 * 検査単位。`targetIndex` は `run_targets` 側の値なので呼び出し元が引いて渡す
 * （単位の行には対象の連番が無い）。`usage` / `inputGraphemes` は落とす。
 */
export function toCheckUnitDto(unit: CheckUnitRecord, targetIndex: number): CheckUnitDto {
  return {
    id: unit.id,
    targetId: unit.targetId,
    targetIndex,
    perspective: unit.perspective,
    status: unit.status,
    attempts: unit.attempts,
    failure: toUnitFailureDtoOrNull(unit.failure),
    pendingNote: unit.pendingNote,
    elapsedMs: unit.elapsedMs,
    startedAt: toIsoOrNull(unit.startedAt),
    finishedAt: toIsoOrNull(unit.finishedAt),
  };
}

export function toRecheckUnitDto(unit: RecheckUnitRecord): RecheckUnitDto {
  return {
    id: unit.id,
    findingId: unit.findingId,
    inputRange: toRangeOrNull(unit.inputRange),
    status: unit.status,
    notApplicableReason: unit.notApplicableReason,
    attempts: unit.attempts,
    failure: toUnitFailureDtoOrNull(unit.failure),
    pendingNote: unit.pendingNote,
    verdict: unit.verdict,
    reasonKind: unit.reasonKind,
    reason: unit.reason,
    suggestionValid: unit.suggestionValid,
    elapsedMs: unit.elapsedMs,
    startedAt: toIsoOrNull(unit.startedAt),
    finishedAt: toIsoOrNull(unit.finishedAt),
  };
}

/** 指摘に付ける再確認の要約（`RecheckUnitDto` から時刻・回数を除いたもの）。 */
function toRecheckSummaryDto(unit: RecheckUnitRecord): RecheckSummaryDto {
  return {
    id: unit.id,
    status: unit.status,
    notApplicableReason: unit.notApplicableReason,
    verdict: unit.verdict,
    reasonKind: unit.reasonKind,
    reason: unit.reason,
    suggestionValid: unit.suggestionValid,
    failure: toUnitFailureDtoOrNull(unit.failure),
  };
}

function toFindingReasonDto(reason: FindingReason): FindingReasonDto {
  return {
    candidateId: reason.candidateId,
    perspective: reason.perspective,
    reason: reason.reason,
  };
}

export function toJudgmentDto(judgment: JudgmentRecord): JudgmentDto {
  return {
    findingId: judgment.findingId,
    status: judgment.status,
    note: judgment.note,
    updatedAt: toIso(judgment.updatedAt),
  };
}

/**
 * 指摘。`manuscriptVersionId` と `mergeKey` は落とす（DTO に無い）。
 * `judgment` は常に非 null（指摘の作成と同時に `undecided` の行ができる。PR8 決定 5）。
 * 行が無ければ呼び出し元が DB 不整合として扱う（ここでは受け取らない）。
 */
export function toFindingDto(
  finding: FindingWithReasons,
  recheck: RecheckUnitRecord | null,
  judgment: JudgmentRecord,
): FindingDto {
  return {
    id: finding.id,
    runId: finding.runId,
    targetId: finding.targetId,
    locateStatus: finding.locateStatus,
    range: toRangeOrNull(finding.range),
    paragraphId: finding.paragraphId,
    quote: finding.quote,
    suggestion: finding.suggestion,
    category: finding.category,
    initialVerdict: finding.initialVerdict,
    suppression:
      finding.suppression === null
        ? null
        : { word: finding.suppression.word, ruleVersion: finding.suppression.ruleVersion },
    reasons: finding.reasons.map(toFindingReasonDto),
    recheck: recheck === null ? null : toRecheckSummaryDto(recheck),
    judgment: toJudgmentDto(judgment),
    createdAt: toIso(finding.createdAt),
  };
}

/**
 * 元候補。観点は `check_units` 側の値なので呼び出し元が引いて渡す（候補側に観点の列は無い。
 * PR8 決定 19）。`findingId` / `mergeKey` / `createdAt` は落とす。
 */
export function toCandidateDto(candidate: CandidateRecord, perspective: Perspective): CandidateDto {
  return {
    id: candidate.id,
    checkUnitId: candidate.checkUnitId,
    perspective,
    candidateIndex: candidate.candidateIndex,
    llm: candidate.llm,
    locateStatus: candidate.locateStatus,
    range: toRangeOrNull(candidate.range),
  };
}

export function toDiagnosticDto(record: DiagnosticRecord): DiagnosticDto {
  return {
    candidateId: record.candidateId,
    quote: record.quote,
    reason: record.reason,
    searchRange: toRange(record.searchRange),
    exactMatches: record.exactMatches.map(toRange),
    transformVersion: record.transformVersion,
    transformCandidates:
      record.transformCandidates === null
        ? null
        : record.transformCandidates.map((candidate) => ({
            transform: candidate.transform,
            text: candidate.text,
            range: toRangeOrNull(candidate.range),
          })),
    omitted: record.omitted,
    tied: record.tied,
  };
}
