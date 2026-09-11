/**
 * 復旧待ち・復旧ブロックの案内（Task 7、決定 7）。
 *
 * `status === "recovery-waiting"`：仕様 8.2 の定型文をそのまま出し、主
 * （「LM Studio 側で生成が止まったことを確認した → 再開する」＝`POST /api/runs/:id/resume`）・副
 * （「確認だけ記録する（この検査は再開しない）」＝`POST /api/recovery/confirm`）の 2 操作と、
 * 「時間経過は終了の証拠にならない」の注記を出す。API 呼び出し自体は `results-page.tsx` の
 * `runControlAction` に集約された `onResume`／`onConfirmRecovery` をそのまま呼ぶだけで、ここでは
 * 直接呼ばない（`run-control.tsx` と同じ流儀）。
 *
 * 副ボタンは `canConfirmRecovery`（`controlAvailability(run, units).canConfirmRecovery`。
 * `recoveryConfirmedAt === null` と同値）が偽になったら隠す（主は残す。決定 7）。押した後は
 * `confirmRecovery` が `status` を変えないため、`recoveryConfirmedAt !== null` のまま
 * `recovery-waiting` に留まり続ける——「復旧の確認を記録済みです。」を出す。
 *
 * `stopReason === "recovery-blocked"`：別の実行の復旧待ちに巻き込まれて停止した旨と、
 * `GET /api/recovery` の `runIds`（表示中の実行を除く）への `runPath` リンクを出す。取得は
 * `RecoveryBlockedNotice`（下）が自分の `useEffect` で `useApiClient()` を呼んで行う（裁定 R4）
 * ——描かれるのは `recovery-blocked` のときだけなので常時の問い合わせにならない。取得に失敗しても
 * 投げず、リンクを出さないだけにする（`/api/recovery` の失敗で結果画面を落とさない）。`runIds` が
 * 空のときも同様。
 *
 * それ以外の状態（`running`・`completed`・`partially-failed`・`recovery-blocked` 以外の `stopped`）
 * では何も描かない（null）。
 */

import type { RunDto } from "@shuten/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useApiClient } from "../../api/context.tsx";
import { runPath } from "../../app/routes.ts";
import styles from "./results-page.module.css";

/** 仕様 8.2 の表示文（決定 7。スペースの有無も含めて一次資料どおり——「Studio側」に空白を入れない）。 */
const RECOVERY_WAITING_NOTICE = "生成の停止を確認できません。LM Studio側を確認して再開してください";

/** 主（決定 7）。押すと `resumeRun` を呼ぶ。`recovery-waiting` の claim に成功したときだけ
 *  復旧ゲートを開けるので、確認と再開が 1 回の操作で済む。 */
const RESUME_LABEL = "LM Studio 側で生成が止まったことを確認した → 再開する";

/** 副（決定 7）。押すと `confirmRecovery` を呼ぶ。この実行を続けずに別の新しい検査を始めたいときの経路。 */
const CONFIRM_ONLY_LABEL = "確認だけ記録する（この検査は再開しない）";

/** 主・副どちらにも添える注記（仕様 8.2「時間経過を終了の証拠とみなさない」）。 */
const TIME_ELAPSED_NOTE =
  "時間が経ったことは終了の証拠になりません。LM Studio側で生成が止まったことを確かめてから押してください。";

/** `confirmRecovery` は `status` を変えないため、副を押した後も `recovery-waiting` のまま
 *  `recoveryConfirmedAt !== null`（＝ `canConfirmRecovery` が偽）になる（決定 7）。 */
const RECOVERY_CONFIRMED_NOTICE = "復旧の確認を記録済みです。";

/** `stopReason === "recovery-blocked"` の案内文。 */
const RECOVERY_BLOCKED_NOTICE =
  "別の検査の復旧待ちのため停止しています。先にそちらを確認してください。";

