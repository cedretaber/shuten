import type { GraphemeIndex } from "../text/grapheme-index.ts";
import { buildGraphemeIndex, graphemeAt, offsetAt } from "../text/grapheme-index.ts";
import type { Paragraph } from "../text/paragraph.ts";
import type { Range } from "../text/range.ts";
import { findSentenceBoundaries } from "./sentence.ts";
import {
  type ChunkSettings,
  InputTooLongError,
  roundingDelta,
  validateChunkSettings,
} from "./settings.ts";

/** 検査対象範囲。index は検査実行内で 0 始まりの連番。paragraphIds は範囲と重なる段落すべて。 */
export interface TargetRange {
  readonly index: number;
  readonly range: Range;
  readonly paragraphIds: readonly number[];
}

/** 参考文脈。本文端や文脈長 0 では null。 */
export interface ContextWindow {
  readonly before: Range | null;
  readonly after: Range | null;
}

/** 1 回の検査要求に渡す本文の範囲。inputRange は before.start（なければ target.start）から after.end（なければ target.end）まで。 */
export interface CheckInput {
  readonly target: TargetRange;
  readonly context: ContextWindow;
  readonly inputRange: Range;
}

/**
 * 本文を検査対象に分割する（仕様書 6.1 手順 2〜4）。
 * 全位置がちょうど 1 つの検査対象に属する（タイル分割）。長さは書記素クラスタ数。
 */
export function planTargets(
  text: string,
  paragraphs: readonly Paragraph[],
  settings: ChunkSettings,
): TargetRange[] {
  validateChunkSettings(settings);
  const index = buildGraphemeIndex(text);
  const target = settings.targetGraphemes;
  const delta = roundingDelta(target, settings.roundingTolerance);
  // 段落の終端を書記素番号で。最後の段落は text.length で終わるため全文長も含まれる。
  const paragraphEnds = paragraphs.map((p) => graphemeAt(index, p.range.end));
  const targets: TargetRange[] = [];
  let cursor = 0; // 書記素番号
  while (cursor < index.count) {
    const remaining = index.count - cursor;
    // 最後の検査対象：境界探しより先に残り全部を 1 つにまとめる。
    const end =
      remaining <= target + delta
        ? index.count
        : chooseTargetEnd(index, text, paragraphEnds, cursor, cursor + target, delta);
    const range: Range = { start: offsetAt(index, cursor), end: offsetAt(index, end) };
    const paragraphIds = paragraphs
      .filter((p) => p.range.start < range.end && range.start < p.range.end)
      .map((p) => p.id);
    targets.push({ index: targets.length, range, paragraphIds });
    cursor = end;
  }
  return targets;
}

/** 検査対象に初回検査の参考文脈を付ける（仕様書 5.2、6.1 手順 5）。長さは書記素クラスタ数。 */
export function buildCheckInput(
  text: string,
  paragraphs: readonly Paragraph[],
  target: TargetRange,
  settings: ChunkSettings,
): CheckInput {
  validateChunkSettings(settings);
  const index = buildGraphemeIndex(text);
  const { before, after } = contextWindows(
    index,
    text,
    target,
    paragraphBoundaries(index, paragraphs),
    settings.contextGraphemes,
    settings.roundingTolerance,
  );
  return finishInput(index, target, before, after, settings.maxInputGraphemes);
}

/** 再確認用に文脈を広げる（仕様書 5.2、6.5）。initial.inputRange を必ず含む。 */
export function buildRecheckInput(
  text: string,
  paragraphs: readonly Paragraph[],
  initial: CheckInput,
  settings: ChunkSettings,
): CheckInput {
  validateChunkSettings(settings);
  const index = buildGraphemeIndex(text);
  const target = initial.target;
  const raw = contextWindows(
    index,
    text,
    target,
    paragraphBoundaries(index, paragraphs),
    settings.recheckContextGraphemes,
    settings.roundingTolerance,
  );
  // 初回入力を含むよう端を広げ、検査対象に対する前後の範囲を再構成する。
  const start = Math.min(raw.before?.start ?? target.range.start, initial.inputRange.start);
  const end = Math.max(raw.after?.end ?? target.range.end, initial.inputRange.end);
  const before: Range | null =
    start < target.range.start ? { start, end: target.range.start } : null;
  const after: Range | null = end > target.range.end ? { start: target.range.end, end } : null;
  return finishInput(index, target, before, after, settings.maxInputGraphemes);
}

/** 段落の始端・終端を書記素番号で並べ直す（paragraphs は id 順に並んでいる）。 */
function paragraphBoundaries(
  index: GraphemeIndex,
  paragraphs: readonly Paragraph[],
): { readonly starts: readonly number[]; readonly ends: readonly number[] } {
  const starts = paragraphs.map((p) => graphemeAt(index, p.range.start));
  const ends = paragraphs.map((p) => graphemeAt(index, p.range.end));
  return { starts, ends };
}

