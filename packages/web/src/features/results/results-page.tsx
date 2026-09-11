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
 * 更新（再取得）の失敗（最終レビュー Important 1）：取り直し（`performRefresh`）が失敗しても、
 * 表示中の `loaded` の内容（本文・一覧・詳細・選択）はそのまま残し、`refreshError` にエラーを
 * 入れて添えて見せる（`state` を `"error"` に倒さない）。`state` が `"error"` に倒れるのは
 * 初回取得（`fetchInitial`）の失敗のときだけで、その場合は再試行の操作子
 * （「最新の状態を取得」ボタン）を出す。
 *
 * 進捗と実行制御（PR12b Task 5、決定 5・6・7・8・9・10・11）：初回取得に `getRunUnits` を足し
 * （`getFindings` と同じく `getRun` と並行に投げる。決定 5）、`run.progress` とあわせて
 * `RunHeader`（実体は `run-progress.tsx`・`run-control.tsx`）へ渡す。停止・再開・失敗単位の
 * 再試行・復旧確認の 4 操作は `runControlAction` に集約する：API を呼び、成功・失敗を問わず
 * 取り直し（`requestRefresh("heavy", ...)`）の完了を待ってから `pending` を `null` に戻す（202 の応答の `RunDto` を
 * 画面の状態へ継ぎ当てない——`RunDetailDto` ではなく進捗も対象も持たないため。かつ、先に
 * `pending` を戻すと取り直し前の古い `run.status` のままボタンが再度押せてしまい、二重送信の
 * 窓が開く）。操作の失敗は `controlFailureOf` で `ControlFailure` に写して保持する
 * （`error.message` は画面に出さない）。`slowUnitIds`（決定 10）を実際に埋めるのは
 * Task 8 の `generation-slow`（下記「自動更新」節）。
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
 * 自身が `detailGenerationRef` を進めるので、古い応答の破棄は従来どおり効く。`performRefresh` から
 * `selectedFindingId` を直接読まない（`filter` と同じ理由で deps に含めていないため、
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
 *
 * ---
 *
 * 自動更新（PR12b Task 8、決定 1・2・3・4・10）。取得の経路が「初回読み込み」と「取り直し」の
 * 2 本に分かれる。
 *
 * - **初回読み込み**（`fetchInitial`）は従来どおり 4 つ（`getRun`・`getManuscript`・`getFindings`・
 *   `getRunUnits`）がそろうまで何も描かない。`id` が変わったとき・初回取得の失敗からの再試行でも
 *   ここを通り、画面の状態（絞り込み・選択・操作の送信中・案内・遅延通知・SSE の印）を既定に戻す。
 * - **取り直し**（`performRefresh`）は 2 種類（決定 2）。`light` = `getRun` + `getRunUnits`、
 *   `heavy` = `light` + `getFindings` + 選択中の詳細。`getManuscript` は取り直さない——原稿の版は
 *   不変（`run.manuscriptVersionId` は実行中に変わらない）で、取り直す理由が無いため。
 *
 * 取り直しには 4 つの規律がある。どれも静かに壊れるので、テストで判別できる形にしてある。
 *
 * 1. **合流**（決定 3）：取り直しは同時に 1 本だけ（`inFlightRef`）。走っている最中に来た合図は
 *    `dirtyRef` に強い方だけを残して畳む。1 本が終わったら `dirtyRef` を取り出して空にし、値が
 *    あれば次を走らせる。これを **`dirtyRef` が空になるまで繰り返す**——「追い 1 本だけ」にすると、
 *    1 本目の追い取得の最中に届いたイベントぶんの更新が画面に永久に出ない。固定時間のデバウンスは
 *    入れない（測っていない待ち時間を足さない）。手動の「最新の状態を取得」も同じ門を通し、
 *    追い取得が終わるまで `refreshing` を立て続ける。
 * 2. **2 段反映**（決定 3）：`getRun` + `getRunUnits` の成功をその時点で反映し、`getFindings` と
 *    詳細は別に反映する。後者の失敗で前者を巻き戻さない——3N+1 の `getFindings` がこけただけで、
 *    停止・再開の後の新しい状態がボタンにも進捗にも出なくなるのを避ける。
 * 3. **静かな更新**（決定 4）：`refreshing`（「更新中…」と `disabled`）は手動のときだけ。自動の
 *    状態は `autoUpdateNotice` の 1 行で表し、同時に 2 行出さない。
 * 4. **実行 ID で鎖を守る**（前タスクの申し送り 1）：取り直しの鎖・`pending`・`controlFailure`・
 *    `slowUnitIds` は `runScopeRef`（`id` が変わるたびに進む世代）で守る。`recovery-blocked` の
 *    案内が別の実行へのリンクを出すので、**同じコンポーネントのまま実行 ID が変わる**経路が実在する。
 *    守らないと、旧実行の取り直しが新しい実行の画面を上書きし（世代番号を進めてしまうため、
 *    新実行の初回読み込みの応答まで捨てられて「読み込み中…」から戻らなくなる）、`pending` も
 *    旧い鎖の完了まで戻らずに新実行のボタンが disabled のままになる。
 *
 * SSE の購読そのものは `use-run-stream.ts`（決定 1）。`streamEnded` / `streamConnection` を
 * 持つのはこちらで、`enabled = run.status === "running" && !streamEnded` を計算して渡す。
 * `streamEnded` を下ろすのは**軽い取得が成功して `status` が `running` だったとき**だけ
 * （決定 1 の規則 4）——取り直しに失敗している間は実行が終端かどうか分からず、そこで張り直すと
 * 「購読 → 合成 `run-settled` → 張り直し」の無限ループが復活する。失敗している間は張らず、
 * 「自動更新は停止しています。」と出して手動の復旧に委ねる。
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
import { type ControlFailure, controlFailureOf, type PendingControlAction } from "./run-control.ts";
import { isSettingsStop, RunHeader } from "./run-header.tsx";
import { pruneSlowUnitIds } from "./run-progress.ts";
import type { RefreshKind, StreamConnectionState } from "./use-run-stream.ts";
import { useRunStream } from "./use-run-stream.ts";

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

