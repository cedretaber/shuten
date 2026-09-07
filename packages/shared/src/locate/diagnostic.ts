import type { GraphemeIndex } from "../text/grapheme-index.ts";
import { isGraphemeBoundary } from "../text/grapheme-index.ts";
import type { Paragraph } from "../text/paragraph.ts";
import type { Range } from "../text/range.ts";
import { sliceRange } from "../text/range.ts";
import { DIAGNOSTIC_TRANSFORM_VERSION } from "../versions.ts";
import type { DiagnosticTransform } from "./position-map.ts";
import {
  applyTransform,
  buildComparisonText,
  coverSource,
  mapToSource,
  overlapsTransformedChunk,
} from "./position-map.ts";
import type { QuoteRef } from "./quote-ref.ts";

/** 位置特定失敗の診断候補 1 件。原文は変更しない。range は原文側の範囲で、位置対応が取れなければ null。 */
export interface DiagnosticCandidate {
  readonly transform: DiagnosticTransform;
  /** 一致を覆う最小の書記素境界範囲の原文。range があればその範囲の原文と同じ。 */
  readonly text: string;
  readonly range: Range | null;
}

/** 位置特定失敗の診断。強調・再確認・採用位置には使わない（仕様書 6.3）。 */
export interface Diagnostic {
  /** 変換規則の版（DIAGNOSTIC_TRANSFORM_VERSION）。 */
  readonly transformVersion: string;
  /** 指定段落に近い順、最大 DIAGNOSTIC_CANDIDATE_LIMIT 件。 */
  readonly candidates: readonly DiagnosticCandidate[];
  /** 見つけたが保存しなかった候補の数。 */
  readonly omitted: number;
  /** 見つけた候補（省いた分も含む）に同じ近さのものが 2 件以上あるか。一意な一致と誤認させないための印。 */
  readonly tied: boolean;
}

/** 保存する候補の上限。 */
export const DIAGNOSTIC_CANDIDATE_LIMIT: number = 3;

/** 適用する変換の順序。 */
const TRANSFORMS: readonly DiagnosticTransform[] = ["newline", "nfc", "newline+nfc"];

/** 整列・打ち切り前の候補。 */
interface CollectedCandidate {
  readonly transform: DiagnosticTransform;
  readonly text: string;
  readonly range: Range | null;
  readonly cover: Range;
  readonly distance: number;
}

/** 完全一致が 0 件のときだけ呼ぶ。inputRange 内で 3 変換の比較を行い、候補を近い順に返す。 */
export function diagnoseQuote(
  text: string,
  inputRange: Range,
  paragraphs: readonly Paragraph[],
  ref: QuoteRef,
  index: GraphemeIndex,
): Diagnostic {
  const slice = sliceRange(text, inputRange);
  const refExists = paragraphs.some((p) => p.id === ref.paragraphId);
  const collected: CollectedCandidate[] = [];
  const seen = new Set<string>();
  for (const transform of TRANSFORMS) {
    const cmp = buildComparisonText(text, inputRange, index, transform);
    const q = applyTransform(ref.quote, transform);
    // この変換が何も変えないなら、完全一致の失敗と等価なので候補にならない。
    if (cmp.text === slice && q === ref.quote) {
      continue;
    }
    // 空引用は何にも一致しない（不変条件）。
    if (q.length === 0) {
      continue;
    }
    let from = 0;
    while (true) {
      const s = cmp.text.indexOf(q, from);
      if (s === -1) {
        break;
      }
      const e = s + q.length;
      from = s + 1;
      // 引用が不変で一致箇所も変換チャンクと重ならない場合、原文に同じ一致があったが
      // 書記素境界で拒否されたものなので「変換後の一致」ではない。
      if (q === ref.quote && !overlapsTransformedChunk(cmp, s, e)) {
        continue;
      }
      const cover = coverSource(cmp, index, s, e);
      const key = `${cover.start}:${cover.end}`;
      // 原文範囲で重複排除。早い変換が優先。
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const ms = mapToSource(cmp, s);
      const me = mapToSource(cmp, e);
      const range: Range | null =
        ms !== null && me !== null && isGraphemeBoundary(index, ms) && isGraphemeBoundary(index, me)
          ? { start: ms, end: me }
          : null;
      const paragraph = paragraphs.find(
        (p) => p.range.start <= cover.start && cover.start < p.range.end,
      );
      if (paragraph === undefined) {
        throw new RangeError(`段落が本文を覆っていません: 位置 ${cover.start}`);
      }
      const distance = refExists ? Math.abs(paragraph.id - ref.paragraphId) : 0;
      collected.push({
        transform,
        text: sliceRange(text, cover),
        range,
        cover,
        distance,
      });
    }
  }
  collected.sort(
    (a, b) => a.distance - b.distance || a.cover.start - b.cover.start || a.cover.end - b.cover.end,
  );
  const countByDistance = new Map<number, number>();
  for (const c of collected) {
    countByDistance.set(c.distance, (countByDistance.get(c.distance) ?? 0) + 1);
  }
  let tied = false;
  for (const count of countByDistance.values()) {
    if (count >= 2) {
      tied = true;
    }
  }
  const candidates = collected.slice(0, DIAGNOSTIC_CANDIDATE_LIMIT).map((c) => ({
    transform: c.transform,
    text: c.text,
    range: c.range,
  }));
  const omitted = collected.length - candidates.length;
  return {
    transformVersion: DIAGNOSTIC_TRANSFORM_VERSION,
    candidates,
    omitted,
    tied,
  };
}
