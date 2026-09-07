import { segmentGraphemes } from "./grapheme.ts";

/**
 * 書記素クラスタ境界の一覧。boundaries[k] は k 番目の書記素クラスタの開始位置（UTF-16 コード単位）、
 * boundaries[count] は text.length。位置 ⇄ 書記素番号の変換に使う。
 */
export interface GraphemeIndex {
  readonly boundaries: readonly number[];
  readonly count: number;
}

/** 本文から書記素インデックスを作る。 */
export function buildGraphemeIndex(text: string): GraphemeIndex {
  const boundaries = segmentGraphemes(text).map((s) => s.index);
  boundaries.push(text.length);
  return { boundaries, count: boundaries.length - 1 };
}

/** 位置が書記素境界かどうか。0 と text.length は常に境界。 */
export function isGraphemeBoundary(index: GraphemeIndex, offset: number): boolean {
  return searchBoundary(index, offset) >= 0;
}

/** 書記素境界の位置を書記素番号に変換する。境界でない位置は RangeError。 */
export function graphemeAt(index: GraphemeIndex, offset: number): number {
  const position = searchBoundary(index, offset);
  if (position === -1) {
    throw new RangeError(`書記素境界ではありません: 位置 ${offset}`);
  }
  return position;
}

/** 書記素番号（0..count）を位置に変換する。範囲外は RangeError。 */
export function offsetAt(index: GraphemeIndex, grapheme: number): number {
  if (!Number.isSafeInteger(grapheme) || grapheme < 0 || grapheme > index.count) {
    throw new RangeError(`書記素番号が範囲外です: ${grapheme}`);
  }
  const offset = index.boundaries[grapheme];
  if (offset === undefined) {
    throw new RangeError(`書記素番号が範囲外です: ${grapheme}`);
  }
  return offset;
}

/** offset が [0, boundaries[count]] 範囲のセーフ整数かを検証し、範囲外なら RangeError を投げる。 */
function validateOffset(index: GraphemeIndex, offset: number): void {
  const last = index.boundaries[index.count];
  if (last === undefined || !Number.isSafeInteger(offset) || offset < 0 || offset > last) {
    throw new RangeError(`位置が範囲外です: ${offset}`);
  }
}

/** offset 以下で最大の書記素境界を返す。offset が境界ならそのまま。範囲外（0 未満、text.length 超）は RangeError。 */
export function floorGraphemeBoundary(index: GraphemeIndex, offset: number): number {
  validateOffset(index, offset);
  let lo = 0;
  let hi = index.count;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const value = index.boundaries[mid];
    if (value === undefined) {
      throw new RangeError(`位置が範囲外です: ${offset}`);
    }
    if (value <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const result = index.boundaries[lo];
  if (result === undefined) {
    throw new RangeError(`位置が範囲外です: ${offset}`);
  }
  return result;
}

/** offset 以上で最小の書記素境界を返す。offset が境界ならそのまま。範囲外は RangeError。 */
export function ceilGraphemeBoundary(index: GraphemeIndex, offset: number): number {
  validateOffset(index, offset);
  let lo = 0;
  let hi = index.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const value = index.boundaries[mid];
    if (value === undefined) {
      throw new RangeError(`位置が範囲外です: ${offset}`);
    }
    if (value >= offset) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  const result = index.boundaries[lo];
  if (result === undefined) {
    throw new RangeError(`位置が範囲外です: ${offset}`);
  }
  return result;
}

/** 二分探索で offset の位置を返す。見つからなければ -1。 */
function searchBoundary(index: GraphemeIndex, offset: number): number {
  let lo = 0;
  let hi = index.boundaries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const value = index.boundaries[mid];
    if (value === undefined) {
      return -1;
    }
    if (value === offset) {
      return mid;
    }
    if (value < offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}
