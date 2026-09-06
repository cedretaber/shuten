export { findSentenceBoundaries } from "./chunk/sentence.ts";
export {
  type ChunkSettings,
  InputTooLongError,
  InvalidChunkSettingsError,
  roundingDelta,
  validateChunkSettings,
} from "./chunk/settings.ts";
export type { GraphemeSegment } from "./text/grapheme.ts";
export { countGraphemes, segmentGraphemes } from "./text/grapheme.ts";
export type { GraphemeIndex } from "./text/grapheme-index.ts";
export {
  buildGraphemeIndex,
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
