import type { GraphemeIndex } from "../text/grapheme-index.ts";
import { ceilGraphemeBoundary, floorGraphemeBoundary, graphemeAt } from "../text/grapheme-index.ts";
import type { Range } from "../text/range.ts";

/** 診断用の比較変換。仕様書 6.3 の初期対象は改行統一と NFC の 2 種とその組み合わせだけ。 */
export type DiagnosticTransform = "newline" | "nfc" | "newline+nfc";

/** 変換で内容が変わった書記素クラスタ 1 個の、原文側と比較用文字列側の範囲。 */
export interface TransformedChunk {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly outputStart: number;
  readonly outputEnd: number;
}

/** 比較用文字列と、原文への位置対応。 */
export interface ComparisonText {
  readonly transform: DiagnosticTransform;
  /** 変換元の原文範囲。 */
  readonly source: Range;
  /** 比較用文字列。 */
  readonly text: string;
  /** 変換チャンク。outputStart の昇順。変換で変わらなかった部分は 1:1 対応なので記録しない。 */
  readonly chunks: readonly TransformedChunk[];
}

/** CRLF と単独 CR を LF に統一する。 */
function unifyNewline(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

/** 文字列全体に変換を適用する（引用側に使う）。 */
export function applyTransform(text: string, transform: DiagnosticTransform): string {
  switch (transform) {
    case "newline":
      return unifyNewline(text);
    case "nfc":
      return text.normalize("NFC");
    case "newline+nfc":
      return unifyNewline(text).normalize("NFC");
  }
}

/**
 * range（両端とも書記素境界。そうでなければ RangeError）を書記素クラスタごとに変換して比較用文字列を作る。
 * クラスタごとに applyTransform を適用し、結果がクラスタと異なるものだけを TransformedChunk として記録する。
 */
export function buildComparisonText(
  text: string,
  range: Range,
  index: GraphemeIndex,
  transform: DiagnosticTransform,
): ComparisonText {
  const from = graphemeAt(index, range.start);
  const to = graphemeAt(index, range.end);
  const chunks: TransformedChunk[] = [];
  let out = "";
  for (let k = from; k < to; k += 1) {
    const sourceStart = index.boundaries[k];
    const sourceEnd = index.boundaries[k + 1];
    if (sourceStart === undefined || sourceEnd === undefined) {
      throw new RangeError(`書記素番号が範囲外です: ${k}`);
    }
    const cluster = text.slice(sourceStart, sourceEnd);
    const piece = applyTransform(cluster, transform);
    if (piece !== cluster) {
      chunks.push({
        sourceStart,
        sourceEnd,
        outputStart: out.length,
        outputEnd: out.length + piece.length,
      });
    }
    out += piece;
  }
  return { transform, source: range, text: out, chunks };
}

/** outputStart <= offset であるチャンクの中で最大の outputStart のものを返す。無ければ null。 */
function chunkAt(comparison: ComparisonText, offset: number): TransformedChunk | null {
  const chunks = comparison.chunks;
  let lo = 0;
  let hi = chunks.length - 1;
  let answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const chunk = chunks[mid];
    if (chunk === undefined) {
      break;
    }
    if (chunk.outputStart <= offset) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (answer === -1) {
    return null;
  }
  const result = chunks[answer];
  return result === undefined ? null : result;
}

/**
 * 比較用文字列上の位置を原文の位置に写す。
 * 変換チャンクの外（1:1 の部分）とチャンクの両端は写せる。チャンクの内部は対応不能で null。
 */
export function mapToSource(comparison: ComparisonText, offset: number): number | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > comparison.text.length) {
    throw new RangeError(`位置が範囲外です: ${offset}`);
  }
  const chunk = chunkAt(comparison, offset);
  if (chunk === null) {
    return comparison.source.start + offset;
  }
  if (offset === chunk.outputStart) {
    return chunk.sourceStart;
  }
  if (offset >= chunk.outputEnd) {
    return chunk.sourceEnd + (offset - chunk.outputEnd);
  }
  return null;
}

/** offset が属するチャンクの sourceStart を返す。offset はチャンク内部でなければならない。 */
function sourceStartOf(comparison: ComparisonText, offset: number): number {
  const chunk = chunkAt(comparison, offset);
  if (chunk === null) {
    throw new RangeError(`位置が範囲外です: ${offset}`);
  }
  return chunk.sourceStart;
}

/** offset が属するチャンクの sourceEnd を返す。offset はチャンク内部でなければならない。 */
function sourceEndOf(comparison: ComparisonText, offset: number): number {
  const chunk = chunkAt(comparison, offset);
  if (chunk === null) {
    throw new RangeError(`位置が範囲外です: ${offset}`);
  }
  return chunk.sourceEnd;
}

/**
 * 比較用文字列上の範囲 [start, end) を覆う最小の原文範囲を、書記素境界に丸めて返す。
 * 端がチャンク内部ならそのチャンクの原文範囲まで広げる。端が写せるなら floor / ceil で境界に丸める。
 */
export function coverSource(
  comparison: ComparisonText,
  index: GraphemeIndex,
  start: number,
  end: number,
): Range {
  const startMap = mapToSource(comparison, start);
  const startResult =
    startMap === null ? sourceStartOf(comparison, start) : floorGraphemeBoundary(index, startMap);

  const endMap = mapToSource(comparison, end);
  const endResult =
    endMap === null ? sourceEndOf(comparison, end) : ceilGraphemeBoundary(index, endMap);

  return { start: startResult, end: endResult };
}

/** 比較用文字列上の範囲 [start, end) が変換チャンクの少なくとも 1 つと重なるか。 */
export function overlapsTransformedChunk(
  comparison: ComparisonText,
  start: number,
  end: number,
): boolean {
  for (const chunk of comparison.chunks) {
    if (chunk.outputStart < end && start < chunk.outputEnd) {
      return true;
    }
  }
  return false;
}