/**
 * 前後の参考文脈を求める。丸めは段落境界のみ（文境界は検査対象の終端にしか使わない）。
 * 本文端・文脈長 0 では null。
 */
function contextWindows(
  index: GraphemeIndex,
  text: string,
  target: TargetRange,
  boundaries: { readonly starts: readonly number[]; readonly ends: readonly number[] },
  context: number,
  tolerance: number,
): { before: Range | null; after: Range | null } {
  const delta = roundingDelta(context, tolerance);
  const targetStart = graphemeAt(index, target.range.start);
  const targetEnd = graphemeAt(index, target.range.end);
  let before: Range | null;
  if (targetStart === 0 || context === 0) {
    before = null;
  } else if (targetStart - context <= 0) {
    // ideal が本文の外にあれば丸めず、本文先頭までを丸ごと文脈にする。
    before = { start: 0, end: target.range.start };
  } else {
    const ideal = targetStart - context;
    // 前方は「検査対象から遠い方」が小さい方なので "smaller"。
    const s = chooseBoundary(
      ideal,
      delta,
      boundaries.starts.filter((b) => b < targetStart),
      "smaller",
    );
    before = { start: offsetAt(index, s ?? ideal), end: target.range.start };
  }
  let after: Range | null;
  if (targetEnd === index.count || context === 0) {
    after = null;
  } else if (targetEnd + context >= index.count) {
    after = { start: target.range.end, end: text.length };
  } else {
    const ideal = targetEnd + context;
    // 後方と検査対象の終端は「検査対象から遠い方」が大きい方なので "larger"。
    const e = chooseBoundary(
      ideal,
      delta,
      boundaries.ends.filter((b) => b > targetEnd),
      "larger",
    );
    after = { start: target.range.end, end: offsetAt(index, e ?? ideal) };
  }
  return { before, after };
}

/** inputRange を組み、上限を超えたら InputTooLongError を投げる（黙って縮めない）。 */
function finishInput(
  index: GraphemeIndex,
  target: TargetRange,
  before: Range | null,
  after: Range | null,
  maxInputGraphemes: number,
): CheckInput {
  const inputRange: Range = {
    start: before?.start ?? target.range.start,
    end: after?.end ?? target.range.end,
  };
  const required = graphemeAt(index, inputRange.end) - graphemeAt(index, inputRange.start);
  if (required > maxInputGraphemes) {
    throw new InputTooLongError(required, maxInputGraphemes);
  }
  return { target, context: { before, after }, inputRange };
}

/**
 * 検査対象の終端を決める（仕様書 6.1 手順 2〜3）。
 * 段落境界 → 文境界 → 理想位置（書記素境界）の順に窓内から選ぶ。
 * 候補は cursor より大きいものに限る（等しくなると空の対象が生まれるため）。
 */
function chooseTargetEnd(
  index: GraphemeIndex,
  text: string,
  paragraphEnds: readonly number[],
  cursor: number,
  ideal: number,
  delta: number,
): number {
  let end = chooseBoundary(
    ideal,
    delta,
    paragraphEnds.filter((b) => b > cursor),
    "larger",
  );
  if (end === null) {
    // 段落境界が窓にない場合は文境界へフォールバック。
    // 走査は窓の上端の直後まででよい（それより先の境界は候補になれない）。
    // 文境界は range.start より大きい書記素境界のみのため、候補が cursor に等しくない。
    // 段落末の終端記号の直後（改行の直前）も通常の文境界候補。そこで切ると次の対象は改行で始まり、
    // 改行を含む直前の段落 ID も paragraphIds に入る（段落範囲の定義どおり）。
    const scanEnd = offsetAt(index, Math.min(ideal + delta + 1, index.count));
    const sentence = findSentenceBoundaries(
      text,
      { start: offsetAt(index, cursor), end: scanEnd },
      index,
    ).map((o) => graphemeAt(index, o));
    end = chooseBoundary(ideal, delta, sentence, "larger");
  }
  if (end === null) {
    // 文境界も窓にない場合は理想位置（書記素境界）で切る。
    return ideal;
  }
  return end;
}

/**
 * 窓 [ideal - delta, ideal + delta]（両端を含む）にある候補のうち ideal に最も近いものを返す。
 * 同距離なら outer 側（"larger" なら大きい方、"smaller" なら小さい方）。候補がなければ null。
 * 単位は書記素番号。candidates は昇順でなくてよい。
 */
function chooseBoundary(
  ideal: number,
  delta: number,
  candidates: readonly number[],
  outer: "larger" | "smaller",
): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - ideal);
    if (distance > delta) {
      continue;
    }
    const closer = distance < bestDistance;
    const tiedOuter =
      best !== null &&
      distance === bestDistance &&
      (outer === "larger" ? candidate > best : candidate < best);
    if (closer || tiedOuter) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
