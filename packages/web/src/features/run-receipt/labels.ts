/**
 * `RunStatus` / `RunStopReason`（`@shuten/shared`）の画面向け日本語ラベル（決定 16）。
 *
 * `satisfies Record<...>` を付けることで、shared 側の列挙が増えたときにここが型検査で
 * 落ちるようにする。`default` の無い `switch` は書き方によっては列挙が増えても検査を
 * すり抜けるため使わない。
 */

import type { RunStatus, RunStopReason } from "@shuten/shared";

export const RUN_STATUS_LABELS = {
  running: "実行中",
  stopped: "停止中",
  "recovery-waiting": "復旧待ち",
  completed: "完了",
  "partially-failed": "一部失敗",
} as const satisfies Record<RunStatus, string>;

export const RUN_STOP_REASON_LABELS = {
  "model-not-loaded": "モデル未ロード",
  "recovery-needed": "復旧が必要",
  "connection-lost": "接続切断",
  settings: "検査設定",
  aborted: "中断",
  "internal-error": "内部エラー",
  "recovery-blocked": "別の実行の復旧待ち",
  "backend-restarted": "サーバー再起動",
} as const satisfies Record<RunStopReason, string>;
