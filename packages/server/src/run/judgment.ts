/**
 * 指摘に対する作者の採否（仕様書 5.3 節）。値の正本は `@shuten/shared` の `run/judgment.ts` に
 * 移した（PR10 決定 2・9）。web からも参照するため。ここでは再エクスポートだけ行う。
 */
export { JUDGMENT_STATUSES, type JudgmentStatus } from "@shuten/shared";
