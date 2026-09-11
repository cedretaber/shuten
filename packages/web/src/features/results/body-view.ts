import { splitParagraphs } from "@shuten/shared";

/** 強調の対象。`range` は保存済みの UTF-16 範囲 `[start, end)`。 */
export interface Highlight {
  readonly id: string;
  readonly range: { readonly start: number; readonly end: number };
}

/** 段落内の 1 区切り。`findingIds` が空なら素のテキスト。 */
export interface BodySegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly findingIds: readonly string[];
}

/** 段落 1 つ分。`id` は `splitParagraphs` の段落 ID（0 始まり）。 */
export interface BodyParagraph {
  readonly id: number;
  readonly segments: readonly BodySegment[];
}

/**
 * 段落範囲の末尾から改行列（CRLF・LF・CR のいずれか 1 つ）を 1 つ分だけ落とし、
 * 内容範囲（改行を含まない範囲）を返す。
 * `splitParagraphs` は区切りの改行列を直前の段落の範囲に含めて返す仕様なので、
 * ここではその末尾だけを見て改行の長さ（0・1・2）を判定すればよい。
 */
function contentEnd(body: string, start: number, end: number): number {
  if (end > start) {
    const last = body.charCodeAt(end - 1);
    if (last === 0x0a) {
      // LF、または CRLF の末尾。直前が CR なら 2 文字分落とす。
      if (end - 1 > start && body.charCodeAt(end - 2) === 0x0d) {
        return end - 2;
      }
      return end - 1;
    }
    if (last === 0x0d) {
      // 単独 CR。
      return end - 1;
    }
  }
  return end;
}

/**
 * 保存済みの UTF-16 範囲による強調を、本文の DOM 表示用にセグメント分割する。
 *
 * 書記素境界の計算はしない（強調範囲はサーバー側で書記素境界に揃えて保存済みという前提）。
 */
export function buildBodyView(body: string, highlights: readonly Highlight[]): BodyParagraph[] {
  const paragraphs = splitParagraphs(body);

  return paragraphs.map((paragraph) => {
    const start = paragraph.range.start;
    const end = contentEnd(body, paragraph.range.start, paragraph.range.end);

    if (end <= start) {
      return { id: paragraph.id, segments: [] };
    }

    // この段落の内容範囲に重なる強調を、範囲内に切り詰めて集める。
    const clipped: { readonly id: string; readonly start: number; readonly end: number }[] = [];
    for (const highlight of highlights) {
      if (highlight.range.end <= highlight.range.start) {
        continue;
      }
      const clippedStart = Math.max(start, highlight.range.start);
      const clippedEnd = Math.min(end, highlight.range.end);
      if (clippedEnd > clippedStart) {
        clipped.push({ id: highlight.id, start: clippedStart, end: clippedEnd });
      }
    }

    // 切れ目（内容範囲の両端 ∪ 切り詰めた強調の開始・終了）を昇順・重複なしで並べる。
    const boundarySet = new Set<number>([start, end]);
    for (const highlight of clipped) {
      boundarySet.add(highlight.start);
      boundarySet.add(highlight.end);
    }
    const boundaries = Array.from(boundarySet).sort((a, b) => a - b);

    const segments: BodySegment[] = [];
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const segStart = boundaries[i] as number;
      const segEnd = boundaries[i + 1] as number;
      // このセグメントを完全に覆う強調の ID を、highlights の順序のまま集める
      // （clipped は highlights を走査した順に積んでいるので、そのまま順序が保たれる）。
      const findingIds = clipped
        .filter((c) => c.start <= segStart && c.end >= segEnd)
        .map((c) => c.id);
      segments.push({
        start: segStart,
        end: segEnd,
        text: body.slice(segStart, segEnd),
        findingIds,
      });
    }

    return { id: paragraph.id, segments };
  });
}