/**
 * 指摘の一覧が、いま画面に出ている実行の状態に追いついているか（レビュー I-1）。
 *
 * 取り直しの 2 段反映（決定 3）は「状態だけ先に進む」窓を開ける：重い取り直しの 1 段目で
 * `status` が `completed` になった後、2 段目（`getFindings`）が届く前に 0 件を「指摘はありません」
 * と断定してしまう。`getFindings` は 3N+1 で中央値 110〜130 ms あり、失敗すればその表示が
 * 残り続ける。取得の失敗を「空」として見せないため、断定はこれが `current` のときだけにする。
 */
type FindingsFreshness = "current" | "pending" | "failed";

function errorMessageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "実行の取得に失敗しました";
}

/** `state.kind !== "loaded"` の間、`findings` の代わりに使う空配列。毎回同じ参照にする。 */
const EMPTY_FINDINGS: readonly FindingDto[] = [];

/** 遅延通知（決定 10）の初期値・リセット値。参照を固定して無駄な再描画を作らない。 */
const EMPTY_SLOW_UNIT_IDS: ReadonlySet<string> = new Set();

/** 取り直しの合図の発生源。手動（「最新の状態を取得」）だけが「うるさい」（決定 4）。 */
type RefreshSource = "auto" | "manual";

/** 決定 3：畳むときは強い方を残す（軽い合図で重い合図を潰さない）。 */
function strongerKind(current: RefreshKind | null, next: RefreshKind): RefreshKind {
  return current === "heavy" || next === "heavy" ? "heavy" : "light";
}

/** 決定 4：自動更新が止まっていることと、手動の取り直しへの導線を伝える 1 行。 */
const AUTO_UPDATE_STOPPED_NOTICE =
  "自動更新は停止しています。「最新の状態を取得」を押してください。";

