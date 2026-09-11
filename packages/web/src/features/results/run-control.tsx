/**
 * 実行制御の操作（停止・再開・失敗単位の再試行・復旧確認）と操作結果の案内
 * （Task 5、決定 6・7・8。Task 7 で復旧待ち・復旧ブロックの案内を `recovery-notice.tsx` へ分離）。
 *
 * ボタンの出し分けは `controlAvailability`（`run-control.ts`）にそのまま従う——条件をここで
 * 書き写さない。停止ボタンだけは表示条件を別にする：`showStopButton`（`run-control.ts`。
 * レビュー指摘 M-1 で純関数に移した）は「停止要求が済んだあと」も true のままで、ボタン自体は
 * 消さず `disabled` にして `run.stopRequestedAt !== null` の間ずっと出し続ける（決定 9 の案内文は
 * `RunHeader` が `statusNotice` で表示する）。`canStop`（押せるかの判断）をそのまま表示条件に
 * すると、停止要求後にボタンが消えてしまい「押せなくなった理由」が伝わらない。
 *
 * `status === "recovery-waiting"` の「再開」「復旧を確認」は `RecoveryNotice` に委譲する
 * （仕様 8.2 の定型文・2 操作・「時間経過は証拠にならない」の注記を 1 か所にまとめるため。決定 7）。
 * ここでの汎用の「再開」ボタン（`showGenericResume`）は `recovery-waiting` 以外
 * （`stopped` かつ `stopReason !== "settings"`）のときだけ出す。
 *
 * `pending !== null`（送信中の操作がある）の間はすべてのボタンを `disabled` にする（決定 8）。
 * `recovery-waiting` では `RecoveryNotice` の 2 つのボタンが同時に出るため、当該ボタンだけの
 * 制御では足りない（一方を送信中でももう一方が押せてしまう）。
 */

import type { RunDto, RunUnitsDto } from "@shuten/shared";
import { Link } from "react-router";
import { ROUTES } from "../../app/routes.ts";
import { RecoveryNotice } from "./recovery-notice.tsx";
import styles from "./results-page.module.css";
import {
  type ControlFailure,
  controlAvailability,
  type PendingControlAction,
  RESUME_SCOPE_NOTE,
  showStopButton,
} from "./run-control.ts";

export interface RunControlProps {
  readonly run: RunDto;
  /** `GET /api/runs/:id/units` の応答（決定 5）。未取得・失敗なら null。 */
  readonly units: RunUnitsDto | null;
  /** 押されたら親が API を呼び、終わったら必ず取り直す（決定 8）。 */
  readonly onStop: () => void;
  readonly onResume: () => void;
  readonly onRetryFailed: () => void;
  readonly onConfirmRecovery: () => void;
  /** 送信中の操作（重複送信を防ぐ。null なら送信していない）。 */
  readonly pending: PendingControlAction;
  readonly failure: ControlFailure | null;
}

export function RunControl(props: RunControlProps) {
  const { run, units, onStop, onResume, onRetryFailed, onConfirmRecovery, pending, failure } =
    props;
  const availability = controlAvailability(run, units);
  const busy = pending !== null;

  // 停止ボタンは `running` の間ずっと表示する（上記コメントのとおり `canStop` は表示条件にしない。
  // レビュー指摘 M-1：表示条件そのものは `run-control.ts` の `showStopButton` に揃える）。
  const showStop = showStopButton(run);
  // `recovery-waiting` の「再開」は `RecoveryNotice` が専用の文言（主ボタン）で出すため、汎用の
  // 「再開」ボタンは `recovery-waiting` のときだけ抑止する（`stopped` の通常再開はそのまま）。
  const showGenericResume = availability.canResume && run.status !== "recovery-waiting";
  const showRecoveryNotice =
    run.status === "recovery-waiting" || run.stopReason === "recovery-blocked";
  const showButtonsRow = showStop || showGenericResume || availability.canRetryFailed;
  const hasAnyControl = showButtonsRow || showRecoveryNotice;

  if (!hasAnyControl && failure === null) {
    return null;
  }

  return (
    <div className={styles.controlPanel}>
      {showButtonsRow && (
        <div className={styles.controlButtons}>
          {showStop && (
            <button
              type="button"
              className={styles.controlButton}
              onClick={onStop}
              disabled={busy || !availability.canStop}
            >
              停止
            </button>
          )}

          {showGenericResume && (
            <div className={styles.controlAction}>
              <button
                type="button"
                className={styles.controlButton}
                onClick={onResume}
                disabled={busy}
              >
                再開
              </button>
              {/* 仕様 8.2「『再開』と『新規検査の開始』を区別する」。文言は `RecoveryNotice` の
                  主ボタンと共有する（`run-control.ts` の `RESUME_SCOPE_NOTE`。最終レビュー Minor 5）。 */}
              <p className={styles.controlNote}>{RESUME_SCOPE_NOTE}</p>
            </div>
          )}

          {availability.canRetryFailed && (
            <button
              type="button"
              className={styles.controlButton}
              onClick={onRetryFailed}
              disabled={busy}
            >
              失敗単位を再試行
            </button>
          )}
        </div>
      )}

      {showRecoveryNotice && (
        <RecoveryNotice
          run={run}
          canConfirmRecovery={availability.canConfirmRecovery}
          onResume={onResume}
          onConfirmRecovery={onConfirmRecovery}
          disabled={busy}
        />
      )}

      {failure !== null && (
        <div className={styles.controlFailure}>
          {/* `failure.message` は `controlFailureOf` の定型文だけ（サーバーの `error.message` は
              画面に出さない。決定 8）。 */}
          <p className={styles.controlFailureMessage}>{failure.message}</p>
          {failure.links.length > 0 && (
            <p className={styles.controlFailureLinks}>
              {failure.links.includes("settings") && (
                <Link to={ROUTES.settings}>接続設定を確認する</Link>
              )}
              {failure.links.includes("home") && <Link to={ROUTES.home}>新しい検査を開始する</Link>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
