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
 * 404 の写し方は発生源で分ける（レビュー対応）：**`getRun` の 404 だけ**が「その実行はありません」
 * （`not-found`）になる。`getManuscript`・`getFindings` の失敗は 404 を含めて常にエラー表示にする
 * （実行自体は存在するので「その実行はありません」と書かない。失敗を正常な値や別の意味の状態に
 * すり替えない、という不変条件のとおり）。
 *
 * 指摘一覧・絞り込み・選択（Task 6、決定 7・8・10）：選択状態（`selectedFindingId`）はこの
 * コンポーネントが持ち、`BodyView`（本文の強調のクリック）と `FindingList`（一覧の行のクリック）
 * の両方に同じ状態・同じハンドラーを渡す。強調に渡す集合は「絞り込み後に一覧へ出ている、位置が
 * 確定した指摘」だけ（`visibleFindings` → `toHighlights`）——隠れている指摘を強調しない。
 * `paragraphs` は `body` と `highlights`（＝絞り込み結果由来）の両方に依存する `useMemo` で作り、
 * `BodyView` 側の `React.memo`（`paragraphPropsEqual`）の抑止が効くようにする。
 *
 * 絞り込みの状態（`filter`）はこのコンポーネントのローカル状態で、URL にも `localStorage` にも
 * 保存しない。選択中の指摘が可視集合（`visible` = 絞り込み後に一覧へ出ている指摘）から消えたら
 * 選択を `null` に戻す——絞り込みの変更・採否の保存・データの再取得（更新ボタン）のどの経路でも
 * 起こりうるため、個別の経路ごとに解除処理を持たず `[visible, selectedFindingId]` を見る 1 つの
 * `useEffect` に一本化する（最終レビュー Important 2）。
 *
 * 更新（再取得）の失敗（最終レビュー Important 1）：`fetchAll("refresh")` が失敗しても、
 * 表示中の `loaded` の内容（本文・一覧・詳細・選択）はそのまま残し、`refreshError` にエラーを
 * 入れて添えて見せる（`state` を `"error"` に倒さない）。`state` が `"error"` に倒れるのは
 * 初回取得（`fetchAll("initial")`）の失敗のときだけで、その場合は再試行の操作子
 * （「最新の状態を取得」ボタン）を出す。
 *
 * `progress`（PR12b の担当）と `targets`（Task 9 が使う）は本タスクでも読み捨てるだけで描画しない。
 *
 * 指摘詳細（Task 7、決定 3・9・12）：選択中の指摘 ID が変わるたびに `getFinding` を 1 回呼ぶ
 * （キャッシュしない。持ち越し「詳細をキャッシュしない」のとおり）。専用の世代番号
 * （`detailGenerationRef`）で古い応答を捨てる——`requestGenerationRef`（3 つの取得）とは別の
 * カウンタにする。選択を解除しても・別の指摘を選び直しても本編の再取得は要らないため。
 * 取得中・取得失敗の間も、`finding`（一覧が持つ情報）から分かる範囲（引用・理由・判定など）は
 * 描き続け、元候補・位置診断の欄だけを「読み込み中」またはエラーにする（`FindingDetail` の責務）。
 * 本文への移動（Task 9、決定 9、仕様 4 の手順 5・5.3）：本文の容器（`.bodyColumn`）に
 * `bodyContainerRef` を持たせ、`navigationTargetOf`（`navigate.ts`）で移動先を決めて
 * `findTargetElement` で要素を探し、`scrollIntoViewIfPossible` で移動する。移動するのは
 * 「一覧の行をクリックしたとき」（`handleSelectFindingFromList`）と「詳細の『本文の該当箇所へ
 * 移動』を押したとき」（`FindingDetail` の `onNavigate`）の 2 経路だけ。本文の強調をクリックして
 * 選んだとき（`handleSelectFinding`、`BodyView` に渡す方）と、詳細内の「関連する他の指摘」の
 * リンクをクリックしたとき（`FindingDetail` の `onSelectFinding`）は移動しない
 * （前者はすでに見えている場所なので画面を跳ねさせる必要が無いため。後者は仕様が求める 2 経路に
 * 含まれないため、範囲を広げない）。該当する検査対象が `targets` に無い（`navigationTargetOf` が
 * `null` を返す）ときは `FindingDetail` に `onNavigate` を渡さず、移動の操作子そのものを出さない。
 *
 * 採否と判断メモ（Task 8、決定 13）：`putJudgment` の呼び出しはこのコンポーネント（`handleSaveJudgment`）
 * に閉じる（状態の持ち主を 1 か所にするため。操作子そのものは `judgment-control.tsx`）。
 * メモが空欄（`note === null`）のときはリクエスト本文から `note` キー自体を省く
 * （`PutJudgmentRequest` は `note` 省略＝サーバー側で null、`exactOptionalPropertyTypes` の下では
 * `{ status }` と `{ status, note }` を分けて組み立てる必要がある）。成功したら応答の
 * `JudgmentDto` で該当指摘の `judgment` だけを差し替える（一覧を取り直さない）。失敗は
 * そのまま呼び出し元（`JudgmentControl`）へ伝播させ、その場でのエラー表示・入力の巻き戻しを
 * 任せる（ここで catch して握りつぶさない）。
 */

