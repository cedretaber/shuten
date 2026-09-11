/**
 * `/runs` — 保存された検査実行の一覧（Task 10、仕様 4 の手順 7「アプリを再度開いたときに
 * 保存された結果と採否を読み込める」）。
 *
 * `GET /api/runs`（`getRuns`）の結果をクライアント側で `startedAt` 降順（新しい順）に並べ替える。
 * `finding-list.tsx` は「サーバーの順（＝本文位置）のまま描く」方針だが、`RunSummaryDto` の一覧には
 * そのような意味のある順序がサーバー側に無いため、ここでは逆にサーバーの順へ依存せず自前で並べる。
 *
 * 取得・状態の作法は `results-page.tsx`（Task 5）に揃える：世代番号（`useRef` の連番）で古い応答を
 * 捨て、取得に失敗したら空の一覧として見せずエラーを出す。`GET /api/runs` は単一の実行を指す ID を
 * 持たないため、`results-page.tsx` の「404 だけを別扱いにする」分岐はここには無い（一覧の取得は
 * 404 になり得ない）。
 *
 * 行全体を `<Link>` にすることでキーボードで辿れるようにする（`runPath(id)`。決定 6 と同じ考え方：
 * 一覧の行は単一のタブ止まりにする）。接続先 URL・API キーはここでは扱わない（`RunSummaryDto` に
 * 含まれないため描画しようがない）。
 */

import type { RunSummaryDto } from "@shuten/shared";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useApiClient } from "../../api/context.tsx";
import { ROUTES, runPath } from "../../app/routes.ts";
import { formatDateTime } from "../results/format-date-time.ts";
import { RUN_STATUS_LABELS } from "../results/labels.ts";
import styles from "./run-list.module.css";

type RunListState =
  | { kind: "loading" }
  | { kind: "loaded"; runs: readonly RunSummaryDto[] }
  | { kind: "error"; message: string };

function errorMessageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "検査実行の取得に失敗しました";
}

/**
 * `startedAt` 降順（新しい順）に並べ替える。サーバーの順に依存しない（ブリーフの指示）。
 * 既存の配列は書き換えず新しい配列を返す（`finding-detail.tsx` の `sortedReasons` と同じ流儀）。
 */
function sortByStartedAtDesc(runs: readonly RunSummaryDto[]): RunSummaryDto[] {
  return [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}

export function RunListPage() {
  const apiClient = useApiClient();
  const [state, setState] = useState<RunListState>({ kind: "loading" });

  // マウント中に古い応答が新しい応答を上書きしないための世代番号（`results-page.tsx` と同じ作法）。
  // このページでは要求は 1 回きりだが、React の StrictMode（`main.tsx`）は開発時に effect を
  // 2 回実行するため、先に始まった要求の応答であとから始まった要求の状態を上書きしないよう備える。
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    setState({ kind: "loading" });
    apiClient.getRuns().then(
      (runs) => {
        if (requestGenerationRef.current !== generation) return; // 古い応答
        setState({ kind: "loaded", runs: sortByStartedAtDesc(runs) });
      },
      (cause: unknown) => {
        if (requestGenerationRef.current !== generation) return;
        // 取得の失敗は空の一覧として見せず、エラーとして見せる（不変条件：失敗を正常な値や
        // 別の意味の状態にすり替えない）。
        setState({ kind: "error", message: errorMessageFrom(cause) });
      },
    );
  }, [apiClient]);

  return (
    <div className={styles.page}>
      <h1>検査結果</h1>

      {state.kind === "loading" && <p>読み込み中…</p>}

      {state.kind === "error" && <p className={styles.error}>{state.message}</p>}

      {state.kind === "loaded" &&
        (state.runs.length === 0 ? (
          <p>
            保存された検査実行はありません。<Link to={ROUTES.home}>トップへ戻る</Link>
          </p>
        ) : (
          <ul className={styles.runList}>
            {state.runs.map((run) => (
              <RunListItem key={run.id} run={run} />
            ))}
          </ul>
        ))}
    </div>
  );
}

function RunListItem(props: { readonly run: RunSummaryDto }) {
  const { run } = props;

  return (
    <li>
      <Link to={runPath(run.id)} className={styles.runRow}>
        <span className={styles.runManuscriptName}>{run.manuscriptName}</span>
        <span className={styles.runMeta}>
          <span>モデル: {run.modelId}</span>
          <span>{RUN_STATUS_LABELS[run.status]}</span>
          {/* 裁定（最終レビュー Important 3）：ローカル時刻で表示する。`run-header.tsx` と同じ
              作法で、表示対象の瞬間ごとにオフセットを求める（`format-date-time.ts` 参照）。 */}
          <span>
            開始: {formatDateTime(run.startedAt, -new Date(run.startedAt).getTimezoneOffset())}
          </span>
          {run.finishedAt !== null && (
            <span>
              終了: {formatDateTime(run.finishedAt, -new Date(run.finishedAt).getTimezoneOffset())}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}
