/**
 * `/runs/:id` — 検査結果の閲覧画面（決定 1・2・3）。
 *
 * PR11 の `features/run-receipt/run-receipt-page.tsx`（削除済み）が担っていた「検査実行の受付表示」
 * を吸収し、本文と指摘を読む結果画面に置き換える。上部の表示（原稿名・状態・停止理由・停止メッセージ・
 * モデル・時刻・「最新の状態を取得」ボタン）は `run-header.tsx` の 1 か所に閉じ込める。
 *
 * 取得は決定 3 のとおり：`getRun` と `getFindings` を並行に投げ、`getManuscript` は
 * `run.manuscriptVersionId` が要るため `getRun` の後に呼ぶ。3 つがそろうまで本文も右側も描かない
 * （部分描画をしない）。世代番号（`useRef` の連番）で古い応答を捨てる。`id` が変わったときと
 * 「最新の状態を取得」のたびに世代を進める。
 *
 * 本タスクでは指摘の強調をまだ出さない（強調に渡す集合を決めるのは絞り込みを作る Task 6 の責務）。
 * `BodyView` には空の強調で作った段落を渡し、本文が正しく描けるところまでを作る。右側は指摘の件数
 * だけを出す仮表示で、Task 6 が一覧に置き換える。
 *
 * `progress`（PR12b の担当）と `targets`（Task 9 が使う）は本タスクでは読み捨てるだけで描画しない。
 */

import type { FindingDto, ManuscriptVersionDto, RunDto, RunTargetDto } from "@shuten/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useApiClient } from "../../api/context.tsx";
import { ApiRequestError } from "../../api/errors.ts";
import { ROUTES } from "../../app/routes.ts";
import type { Highlight } from "./body-view.ts";
import { buildBodyView } from "./body-view.ts";
import { BodyView } from "./body-view.tsx";
import { RUN_STATUS_LABELS } from "./labels.ts";
import styles from "./results-page.module.css";
import { isSettingsStop, RunHeader } from "./run-header.tsx";

type ResultsState =
  | { kind: "loading" }
  | {
      kind: "loaded";
      run: RunDto;
      targets: readonly RunTargetDto[];
      manuscript: ManuscriptVersionDto;
      findings: readonly FindingDto[];
    }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

function errorMessageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "実行の取得に失敗しました";
}

/** 強調は本タスクでは出さない。空配列は毎回同じ参照にし、`buildBodyView` の呼び出しを安定させる。 */
const NO_HIGHLIGHTS: readonly Highlight[] = [];

