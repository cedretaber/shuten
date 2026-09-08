/**
 * 検査実行・検査単位の状態名（仕様書 8.1 / 8.2 節）。DB に保存する値の正本として、
 * ここでの値・並び順をそのまま DB の列挙に使う。
 */

/**
 * 検査実行の状態（仕様書 8.2 節「『完了』『一部失敗』『停止中』『実行中』を区別する」、
 * および終了確認待ちの「復旧待ち」）。
 */
export const RUN_STATUSES = [
  "running",
  "stopped",
  "recovery-waiting",
  "completed",
  "partially-failed",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * 検査単位・再確認単位の処理状態（仕様書 8.1 節「検査単位」「再確認単位」の「処理状態」）。
 * `not-applicable` は対象外（抑制済み、再確認無効など）を表す。
 */
export const UNIT_STATUSES = ["pending", "running", "done", "failed", "not-applicable"] as const;

export type UnitStatus = (typeof UNIT_STATUSES)[number];
