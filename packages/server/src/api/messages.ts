/**
 * `POST /api/settings/connection/check` が返す `error.message` の定型文（決定 8）。
 *
 * `reason`（`FailureReason`）ごとに固定した文言だけを使う。例外自身の `message`
 * （`LmStudioError.message` は接続先 URL を含みうる。決定 4・不変条件）は転記しない。
 * 実行側（`run/executor.ts` の `haltForChatError` / `haltForEnsureLoadedError`）が
 * `stop_message` に使う言い回しに揃える。
 *
 * 接続確認は `listModels()` しか呼ばない（決定 8。試験生成は送らない）ので、実際に届きうるのは
 * `connection` / `timeout` / `aborted` / `malformed` の 4 つだけだが、`Record<FailureReason, string>`
 * にして `FAILURE_REASONS` を網羅する（値が増えたらここが型エラーになるため、足し忘れない）。
 */

import type { FailureReason } from "@shuten/shared";

export const CONNECTION_CHECK_ERROR_MESSAGES: Record<FailureReason, string> = {
  connection: "LM Studio との接続を確認できませんでした",
  timeout: "LM Studio への接続確認がタイムアウトしました",
  aborted: "接続確認が中断されました",
  malformed: "LM Studio のモデル一覧を解析できませんでした",
  "model-not-loaded": "モデルがロードされていません",
  truncated: "生成が途中で打ち切られました",
  "input-too-long": "入力が長すぎます",
};