import type {
  FindingDetailDto,
  FindingDto,
  JudgmentStatus,
  ManuscriptVersionDto,
  PutJudgmentRequest,
  RunDto,
  RunTargetDto,
} from "@shuten/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useApiClient } from "../../api/context.tsx";
import { ApiRequestError } from "../../api/errors.ts";
import { ROUTES } from "../../app/routes.ts";
import { buildBodyView } from "./body-view.ts";
import { BodyView } from "./body-view.tsx";
import { relatedFindings } from "./finding-detail.ts";
import { FindingDetail } from "./finding-detail.tsx";
import type { FindingFilter } from "./finding-filter.ts";
import { DEFAULT_FINDING_FILTER, toHighlights, visibleFindings } from "./finding-filter.ts";
import { FindingFilterControls } from "./finding-filter.tsx";
import { FindingList } from "./finding-list.tsx";
import { RUN_STATUS_LABELS } from "./labels.ts";
import type { NavigationTarget } from "./navigate.ts";
import { findTargetElement, navigationTargetOf, scrollIntoViewIfPossible } from "./navigate.ts";
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

/** `state.kind !== "loaded"` の間、`findings` の代わりに使う空配列。毎回同じ参照にする。 */
const EMPTY_FINDINGS: readonly FindingDto[] = [];

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
  // 更新（再取得）の失敗メッセージ。`state` はいじらず、これだけを立てて `loaded` の内容を
  // 残したまま添えて見せる（最終レビュー Important 1）。次の更新を試みたとき、または初回取得
  // （id 変更を含む）をやり直したときにクリアする。
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // 絞り込みと選択（Task 6、決定 7・8・10）。どちらもこの画面のセッションだけのローカル状態
  // （URL にも localStorage にも保存しない）。id が変わったら（別の実行への直リンク遷移）
  // 両方とも既定に戻す（`fetchAll` の "initial" 分岐でリセットする。理由は下記）。
  const [filter, setFilter] = useState<FindingFilter>(DEFAULT_FINDING_FILTER);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);

  // 同一コンポーネントインスタンスのまま id が変わる（別の実行への直リンク遷移）ことがある。
  // 古い要求の応答が後から届いて新しい要求の結果を上書きしないよう、要求ごとに世代を数える。
  const requestGenerationRef = useRef(0);

  const fetchAll = useCallback(
    (mode: "initial" | "refresh") => {
      if (id === undefined) return;
      const generation = ++requestGenerationRef.current;
      if (mode === "initial") {
        setState({ kind: "loading" });
        // 初回・id 変更（別の実行への直リンク遷移）のときだけ絞り込み・選択を既定に戻す。
        // 更新ボタン（"refresh"）では戻さない——絞り込みは操作中の状態として保つ。
        setFilter(DEFAULT_FINDING_FILTER);
        setSelectedFindingId(null);
        setRefreshError(null);
      } else {
        setRefreshing(true);
        // 前回の更新失敗の表示を、新しい試みの結果が出るまで一旦消す。
        setRefreshError(null);
      }

      // `getRun` と `getFindings` は並行に投げる（決定 3）。`findingsPromise` の拒否は
      // 下の then/catch のどちらかで必ず読むが、`getRun` が先に失敗した経路では読まれないまま
      // 終わることがあるため、ここで空の catch を挟んで未処理拒否（unhandled rejection）を防ぐ
      // （実際のエラー処理は下の分岐で行うので、ここでは何もしない）。
      const findingsPromise = apiClient.getFindings(id);
      findingsPromise.catch(() => {});

      apiClient.getRun(id).then(
        (detail) => {
          if (requestGenerationRef.current !== generation) return; // 古い応答

          // `getManuscript` は `run.manuscriptVersionId` が要るため `getRun` の応答が届いてから
          // 呼ぶ（決定 3）。3 つそろうまで setState しない（部分描画をしない）。
          Promise.all([apiClient.getManuscript(detail.run.manuscriptVersionId), findingsPromise])
            .then(([manuscript, findings]) => {
              if (requestGenerationRef.current !== generation) return;
              setState({
                kind: "loaded",
                run: detail.run,
                targets: detail.targets,
                manuscript,
                findings,
              });
              setRefreshing(false);
              // 選択中の指摘が消えたかどうかの判定は、可視集合（`visible`）を監視する
              // `useEffect`（下）に一本化する。ここでは選択を触らない（最終レビュー Important 2。
              // ここで `filter` を見て判定しようとしないこと——`fetchAll` の deps に `filter` が
              // 無く、古い値を読んでしまう）。
            })
            .catch((cause: unknown) => {
              if (requestGenerationRef.current !== generation) return;
              setRefreshing(false);
              if (mode === "refresh") {
                // 再取得の失敗では `loaded` の内容を保ったまま、エラーを添えて見せる
                // （本文・一覧・詳細・選択を消さない。最終レビュー Important 1）。
                setRefreshError(errorMessageFrom(cause));
                return;
              }
              // 初回取得の失敗（`getManuscript`・`getFindings`）は 404 でも「その実行はありません」
              // にしない（実行自体は取得できているため）。取得の失敗はエラーとして見せる
              // （空として見せない。本文だけ描いて黙らない）。
              setState({ kind: "error", message: errorMessageFrom(cause) });
            });
        },
        (cause: unknown) => {
          if (requestGenerationRef.current !== generation) return;
          setRefreshing(false);
          if (mode === "refresh") {
            // 再取得の失敗では `loaded` の内容を保ったまま、エラーを添えて見せる
            // （本文・一覧・詳細・選択を消さない。最終レビュー Important 1）。
            setRefreshError(errorMessageFrom(cause));
            return;
          }
          // `getRun` の 404 だけが「その実行はありません」になる（発生源で写し方を分ける）。
          // これは初回取得（`mode === "initial"`）のときだけの分岐——再取得時に実行が消えている
          // 場合も上の分岐でエラー表示にする（「その実行はありません」に倒すと本文・一覧が消える
          // ため）。
          if (cause instanceof ApiRequestError && cause.status === 404) {
            setState({ kind: "not-found" });
            return;
          }
          setState({ kind: "error", message: errorMessageFrom(cause) });
        },
      );
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

  // 初回取得の失敗（`state.kind === "error"`）からの再試行（最終レビュー Important 1）。
  // "refresh" ではなく "initial" を使う——まだ何も `loaded` になっていないので、絞り込み・選択を
  // 戻す通常の初回取得と同じ扱いでよい（`fetchAll` の "loading" 分岐で state も戻る）。
  const handleRetryInitial = useCallback(() => {
    fetchAll("initial");
  }, [fetchAll]);

  // 本文の強調（クリック）と一覧の行（クリック）の両方から同じ状態を更新する。参照を安定させ、
  // `BodyView` 側の `React.memo`（`paragraphPropsEqual`）の抑止が効くようにする。
  // ここでは選択するだけで本文への移動はしない（本文の強調はすでに見えている場所をクリックした
  // ものなので、画面を跳ねさせる必要が無い。移動する経路は `handleSelectFindingFromList` と
  // `FindingDetail` の `onNavigate` の 2 つだけ。Task 9）。
  const handleSelectFinding = useCallback((findingId: string) => {
    setSelectedFindingId(findingId);
  }, []);

  // 本文の容器（`.bodyColumn`）。移動先の要素をここから探す（Task 9）。
  const bodyContainerRef = useRef<HTMLDivElement | null>(null);

  // 移動先（`NavigationTarget`）が決まったあと、実際に DOM 要素を探してスクロールする共通処理。
  const scrollToTarget = useCallback((target: NavigationTarget) => {
    const container = bodyContainerRef.current;
    if (container === null) return;
    const element = findTargetElement(container, target);
    if (element === null) return;
    scrollIntoViewIfPossible(element);
  }, []);

  // 一覧の行をクリックしたとき（Task 9）：選択に加えて本文へ移動する。`state` が "loaded" でない、
  // 選んだ指摘が見つからない、移動先が無い（`targets` に対応する検査対象が無い）のいずれかなら
  // 選択だけ行い、移動はしない。
  const handleSelectFindingFromList = useCallback(
    (findingId: string) => {
      setSelectedFindingId(findingId);
      if (state.kind !== "loaded") return;
      const finding = state.findings.find((f) => f.id === findingId);
      if (finding === undefined) return;
      const target = navigationTargetOf(finding, state.targets, state.manuscript.body);
      if (target === null) return;
      scrollToTarget(target);
    },
    [state, scrollToTarget],
  );

  // 絞り込みの変更を反映するだけ。選択中の指摘が新しい絞り込みで可視集合から消えたときの解除は
  // `[visible, selectedFindingId]` を見る `useEffect`（下）が一本化して受け持つ（最終レビュー
  // Important 2。以前はここで個別に解除していたが、絞り込み以外の経路（採否の保存・再取得）では
  // 選択が残ってしまう抜け穴があったため、経路を 1 つに集約した）。
  const handleFilterChange = useCallback((next: FindingFilter) => {
    setFilter(next);
  }, []);

  // 指摘詳細（Task 7、決定 3・9・12）。選択中の指摘 ID が変わるたびに 1 回だけ `getFinding` を
  // 呼ぶ（キャッシュしない。持ち越し「詳細をキャッシュしない」のとおり）。`requestGenerationRef`
  // （本編の取得）とは別の世代カウンタで、選び直すたびに世代を進めて古い応答を捨てる。
  const [findingDetail, setFindingDetail] = useState<FindingDetailDto | null>(null);
  const [findingDetailError, setFindingDetailError] = useState<string | null>(null);
  const detailGenerationRef = useRef(0);

  useEffect(() => {
    if (selectedFindingId === null) {
      setFindingDetail(null);
      setFindingDetailError(null);
      return;
    }
    const generation = ++detailGenerationRef.current;
    // 選び直した直後は前の詳細を出さない（取得中は「一覧が持つ情報だけで描く」状態にする。
    // `FindingDetail` 側が `detail === null` を「読み込み中」として扱う）。
    setFindingDetail(null);
    setFindingDetailError(null);
    apiClient.getFinding(selectedFindingId).then(
      (detail) => {
        if (detailGenerationRef.current !== generation) return; // 古い応答（選び直した後）
        setFindingDetail(detail);
      },
      (cause: unknown) => {
        if (detailGenerationRef.current !== generation) return;
        // 詳細の取得失敗は詳細パネルの当該欄にだけエラーを出す（詳細全体を消さない）。
        setFindingDetailError(errorMessageFrom(cause));
      },
    );
  }, [apiClient, selectedFindingId]);

  // 採否と判断メモ（Task 8、決定 13）。`putJudgment` の呼び出しはここに閉じる（状態の持ち主を
  // 1 か所にする。`JudgmentControl` は onSave を呼ぶだけで API を直接呼ばない）。
  const handleSaveJudgment = useCallback(
    (findingId: string, status: JudgmentStatus, note: string | null): Promise<void> => {
      const body: PutJudgmentRequest = note === null ? { status } : { status, note };
      return apiClient.putJudgment(findingId, body).then((judgment) => {
        // 成功したら応答の JudgmentDto で該当指摘の judgment だけを差し替える
        // （一覧を取り直さない。一覧の行の採否表示もこの差し替えで更新される）。
        setState((current) => {
          if (current.kind !== "loaded") return current;
          return {
            ...current,
            findings: current.findings.map((f) => (f.id === findingId ? { ...f, judgment } : f)),
          };
        });
      });
      // 失敗時はここで catch しない。呼び出し元（JudgmentControl）に reject を伝え、
      // その場でのエラー表示・入力の巻き戻しを行わせる。
    },
    [apiClient],
  );

  const findings = state.kind === "loaded" ? state.findings : EMPTY_FINDINGS;
  // 決定 7：強調に渡すのは「絞り込み後に一覧へ出ている、位置が確定した指摘」だけ。隠れている
  // 指摘は強調しない（強調を押しても一覧に行が無い、という状態を作らないため）。
  const visible = useMemo(() => visibleFindings(findings, filter), [findings, filter]);
  const highlights = useMemo(() => toHighlights(visible), [visible]);

  // 選択中の指摘が可視集合（`visible`）に無ければ選択を外す（最終レビュー Important 2）。
  // 絞り込みの変更・採否の保存で条件から外れる・再取得で再確認が確定し既定の絞り込みから
  // 外れる、の 3 経路すべてがここを通る唯一の解除処理（経路ごとに個別の解除処理を持たない）。
  // `fetchAll` の成功時にここで潰そうとしないこと——`fetchAll` の deps に `filter` が無く、
  // 古い値を読んでしまう。この `useEffect` はレンダー後の `visible`（常に最新の `filter` で
  // 計算済み）を見るので、その問題が起きない。
  useEffect(() => {
    if (selectedFindingId === null) return;
    const stillVisible = visible.some((f) => f.id === selectedFindingId);
    if (!stillVisible) {
      setSelectedFindingId(null);
    }
  }, [visible, selectedFindingId]);

  // 選択中の指摘そのもの（一覧から探す。可視集合から消えていても選択は一瞬残りうるが、上の
  // `useEffect` が次のレンダーで null に戻す）。
  const selectedFinding = useMemo(
    () =>
      selectedFindingId === null
        ? null
        : (findings.find((f) => f.id === selectedFindingId) ?? null),
    [findings, selectedFindingId],
  );
  // 決定 8 の 2 群。「可視の指摘」（絞り込み後に一覧へ出ているもの）から作り、自分自身を除く。
  const related = useMemo(
    () => (selectedFinding === null ? null : relatedFindings(selectedFinding, visible)),
    [selectedFinding, visible],
  );

  // 選択中の指摘の移動先（Task 9）。`null` なら `FindingDetail` に `onNavigate` を渡さず、
  // 移動の操作子そのものを出さない（該当する検査対象が `targets` に無い場合など）。
  const selectedNavigationTarget = useMemo(
    () =>
      selectedFinding === null || state.kind !== "loaded"
        ? null
        : navigationTargetOf(selectedFinding, state.targets, state.manuscript.body),
    [selectedFinding, state],
  );
  const handleNavigate = useCallback(() => {
    if (selectedNavigationTarget === null) return;
    scrollToTarget(selectedNavigationTarget);
  }, [selectedNavigationTarget, scrollToTarget]);

  const manuscriptBody = state.kind === "loaded" ? state.manuscript.body : null;
  // `body` と `highlights`（＝絞り込み結果由来）の両方に依存させる。`BodyView` 側の
  // `React.memo` は参照比較なので、依存が揃っていないと不要な再描画抑止に失敗する。
  const paragraphs = useMemo(
    () => (manuscriptBody === null ? [] : buildBodyView(manuscriptBody, highlights)),
    [manuscriptBody, highlights],
  );

  return (
    <div className={styles.page}>
      {state.kind === "loading" && <p>読み込み中…</p>}

      {state.kind === "not-found" && (
        <p>
          その実行はありません。<Link to={ROUTES.home}>トップへ戻る</Link>
        </p>
      )}

      {state.kind === "error" && (
        <div>
          <p className={styles.error}>{state.message}</p>
          {/* 初回取得の失敗には再試行の導線を置く（最終レビュー Important 1）。"最新の状態を
              取得" と同じラベルにして、更新ボタンと同じ操作だと分かるようにする。 */}
          <button type="button" className={styles.refreshButton} onClick={handleRetryInitial}>
            最新の状態を取得
          </button>
          <p>
            <Link to={ROUTES.home}>トップへ戻る</Link>
          </p>
        </div>
      )}

      {state.kind === "loaded" && (
        <>
          <RunHeader
            run={state.run}
            manuscriptName={state.manuscript.name}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          />

          {/* 更新（再取得）の失敗（最終レビュー Important 1）：`loaded` の内容は残したまま、
              エラーだけを添えて見せる。本文・一覧・詳細・選択は消えない。 */}
          {refreshError !== null && <p className={styles.error}>{refreshError}</p>}

          {!isSettingsStop(state.run) && (
            <div className={styles.layout}>
              <div className={styles.bodyColumn} ref={bodyContainerRef}>
                <BodyView
                  paragraphs={paragraphs}
                  selectedFindingId={selectedFindingId}
                  onSelectFinding={handleSelectFinding}
                />
              </div>
              <div className={styles.sideColumn}>
                <FindingsPanel
                  run={state.run}
                  findings={state.findings}
                  visible={visible}
                  filter={filter}
                  onFilterChange={handleFilterChange}
                  selectedFindingId={selectedFindingId}
                  onSelectFinding={handleSelectFindingFromList}
                />
                {selectedFinding !== null && related !== null && (
                  <FindingDetail
                    finding={selectedFinding}
                    detail={findingDetail}
                    detailError={findingDetailError}
                    body={state.manuscript.body}
                    sameRange={related.sameRange}
                    overlapping={related.overlapping}
                    onSelectFinding={handleSelectFinding}
                    // `onNavigate` は省略可（`exactOptionalPropertyTypes` の下では `undefined` を
                    // 明示的に渡すのと「キー自体を省く」のは別物）。移動先が無いときはキーごと省き、
                    // `FindingDetail` 側に「渡されていない」と判定させて操作子を出させない。
                    {...(selectedNavigationTarget !== null ? { onNavigate: handleNavigate } : {})}
                    onSaveJudgment={handleSaveJudgment}
                  />
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 右側（指摘一覧と絞り込み。Task 6、決定 7・8・10）。
 *
 * `completed` 以外では「指摘はありません」と書かない（決定 2）。未処理の範囲が残っている実行を
 * 「問題なし」と見せないため。0 件のときの文言は決定 2 の表のとおり状態で分ける。
 * この 0 件判定は `findings`（絞り込み前の全件）で行う——絞り込みで 0 件になった場合は
 * `FindingList` 側が「絞り込みに一致する指摘はありません」を出すので、ここの文言（実行状態の
 * 説明）とは混同しない。
 */
function FindingsPanel(props: {
  readonly run: RunDto;
  readonly findings: readonly FindingDto[];
  readonly visible: readonly FindingDto[];
  readonly filter: FindingFilter;
  readonly onFilterChange: (next: FindingFilter) => void;
  readonly selectedFindingId: string | null;
  readonly onSelectFinding: (findingId: string) => void;
}) {
  const { run, findings, visible, filter, onFilterChange, selectedFindingId, onSelectFinding } =
    props;

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

  return (
    <div className={styles.findingsPanel}>
      <p className={styles.findingCount}>
        {visible.length} / {findings.length} 件
      </p>
      <FindingFilterControls filter={filter} onChange={onFilterChange} />
      <FindingList
        findings={visible}
        selectedFindingId={selectedFindingId}
        onSelectFinding={onSelectFinding}
      />
    </div>
  );
}
