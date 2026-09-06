import type { GraphemeIndex } from "../text/grapheme-index.ts";
import { isGraphemeBoundary } from "../text/grapheme-index.ts";
import type { Range } from "../text/range.ts";

/** 終端記号のコードポイント集合（。！？!?）。 */
const TERMINALS = new Set([0x3002, 0xff01, 0xff1f, 0x0021, 0x003f]);

/** 閉じ括弧のコードポイント集合（」』）】〕〉》］)）。 */
const CLOSERS = new Set([0x300d, 0x300f, 0xff09, 0x3011, 0x3015, 0x3009, 0x300b, 0xff3d, 0x0029]);

/**
 * 範囲内の文境界を返す（仕様書 6.1 手順 3 の「文境界」）。
 * 終端記号（。！？!?）で始まり、終端記号と閉じ括弧だけが続く最長の並びの直後を文境界とする。
 * 返す位置は range.start より大きく range.end より小さい書記素境界に限る。昇順。
 */
export function findSentenceBoundaries(text: string, range: Range, index: GraphemeIndex): number[] {
  const boundaries: number[] = [];
  let i = range.start;
  while (i < range.end) {
    if (!TERMINALS.has(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    // 終端記号の直後にある終端記号・閉じ括弧の最長の並びをスキップする。
    let j = i + 1;
    while (
      j < range.end &&
      (TERMINALS.has(text.charCodeAt(j)) || CLOSERS.has(text.charCodeAt(j)))
    ) {
      j += 1;
    }
    // 並びの直後が範囲内かつ書記素境界のときのみ文境界とする。
    if (j < range.end && isGraphemeBoundary(index, j)) {
      boundaries.push(j);
    }
    i = j;
  }
  return boundaries;
}
