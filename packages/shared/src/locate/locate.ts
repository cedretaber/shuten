import type { CheckInput } from "../chunk/plan.ts";
import { buildGraphemeIndex, isGraphemeBoundary } from "../text/grapheme-index.ts";
import type { Paragraph } from "../text/paragraph.ts";
import type { Range } from "../text/range.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { diagnoseQuote } from "./diagnostic.ts";
import type { QuoteRef } from "./quote-ref.ts";

/** 位置特定失敗の理由。not-found / ambiguous は一覧に表示する失敗、outside-target は診断記録にだけ残す。 */
export type LocateFailureReason = "not-found" | "ambiguous" | "outside-target";

export type LocateResult =
  | { readonly status: "located"; readonly range: Range }
  | {
      readonly status: "failed";
      readonly reason: LocateFailureReason;
      /** 絞り込み後に残った完全一致。not-found では空。診断用の記録であり、強調・再確認・採用位置に使ってはならない（仕様書 6.3）。 */
      readonly exactMatches: readonly Range[];
      /** 診断。not-found（空引用を除く）のときだけ非 null。 */
      readonly diagnostic: Diagnostic | null;
    };

/**
 * 引用を原文の位置に確定する（仕様書 6.3）。
 * inputRange 全体で完全一致を集め、複数なら段落 ID・before・after で 1 件に絞り、開始位置が target.range 内なら採用する。
 */
export function locateQuote(
  text: string,
  input: CheckInput,
  paragraphs: readonly Paragraph[],
  ref: QuoteRef,
): LocateResult {
  const index = buildGraphemeIndex(text);
  const ir = input.inputRange;
  const tr = input.target.range;
  // 空引用は何にも一致しない（不変条件）。診断は付けない。
  if (ref.quote === "") {
    return { status: "failed", reason: "not-found", exactMatches: [], diagnostic: null };
  }
  const quote = ref.quote;
  // 原文側で完全一致を集める。inputRange 内（開始・終了ともに）の一致のみ。
  const matches: Range[] = [];
  let pos = text.indexOf(quote, ir.start);
  while (pos !== -1 && pos + quote.length <= ir.end) {
    if (isGraphemeBoundary(index, pos) && isGraphemeBoundary(index, pos + quote.length)) {
      matches.push({ start: pos, end: pos + quote.length });
    }
    pos = text.indexOf(quote, pos + 1);
  }
  if (matches.length === 0) {
    return {
      status: "failed",
      reason: "not-found",
      exactMatches: [],
      diagnostic: diagnoseQuote(text, ir, paragraphs, ref, index),
    };
  }
  // 絞り込み。strip は CR / LF のみ除去する（引用自体は改行込みで正確に照合する）。
  const strip = (s: string): string => s.replace(/\r|\n/g, "");
  const before = strip(ref.before);
  const after = strip(ref.after);
  // 段落 ID は入力範囲と重なる段落の中で探す。入力範囲外の段落 ID は、存在しない ID と同じくヒントなしとして飛ばす
  // （完全一致はすべて入力範囲内にあるので、入力範囲外の段落を指すヒントは必ず全候補と矛盾する）。
  const hasRefParagraph = paragraphs.some(
    (paragraph) =>
      paragraph.id === ref.paragraphId &&
      paragraph.range.start < ir.end &&
      ir.start < paragraph.range.end,
  );
  const filters: Array<(m: Range) => boolean> = [];
  if (hasRefParagraph) {
    filters.push((m) => {
      for (const p of paragraphs) {
        if (p.range.start <= m.start && m.start < p.range.end) {
          return p.id === ref.paragraphId;
        }
      }
      return false;
    });
  }
  if (before !== "") {
    filters.push((m) => strip(text.slice(ir.start, m.start)).endsWith(before));
  }
  if (after !== "") {
    filters.push((m) => strip(text.slice(m.end, ir.end)).startsWith(after));
  }
  let current = matches;
  for (const filter of filters) {
    if (current.length === 1) {
      break;
    }
    const kept = current.filter(filter);
    // ヒントが全候補と矛盾したら絞り込みを止め、その前の候補のまま残す。
    if (kept.length === 0) {
      break;
    }
    current = kept;
  }
  const inTarget = (m: Range): boolean => tr.start <= m.start && m.start < tr.end;
  if (current.length === 1) {
    const m = current[0];
    // 上記で length === 1 を確認済みのガード。noUncheckedIndexedAccess 対応。
    if (m === undefined) {
      throw new Error("絞り込みの結果が空です（起こりえない）");
    }
    if (inTarget(m)) {
      return { status: "located", range: m };
    }
    return { status: "failed", reason: "outside-target", exactMatches: [m], diagnostic: null };
  }
  const reason = current.some(inTarget) ? "ambiguous" : "outside-target";
  return { status: "failed", reason, exactMatches: current, diagnostic: null };
}
