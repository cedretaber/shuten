import type { Range } from "./range.ts";

/** 段落。id は原稿版内で 0 始まりの出現順。 */
export interface Paragraph {
  readonly id: number;
  readonly range: Range;
}

/**
 * 本文を段落に分割する（仕様書 6.1 節）。
 * CRLF・単独 LF・単独 CR のいずれか 1 つの改行列で区切られた行が段落。
 * 区切りの改行列は直前の段落の範囲に含める。空行も段落として保持する。
 */
export function splitParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x0d) {
      // CR。直後に LF が続く場合は CRLF として 1 つの区切りにする。
      const end = i + 1 < text.length && text.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1;
      paragraphs.push({ id: paragraphs.length, range: { start, end } });
      start = end;
      i = end;
    } else if (code === 0x0a) {
      const end = i + 1;
      paragraphs.push({ id: paragraphs.length, range: { start, end } });
      start = end;
      i = end;
    } else {
      i += 1;
    }
  }
  if (start < text.length) {
    paragraphs.push({ id: paragraphs.length, range: { start, end: text.length } });
  }
  return paragraphs;
}
