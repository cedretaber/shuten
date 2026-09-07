import type { FindingCategory, InitialVerdict } from "../llm/schema.ts";
import type { Range } from "../text/range.ts";
import type { LocatedCandidate } from "./candidate.ts";

/** 重複統合後の指摘。同一の検査実行内の位置確定済み候補だけから作る（仕様書 6.4）。 */
export interface MergedFinding {
  readonly id: string;
  readonly range: Range;
  /** 原文の引用。位置確定済みなので range の原文と同じ。 */
  readonly quote: string;
  /** 元候補の分類が一致すればその値、不一致なら unclear。 */
  readonly category: FindingCategory;
  readonly suggestion: string | null;
  /** 全候補が likely-error のときだけ likely-error。それ以外は confirm-with-author。 */
  readonly verdict: InitialVerdict;
  /** 統合した元候補。入力順。 */
  readonly sources: readonly LocatedCandidate[];
}

/**
 * 統合の同一性の鍵。範囲・引用・修正案が完全一致する候補だけが同じ鍵を持つ。
 * 修正案が無い候補は統合しないので null（仕様書 6.4）。
 */
export function mergeKey(candidate: LocatedCandidate): string | null {
  const { suggestion } = candidate.llm;
  if (suggestion === null) {
    return null;
  }
  const { range } = candidate.locate;
  const { quote } = candidate.llm;
  return `${range.start}:${range.end}:${JSON.stringify(quote)}:${JSON.stringify(suggestion)}`;
}

/** 統合前の候補グループ。作成時に first を保存し、以後 members[0] を参照しない。 */
interface Group {
  readonly firstIndex: number;
  readonly first: LocatedCandidate;
  readonly members: LocatedCandidate[];
}

/**
 * 同じ鍵の候補を 1 件にまとめる。呼び出し元は candidates が同一の検査実行のものであることを保証する。
 * 出力は range.start、range.end、最初の元候補の入力順で並べ、その順に createId() で id を付ける。
 */
export function mergeCandidates(
  candidates: readonly LocatedCandidate[],
  createId: () => string,
): MergedFinding[] {
  const keyedGroups = new Map<string, Group>();
  const standaloneGroups: Group[] = [];
  let index = 0;
  for (const candidate of candidates) {
    const key = mergeKey(candidate);
    if (key === null) {
      standaloneGroups.push({ firstIndex: index, first: candidate, members: [candidate] });
    } else {
      const existing = keyedGroups.get(key);
      if (existing === undefined) {
        keyedGroups.set(key, { firstIndex: index, first: candidate, members: [candidate] });
      } else {
        existing.members.push(candidate);
      }
    }
    index += 1;
  }

  const groups: Group[] = [...keyedGroups.values(), ...standaloneGroups];
  groups.sort((a, b) => {
    if (a.first.locate.range.start !== b.first.locate.range.start) {
      return a.first.locate.range.start - b.first.locate.range.start;
    }
    if (a.first.locate.range.end !== b.first.locate.range.end) {
      return a.first.locate.range.end - b.first.locate.range.end;
    }
    return a.firstIndex - b.firstIndex;
  });

  const result: MergedFinding[] = [];
  for (const group of groups) {
    const category = group.members.every((m) => m.llm.category === group.first.llm.category)
      ? group.first.llm.category
      : "unclear";
    const verdict = group.members.every((m) => m.llm.verdict === "likely-error")
      ? "likely-error"
      : "confirm-with-author";
    result.push({
      id: createId(),
      range: group.first.locate.range,
      quote: group.first.llm.quote,
      category,
      suggestion: group.first.llm.suggestion,
      verdict,
      sources: group.members,
    });
  }
  return result;
}