/**
 * 決定 4：自動更新の状態を表す 1 行。同時に 2 行出さない（上から優先）。
 *
 * 「再接続を試みています」と書けるのは、**SSE が切れていて `EventSource` が実際に再接続を試みて
 * いるとき**（`streamConnection === "reconnecting"`）だけである。
 *
 * - REST の取得が失敗しても `EventSource` を張り直すとは限らず、終端イベントの後なら接続は
 *   こちらが意図して閉じている。だから 1 行目・4 行目には「再接続」を持ち出さない。
 * - `streamConnection === "closed"`（`readyState` が CLOSED）は、WHATWG の規定で **以後 `EventSource`
 *   が再接続しない**状態なので、「再接続を試みています」は嘘になる。自動更新はもう戻らないため、
 *   1 行目と同じ「自動更新は停止しています。」に倒して手動の取り直しへ導く
 *   （最終レビュー Important 1）。
 */
function autoUpdateNotice(input: {
  readonly runStatus: RunDto["status"];
  readonly streamEnded: boolean;
  readonly streamConnection: StreamConnectionState;
  readonly autoRefreshError: boolean;
}): string | null {
  if (input.streamEnded && input.runStatus === "running") {
    return AUTO_UPDATE_STOPPED_NOTICE;
  }
  if (input.streamConnection === "closed") {
    return AUTO_UPDATE_STOPPED_NOTICE;
  }
  if (input.streamConnection === "reconnecting") {
    return "サーバーとの接続が切れました。再接続を試みています。";
  }
  if (input.autoRefreshError) {
    return "最新情報の取得に失敗しました。「最新の状態を取得」を押してください。";
  }
  return null;
}

/**
 * `apiClient.*` が同期例外を投げても、拒否した Promise にそろえる。
 *
 * 同期 throw のままだと、`.then(...).finally(...)` で閉じた鎖が未処理の拒否
 * （unhandled rejection）になる（前タスクの申し送り 2）。
 */