export function ResultsPage() {
  const { id } = useParams<{ id: string }>();
  const apiClient = useApiClient();
  // `useParams` の型は `string` を返すと言っているが、実際には `string | undefined` になりうる
  // （ルート定義の書き方次第）。今のルート構成では常に存在するが、無い場合に「読み込み中…」の
  // まま止まらないよう、取得を試みずにエラー表示へ倒す（PR11 の受付表示と同じ作法）。
  const [state, setState] = useState<ResultsState>(() =>
    id === undefined
      ? { kind: "error", message: "実行 ID が指定されていません" }
      : { kind: "loading" },
  );
  // 更新ボタンによる再取得中は、直前の表示内容を残したまま「更新中…」を示す（初回の読み込み中とは
  // 別に持つ。初回は state が "loading" になるのでボタン自体がまだ画面に無い）。
  const [refreshing, setRefreshing] = useState(false);

  // 同一コンポーネントインスタンスのまま id が変わる（別の実行への直リンク遷移）ことがある。
  // 古い要求の応答が後から届いて新しい要求の結果を上書きしないよう、要求ごとに世代を数える。
  const requestGenerationRef = useRef(0);

  const fetchAll = useCallback(
    (mode: "initial" | "refresh") => {
      if (id === undefined) return;
      const generation = ++requestGenerationRef.current;
      if (mode === "initial") {
        setState({ kind: "loading" });
      } else {
        setRefreshing(true);
      }

      // `getRun` と `getFindings` は並行に投げる。`getManuscript` は `run.manuscriptVersionId` が
      // 要るため `getRun` の応答が届いてから呼ぶ（決定 3）。3 つそろうまで setState しない
      // （部分描画をしない）。
      Promise.all([
        apiClient
          .getRun(id)
          .then((detail) =>
            apiClient
              .getManuscript(detail.run.manuscriptVersionId)
              .then((manuscript) => ({ detail, manuscript })),
          ),
        apiClient.getFindings(id),
      ])
        .then(([{ detail, manuscript }, findings]) => {
          if (requestGenerationRef.current !== generation) return; // 古い応答
          setState({
            kind: "loaded",
            run: detail.run,
            targets: detail.targets,
            manuscript,
            findings,
          });
          setRefreshing(false);
        })
        .catch((cause: unknown) => {
          if (requestGenerationRef.current !== generation) return;
          setRefreshing(false);
          if (cause instanceof ApiRequestError && cause.status === 404) {
            setState({ kind: "not-found" });
            return;
          }
          // 取得の失敗はエラーとして見せる（空として見せない）。本文だけ描いて黙らない。
          setState({ kind: "error", message: errorMessageFrom(cause) });
        });
    },
    [apiClient, id],
  );

  // 初回・再読み込み・直リンクのいずれでも、表示時に 1 回だけ取得する。id が変わったときも
  // （`fetchAll` の参照が変わるので）ここが再実行される。
  useEffect(() => {
    fetchAll("initial");
  }, [fetchAll]);

  const handleRefresh = useCallback(() => {
    fetchAll("refresh");
  }, [fetchAll]);

  // Task 6（絞り込みと選択）が来るまでの仮の実装：強調も選択も無い。`onSelectFinding` は
  // 参照を安定させ、`React.memo`（`paragraphPropsEqual`）の抑止が効くようにする。
  const handleSelectFinding = useCallback((_findingId: string) => {
    // 本タスクでは強調を出さないため、この関数が呼ばれることはない。
  }, []);

  const manuscriptBody = state.kind === "loaded" ? state.manuscript.body : null;
  const paragraphs = useMemo(
    () => (manuscriptBody === null ? [] : buildBodyView(manuscriptBody, NO_HIGHLIGHTS)),
    [manuscriptBody],
  );

  return (
    <div className={styles.page}>
      {state.kind === "loading" && <p>読み込み中…</p>}

      {state.kind === "not-found" && (
        <p>
          その実行はありません。<Link to={ROUTES.home}>トップへ戻る</Link>
        </p>
      )}

      {state.kind === "error" && <p className={styles.error}>{state.message}</p>}

      {state.kind === "loaded" && (
        <>
          <RunHeader
            run={state.run}
            manuscriptName={state.manuscript.name}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          />

          {!isSettingsStop(state.run) && (
            <div className={styles.layout}>
              <div className={styles.bodyColumn}>
                <BodyView
                  paragraphs={paragraphs}
                  selectedFindingId={null}
                  onSelectFinding={handleSelectFinding}
                />
              </div>
              <div className={styles.sideColumn}>
                <FindingsSummary run={state.run} findings={state.findings} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 右側の仮表示（Task 6 が指摘一覧に置き換える）。件数だけの事実を出す。
 *
 * `completed` 以外では「指摘はありません」と書かない（決定 2）。未処理の範囲が残っている実行を
 * 「問題なし」と見せないため。0 件のときの文言は決定 2 の表のとおり状態で分ける。
 */
function FindingsSummary(props: {
  readonly run: RunDto;
  readonly findings: readonly FindingDto[];
}) {
  const { run, findings } = props;

  if (findings.length === 0) {
    if (run.status === "completed") {
      return <p>指摘はありません</p>;
    }
    return (
      <p>
        この実行には、まだ指摘がありません（検査は完了していません）。状態:{" "}
        {RUN_STATUS_LABELS[run.status]}
      </p>
    );
  }

  return <p>{findings.length} 件</p>;
}
