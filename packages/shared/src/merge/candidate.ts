import type { LlmFinding, Perspective } from "../llm/schema.ts";
import type { LocateResult } from "../locate/locate.ts";

/** 観点別検査が返した指摘 1 件と、その位置確定の結果。id は呼び出し元（server）が付ける。 */
export interface CandidateBase {
  readonly id: string;
  readonly perspective: Perspective;
  readonly llm: LlmFinding;
}
/** 位置確定済みの候補。統合・抑制・再確認はこれだけを扱う。 */
export interface LocatedCandidate extends CandidateBase {
  readonly locate: Extract<LocateResult, { status: "located" }>;
}
/**
 * 位置特定失敗の候補。統合・抑制・再確認に進まず、そのまま保存して一覧に表示する（not-found / ambiguous）か、
 * 診断記録にだけ残す（outside-target）。
 */
export interface UnlocatedCandidate extends CandidateBase {
  readonly locate: Extract<LocateResult, { status: "failed" }>;
}
export type Candidate = LocatedCandidate | UnlocatedCandidate;

/** locate.status で Candidate を絞り込む。TypeScript はネストした status を自動で絞り込めないため明示する。 */
function isLocated(candidate: Candidate): candidate is LocatedCandidate {
  return candidate.locate.status === "located";
}

/** 位置確定済みと失敗に分ける。それぞれ入力順を保つ。 */
export function partitionCandidates(candidates: readonly Candidate[]): {
  readonly located: readonly LocatedCandidate[];
  readonly unlocated: readonly UnlocatedCandidate[];
} {
  const located: LocatedCandidate[] = [];
  const unlocated: UnlocatedCandidate[] = [];
  for (const candidate of candidates) {
    if (isLocated(candidate)) {
      located.push(candidate);
    } else {
      unlocated.push(candidate);
    }
  }
  return { located, unlocated };
}
