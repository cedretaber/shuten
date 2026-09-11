/**
 * 結果画面（`/runs/:id`）の上部（決定 1）。
 *
 * PR11 の受付表示（`features/run-receipt/run-receipt-page.tsx`、削除済み）から、原稿名・状態・
 * 停止理由・停止メッセージ・モデル ID・開始/終了時刻・「最新の状態を取得」ボタンを引き継ぐ。
 * `status === "stopped" && stopReason === "settings"` は「検査は開始できませんでした」とだけ表示し、
 * 通常の状態表示（状態・停止理由・モデル・時刻）・中間状態の案内・進捗は出さない（PR11 決定 16 の
 * `isSettingsStop` をそのまま持ち込む。PR12b 決定 14）。
 *
 * PR12b（Task 5）で「画面ごとの仕様」1〜8 をこの 1 か所に組み込んだ：
 * 1. 原稿名、2. 状態・停止理由・停止メッセージ・モデル・時刻（以上 PR12a のまま）、
 * 3. 中間状態の案内（決定 9・`statusNotice`）、4+5. 進捗（決定 10・11・`RunProgress`。
 * 遅延通知はコントローラーの裁定で `RunProgress` 側に一本化しており、ここでは描かない）、
 * 6+7. 操作と操作結果の案内（決定 6・7・8・`RunControl`）、8. 「最新の状態を取得」（PR12a のまま。
 * 自動更新の状態を表す 1 行（決定 4）は `RunHeader` の外——呼び出し元の `results-page.tsx`
 * （PR12b Task 8）が SSE の購読・取り直しの合流を持つため、そちらで描く）。
 */

import type { ProgressDto, RunDto, RunUnitsDto } from "@shuten/shared";
import { Link } from "react-router";
import { ROUTES } from "../../app/routes.ts";
import { formatDateTime } from "./format-date-time.ts";
import { RUN_STATUS_LABELS, RUN_STOP_REASON_LABELS } from "./labels.ts";
import styles from "./results-page.module.css";
import { type ControlFailure, type PendingControlAction, statusNotice } from "./run-control.ts";
import { RunControl } from "./run-control.tsx";
import { RunProgress } from "./run-progress.tsx";

/** `stopped` かつ `stopReason === "settings"` は検査の開始そのものに失敗している（PR11 決定 16）。 */
export function isSettingsStop(run: RunDto): boolean {
  return run.status === "stopped" && run.stopReason === "settings";
}

export interface RunHeaderProps {
  readonly run: RunDto;
  readonly manuscriptName: string;
  /** `GET /api/runs/:id` の `progress`（決定 5・11）。 */
  readonly progress: ProgressDto;
  /** `GET /api/runs/:id/units` の応答（決定 5）。未取得・失敗なら null。 */
  readonly units: RunUnitsDto | null;
  /** 決定 10：まだ `running` の遅延通知（`generation-slow`）の件数。 */
  readonly slowUnitCount: number;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  /** 押されたら親が API を呼び、終わったら必ず取り直す（決定 8）。 */
  readonly onStop: () => void;
  readonly onResume: () => void;
  readonly onRetryFailed: () => void;
  readonly onConfirmRecovery: () => void;
  /** 送信中の操作（重複送信を防ぐ。null なら送信していない）。 */
  readonly pending: PendingControlAction;
  readonly failure: ControlFailure | null;
}

export function RunHeader(props: RunHeaderProps) {
  const {
    run,
    manuscriptName,
    progress,
    units,
    slowUnitCount,
    onRefresh,
    refreshing,
    onStop,
    onResume,
    onRetryFailed,
    onConfirmRecovery,
    pending,
    failure,
  } = props;
  const settingsStop = isSettingsStop(run);
  const notice = statusNotice(run);

  return (
    <div className={styles.header}>
      <h1>{manuscriptName}</h1>

      {settingsStop ? (
        <div className={styles.status}>
          <p className={styles.statusLine}>検査は開始できませんでした</p>
          {run.stopMessage !== null && <p className={styles.stopMessage}>{run.stopMessage}</p>}
          <p>
            <Link to={ROUTES.home}>検査設定に戻る</Link>
          </p>
        </div>
      ) : (
        <>
          <div className={styles.status}>
            <p className={styles.statusLine}>状態: {RUN_STATUS_LABELS[run.status]}</p>
            {run.stopReason !== null && (
              <p className={styles.statusLine}>
                停止理由: {RUN_STOP_REASON_LABELS[run.stopReason]}
              </p>
            )}
            {run.stopMessage !== null && <p className={styles.stopMessage}>{run.stopMessage}</p>}
            <p className={styles.statusLine}>モデル: {run.modelId}</p>
            {/* 裁定（最終レビュー Important 3）：ローカル時刻で表示する。オフセットは表示対象の
                瞬間ごとに `-new Date(iso).getTimezoneOffset()` で求める（`format-date-time.ts` 参照）。 */}
            <p className={styles.statusLine}>
              開始: {formatDateTime(run.startedAt, -new Date(run.startedAt).getTimezoneOffset())}
            </p>
            {run.finishedAt !== null && (
              <p className={styles.statusLine}>
                終了:{" "}
                {formatDateTime(run.finishedAt, -new Date(run.finishedAt).getTimezoneOffset())}
              </p>
            )}
          </div>

          {/* 3. 中間状態の案内（決定 9）。停止ボタンが disabled になる理由もここに出る。 */}
          {notice !== null && <p className={styles.statusNotice}>{notice}</p>}

          {/* 4+5. 進捗（決定 10・11）。`run.recheckEnabled` は `RunDto` にすでにあるので、別 props
              として受け取らずここから渡す。 */}
          <RunProgress
            progress={progress}
            units={units}
            recheckEnabled={run.recheckEnabled}
            slowUnitCount={slowUnitCount}
          />
        </>
      )}

      {/* 6+7. 操作と操作結果の案内（決定 6・7・8）。`isSettingsStop` でも失敗単位の再試行だけは
          `controlAvailability` の判断に従って出す（決定 14）ので、上の分岐の外に置く。 */}
      <RunControl
        run={run}
        units={units}
        onStop={onStop}
        onResume={onResume}
        onRetryFailed={onRetryFailed}
        onConfirmRecovery={onConfirmRecovery}
        pending={pending}
        failure={failure}
      />

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
