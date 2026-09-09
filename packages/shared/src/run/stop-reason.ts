/**
 * 検査実行の停止理由・再確認対象外の理由・元候補と指摘の位置特定状態の語彙。DB に保存する
 * 値の正本として、ここでの値・並び順をそのまま DB の列挙に使う。server（DB スキーマ）と
 * web（画面表示）の両方が参照するため shared に置く（PR10 決定 2・9）。
 */

/**
 * `runs.stop_reason`。
 *
 * `backend-restarted` はオーケストレーターの halt を経由する停止理由ではない（決定 13・40）。
 * 起動時照合（`reconcileOnStartup`）は halt を経由せずに直接この値を書くので、halt 由来の
 * 停止理由に足す必要が無い。
 */
export const RUN_STOP_REASONS = [
  "model-not-loaded",
  "recovery-needed",
  "connection-lost",
  "settings",
  "aborted",
  "internal-error",
  "recovery-blocked",
  "backend-restarted",
] as const;

export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

/** `recheck_units.not_applicable_reason`。仕様書 6.5 節。 */
export const RECHECK_NOT_APPLICABLE_REASONS = ["disabled", "suppressed", "unlocated"] as const;

export type RecheckNotApplicableReason = (typeof RECHECK_NOT_APPLICABLE_REASONS)[number];

/** `candidates` / `findings` の位置特定状態。`located` の有無だけが違う。 */
export const CANDIDATE_LOCATE_STATUSES = [
  "located",
  "not-found",
  "ambiguous",
  "outside-target",
] as const;

export type CandidateLocateStatus = (typeof CANDIDATE_LOCATE_STATUSES)[number];

export const FINDING_LOCATE_STATUSES = ["located", "not-found", "ambiguous"] as const;

export type FindingLocateStatus = (typeof FINDING_LOCATE_STATUSES)[number];