function invoke<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call();
  } catch (cause) {
    return Promise.reject(cause);
  }
}

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
  // 両方とも既定に戻す（`fetchInitial` でリセットする。理由は下記）。
  const [filter, setFilter] = useState<FindingFilter>(DEFAULT_FINDING_FILTER);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);

  // 取り直し（`performRefresh`）の成功コールバックから「今選ばれている指摘」を読むための ref
  // （PR21 レビュー指摘 1）。`performRefresh` の deps に `selectedFindingId` を含めたくない
  // （`filter` と同じ理由——選択のたびに作り直したくない）ため、レンダーのたびに素直に同期する
  // だけの ref で渡す（`useEffect` を挟まない。値を読むのは非同期コールバックの中だけなので、
  // コミット前のタイミングでも実害は無い）。
  const selectedFindingIdRef = useRef<string | null>(selectedFindingId);
  selectedFindingIdRef.current = selectedFindingId;

  // 同一コンポーネントインスタンスのまま id が変わる（別の実行への直リンク遷移）ことがある。
  // 古い要求の応答が後から届いて新しい要求の結果を上書きしないよう、要求ごとに世代を数える。
  const requestGenerationRef = useRef(0);

  // 自動更新（Task 8、決定 1・4）。`streamEnded` / `streamConnection` の持ち主はこの画面
  // （`useRunStream` ではない。決定 1）。`autoRefreshError` は自動の取り直しの失敗を 1 行に畳んだもの。
  const [streamEnded, setStreamEnded] = useState(false);
  const [streamConnection, setStreamConnection] = useState<StreamConnectionState>("open");
  const [autoRefreshError, setAutoRefreshError] = useState(false);
  // 決定 10：遅延通知（`generation-slow`）の対象単位 ID。単位が `running` でなくなったら消える。
  const [slowUnitIds, setSlowUnitIds] = useState<ReadonlySet<string>>(EMPTY_SLOW_UNIT_IDS);
  // レビュー I-1：指摘の一覧が実行の状態に追いついているか。
  const [findingsFreshness, setFindingsFreshness] = useState<FindingsFreshness>("current");

  // 取り直しの合流（決定 3）。`inFlightRef` は「今 1 本走っている」、`dirtyRef` は「走り終わったら
  // もう 1 本走らせる」合図（強い方だけを残す）。`loudRef` は手動の取り直しが混ざっているか
  // （＝ `refreshing` を立て続けるか）、`clearControlFailureRef` は「最新の状態を取得」由来かどうか
  // （成功したら実行制御の失敗案内を消す。前タスクの申し送り 3）。
  const inFlightRef = useRef(false);
  const dirtyRef = useRef<RefreshKind | null>(null);
  const loudRef = useRef(false);
  const clearControlFailureRef = useRef(false);
  // 門が空になるのを待っている呼び出し元（手動の取り直し・実行制御の鎖）。世代ごとに解決する。
  const idleWaitersRef = useRef<{ readonly scope: number; readonly resolve: () => void }[]>([]);

  // 実行 ID ごとの世代（前タスクの申し送り 1）。`requestGenerationRef`（要求ごと）とは別物で、
  // 「どの実行に紐づく鎖か」を表す。レンダー中に同期で進める——非同期の続きより先に進んで
  // いなければ守りにならないため（同じ値なら何もしないので、StrictMode の二重呼び出しでも安全）。
  const runScopeRef = useRef(0);
  const scopedIdRef = useRef<string | undefined>(id);
  if (scopedIdRef.current !== id) {
    scopedIdRef.current = id;
    runScopeRef.current += 1;
    // 門は新しい実行のために空にする。旧い鎖は自分の世代を見て、門に触らず終わる。
    inFlightRef.current = false;
    dirtyRef.current = null;
    loudRef.current = false;
    clearControlFailureRef.current = false;
  }

  // 指摘詳細（Task 7、決定 3・9・12）。選択中の指摘 ID が変わるたびに、または更新が成功した
  // ときに `getFinding` を 1 回呼ぶ（キャッシュしない。持ち越し「詳細をキャッシュしない」の
  // とおり）。`requestGenerationRef`（本編の取得）とは別の世代カウンタで、呼び直すたびに世代を
  // 進めて古い応答を捨てる。`performRefresh` から呼ぶため、それより前に定義する。
  const [findingDetail, setFindingDetail] = useState<FindingDetailDto | null>(null);
  const [findingDetailError, setFindingDetailError] = useState<string | null>(null);
  const detailGenerationRef = useRef(0);

  const fetchDetail = useCallback(
    (findingId: string, mode: "select" | "refresh") => {
      const generation = ++detailGenerationRef.current;
      if (mode === "select") {
        // 別の指摘を選び直したときは、前の指摘の詳細を出したままにしない（取得中は
        // 「一覧が持つ情報だけで描く」状態にする。`FindingDetail` 側が `detail === null` を
        // 「読み込み中」として扱う）。
        setFindingDetail(null);
        setFindingDetailError(null);
      }
      // レビュー M-1：取り直し（`mode === "refresh"`）では前の値を残す。同じ指摘の詳細を
      // 取り直しているだけなので、`null` に戻すと実行中は `check-finished` / `target-merged` が
      // 届くたびに元候補・位置診断の欄が点滅する（自動更新では高頻度で起きる）。
      invoke(() => apiClient.getFinding(findingId)).then(
        (detail) => {
          if (detailGenerationRef.current !== generation) return; // 古い応答
          setFindingDetail(detail);
          setFindingDetailError(null);
        },
        (cause: unknown) => {
          if (detailGenerationRef.current !== generation) return;
          // 詳細の取得失敗は詳細パネルの当該欄にだけエラーを出す（詳細全体を消さない）。
          // 取り直しの失敗では前の値が残っているので、`FindingDetail` は引き続きそれを描く。
          setFindingDetailError(errorMessageFrom(cause));
        },
      );
    },
    [apiClient],
  );

  // 初回読み込み（決定 3）。4 つそろうまで何も描かない（部分描画をしない）。`id` が変わったとき・
  // 初回取得の失敗からの再試行でもここを通り、画面の状態を既定に戻す。
  const fetchInitial = useCallback((): void => {
    if (id === undefined) return;
    const generation = ++requestGenerationRef.current;
    setState({ kind: "loading" });
    // 初回・id 変更（別の実行への直リンク遷移）のときだけ絞り込み・選択を既定に戻す。
    // 取り直し（`performRefresh`）では戻さない——絞り込みは操作中の状態として保つ。
    setFilter(DEFAULT_FINDING_FILTER);
    setSelectedFindingId(null);
    setRefreshError(null);
    setRefreshing(false);
    // 実行制御の失敗案内（決定 8）も id 変更のたびに戻す。戻さないと、別の実行（run A）で
    // 出ていた 409 の案内（「この検査はすでに動いていません」等）が、直リンクで移った
    // 別の実行（run B）の画面にそのまま残ってしまう。
    setControlFailure(null);
    // 送信中の操作も実行 ID に紐づく（前タスクの申し送り 1(b)）。戻さないと、操作の送信中に
    // 別の実行へ移ったとき、旧い鎖が終わるまで新しい実行のボタンが disabled のままになる。
    setPending(null);
    setSlowUnitIds(EMPTY_SLOW_UNIT_IDS);
    setFindingsFreshness("current");
    setStreamEnded(false);
    setStreamConnection("open");
    setAutoRefreshError(false);

    // `getRun`・`getFindings`・`getRunUnits`（決定 5。PR12b Task 5）は並行に投げる（決定 3）。
    // `findingsPromise`・`unitsPromise` の拒否は下の then/catch のどちらかで必ず読むが、
    // `getRun` が先に失敗した経路では読まれないまま終わることがあるため、ここで空の catch を
    // 挟んで未処理拒否（unhandled rejection）を防ぐ（実際のエラー処理は下の分岐で行うので、
    // ここでは何もしない）。
    const findingsPromise = invoke(() => apiClient.getFindings(id));
    findingsPromise.catch(() => {});
    const unitsPromise = invoke(() => apiClient.getRunUnits(id));
    unitsPromise.catch(() => {});

    invoke(() => apiClient.getRun(id))
      .then(
        (detail) => {
          if (requestGenerationRef.current !== generation) return undefined; // 古い応答

          // `getManuscript` は `run.manuscriptVersionId` が要るため `getRun` の応答が届いてから
          // 呼ぶ（決定 3）。4 つそろうまで setState しない（部分描画をしない）。
          return Promise.all([
            invoke(() => apiClient.getManuscript(detail.run.manuscriptVersionId)),
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
              // 選択中の指摘が消えたかどうかの判定は、可視集合（`visible`）を監視する
              // `useEffect`（下）に一本化する。ここでは選択を触らない（最終レビュー Important 2）。
            })
            .catch((cause: unknown) => {
              if (requestGenerationRef.current !== generation) return;
              // 初回取得の失敗（`getManuscript`・`getFindings`・`getRunUnits`）は 404 でも
              // 「その実行はありません」にしない（実行自体は取得できているため）。取得の失敗は
              // エラーとして見せる（空として見せない。本文だけ描いて黙らない）。
              setState({ kind: "error", message: errorMessageFrom(cause) });
            });
        },
        (cause: unknown) => {
          if (requestGenerationRef.current !== generation) return;
          // `getRun` の 404 だけが「その実行はありません」になる（発生源で写し方を分ける）。
          // これは初回取得のときだけの分岐——取り直しで実行が消えている場合は
          // `performRefresh` 側が失敗として扱う（「その実行はありません」に倒すと本文・一覧が
          // 消えるため）。
          if (cause instanceof ApiRequestError && cause.status === 404) {
            setState({ kind: "not-found" });
            return;
          }
          setState({ kind: "error", message: errorMessageFrom(cause) });
        },
      )
      .catch(() => {});
  }, [apiClient, id]);

  // 初回・再読み込み・直リンクのいずれでも、表示時に 1 回だけ取得する。id が変わったときも
  // （`fetchInitial` の参照が変わるので）ここが再実行される。
  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  /**
   * 取り直し 1 本ぶん（決定 2・3）。必ず解決する（拒否を外へ漏らさない）。
   *
   * 反映は 2 段。1 段目（`getRun` + `getRunUnits`）の成功はその場で状態・進捗・操作の可否へ
   * 反映し、決定 1 の規則 4（`streamEnded` を下ろす）もここで判定する——2 段目
   * （`getFindings`）の成否を待たない。2 段目の失敗で 1 段目を巻き戻さない。
   */
  const performRefresh = useCallback(
    (kind: RefreshKind): Promise<void> => {
      if (id === undefined) return Promise.resolve();
      const runId = id;
      const generation = ++requestGenerationRef.current;

      // 重い取り直しの `getFindings` は軽い取得と並行に投げる（決定 3）。拒否は下の
      // `allSettled` で読むが、先に読まれない経路があるので空の catch を挟む。
      const findingsPromise = kind === "heavy" ? invoke(() => apiClient.getFindings(runId)) : null;
      findingsPromise?.catch(() => {});
      if (findingsPromise !== null) {
        // 一覧はこの瞬間から「追いついていない」（レビュー I-1）。
        setFindingsFreshness("pending");
      }

      const lightPromise = Promise.all([
        invoke(() => apiClient.getRun(runId)),
        invoke(() => apiClient.getRunUnits(runId)),
      ]).then(([detail, units]) => {
        if (requestGenerationRef.current !== generation) return;
        // `getManuscript` は取り直さない（原稿の版は不変）。`loaded` でなければ何もしない
        // ——初回読み込みの途中に割り込んで部分描画を作らないため。
        setState((current) =>
          current.kind !== "loaded"
            ? current
            : {
                ...current,
                run: detail.run,
                targets: detail.targets,
                progress: detail.progress,
                units,
              },
        );
        // 決定 10：もう `running` でない単位の遅延通知は消える。
        setSlowUnitIds((previous) => pruneSlowUnitIds(previous, units));
        // 決定 1 の規則 4：軽い取得の成功だけで判定する。終端状態なら立てたままにする。
        if (detail.run.status === "running") {
          setStreamEnded(false);
        }
      });

      const heavyPromise =
        findingsPromise === null
          ? Promise.resolve()
          : findingsPromise.then(
              (findings) => {
                if (requestGenerationRef.current !== generation) return;
                setState((current) =>
                  current.kind !== "loaded" ? current : { ...current, findings },
                );
                setFindingsFreshness("current");
                // PR21 レビュー指摘 1：選択中の指摘があれば詳細も取り直す（同じ指摘が選ばれた
                // ままだと `selectedFindingId` は変化せず、選択変更だけを見る useEffect では
                // 再取得されない）。`fetchDetail` 自身が世代を進めるので古い応答は捨てられる。
                if (selectedFindingIdRef.current !== null) {
                  fetchDetail(selectedFindingIdRef.current, "refresh");
                }
              },
              (cause: unknown) => {
                if (requestGenerationRef.current !== generation) {
                  throw cause;
                }
                // 一覧は古いまま。0 件を「指摘はありません」と断定させない（レビュー I-1）。
                setFindingsFreshness("failed");
                throw cause;
              },
            );

      return Promise.allSettled([lightPromise, heavyPromise]).then((results) => {
        if (requestGenerationRef.current !== generation) return;
        // 先に軽い側の失敗を見る（並びは `allSettled` の引数どおり）。
        const rejected = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        const first = rejected[0];
        if (first !== undefined) {
          if (loudRef.current) {
            // 手動が混ざっている間の失敗は、これまでどおりエラー帯に出す（決定 4）。あわせて
            // 自動の案内は消す——同じ失敗を 2 か所に出さないため。しかも自動の 3 行目は
            // 「「最新の状態を取得」を押してください。」であり、押した直後に出すと堂々巡りになる。
            setRefreshError(errorMessageFrom(first.reason));
            setAutoRefreshError(false);
          } else {
            setAutoRefreshError(true);
          }
          return;
        }
        // 1 回でも成功したら自動更新の失敗案内は消す（連続して失敗しても行は増えない）。
        setAutoRefreshError(false);
        if (loudRef.current) {
          setRefreshError(null);
        }
        // 前タスクの申し送り 3：409 の「…最新の状態を取得しました。」は、その後の手動の
        // 取り直しが成功したら消す（文面と状態がずれるため）。操作直後の自動の取り直しでは
        // 消さない——消すと、案内が出た瞬間に自分で消してしまう。
        if (clearControlFailureRef.current) {
          setControlFailure(null);
        }
      });
    },
    [apiClient, id, fetchDetail],
  );

  /** 門が空になるのを待っている呼び出し元を、その世代ぶんだけ解決する。 */
  const settleIdle = useCallback((scope: number) => {
    const waiters = idleWaitersRef.current;
    idleWaitersRef.current = waiters.filter((waiter) => waiter.scope !== scope);
    for (const waiter of waiters) {
      if (waiter.scope === scope) waiter.resolve();
    }
  }, []);

  // 合流の本体（決定 3）。自分自身を呼び直すので ref を経由する。
  const startPassRef = useRef<(kind: RefreshKind) => void>(() => {});

  const startPass = useCallback(
    (kind: RefreshKind) => {
      const scope = runScopeRef.current;
      inFlightRef.current = true;
      const finish = () => {
        if (runScopeRef.current !== scope) {
          // 別の実行へ移った。ここで次を走らせると旧実行の ID で取りに行き、世代番号を進めて
          // 新実行の初回読み込みの応答まで捨ててしまう（前タスクの申し送り 1）。門はレンダー時に
          // 初期化済みなので触らず、待っている旧い鎖だけ解放して終わる。
          settleIdle(scope);
          return;
        }
        const next = dirtyRef.current;
        dirtyRef.current = null;
        if (next !== null) {
          // 取り出して空にし、値があれば次を走らせる。これを空になるまで繰り返す
          // （「追い 1 本だけ」にしない）。
          startPassRef.current(next);
          return;
        }
        inFlightRef.current = false;
        if (loudRef.current) {
          loudRef.current = false;
          setRefreshing(false);
        }
        clearControlFailureRef.current = false;
        settleIdle(scope);
      };
      performRefresh(kind).then(finish, finish);
    },
    [performRefresh, settleIdle],
  );
  startPassRef.current = startPass;

  /**
   * 取り直しの入口（決定 3）。自動も手動も必ずここを通す。戻り値は門が空になったときに
   * 解決する `Promise`——実行制御の鎖がこれを待ってから `pending` を戻す（操作の直後にすぐ
   * 戻すと、取り直し前の古い `run.status` のままボタンが再度押せて二重送信の窓が開く）。
   */
  const requestRefresh = useCallback(
    (kind: RefreshKind, source: RefreshSource): Promise<void> => {
      if (id === undefined) return Promise.resolve();
      if (source === "manual") {
        // 決定 4：`refreshing` は手動のときだけ。追い取得が終わるまで立て続ける。
        loudRef.current = true;
        clearControlFailureRef.current = true;
        setRefreshing(true);
        setRefreshError(null);
      }
      const scope = runScopeRef.current;
      const idle = new Promise<void>((resolve) => {
        idleWaitersRef.current.push({ scope, resolve });
      });
      if (inFlightRef.current) {
        dirtyRef.current = strongerKind(dirtyRef.current, kind);
      } else {
        startPassRef.current(kind);
      }
      return idle;
    },
    [id],
  );

  const handleRefresh = useCallback(() => {
    void requestRefresh("heavy", "manual");
  }, [requestRefresh]);

  // 実行制御（決定 6・7・8。PR12b Task 5）。停止・再開・失敗単位の再試行・復旧確認の 4 操作は
  // すべてこの 1 つに集約する：API を呼び、成功・失敗にかかわらず重い取り直しの完了を
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
      // 鎖のすべての続きを実行 ID の世代で守る（前タスクの申し送り 1）。
      const scope = runScopeRef.current;
      setPending(kind);
      setControlFailure(null);
      invoke(() => action(runId))
        .then(
          () => {},
          (cause: unknown) => {
            if (runScopeRef.current !== scope) return;
            setControlFailure(controlFailureOf(cause));
          },
        )
        .then(() => {
          // 別の実行へ移っていたら取り直さない（新しい実行の画面を旧実行の値で上書きしない）。
          if (runScopeRef.current !== scope) return undefined;
          // 決定 8：成功・失敗を問わず重い取り直し。門を通すので自動の取り直しと合流する。
          return requestRefresh("heavy", "auto");
        })
        .then(() => {
          if (runScopeRef.current !== scope) return;
          setPending(null);
        })
        // 申し送り 2：`.finally()` で閉じると、`apiClient.*` の同期例外がここまで拒否として
        // 流れてきたときに未処理の拒否になる。末尾で必ず握る。
        .catch(() => {});
    },
    [id, pending, requestRefresh],
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

  // SSE の購読（決定 1・2・4・10）。実体は `use-run-stream.ts`。この画面は「張るかどうか」を
  // 決めて渡し、hook からの合図を状態に写すだけにする。
  const handleStreamRefresh = useCallback(
    (kind: RefreshKind) => {
      void requestRefresh(kind, "auto");
    },
    [requestRefresh],
  );
  const handleStreamSettled = useCallback(() => {
    // 決定 1 の規則 3：購読は `subscribeRunEvents` が既に閉じている。張り直さない印を立てる。
    setStreamEnded(true);
  }, []);
  const handleConnectionStateChange = useCallback((connection: StreamConnectionState) => {
    setStreamConnection(connection);
  }, []);
  const handleGenerationSlow = useCallback((unitId: string) => {
    setSlowUnitIds((previous) => {
      if (previous.has(unitId)) return previous;
      const next = new Set(previous);
      next.add(unitId);
      return next;
    });
  }, []);

  // 決定 1 の規則 2：`running` かつ `streamEnded === false` のときだけ張る。
  const streamEnabled =
    id !== undefined && state.kind === "loaded" && state.run.status === "running" && !streamEnded;
  useRunStream({
    runId: id ?? "",
    enabled: streamEnabled,
    onRefresh: handleStreamRefresh,
    onSettled: handleStreamSettled,
    onConnectionStateChange: handleConnectionStateChange,
    onGenerationSlow: handleGenerationSlow,
  });

  // 購読していない間に切断の案内を出したままにしない（決定 4。実行が終端になった・`run-settled` で
  // 閉じた後は、切れているのではなく張っていない）。
  useEffect(() => {
    if (!streamEnabled) {
      setStreamConnection("open");
    }
  }, [streamEnabled]);

  // 初回取得の失敗（`state.kind === "error"`）からの再試行（最終レビュー Important 1）。
  // 取り直しではなく初回読み込みを使う——まだ何も `loaded` になっていないので、絞り込み・選択を
  // 戻す通常の初回取得と同じ扱いでよい。
  const handleRetryInitial = useCallback(() => {
    fetchInitial();
  }, [fetchInitial]);

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
    fetchDetail(selectedFindingId, "select");
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
  // 取得の成功時にここで潰そうとしないこと——`fetchInitial` / `performRefresh` の deps に `filter` が無く、
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

  // 決定 4：自動更新の状態を表す 1 行（出さないときは null）。
  const autoNotice =
    state.kind === "loaded"
      ? autoUpdateNotice({
          runStatus: state.run.status,
          streamEnded,
          streamConnection,
          autoRefreshError,
        })
      : null;

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

          {/* 自動更新の状態（決定 4）。3 つのうち 1 行だけを出す（同時に 2 行出さない）。
              手動の `refreshError`（下）とは別の帯で、こちらはエラーの文面を転記しない。 */}
          {autoNotice !== null && <p className={styles.statusNotice}>{autoNotice}</p>}

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
                  freshness={findingsFreshness}
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
  /** レビュー I-1：一覧が実行の状態に追いついているか。0 件の文言の分岐にだけ効く。 */
  readonly freshness: FindingsFreshness;
  readonly visible: readonly FindingDto[];
  readonly filter: FindingFilter;
  readonly onFilterChange: (next: FindingFilter) => void;
  readonly selectedFindingId: string | null;
  readonly onSelectFinding: (findingId: string) => void;
}) {
  const {
    run,
    findings,
    freshness,
    visible,
    filter,
    onFilterChange,
    selectedFindingId,
    onSelectFinding,
  } = props;

  if (findings.length === 0) {
    // レビュー I-1：一覧が追いついていない間は 0 件を断定しない。取得中と取得失敗を
    // 実行の状態の文言より先に見る——どちらも「いま画面にある 0 件は当てにならない」ことを
    // 意味し、そちらのほうが利用者に必要な情報なので。
    if (freshness === "pending") {
      return <p>指摘を読み込んでいます…</p>;
    }
    if (freshness === "failed") {
      return <p className={styles.error}>指摘の取得に失敗しました</p>;
    }
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
