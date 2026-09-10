/**
 * `/runs/:id` — 検査実行の受付表示画面（決定 1・16）。
 *
 * 初回・再読み込み・直リンクのすべてで `GET /api/runs/:id` を 1 回だけ呼ぶ。
 * `POST /api/runs` の応答（`location.state` に載っているかもしれない値）は読まない：
 * 履歴の扱いによっては再読み込み後も残りうるので、「開始直後だけ」の判定に使えない。
 * ポーリングも SSE もしない。更新は「最新の状態を取得」ボタンによる手動操作だけ。
 *
 * 画面が読むのは `RunDetailDto` のうち `run`（`RunDto`）だけ。`progress` と `targets` は
 * 使わない（進捗の表示は別 PR）。
 */

import type { RunDto } from "@shuten/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useApiClient } from "../../api/context.tsx";
import { ApiRequestError } from "../../api/errors.ts";
import { ROUTES } from "../../app/routes.ts";
import { RUN_STATUS_LABELS, RUN_STOP_REASON_LABELS } from "./labels.ts";
import styles from "./run-receipt.module.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; run: RunDto }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

function errorMessageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "実行の取得に失敗しました";
}

/** `stopped` かつ `stopReason === "settings"` は受付成功として見せない（決定 16）。 */
function isSettingsStop(run: RunDto): boolean {
  return run.status === "stopped" && run.stopReason === "settings";
}

export function RunReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const apiClient = useApiClient();
  // `useParams` の型は `string` を返すと言っているが、実際には `string | undefined` になりうる
  // （ルート定義の書き方次第）。今のルート構成では常に存在するが、無い場合に「読み込み中…」の
  // まま止まらないよう、取得を試みずにエラー表示へ倒す。
  const [state, setState] = useState<LoadState>(() =>
    id === undefined
      ? { kind: "error", message: "実行 ID が指定されていません" }
      : { kind: "loading" },
  );

  // 同一コンポーネントインスタンスのまま id が変わる（別の実行への直リンク遷移）ことがある。
  // 古い要求の応答が後から届いて新しい要求の結果を上書きしないよう、要求ごとに世代を数える。
  const requestGenerationRef = useRef(0);

  const fetchRun = useCallback(() => {
    if (id === undefined) return;
    const generation = ++requestGenerationRef.current;
    setState({ kind: "loading" });
    apiClient
      .getRun(id)
      .then((detail) => {
        if (requestGenerationRef.current !== generation) return; // 古い応答
        setState({ kind: "loaded", run: detail.run });
      })
      .catch((cause: unknown) => {
        if (requestGenerationRef.current !== generation) return;
        if (cause instanceof ApiRequestError && cause.status === 404) {
          setState({ kind: "not-found" });
          return;
        }
        setState({ kind: "error", message: errorMessageFrom(cause) });
      });
  }, [apiClient, id]);

  // 初回・再読み込み・直リンクのいずれでも、表示時に 1 回だけ取得する。
  useEffect(() => {
    fetchRun();
  }, [fetchRun]);

  return (
    <div className={styles.page}>
      <h1>検査実行</h1>
      {id !== undefined && <p className={styles.runId}>実行 ID: {id}</p>}

      {state.kind === "loading" && <p>読み込み中…</p>}

      {state.kind === "not-found" && (
        <p>
          その実行はありません。<Link to={ROUTES.home}>トップへ戻る</Link>
        </p>
      )}

      {state.kind === "error" && <p className={styles.error}>{state.message}</p>}

      {state.kind === "loaded" && <RunStatusView run={state.run} />}

      <button
        type="button"
        className={styles.refreshButton}
        onClick={fetchRun}
        disabled={state.kind === "loading" || id === undefined}
      >
        最新の状態を取得
      </button>
    </div>
  );
}

function RunStatusView({ run }: { run: RunDto }) {
  if (isSettingsStop(run)) {
    return (
      <div className={styles.status}>
        <p className={styles.statusLine}>検査は開始できませんでした</p>
        {run.stopMessage !== null && <p className={styles.stopMessage}>{run.stopMessage}</p>}
        <p>
          <Link to={ROUTES.home}>検査設定に戻る</Link>
        </p>
      </div>
    );
  }

  return (
    <div className={styles.status}>
      <p className={styles.statusLine}>状態: {RUN_STATUS_LABELS[run.status]}</p>
      {run.stopReason !== null && (
        <p className={styles.statusLine}>停止理由: {RUN_STOP_REASON_LABELS[run.stopReason]}</p>
      )}
      {run.stopMessage !== null && <p className={styles.stopMessage}>{run.stopMessage}</p>}
    </div>
  );
}
