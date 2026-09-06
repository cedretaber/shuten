/**
 * 書記素クラスタの分割と計数。
 *
 * 仕様書 5.2 節・6.1 節のとおり、分割長や文脈長の「字」は書記素クラスタ数で数える。
 * 位置の保存に使う UTF-16 コード単位とは別物であり、ここでは数えるだけで位置を返さない。
 *
 * Intl.Segmenter の境界判定は実行環境の ICU に依存する。分割範囲と確定位置の正本は
 * サーバーが保存した値であり、ブラウザ側で再計算した結果で上書きしない
 * （docs/decisions/0001-tech-stack.md）。
 */

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

/** 書記素クラスタごとの文字列と、元文字列内の UTF-16 コード単位の開始位置。 */
export interface GraphemeSegment {
  readonly segment: string;
  /** 元文字列内の開始位置（UTF-16 コード単位、0 始まり）。 */
  readonly index: number;
}

/** 文字列を書記素クラスタに分割する。 */
export function segmentGraphemes(text: string): GraphemeSegment[] {
  const result: GraphemeSegment[] = [];
  for (const { segment, index } of segmenter.segment(text)) {
    result.push({ segment, index });
  }
  return result;
}

/** 書記素クラスタ数を返す。 */
export function countGraphemes(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) {
    count += 1;
  }
  return count;
}
