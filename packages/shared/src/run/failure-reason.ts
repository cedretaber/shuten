/**
 * 生成要求が失敗しうる理由の区分（仕様書 7 節）。
 *
 * LM Studio を経由しない失敗（PR7 の `InputTooLongError` からの `input-too-long` など）や
 * web での表示（PR12）も同じ列挙を使うため `shared` に置く。
 */
export const FAILURE_REASONS = [
  "connection",
  "model-not-loaded",
  "input-too-long",
  "timeout",
  "truncated",
  "malformed",
  "aborted",
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];
