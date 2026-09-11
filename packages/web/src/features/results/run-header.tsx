/**
 * 結果画面（`/runs/:id`）の上部（決定 1）。
 *
 * PR11 の受付表示（`features/run-receipt/run-receipt-page.tsx`、削除済み）から、原稿名・状態・
 * 停止理由・停止メッセージ・モデル ID・開始/終了時刻・「最新の状態を取得」ボタンを引き継ぐ。
 * `status === "stopped" && stopReason === "settings"` は「検査は開始できませんでした」とだけ表示し、
 * 通常の状態表示（状態・停止理由・モデル・時刻）は出さない（PR11 決定 16 の `isSettingsStop` を
 * そのまま持ち込む）。
 *
 * 上部の DOM をここ 1 か所に閉じ込めることで、PR12b が進捗・停止・再開の操作をここへ足せるようにする
 * （決定 1）。`progress` はここでは読まない（PR12b の担当）。
 */

import type { RunDto } from "@shuten/shared";
import { Link } from "react-router";
import { ROUTES } from "../../app/routes.ts";
import { formatDateTime } from "./format-date-time.ts";
import { RUN_STATUS_LABELS, RUN_STOP_REASON_LABELS } from "./labels.ts";
import styles from "./results-page.module.css";

/** `stopped` かつ `stopReason === "settings"` は検査の開始そのものに失敗している（PR11 決定 16）。 */
export function isSettingsStop(run: RunDto): boolean {
  return run.status === "stopped" && run.stopReason === "settings";
}

export interface RunHeaderProps {
  readonly run: RunDto;
  readonly manuscriptName: string;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}

export function RunHeader(props: RunHeaderProps) {
  const { run, manuscriptName, onRefresh, refreshing } = props;

  return (
    <div className={styles.header}>
      <h1>{manuscriptName}</h1>

      {isSettingsStop(run) ? (
        <div className={styles.status}>
          <p className={styles.statusLine}>検査は開始できませんでした</p>
          {run.stopMessage !== null && <p className={styles.stopMessage}>{run.stopMessage}</p>}
          <p>
            <Link to={ROUTES.home}>検査設定に戻る</Link>
          </p>
        </div>
      ) : (
        <div className={styles.status}>
          <p className={styles.statusLine}>状態: {RUN_STATUS_LABELS[run.status]}</p>
          {run.stopReason !== null && (
            <p className={styles.statusLine}>停止理由: {RUN_STOP_REASON_LABELS[run.stopReason]}</p>
          )}
          {run.stopMessage !== null && <p className={styles.stopMessage}>{run.stopMessage}</p>}
          <p className={styles.statusLine}>モデル: {run.modelId}</p>
          <p className={styles.statusLine}>開始: {formatDateTime(run.startedAt)}</p>
          {run.finishedAt !== null && (
            <p className={styles.statusLine}>終了: {formatDateTime(run.finishedAt)}</p>
          )}
        </div>
      )}

      <button
        type="button"
        className={styles.refreshButton}
        onClick={onRefresh}
        disabled={refreshing}
      >
        {refreshing ? "更新中…" : "最新の状態を取得"}
      </button>
    </div>
  );
}
