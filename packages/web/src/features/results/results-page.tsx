/**
 * `/runs/:id` — 検査結果の閲覧画面（決定 1・2・3）。
 *
 * PR11 の `features/run-receipt/run-receipt-page.tsx`（削除済み）が担っていた「検査実行の受付表示」
 * を吸収し、本文と指摘を読む結果画面に置き換える。上部の表示（原稿名・状態・停止理由・停止メッセージ・
 * モデル・時刻・「最新の状態を取得」ボタン）は `run-header.tsx` の 1 か所に閉じ込める。
 *
 * 取得は決定 3 のとおり：`getRun`・`getFindings`・`getRunUnits`（決定 5。PR12b Task 5 で追加）を
 * 並行に投げ、`getManuscript` は `run.manuscriptVersionId` が要るため `getRun` の後に呼ぶ。
 * 4 つがそろうまで本文も右側も描かない（部分描画をしない）。世代番号（`useRef` の連番）で
 * 古い応答を捨てる。`id` が変わったときと
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
 * 進捗と実行制御（PR12b Task 5、決定 5・6・7・8・9・10・11）：初回取得に `getRunUnits` を足し
 * （`getFindings` と同じく `getRun` と並行に投げる。決定 5）、`run.progress` とあわせて
 * `RunHeader`（実体は `run-progress.tsx`・`run-control.tsx`）へ渡す。停止・再開・失敗単位の
 * 再試行・復旧確認の 4 操作は `runControlAction` に集約する：API を呼び、成功・失敗を問わず
 * `fetchAll("refresh")` の完了を待ってから `pending` を `null` に戻す（202 の応答の `RunDto` を
 * 画面の状態へ継ぎ当てない——`RunDetailDto` ではなく進捗も対象も持たないため。かつ、先に
 * `pending` を戻すと取り直し前の古い `run.status` のままボタンが再度押せてしまい、二重送信の
 * 窓が開く）。操作の失敗は `controlFailureOf` で `ControlFailure` に写して保持する
 * （`error.message` は画面に出さない）。`slowUnitIds`（決定 10）はこの Task では空集合のまま
 * 持つだけで、実際に埋めるのは SSE を足す後続 Task の担当。
 *
 * 指摘詳細（Task 7、決定 3・9・12）：選択中の指摘 ID が変わるたびに `getFinding` を 1 回呼ぶ
 * （キャッシュしない。持ち越し「詳細をキャッシュしない」のとおり）。専用の世代番号
 * （`detailGenerationRef`）で古い応答を捨てる——`requestGenerationRef`（4 つの取得）とは別の
 * カウンタにする。選択を解除しても・別の指摘を選び直しても本編の再取得は要らないため。
 * 取得中・取得失敗の間も、`finding`（一覧が持つ情報）から分かる範囲（引用・理由・判定など）は
 * 描き続け、元候補・位置診断の欄だけを「読み込み中」またはエラーにする（`FindingDetail` の責務）。
 *
 * **PR21 レビュー指摘 1**：選択中の指摘の詳細（`getFinding`）は、選択が変わったときだけでなく
 * 「最新の状態を取得」が成功したときにも取り直す（同じ指摘が選ばれたままだと `selectedFindingId`
 * 自体は変化しないため、選択変更だけを見る仕組みでは再取得されない。失敗単位の再試行で同じ指摘に
 * 元候補が増える経路があるため、実際に古びる）。取得処理そのものは `fetchDetail` に切り出し、
 * 「選択が変わったとき」と「更新が成功し、選択中の指摘があるとき」の両方から呼ぶ。`fetchDetail`
 * 自身が `detailGenerationRef` を進めるので、古い応答の破棄は従来どおり効く。`fetchAll` から
 * `selectedFindingId` を直接読まない（`filter` と同じ理由で `fetchAll` の deps に含めていないため、
 * 古い値を読んでしまう）。代わりに毎レンダーで同期するだけの `selectedFindingIdRef` を介す。
 *
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
 *
 * **PR21 レビュー指摘 2**：`JudgmentControl` は指摘ごとに作り直される（`FindingDetail` が
 * `key={finding.id}` を付けているため）。保存を投げた直後に別の指摘へ切り替えると、その操作子は
 * アンマウントされ、そこにだけ出していたエラー表示は失われる。選択を変えても消えない失敗表示を
 * 出すため、保存の失敗（どの指摘の、どんな理由でか）を `judgmentErrors`（`Map`）としてこの
 * コンポーネントへ持ち上げ、ヘッダー直下（`refreshError` と同じ並び）に表示する。`handleSaveJudgment`
 * は失敗を記録したあとそのまま re-throw するので、`JudgmentControl` がまだマウントされていれば
 * 従来どおりその場のエラー表示・入力の巻き戻しも行われる（二重に出ることを許容する。選択を
 * 変えても消えない表示は、ここでしか持てないため）。表示する引用（`quote`）は呼び出し側
 * （`finding-detail.tsx`）から渡してもらう——ここで `state.findings` を検索すると、`state` を
 * deps に含めない `handleSaveJudgment` から古い値を読むおそれがあるため。
 */

