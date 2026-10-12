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
 * 行の本体を `<Link>` にすることでキーボードで辿れるようにする（`runPath(id)`。決定 6 と同じ考え方：
 * 一覧の行の本体は単一のタブ止まりにする）。接続先 URL・API キーはここでは扱わない
 * （`RunSummaryDto` に含まれないため描画しようがない）。
 *
 * 各行に「削除」ボタンを置く（仕様 8.3）。ボタンは `<Link>` の中に入れず兄弟に置く（`<a>` の中の
 * `<button>` は HTML として不正で、クリックがリンクの遷移にも伝わる）。タブ順は行ごとに
 * 「リンク → 削除」の 2 止まりになる。削除の前に `window.confirm` で確認を求める。
 * 「実行中」「復旧待ち」の行はボタンを無効にするが、処理中かどうかの正本はサーバーである
 * （停止を要求したが生成の終了を確認できていない実行は一覧上 `running` のまま見えるので、ここで
 * 無効になる。それ以外の食い違いはサーバーの 409 の文言をそのまま見せる）。
 * 成功したら一覧からその行を外す。失敗したら行を残し、その行にエラーを出す。
 */

import type { RunSummaryDto } from "@shuten/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useApiClient } from "../../api/context.tsx";
import { ROUTES, runPath } from "../../app/routes.ts";
import controls from "../../styles/controls.module.css";
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

function deleteErrorMessageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "検査実行の削除に失敗しました";
}

/** 削除できない状態（仕様 8.3「実行中」「復旧待ち」）。サーバー側の判定の一部を写しただけで、正本はサーバー。 */
function isDeletionBlocked(run: RunSummaryDto): boolean {
  return run.status === "running" || run.status === "recovery-waiting";
}

/** 行に出す開始日時。`RunListItem` の表示と確認の文言で同じ値を使う。 */
function formatStartedAt(run: RunSummaryDto): string {
  // 裁定（最終レビュー Important 3）：ローカル時刻で表示する。`run-header.tsx` と同じ
  // 作法で、表示対象の瞬間ごとにオフセットを求める（`format-date-time.ts` 参照）。
  // `startedAt` は null にならないので、`formatDateTime` も null を返さない（型を合わせるための既定値）。
  return (
    formatDateTime(run.startedAt, -new Date(run.startedAt).getTimezoneOffset()) ?? run.startedAt
  );
}

/** 削除の確認文（仕様 8.3）。消えるもの・元に戻せないこと・原稿の本文の扱いを示す。 */
function deleteConfirmMessage(run: RunSummaryDto): string {
  return [
    `「${run.manuscriptName}」（開始: ${formatStartedAt(run)}）の検査結果を削除します。`,
    "指摘と採否・判断メモもすべて削除され、元に戻せません。",
    "この原稿を使う検査結果がほかになければ、原稿の本文も削除されます。",
    "削除してよろしいですか？",
  ].join("\n");
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

  /** 削除に成功した行を一覧から外す。 */
  const handleDeleted = useCallback((runId: string) => {
    setState((current) =>
      current.kind === "loaded"
        ? { kind: "loaded", runs: current.runs.filter((run) => run.id !== runId) }
        : current,
    );
  }, []);

  return (
    <div className={styles.page}>
      <h1>検査結果</h1>

      {state.kind === "loading" && <p>読み込み中…</p>}

      {state.kind === "error" && <p className={controls.errorBox}>{state.message}</p>}

      {state.kind === "loaded" &&
        (state.runs.length === 0 ? (
          <p>
            保存された検査実行はありません。<Link to={ROUTES.home}>トップへ戻る</Link>
          </p>
        ) : (
          <ul className={styles.runList}>
            {state.runs.map((run) => (
              <RunListItem key={run.id} run={run} onDeleted={handleDeleted} />
            ))}
          </ul>
        ))}
    </div>
  );
}

function RunListItem(props: {
  readonly run: RunSummaryDto;
  readonly onDeleted: (runId: string) => void;
}) {
  const { run, onDeleted } = props;
  const apiClient = useApiClient();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const blocked = isDeletionBlocked(run);

  function handleDelete(): void {
    if (!window.confirm(deleteConfirmMessage(run))) return; // 取り消し：何もしない
    setDeleting(true);
    setDeleteError(null);
    apiClient.deleteRun(run.id).then(
      () => {
        // 成功したら行ごと外れる（この部品はアンマウントされる）ので、自分の状態は戻さない。
        onDeleted(run.id);
      },
      (cause: unknown) => {
        // 失敗したら行を残し、理由を出す（409 ならサーバーの文言のまま）。
        setDeleting(false);
        setDeleteError(deleteErrorMessageFrom(cause));
      },
    );
  }

  return (
    <li className={styles.runItem}>
      <Link to={runPath(run.id)} className={styles.runRow}>
        <span className={styles.runManuscriptName}>{run.manuscriptName}</span>
        <span className={styles.runMeta}>
          <span>モデル: {run.modelId}</span>
          <span>{RUN_STATUS_LABELS[run.status]}</span>
          <span>開始: {formatStartedAt(run)}</span>
          {run.finishedAt !== null && (
            <span>
              終了: {formatDateTime(run.finishedAt, -new Date(run.finishedAt).getTimezoneOffset())}
            </span>
          )}
        </span>
      </Link>
      <button
        type="button"
        className={`${controls.secondaryButton} ${styles.deleteButton}`}
        onClick={handleDelete}
        disabled={blocked || deleting}
        aria-label={`「${run.manuscriptName}」（開始: ${formatStartedAt(run)}）の検査結果を削除`}
        title={
          blocked
            ? "処理中の検査は削除できません。停止して処理が終わってから削除してください"
            : undefined
        }
      >
        {deleting ? "削除中…" : "削除"}
      </button>
      {deleteError !== null && (
        <p className={`${controls.errorBox} ${styles.deleteError}`} role="alert">
          {deleteError}
        </p>
      )}
    </li>
  );
}
