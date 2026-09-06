/** UTF-16 コード単位の範囲。開始を含み終了を含まない [start, end)。 */
export interface Range {
  readonly start: number;
  readonly end: number;
}

/** 範囲で本文を切り出す。 */
export function sliceRange(text: string, range: Range): string {
  return text.slice(range.start, range.end);
}