import type {
  FindingDetailDto,
  FindingDto,
  JudgmentStatus,
  ManuscriptVersionDto,
  ProgressDto,
  PutJudgmentRequest,
  RunDto,
  RunTargetDto,
  RunUnitsDto,
} from "@shuten/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useApiClient } from "../../api/context.tsx";
import { ApiRequestError } from "../../api/errors.ts";
import { ROUTES } from "../../app/routes.ts";
import { buildBodyView } from "./body-view.ts";
import { BodyView } from "./body-view.tsx";
import { FailedUnits } from "./failed-units.tsx";
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
import { type ControlFailure, controlFailureOf } from "./run-control.ts";
import { isSettingsStop, RunHeader } from "./run-header.tsx";

type ResultsState =
  | { kind: "loading" }
  | {
      kind: "loaded";
      run: RunDto;
      targets: readonly RunTargetDto[];
      progress: ProgressDto;
      units: RunUnitsDto;
      manuscript: ManuscriptVersionDto;
      findings: readonly FindingDto[];
    }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/** 実行制御（決定 6・7・8）の送信中の操作。`null` なら送信していない。 */
type PendingControlAction = "stop" | "resume" | "retry" | "confirm" | null;

function errorMessageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "実行の取得に失敗しました";
}

/** `state.kind !== "loaded"` の間、`findings` の代わりに使う空配列。毎回同じ参照にする。 */
const EMPTY_FINDINGS: readonly FindingDto[] = [];

