export type { CheckInput, ContextWindow, TargetRange } from "./chunk/plan.ts";
export { buildCheckInput, buildRecheckInput, planTargets } from "./chunk/plan.ts";
export { findSentenceBoundaries } from "./chunk/sentence.ts";
export {
  type ChunkSettings,
  InputTooLongError,
  InvalidChunkSettingsError,
  roundingDelta,
  validateChunkSettings,
} from "./chunk/settings.ts";
export type {
  FindingCategory,
  InitialVerdict,
  LlmCheckOutput,
  LlmFinding,
  LlmRecheckOutput,
  Perspective,
  RecheckReasonKind,
  RecheckVerdict,
} from "./llm/schema.ts";
export {
  checkOutputJsonSchema,
  FINDING_CATEGORIES,
  INITIAL_VERDICTS,
  llmCheckOutputSchema,
  llmRecheckOutputSchema,
  RECHECK_REASON_KINDS,
  RECHECK_VERDICTS,
  recheckOutputJsonSchema,
} from "./llm/schema.ts";
export type { Diagnostic, DiagnosticCandidate } from "./locate/diagnostic.ts";
export { DIAGNOSTIC_CANDIDATE_LIMIT } from "./locate/diagnostic.ts";
export type { LocateFailureReason, LocateResult } from "./locate/locate.ts";
export { locateQuote } from "./locate/locate.ts";
export type { DiagnosticTransform } from "./locate/position-map.ts";
export { applyTransform } from "./locate/position-map.ts";
export type { QuoteRef } from "./locate/quote-ref.ts";
export type { Suppression, SuppressionInput } from "./merge/allowed-words.ts";
export { findSuppression } from "./merge/allowed-words.ts";
export type {
  Candidate,
  CandidateBase,
  LocatedCandidate,
  UnlocatedCandidate,
} from "./merge/candidate.ts";
export { partitionCandidates } from "./merge/candidate.ts";
export type { MergedFinding } from "./merge/merge.ts";
export { mergeCandidates, mergeKey } from "./merge/merge.ts";
export type { FailureReason } from "./run/failure-reason.ts";
export { FAILURE_REASONS } from "./run/failure-reason.ts";
export type { GraphemeSegment } from "./text/grapheme.ts";
export { countGraphemes, segmentGraphemes } from "./text/grapheme.ts";
export type { GraphemeIndex } from "./text/grapheme-index.ts";
export {
  buildGraphemeIndex,
  ceilGraphemeBoundary,
  floorGraphemeBoundary,
  graphemeAt,
  isGraphemeBoundary,
  offsetAt,
} from "./text/grapheme-index.ts";
export { decodeUtf8Strict, ingestUtf8Bytes, stripBom, Utf8DecodeError } from "./text/ingest.ts";
export type { Paragraph } from "./text/paragraph.ts";
export { splitParagraphs } from "./text/paragraph.ts";
export type { Range } from "./text/range.ts";
export { sliceRange } from "./text/range.ts";
export {
  ALLOWED_WORD_RULE_VERSION,
  DIAGNOSTIC_TRANSFORM_VERSION,
  PROMPT_VERSION,
} from "./versions.ts";