export interface RecoveryNoticeProps {
  readonly run: RunDto;
  /** `controlAvailability(run, units).canConfirmRecovery` をそのまま渡す（副ボタンを出すか）。 */
  readonly canConfirmRecovery: boolean;
  /** 押されたら親が `POST /api/runs/:id/resume` を呼び、終わったら必ず取り直す（決定 8）。 */
  readonly onResume: () => void;
  /** 押されたら親が `POST /api/recovery/confirm` を呼び、終わったら必ず取り直す（決定 8）。 */
  readonly onConfirmRecovery: () => void;
  /** 送信中はすべて disabled にする（決定 8。`run-control.tsx` の `busy` をそのまま渡す）。 */
  readonly disabled: boolean;
}

export function RecoveryNotice(props: RecoveryNoticeProps) {
  const { run, canConfirmRecovery, onResume, onConfirmRecovery, disabled } = props;

  if (run.status === "recovery-waiting") {
    return (
      <div className={styles.recoveryNotice}>
        <p className={styles.statusNotice}>{RECOVERY_WAITING_NOTICE}</p>
        <div className={styles.controlButtons}>
          <button
            type="button"
            className={styles.controlButton}
            onClick={onResume}
            disabled={disabled}
          >
            {RESUME_LABEL}
          </button>
          {canConfirmRecovery && (
            <button
              type="button"
              className={styles.controlButton}
              onClick={onConfirmRecovery}
              disabled={disabled}
            >
              {CONFIRM_ONLY_LABEL}
            </button>
          )}
        </div>
        <p className={styles.controlNote}>{TIME_ELAPSED_NOTE}</p>
        {!canConfirmRecovery && <p className={styles.controlNote}>{RECOVERY_CONFIRMED_NOTICE}</p>}
      </div>
    );
  }

  if (run.stopReason === "recovery-blocked") {
    return <RecoveryBlockedNotice runId={run.id} />;
  }

  return null;
}

/**
 * `stopReason === "recovery-blocked"` のときだけ `RecoveryNotice` からマウントされる下位
 * コンポーネント（裁定 R4）。`useApiClient` の呼び出しをここに閉じることで、`recovery-waiting`
 * など他の状態の描画・検査で `ApiClientProvider` が無くても落ちないようにする。
 */
function RecoveryBlockedNotice(props: { readonly runId: string }) {
  const { runId } = props;
  const apiClient = useApiClient();
  const [otherRunIds, setOtherRunIds] = useState<readonly string[]>([]);

  useEffect(() => {
    // アンマウント後に setState しない（`runId` が変わって再マウントされた場合を含む）。
    let active = true;
    apiClient.getRecovery().then(
      (recovery) => {
        if (!active) return;
        // 表示中の実行以外へのリンクだけを出す。
        setOtherRunIds(recovery.runIds.filter((id) => id !== runId));
      },
      () => {
        // 取得に失敗してもリンクを出さないだけにする（結果画面を落とさない。裁定 R4）。
        if (!active) return;
        setOtherRunIds([]);
      },
    );
    return () => {
      active = false;
    };
  }, [apiClient, runId]);

  return (
    <div className={styles.recoveryNotice}>
      <p className={styles.statusNotice}>{RECOVERY_BLOCKED_NOTICE}</p>
      {otherRunIds.length > 0 && (
        <ul className={styles.recoveryBlockedLinks}>
          {otherRunIds.map((id) => (
            <li key={id}>
              {/* 申し送り（Task 7 のブリーフより）：ここは同じコンポーネント（`ResultsPage`）の
                  まま実行 ID が変わる初めての経路になる。取り直し・`pending` の送信チェーンが
                  実行 ID や世代番号に紐づいていないため、送信中にこのリンクを踏むと旧実行の
                  取り直しが新実行の画面を上書きしうる（構造的な弱点。手当ては SSE と取り直しを
                  書き直す後続 Task が行う）。 */}
              <Link to={runPath(id)}>この検査を確認する（{id}）</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