/** 採否の保存に失敗した指摘 1 件ぶんの表示情報（PR21 レビュー指摘 2）。 */
interface JudgmentSaveError {
  /** 保存を試みた時点の引用。どの指摘の保存が失敗したのか利用者が識別できるようにする。 */
  readonly quote: string;
  readonly message: string;
}

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

  // `fetchAll` の更新成功コールバックから「今選ばれている指摘」を読むための ref
  // （PR21 レビュー指摘 1）。`fetchAll` の deps に `selectedFindingId` を含めたくない（`filter` と
  // 同じ理由——選択のたびに `fetchAll` を作り直したくない）ため、レンダーのたびに素直に同期する
  // だけの ref で渡す（`useEffect` を挟まない。値を読むのは非同期コールバックの中だけなので、
  // コミット前のタイミングでも実害は無い）。
  const selectedFindingIdRef = useRef<string | null>(selectedFindingId);
  selectedFindingIdRef.current = selectedFindingId;

  // 同一コンポーネントインスタンスのまま id が変わる（別の実行への直リンク遷移）ことがある。
  // 古い要求の応答が後から届いて新しい要求の結果を上書きしないよう、要求ごとに世代を数える。
  const requestGenerationRef = useRef(0);

  // 指摘詳細（Task 7、決定 3・9・12）。選択中の指摘 ID が変わるたびに、または更新が成功した
  // ときに `getFinding` を 1 回呼ぶ（キャッシュしない。持ち越し「詳細をキャッシュしない」の
  // とおり）。`requestGenerationRef`（本編の取得）とは別の世代カウンタで、呼び直すたびに世代を
  // 進めて古い応答を捨てる。`fetchAll` から呼ぶため、`fetchAll` より前に定義する。
  const [findingDetail, setFindingDetail] = useState<FindingDetailDto | null>(null);
  const [findingDetailError, setFindingDetailError] = useState<string | null>(null);
  const detailGenerationRef = useRef(0);

  const fetchDetail = useCallback(
    (findingId: string) => {
      const generation = ++detailGenerationRef.current;
      // 呼び直した直後は前の詳細を出さない（取得中は「一覧が持つ情報だけで描く」状態にする。
      // `FindingDetail` 側が `detail === null` を「読み込み中」として扱う）。
      setFindingDetail(null);
      setFindingDetailError(null);
      apiClient.getFinding(findingId).then(
        (detail) => {
          if (detailGenerationRef.current !== generation) return; // 古い応答
          setFindingDetail(detail);
        },
        (cause: unknown) => {
          if (detailGenerationRef.current !== generation) return;
          // 詳細の取得失敗は詳細パネルの当該欄にだけエラーを出す（詳細全体を消さない）。
          setFindingDetailError(errorMessageFrom(cause));
        },
      );
    },
    [apiClient],
  );

  // `fetchAll` は必ず解決する（内部で全ての拒否を捕まえて `setState`/`setRefreshError` に写す）
  // `Promise<void>` を返す。実行制御の操作（`runControlAction`、下）がこれを待ってから `pending` を
  // 戻すため——操作の直後にすぐ `pending` を戻すと、取り直し前の古い `run.status` のままボタンが
  // 再度押せてしまい、二重送信の窓が開く。
  const fetchAll = useCallback(
    (mode: "initial" | "refresh"): Promise<void> => {
      if (id === undefined) return Promise.resolve();
      const generation = ++requestGenerationRef.current;
      if (mode === "initial") {
        setState({ kind: "loading" });
        // 初回・id 変更（別の実行への直リンク遷移）のときだけ絞り込み・選択を既定に戻す。
        // 更新ボタン（"refresh"）では戻さない——絞り込みは操作中の状態として保つ。
        setFilter(DEFAULT_FINDING_FILTER);
        setSelectedFindingId(null);
        setRefreshError(null);
        // 実行制御の失敗案内（決定 8）も id 変更のたびに戻す。戻さないと、別の実行（run A）で
        // 出ていた 409 の案内（「この検査はすでに動いていません」等）が、直リンクで移った
        // 別の実行（run B）の画面にそのまま残ってしまう。
        setControlFailure(null);
      } else {
        setRefreshing(true);
        // 前回の更新失敗の表示を、新しい試みの結果が出るまで一旦消す。
        setRefreshError(null);
      }

      // `getRun`・`getFindings`・`getRunUnits`（決定 5。PR12b Task 5）は並行に投げる（決定 3）。
      // `findingsPromise`・`unitsPromise` の拒否は下の then/catch のどちらかで必ず読むが、
      // `getRun` が先に失敗した経路では読まれないまま終わることがあるため、ここで空の catch を
      // 挟んで未処理拒否（unhandled rejection）を防ぐ（実際のエラー処理は下の分岐で行うので、
      // ここでは何もしない）。
      const findingsPromise = apiClient.getFindings(id);
      findingsPromise.catch(() => {});
      const unitsPromise = apiClient.getRunUnits(id);
      unitsPromise.catch(() => {});

      return apiClient.getRun(id).then(
        (detail) => {
          if (requestGenerationRef.current !== generation) return; // 古い応答

          // `getManuscript` は `run.manuscriptVersionId` が要るため `getRun` の応答が届いてから
          // 呼ぶ（決定 3）。4 つそろうまで setState しない（部分描画をしない）。
          return Promise.all([
            apiClient.getManuscript(detail.run.manuscriptVersionId),
            findingsPromise,
            unitsPromise,
          ])
            .then(([manuscript, findings, units]) => {
              if (requestGenerationRef.current !== generation) return;
              setState({
                kind: "loaded",
                run: detail.run,
                targets: detail.targets,
                progress: detail.progress,
                units,
                manuscript,
                findings,
              });
              setRefreshing(false);
              // 選択中の指摘が消えたかどうかの判定は、可視集合（`visible`）を監視する
              // `useEffect`（下）に一本化する。ここでは選択を触らない（最終レビュー Important 2。
              // ここで `filter` を見て判定しようとしないこと——`fetchAll` の deps に `filter` が
              // 無く、古い値を読んでしまう）。
              //
              // PR21 レビュー指摘 1：更新が成功し、かつ選択中の指摘があれば詳細も取り直す。
              // 同じ指摘が選ばれたままだと `selectedFindingId` 自体は変化しないため、選択変更
              // だけを見る useEffect では再取得が走らない（失敗単位の再試行で同じ指摘に元候補が
              // 増える経路があり、実際に古くなる）。`fetchDetail` 自身が `detailGenerationRef` を
              // 進めるので、古い応答の破棄は従来どおり効く。
              if (mode === "refresh" && selectedFindingIdRef.current !== null) {
                fetchDetail(selectedFindingIdRef.current);
              }
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
              // 初回取得の失敗（`getManuscript`・`getFindings`・`getRunUnits`）は 404 でも
              // 「その実行はありません」にしない（実行自体は取得できているため）。取得の失敗は
              // エラーとして見せる（空として見せない。本文だけ描いて黙らない）。
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
    [apiClient, id, fetchDetail],
  );

  // 初回・再読み込み・直リンクのいずれでも、表示時に 1 回だけ取得する。id が変わったときも
  // （`fetchAll` の参照が変わるので）ここが再実行される。
  useEffect(() => {
    fetchAll("initial");
  }, [fetchAll]);

  const handleRefresh = useCallback(() => {
    fetchAll("refresh");
  }, [fetchAll]);

  // 実行制御（決定 6・7・8。PR12b Task 5）。停止・再開・失敗単位の再試行・復旧確認の 4 操作は
  // すべてこの 1 つに集約する：API を呼び、成功・失敗にかかわらず `fetchAll("refresh")` の完了を
  // 待ってから `pending` を戻す（202 の応答の `RunDto` を画面の状態へ直接継ぎ当てない——
  // `RunDetailDto` と違って進捗も対象も持たないため）。`pending !== null` の間に別の操作を
  // 呼ばれても無視する（`RunControl` 側もすべてのボタンを disabled にするが、二重の防御として
  // ここでも防ぐ）。
  const [pending, setPending] = useState<PendingControlAction>(null);
  const [controlFailure, setControlFailure] = useState<ControlFailure | null>(null);

  const runControlAction = useCallback(
    (kind: Exclude<PendingControlAction, null>, action: (runId: string) => Promise<unknown>) => {
      if (id === undefined || pending !== null) return;
      const runId = id;
      setPending(kind);
      setControlFailure(null);
      action(runId)
        .then(
          () => {},
          (cause: unknown) => {
            setControlFailure(controlFailureOf(cause));
          },
        )
        .then(() => fetchAll("refresh"))
        .finally(() => {
          setPending(null);
        });
    },
    [id, pending, fetchAll],
  );

  const handleStop = useCallback(() => {
    runControlAction("stop", (runId) => apiClient.stopRun(runId));
  }, [runControlAction, apiClient]);

  const handleResume = useCallback(() => {
    runControlAction("resume", (runId) => apiClient.resumeRun(runId));
  }, [runControlAction, apiClient]);

  const handleRetryFailed = useCallback(() => {
    runControlAction("retry", (runId) => apiClient.retryFailedUnits(runId));
  }, [runControlAction, apiClient]);

  // Task 6：失敗単位の個別再試行（`failed-units.tsx`）。`runControlAction` の仕組みにそのまま乗せる
  // （送信中は `pending`、成否によらず取り直し、失敗は `controlFailureOf` で案内。決定 6・36）。
  const handleRetryUnit = useCallback(
    (unitId: string) => {
      runControlAction("retry", (runId) =>
        apiClient.retryFailedUnits(runId, { unitIds: [unitId] }),
      );
    },
    [runControlAction, apiClient],
  );

  const handleConfirmRecovery = useCallback(() => {
    runControlAction("confirm", (runId) => apiClient.confirmRecovery(runId));
  }, [runControlAction, apiClient]);

  // 決定 10：遅延通知（`generation-slow`）の対象単位 ID。SSE 購読を足す後続 Task が埋める。
  // この Task では常に空集合のまま。
  const [slowUnitIds] = useState<ReadonlySet<string>>(() => new Set());

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

  // 選択中の指摘 ID が変わるたびに詳細を取り直す（`fetchDetail` に切り出し済み。上記コメント参照）。
  useEffect(() => {
    if (selectedFindingId === null) {
      setFindingDetail(null);
      setFindingDetailError(null);
      return;
    }
    fetchDetail(selectedFindingId);
  }, [selectedFindingId, fetchDetail]);

  // 採否の保存に失敗した指摘の一覧（PR21 レビュー指摘 2）。`findingId` をキーにする——同じ指摘で
  // 保存をやり直せば、成功時にも新しい失敗時にもこのキーが上書き・削除されるので二重に残らない。
  const [judgmentErrors, setJudgmentErrors] = useState<ReadonlyMap<string, JudgmentSaveError>>(
    new Map(),
  );

  // 採否と判断メモ（Task 8、決定 13）。`putJudgment` の呼び出しはここに閉じる（状態の持ち主を
  // 1 か所にする。`JudgmentControl` は onSave を呼ぶだけで API を直接呼ばない）。
  const handleSaveJudgment = useCallback(
    (
      findingId: string,
      status: JudgmentStatus,
      note: string | null,
      quote: string,
    ): Promise<void> => {
      const body: PutJudgmentRequest = note === null ? { status } : { status, note };
      // 新しい試みを始めるので、その指摘の前回の失敗表示は結果が出るまで一旦消す。
      setJudgmentErrors((prev) => {
        if (!prev.has(findingId)) return prev;
        const next = new Map(prev);
        next.delete(findingId);
        return next;
      });
      return apiClient.putJudgment(findingId, body).then(
        (judgment) => {
          // 成功したら応答の JudgmentDto で該当指摘の judgment だけを差し替える
          // （一覧を取り直さない。一覧の行の採否表示もこの差し替えで更新される）。
          setState((current) => {
            if (current.kind !== "loaded") return current;
            return {
              ...current,
              findings: current.findings.map((f) => (f.id === findingId ? { ...f, judgment } : f)),
            };
          });
        },
        (cause: unknown) => {
          // PR21 レビュー指摘 2：`JudgmentControl` は指摘ごとに作り直される（`key={finding.id}`）
          // ため、保存を投げた直後に別の指摘へ切り替えると、その場のエラー表示はアンマウントで
          // 消えてしまう。選択を変えても消えない表示として、ここに記録してから re-throw する
          // （呼び出し元がまだマウントされていれば、従来どおりその場のエラー表示・入力の巻き戻しも
          // 行われる。二重に出ることは許容する——選択を変えても消えない表示は、ここでしか持てない）。
          setJudgmentErrors((prev) => {
            const next = new Map(prev);
            next.set(findingId, { quote, message: errorMessageFrom(cause) });
            return next;
          });
          throw cause;
        },
      );
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
            progress={state.progress}
            units={state.units}
            slowUnitCount={slowUnitIds.size}
            onRefresh={handleRefresh}
            refreshing={refreshing}
            onStop={handleStop}
            onResume={handleResume}
            onRetryFailed={handleRetryFailed}
            onConfirmRecovery={handleConfirmRecovery}
            pending={pending}
            failure={controlFailure}
          />

          {/* 更新（再取得）の失敗（最終レビュー Important 1）：`loaded` の内容は残したまま、
              エラーだけを添えて見せる。本文・一覧・詳細・選択は消えない。 */}
          {refreshError !== null && <p className={styles.error}>{refreshError}</p>}

          {/* PR21 レビュー指摘 2：採否の保存の失敗。選択を変えても消えない場所（ヘッダー直下、
              上の更新失敗と同じ並び）に出す。どの指摘の保存が失敗したかを引用で示す（切り詰めない
              ——はみ出しは CSS の省略表示に任せる。`.findingQuote` などと同じ理由）。 */}
          {judgmentErrors.size > 0 && (
            <ul className={styles.judgmentErrorList}>
              {Array.from(judgmentErrors).map(([findingId, entry]) => (
                <li key={findingId} className={styles.judgmentErrorItem}>
                  <span className={styles.judgmentErrorQuote}>{entry.quote}</span>
                  <span className={styles.judgmentErrorMessage}>
                    の採否の保存に失敗しました：{entry.message}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* 失敗単位の一覧と個別再試行（Task 6、決定 6・12。裁定 R3）。`isSettingsStop` の外に
              置く——`settings` 停止でも、それとは無関係な `failed` が残っている形が実在するため
              （決定 14。`orchestrator.ts` の `retryFailedUnits` のコメント）。出すかどうかの
              判定自体は `FailedUnits` 内部が `run.status`／失敗単位の有無で行う。 */}
          <FailedUnits
            run={state.run}
            units={state.units}
            onRetryAll={handleRetryFailed}
            onRetryUnit={handleRetryUnit}
            pending={pending}
          />

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
