/**
 * 検査実行・検査単位の状態名（仕様書 8.1 / 8.2 節）。値の正本は `@shuten/shared` の
 * `run/status.ts` に移した（PR10 決定 2・9）。web からも参照するため。ここでは再エクスポートだけ行う。
 */
export { RUN_STATUSES, type RunStatus, UNIT_STATUSES, type UnitStatus } from "@shuten/shared";
