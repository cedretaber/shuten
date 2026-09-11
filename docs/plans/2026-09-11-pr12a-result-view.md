# PR12a 詳細計画：結果閲覧（web）

作成日：2026-09-11
状態：実装済み
仕様：`docs/spec/mvp-spec.md`（v0.9.1）4（手順 5〜7）、5.3（上部の状態表示を除く）、5.4、
9（本文をテキストとして表示、原文表示と位置情報の対応を保つ）、11 節（6・7・9・10・11・12・13 項の UI 側）
前提：`docs/plans/2026-09-07-mvp-roadmap.md` の PR12a 節、`docs/reference/invariants.md`、
`docs/plans/2026-09-09-pr10-http-api.md`（決定 1〜19。API の契約はここが正本）、
`docs/plans/2026-09-10-pr11-web-shell.md`（決定 1〜20。画面の土台の正本）、
`docs/experiments/2026-09-11-highlight-spike/README.md`（強調表示のスパイク。申し送り 8 件）

## 目標

保存済みの検査結果を読む画面を作る。すなわち、

- `/runs/:id` を「実行の受付表示」から**結果画面**にする（PR11 の `features/run-receipt/` を吸収する）
- 本文の読み取り専用表示と、保存済み UTF-16 範囲による強調（スパイクの `buildBodyView`）
- 指摘一覧、指摘詳細（5.4 の全項目）、採否の記録、クライアント側の絞り込み
- 実行一覧 `/runs`（`GET /api/runs`）からの再閲覧

本 PR の終点は「保存済みの実行を開いて、本文・強調・指摘・詳細を読み、採否を記録して、
再読み込み後も同じものが読める」ところまでである。進捗の表示・停止・再開・再試行・復旧確認・SSE は
PR12b が作る。

## 対象外（MUST NOT）

- **進捗と実行制御を作らない**（PR12b）。SSE、ポーリング、停止・再開・再試行・復旧確認の操作、
  観点別の処理進捗、`recovery-waiting` / `recovery-blocked` / `backend-restarted` の案内。
  結果画面の更新は PR11 から引き継ぐ「最新の状態を取得」ボタンだけ（決定 1）。
- **サーバーの API を増やさない・変えない。** 本 PR で `packages/server` に手を入れるのは、
  決定 14 の計測（テストの追加のみ）だけである。エンドポイントも DTO も増やさない。
- **エクスポートを作らない**（PR13a）。
- **本文を編集する経路を作らない。** 本文は読み取り専用の表示だけ。原稿版は不変。
- **ブラウザで位置を再計算しない。** `Intl.Segmenter`、`packages/shared/src/text/grapheme-index.ts`、
  `locateQuote` のいずれも結果画面では使わない（申し送り 1）。引用文字列を本文から検索し直さない。
- **`dangerouslySetInnerHTML` を使わない。** 本文・引用・理由・修正案・停止メッセージはすべて
  React のテキストノードとして描画する（仕様 9「HTML として実行しない」）。
- **本文をブラウザで加工しない。** 改行の正規化、空白の畳み込み、トリムをしない。
  唯一の例外は段落末尾の改行列を DOM に入れないこと（申し送り 4。表示上は段落ブロックが改行を担う）。
- **CSS フレームワーク・状態管理ライブラリ・API モックライブラリを入れない**（PR11 決定 4・5 のまま）。
- **仮想スクロールを入れない**（スパイク C5。1 万字・指摘 800 件で DOM 反映 21 ms）。
- **API キーを扱わない。接続先 URL を結果画面に出さない**（PR11 決定 18）。

## 全体の制約（不変条件から）

- **位置の正本はサーバーが保存した UTF-16 範囲**（`FindingDto.range`。`[start, end)`）。
  ブラウザは表示に使うだけで、再計算結果で上書きしない（`docs/reference/invariants.md`）。
- 範囲は書記素クラスタ境界に揃っている（サーバーの `locateQuote` が保証する）。
  ブラウザはそれを前提にしてよく、確かめ直さない。
- 本文は CRLF を含む元の改行のまま保存されている。表示でも正規化しない。
- 「採用予定」は本文を書き換えない。採否は `judgments` にだけ記録する。
- 失敗・形式不正を正常な値に置き換えない（DTO の検証失敗は握りつぶさずエラー表示にする）。
- 依存の版は完全固定。相対 import は `.ts` / `.tsx` 拡張子付き。
- 公開リポジトリ。個人情報・機器固有の値・実原稿をコミットしない。
- ドキュメント・コミットメッセージ・コード内コメントは日本語、識別子は英語。

## 作るもの

```
packages/web/src/
  api/client.ts                      ← getRuns / getFindings / getFinding / putJudgment を足す
  app/routes.ts                      ← ROUTES.runs（/runs）を足す
  app/App.tsx                        ← /runs と、/runs/:id の差し替え
  features/results/
    results-page.tsx                 画面の骨組み（取得・状態・左右の割り付け）
    run-header.tsx                   上部（原稿名・状態・停止理由・更新）
    body-view.ts                     buildBodyView（範囲 → セグメント列。純関数）
    body-view.tsx                    本文の描画（段落ブロック、強調、選択）
    finding-list.tsx                 指摘一覧
    finding-filter.ts / .tsx         絞り込みの述語と操作子
    finding-detail.tsx               指摘詳細（5.4）
    judgment-control.tsx             採否と判断メモ
    labels.ts                        列挙 → 日本語ラベル（run-receipt/labels.ts を移して拡張）
    results.module.css
  features/run-list/
    run-list-page.tsx                実行一覧（/runs）
    run-list.module.css
```

`features/run-receipt/` は削除する（決定 1）。

## 決定

### 決定 1：`/runs/:id` を結果画面にし、受付表示を吸収する

PR11 の `features/run-receipt/` は「開始した実行の受付表示」だけの暫定画面だった。結果画面と
別に置くとパスが 2 つになり、開始 → 結果の動線が切れる。`/runs/:id` を結果画面に置き換え、
受付表示の内容は結果画面の上部（`run-header.tsx`）に吸収する。`features/run-receipt/` は削除し、
`labels.ts` は `features/results/labels.ts` へ移す（決定 11）。

**PR12a の上部に載せるもの**（PR11 の受付表示から引き継ぐ範囲）：

- 原稿名（`GET /api/manuscripts/:id` の `name`）
- 実行の状態ラベル（`RunDto.status`）、停止理由（`stopReason`）、停止メッセージ（`stopMessage`）
- モデル ID、開始時刻・終了時刻
- 「最新の状態を取得」ボタン（手動の再取得。ポーリングも SSE もしない）
- `status === "stopped" && stopReason === "settings"` は「検査は開始できませんでした」と表示し、
  結果の領域を描かない（PR11 決定 16 の `isSettingsStop` をそのまま持ち込む）

**PR12b が足すもの**（本 PR では作らない）：観点別の処理進捗、停止・再開・再試行・復旧確認の操作、
SSE の購読と「最新の状態を取得」ボタンの置き換え、`recovery-waiting` などの案内。
上部の DOM は `run-header.tsx` の 1 か所に閉じ込め、PR12b がそこだけを書き換えられるようにする。

### 決定 2：完了していない実行でも、保存済みの結果は読めるようにする

`GET /api/runs/:id/findings` は実行の状態に関係なくその時点の指摘を返す。`running`・`stopped`・
`partially-failed`・`recovery-waiting` のいずれでも、取得できた指摘を一覧と強調に出す。
再開や進捗の観測は PR12b が足すので、本 PR での更新手段は「最新の状態を取得」だけである。

**ただし `status === "completed"` 以外では「指摘はありません」「問題ありません」と表示しない。**
未処理の範囲が残っている実行を「問題なし」と見せないため（仕様 9、ロードマップの PR12b 規則）。
指摘が 0 件のときの文言は状態で分ける。

| `status` | 指摘 0 件のときの表示 |
| --- | --- |
| `completed` | 「指摘はありません」 |
| それ以外 | 「この実行には、まだ指摘がありません（検査は完了していません）」＋状態ラベル |

### 決定 3：読む口と取得の順序

本 PR が呼ぶのは次の 6 つだけで、すべて PR10 が作った既存の口である。

| 呼ぶ口 | 用途 | 契機 |
| --- | --- | --- |
| `GET /api/runs` | 実行一覧（`RunSummaryDto[]`） | `/runs` の表示時 |
| `GET /api/runs/:id` | `run` / `progress` / `targets`（`RunDetailDto`） | `/runs/:id` の表示時、更新ボタン |
| `GET /api/manuscripts/:id` | 本文（`body`）と原稿名 | `run.manuscriptVersionId` が判明した後 |
| `GET /api/runs/:id/findings` | 指摘一覧（`FindingDto[]`） | `/runs/:id` の表示時、更新ボタン |
| `GET /api/findings/:id` | 指摘詳細（`FindingDetailDto`。元候補と位置診断） | 指摘を選んだとき（選択ごとに 1 回） |
| `PUT /api/findings/:id/judgment` | 採否の記録（`PutJudgmentRequest`） | 採否の操作 |

- 実行の取得と指摘の取得は並行に投げてよい。本文の取得は `run.manuscriptVersionId` に依存するので
  実行の取得の後になる。3 つがそろうまで本文と一覧は描かない（部分描画をしない）。
- `progress` は本 PR では読まない（PR12b）。`targets` は決定 9 の移動先の算出にだけ使う。
- 競合の防止は PR11 決定 10・16 と同じく**世代番号**（`useRef` の連番）で行う。`id` が変わったときと
  更新ボタンのたびに世代を進め、古い応答を捨てる。`AbortController` は使わない（`GET` なので
  捨てるだけでよい）。
- 詳細（`GET /api/findings/:id`）は選択のたびに取りに行き、キャッシュしない（同じ指摘を選び直したら
  もう一度取る）。指摘 800 件ぶんを先読みしない。詳細の取得中は一覧の情報（`FindingDto` の範囲）で
  詳細パネルを描き、候補・診断の欄だけ「読み込み中」にする。
- 採否は応答の `JudgmentDto` でその指摘の `judgment` を差し替える（一覧を取り直さない）。

### 決定 4：`buildBodyView` は `packages/web` に置く

スパイクの提案インタフェースは `packages/web` か `packages/shared` としていた。**web に置く。**
サーバーも CLI も使わない表示専用の変換であり、`shared` の役割（位置換算・分割・照合・許容語判定・
共有型）に当てはまらないため。DOM に依存しない純関数なので、テストは `body-view.ts` 単体で書ける
（申し送り 2）。

インタフェースはスパイクの提案どおり（`Range` は `@shuten/shared` の DTO と同じ形）：

```ts
interface Highlight { readonly id: string; readonly range: { start: number; end: number }; }
interface BodySegment {
  readonly start: number; readonly end: number;
  readonly text: string; readonly findingIds: readonly string[];
}
interface BodyParagraph { readonly id: number; readonly segments: readonly BodySegment[]; }
function buildBodyView(body: string, highlights: readonly Highlight[]): BodyParagraph[];
```

- 段落分割は `@shuten/shared` の `splitParagraphs` をそのまま使う。段落範囲は末尾の改行列を含むので、
  表示用には改行列を落とした「内容範囲」を使う（申し送り 4）。
- 段落ごとに「切れ目の集合＝段落の内容範囲の両端 ∪ その段落に掛かる強調の開始・終了」を作り、
  隣接する 2 点でセグメントに切る。各セグメントの `findingIds` は、そのセグメントを完全に覆う強調の ID。
- 実装は素朴な O(段落数 × 強調数) でよい（申し送り 6。10 万字で 23〜30 ms）。
- 段落ブロックに改行文字を入れない。空段落は CSS の `min-height` でつぶさない。

### 決定 5：本文末尾の改行ぶんの空ブロックは足さない（2026-09-11 にユーザーが確定。仕様 v0.9.1）

申し送り 8 のとおり、`splitParagraphs` は末尾の区切りの後に段落を作らないので、素直に作ると
**本文末尾の改行 1 つぶんが表示に現れない**（改行 n 個なら空行 n−1 個になる）。途中の空行は正しく残る。
位置の対応はどちらでも変わらない（強調範囲が末尾の改行に掛かっても、塗る範囲が縮むだけである）。

**足さない**を採る。失われるのは末尾の空行 1 つだけで、校正に必要な情報を含まない。足す案では
段落 ID を持たないブロックが 1 つできるため、`BodyParagraph.id` を `number | null` にするか末尾
ブロックを別のフィールドで返す必要があり、型・描画・テストがその分だけ複雑になる。

この振る舞いは仕様 5.3「空白、改行、段落を保った表示」の例外にあたるので、**仕様書側に明記した**
（v0.9.1。5.3 節の本文表示の行と 15 節の改訂記録。表示だけの差で、保存する本文・位置情報・強調範囲の
対応は変わらない）。

したがって `buildBodyView` の出力は `splitParagraphs` の段落と 1 対 1 に対応する。この振る舞いを
テストで固定する（R1）：末尾が LF・CRLF・CR の 3 通り、連続する末尾改行（`"あ\n\n"` は 2 ブロックで
2 つ目は空）、末尾に改行が無い場合の 4 通り。

### 決定 6：選択の塗り分けは props と `React.memo`（申し送り 5 からの意図的な逸脱）

スパイクの申し送り 5 は「`ref` から該当要素を引いて class を操作する」としていた（素の DOM で
測った C6 の方式 B）。**React ではこれを採らない。** 理由は 2 つある。

- 強調の集合は絞り込みに依存する（決定 7）ので、絞り込みを変えるとセグメント列が作り直され、
  手で付けた class が落ちる。React の再利用の仕方によって落ちたり落ちなかったりするのが最悪で、
  「選択が消えることがある」という再現しにくい不具合になる。
- 選択状態を DOM に手で書くと、テストが `ref` の配線を追う形になり、画面の意味を検査できない。

**採る形**：段落コンポーネントを `React.memo` で包み、props に「この段落に含まれる選択中の指摘 ID」
（`selectedIdHere: string | null`）を渡す。選択が A から B へ移ると、A を含む段落と B を含む段落だけが
再描画される（指摘が段落を跨ぐときはその数だけ）。本文全体の再描画は起きない。

class は React が付ける（`className` に選択中かどうかを反映する）。CSS だけで選択 ID と
`data-findings` を照合することはできない、というスパイク C6 の結論はそのまま効いている。
`data-findings` 属性は**本文の強調から指摘を引くため**（クリック時の照合と、テストからの参照）に残す。

**キーボード操作**：本文の強調（`<span>`）は**フォーカスできるようにしない**。指摘は 1 万字で 800 件に
なりうるので、強調ごとにタブ止まりを作るとキーボードだけの利用者にはかえって使えなくなる。キーボードの
経路は指摘一覧（決定 10 の一覧。行はボタン）が担い、**一覧からすべての指摘を選べる**ようにする。
本文の強調はポインタ用の近道である。

### 決定 7：強調に渡すのは「絞り込み後に一覧へ出ている、位置が確定した指摘」だけ

`buildBodyView` の `highlights` に渡す集合は、

```
一覧に出ている指摘（絞り込み後） ∩ { locateStatus === "located" かつ range !== null }
```

とする（申し送り 7）。`locateStatus` と `range` の両方を見る（型の上では独立なので、片方だけでは
守れない）。絞り込みで隠れている指摘（抑制候補・撤回候補など）は強調しない——強調をクリックしても
一覧に対応する行が無い、という状態を作らないため。

### 決定 8：同じ範囲に複数の指摘があるとき

仕様 5.3 は「同じ範囲に複数指摘がある場合はすべて参照可能にする」とする。

- セグメントは `data-findings="id1 id2 …"` を持ち、**クリックで一覧順（`start` 昇順）の先頭を選ぶ**。
- 循環選択（クリックのたびに次へ移る）はしない。クリックの結果が毎回同じになる方を採る。
- 詳細パネルの先頭に、次の **2 つを別々の見出しで**出す。各行のクリックでそちらへ切り替える。
  - **「同じ範囲の他の指摘（N 件）」**：`range.start` と `range.end` が**完全に一致**する指摘。
    仕様 5.3 の「同じ範囲に複数指摘がある場合はすべて参照可能にする」はこれを指す。
  - **「範囲が重なる他の指摘（N 件）」**：範囲が重なるが一致しない指摘。同じセグメントを
    クリックしたときに到達できるようにするために出す。**「同じ箇所」と呼ばない**
    （`[0,10)` と `[9,20)` は 1 文字しか共有しない）。
- どちらも絞り込み後に見えている指摘から作る（隠れている指摘への導線は作らない）。

### 決定 9：位置特定失敗の指摘の移動先は `run.targets` から引く

`locateStatus` が `not-found` / `ambiguous` の指摘は強調しない。移動は「元の検査対象範囲へ」だけを
提供する（仕様 5.3）。移動先は次のように決める。

- `finding.targetId` で `RunDetailDto.targets` を引き、`target.target.start` を含む段落ブロックへ移動する。
- **`finding.paragraphId` は使わない。** 位置が確定していない指摘の `paragraphId` は LLM の申告値を
  そのまま入れたものであり（`packages/server/src/db/repositories/findings.ts` の決定 15）、本文の段落と
  対応している保証がない。詳細パネルにも「LLM の申告」として出さない（誤解を招くため）。
- 該当する検査対象が見つからないときは移動の操作子を出さない（黙って何もしない操作子を置かない）。

`outside-target` は `FINDING_LOCATE_STATUSES` に無い（`CANDIDATE_LOCATE_STATUSES` だけが持つ）ので、
指摘の一覧には現れない。詳細パネルの元候補・位置診断の欄にだけ出る（ロードマップの「`outside-target` は
通常一覧に出さず診断表示だけ」はこの意味である）。

### 決定 10：絞り込みはクライアント側。既定は「抑制候補と撤回候補を隠す」

サーバーはクエリパラメーターを読まない（PR10 決定 15）。取得した `FindingDto[]` に対して
クライアント側で述語を適用する。項目は仕様 5.3 の 4 つ＋2 つの切り替え：

| 絞り込み | 値 | 既定 |
| --- | --- | --- |
| 分類 | `FINDING_CATEGORIES` の複数選択 | すべて |
| 採否 | `JUDGMENT_STATUSES` の複数選択 | すべて |
| 再確認状態 | 再確認なし / 待ち / 完了 / 失敗 / 対象外 | すべて |
| 位置特定 | 確定 / 失敗（`not-found`・`ambiguous`） | すべて |
| 抑制候補を表示（`suppression !== null`） | 切り替え | **隠す** |
| 撤回候補を表示（`recheck.verdict === "withdraw"`） | 切り替え | **隠す** |

- 述語は `finding-filter.ts` の純関数（`matchesFilter(finding, filter): boolean`）に閉じ込め、テストは
  そこに書く。
- 絞り込みの状態は画面のローカル状態にする。URL にも `localStorage` にも載せない（再読み込み後に
  保持するのは結果と判断であって、絞り込みではない。仕様 11 節 13 項）。
- 絞り込みを変えたときに、選択中の指摘が一覧から消えたら選択を解除する（詳細パネルを閉じる）。

### 決定 11：ラベルは網羅的な `Record<列挙, string>` にする

PR11 決定 16 と同じ形で、列挙から日本語ラベルへの写像を `features/results/labels.ts` に集める。
`Record<T, string>` の網羅性を型で担保し、値が増えたら型検査で落ちるようにする。対象は
`RUN_STATUSES`・`RUN_STOP_REASONS`（`run-receipt/labels.ts` から移す）に加えて、
`FINDING_CATEGORIES`・`INITIAL_VERDICTS`・`RECHECK_VERDICTS`・`RECHECK_REASON_KINDS`・
`JUDGMENT_STATUSES`・`FINDING_LOCATE_STATUSES`・`RECHECK_NOT_APPLICABLE_REASONS`・`UNIT_STATUSES`。

`JUDGMENT_STATUSES` のラベルは仕様 5.3 の語（未判断・採用予定・却下・保留）をそのまま使う。

### 決定 12：指摘詳細の表示規則（仕様 5.4）

`FindingDto.recheck` を軸に、次の表のとおり描く。**初回判定は必ず残す**（仕様 5.4「初回判定は履歴に
保持し、再確認待ち・失敗・無効の場合は未検証の初回判定とその状態を示す」）。

| `recheck` | 表示上の最終判定 | 状態の見出し |
| --- | --- | --- |
| `null` | 初回判定（`initialVerdict`） | 「再確認なし」 |
| `status === "done"` かつ `verdict !== null` | `verdict` | 「再確認済み」＋`reasonKind`・`reason` |
| `status === "pending"` / `"running"` | 初回判定（未検証） | 「再確認待ち」 |
| `status === "failed"` | 初回判定（未検証） | 「再確認失敗」＋`failure.reason` のラベル |
| `status === "not-applicable"` | 初回判定（未検証） | `notApplicableReason` のラベル（無効・抑制・位置未確定） |

そのほか：

- 位置確定時は**本文から切り出した引用**（`body.slice(range.start, range.end)`）を「原文」として出す。
  位置特定失敗時は `finding.quote` を「LLM の引用（原文との一致未確認）」として出す。
- 修正案（`suggestion`）は、`recheck.suggestionValid === false` または
  `recheck.reasonKind === "suggestion-inappropriate"` のとき、**有効な修正案として表示しない**
  （「この修正案は再確認で不適切と判定されました」と添えて、採否の判断材料としてだけ見せる）。
- `initialVerdict` の「誤りの可能性が高い」「作者への確認事項」を区別して出す。
- 理由（`reasons`）は観点（`perspective`）ごとに並べる（重複統合で複数になりうる）。
- 抑制候補（`suppression !== null`）は「許容語『〜』により抑制」と明示する。
- **見出しは「分類ラベル ＋ 原文」の 1 行**にする（仕様 5.4「分類と短い見出し」。2026-09-11 の裁定。
  当初この表は「短い見出し」を分解しておらず、Task 7 のレビューで漏れが出た）。位置特定失敗の指摘では
  原文の代わりに `finding.quote` を使い、LLM の引用で一致未確認であることを見出しにも示す。
  **文字列は切り詰めない**（全文を DOM に置き、CSS で省略する）。
- 確信度に類する数値は出さない（仕様 5.4）。

### 決定 13：採否の操作には「本文を書き換えない」ことを添える

仕様 5.3「『採用予定』は本文を書き換えないことを操作付近に明示する」。採否の操作子の直下に
固定の注記を置く（採用予定を選んだときだけ出す、にはしない）。判断メモは `note`（2,000 字以下。
`putJudgmentRequestSchema`）で、空欄は `null` として送る。

保存は明示の操作（保存ボタン）で行い、成功するまで一覧の表示を変えない。失敗したらその場に
エラーを出し、元の値に戻す（「保存したつもりで保存されていない」を作らない）。

### 決定 14：`listFindings` の N+1 は本 PR で計測して決着させる

ロードマップの持ち越し「`listFindings` の N+1 は PR12a で件数を見て判断する」。
`GET /api/runs/:id/findings` は指摘 1 件ごとに 3 つの問い合わせを出している。
`listFindings` の中の `toFindingWithReasons` → `listReasons`（理由）、ハンドラー側の
`findRecheckUnitByFinding`（再確認）と `findJudgment`（採否）である
（`packages/server/src/db/repositories/findings.ts`、`packages/server/src/api/findings.ts`）。
**実質 3N+1** で、当初「N+1」と書いていたよりも 1 件あたりの回数が多い。better-sqlite3 は同期なので
実測して決める。

- 指摘 800 件（スパイクと同じ規模）を投入した DB に対する `GET /api/runs/:id/findings` の所要時間を
  `packages/server` のテストで測る。
- **判断に使う値は、ウォームアップ 1 回の後に 5 回測った中央値**とする（1 回の測定では判断しない）。
- **中央値が 100 ms 以下なら据え置き**（ロードマップの持ち越しを「計測して据え置き」に書き換える）。
  **超えるならサーバー側の後続 PR に回す**（本 PR ではサーバーの実装を変えない。結果を計画書と
  ロードマップに記録する）。
- **CI で赤くするしきい値は判断値と分ける。** テストに残す上限は 1,000 ms（環境差で揺れないための
  歯止めであって、据え置きの判断基準ではない）。

**実測結果**（`packages/server/src/api/findings.perf.test.ts`。WSL2 上の Linux、指摘 800 件・
各件に理由 1・再確認 1・採否 1 を添えた状態で `GET /api/runs/:id/findings` を計測）：

| 実行 | サンプル（ms） | 中央値（ms） |
| --- | --- | --- |
| 1 回目 | 125.78, 130.77, 130.34, 131.76, 126.63 | 130.34 |
| 2 回目 | 118.17, 123.46, 127.80, 126.89, 123.85 | 123.85 |
| 3 回目 | 112.00, 109.69, 116.80, 127.88, 133.24 | 116.80 |

3 回とも中央値は 110〜130 ms 台で安定し、**100 ms を上回る**。よって**据え置きではなくサーバー側の
後続 PR に回す**（結論。本 PR ではサーバーの実装を変えない）。

参考として、コミットしないその場限りの計測で内訳も確かめた（HTTP・JSON の変換を含む「エンドポイント
全体」と、`listFindings` + 再確認 800 回 + 採否 800 回だけを回す「DB 問い合わせのみ」を分けて計測）。
DB 問い合わせのみで中央値 117.12 ms、エンドポイント全体で 125.23 ms と、**遅さの大半（9 割程度）は
3N+1 の問い合わせそのもの**で、JSON シリアライズや zod 検証の寄与は小さい。後続 PR では `listFindings`
の理由を 1 クエリで JOIN するか、再確認・採否を `runId` 単位で先読みして `Map` から引くなど、
N 回の問い合わせをまとめる方向で検討する。

**後日談（PR12c で解消）**：`docs/plans/2026-09-11-pr12c-findings-batch.md` で、`listFindings` の理由を
候補列挙 1 本にまとめ（決定 2）、ハンドラー側の再確認・採否も実行 1 件につき 1 回ずつの問い合わせに
まとめた（決定 4）。実行 1 件あたりの問い合わせ本数は `findRun` 1 ＋一覧側 4 本の計 5 本に固定され、
指摘の件数によらないことをクエリ本数のテストで検査している（同計画書 決定 7）。改善後に同じ条件
（指摘 800 件、WSL2/Linux）で再計測した中央値は 3 回とも 12 ms 前後（samples はいずれも 10〜14 ms 台）
で、上の 110〜130 ms 台から約 1/10 に縮んだ（詳細な実測値は同計画書 決定 5）。マイグレーション・索引は
追加していない（同計画書 決定 5：走査のままで十分という判断が実測で裏付けられた）。

### 決定 15：テストの方針（スパイクの申し送り 2・3 を反映）

- **描画ではなくセグメント列を検査する。** 分割位置のずれは描画では見つからない（スパイク C2）。
  `buildBodyView` の出力の `start` / `end` / `findingIds` を直接検査する。
- **どのセグメントにも単独サロゲートが無いことを検査する**（ずれをそのまま捕まえられる）。
- Unicode の例は**明示のエスケープ**で書く（`が`、`\u{29E3D}`、`葛\u{E0100}`、
  ZWJ の家族、`❤️`）。エディタの正規化で崩れないようにする。
- 改行は LF・CRLF・CR と連続する改行、および本文末尾の改行（決定 5）を含める。
- **jsdom の制限**（申し送り 3）：`[data-findings~="id"]` の照合は動く。`getBoundingClientRect()` は
  常に 0 を返し、`scrollIntoView` は**存在しない**。移動の検査は `scrollIntoView` を注入可能にするか
  スタブを置き、「正しい要素に対して呼ばれたこと」までにする。幾何と実際のスクロール位置は検査しない。

### 決定 16：漏えい検査を結果画面にも広げる

`packages/web/src/leak.test.tsx`（W9-7）は接続先 URL が `/` と `/runs/:id` に出ないことを見ている。
`/runs/:id` は本 PR で中身が変わり、`/runs` が増えるので、両方を番兵付きで通す。
`RunDto` は `endpointUrl` を持たないが、モデル情報・停止メッセージ・原稿名を経由して出ないことを
実際に描画して確かめる。

## 画面ごとの仕様

### `/runs` — 実行一覧

- `GET /api/runs` の `RunSummaryDto[]` を新しい順（`startedAt` 降順）に並べる。
- 各行：原稿名、モデル ID、状態ラベル、開始時刻、終了時刻。行全体が `/runs/:id` へのリンク。
- 0 件のときは「保存された検査実行はありません」＋ホームへのリンク。
- ヘッダー（`app/header.tsx`）に「検査結果」のリンクを足し、ホームからも辿れるようにする。

### `/runs/:id` — 結果画面

- 上部（`run-header.tsx`）：決定 1 のとおり。
- 左（本文）：`white-space: pre-wrap` の容器に段落ブロック。強調は `<span data-findings="…">`。
  選択中の指摘の強調だけ色を変える（決定 6）。空段落は `min-height` でつぶさない。
- 右（一覧と詳細）：絞り込み（決定 10）→ 指摘一覧 → 選択した指摘の詳細（決定 12）→ 採否（決定 13）。
- 一覧の行：分類ラベル、見出し（引用の先頭を切り詰めたもの）、採否、再確認状態、位置特定失敗の印。
  並びはサーバーの順（本文位置 `start` 昇順、位置未確定は最後）をそのまま使い、再ソートしない。
- 指摘の行をクリック → 選択して本文の該当箇所へ移動（位置確定時）。
  位置特定失敗の指摘は元の検査対象範囲へ移動（決定 9）。
- 本文の強調をクリック → 対応する指摘を選択（決定 8）。
- 実行が見つからないとき（404）は「その実行はありません」＋ホームへのリンク（PR11 の受付画面と同じ）。

## テスト

`packages/web` は jsdom ＋ Testing Library（PR11 決定 19）。番号は PR11 の W シリーズに続けて R とする。

- **R1：`buildBodyView`（`features/results/body-view.test.ts`）** — 決定 15 の方針で。
  同一範囲・重なり・入れ子・段落跨ぎ、強調なし、本文全体が 1 指摘、空段落、CRLF・LF・CR、
  本文末尾の改行（決定 5。空ブロックを足さない）、絵文字・異体字セレクタ・結合文字・サロゲートペア、
  「どのセグメントにも単独サロゲートが無い」、セグメントの連結が元の本文（改行を除く）に一致すること。
- **R2：本文の描画（`features/results/body-view.test.tsx`）** — 段落数、改行文字が DOM に無いこと、
  `data-findings` の値、強調のクリックで選択が変わること、選択の切り替えで本文全体が
  作り直されないこと（段落コンポーネントの描画回数で見る）。
- **R3：絞り込み（`features/results/finding-filter.test.ts`）** — 既定で抑制候補・撤回候補が隠れること、
  各項目の述語、隠れている指摘が強調に渡らないこと（決定 7）、選択中の指摘が消えたら選択が外れること。
  一覧の見出しに**引用の全文**が入っていること（結合文字・ZWJ の絵文字を含む引用で、切られていない
  ことを `textContent` の一致で見る）。
- **R4：指摘詳細（`features/results/finding-detail.test.tsx`）** — 決定 12 の表を 1 行ずつ。
  位置特定失敗時の「LLM の引用（原文との一致未確認）」、`suggestion-inappropriate` の修正案の扱い、
  初回判定が必ず残ること。
- **R5：採否（`features/results/judgment-control.test.tsx`）** — 4 状態の切り替え、メモの保存、
  `null` で送ること、保存失敗時に元へ戻ること、「本文を書き換えない」旨が操作の近くにあること。
- **R6：移動（`features/results/results-page.test.tsx`）** — 指摘の選択で正しい要素に対して
  `scrollIntoView` が呼ばれること（スタブ）。位置特定失敗の指摘では検査対象範囲を含む段落が対象に
  なること。幾何は検査しない。
- **R7：画面の取得と状態（`features/results/results-page.test.tsx`）** — 3 つの取得がそろうまで
  描かないこと、404、取得失敗、`settings` 停止の扱い、`completed` 以外で「指摘はありません」と
  出さないこと（決定 2）。
- **R8：実行一覧（`features/run-list/run-list-page.test.tsx`）** — 並び、0 件、リンク先。
- **R9：API クライアント（`api/client.test.ts` に追記）** — 新しい 4 メソッドの URL・メソッド・本文、
  応答のスキーマ検証、エラーの写像。
- **R10：ルーティングと漏えい（`App.test.tsx`、`leak.test.tsx`）** — `/runs` と `/runs/:id` の描画、
  決定 16 の番兵。
- **S1：サーバー側の計測（`packages/server`）** — 決定 14 の 800 件計測。

## 完了条件

- `pnpm check`（型検査・lint・テスト）が通る。
- `pnpm build` が通る（PR11 決定 20）。
- CI が Ubuntu・Windows の両方で緑。**ローカルの Windows 実機確認は本 PR では行わない**
  （PR11 で画面の実機確認は済んでおり、本 PR は同じ土台の上の画面追加であるため）。その旨を
  PR 本文に明記する。
- ロードマップの PR12a 節と持ち越し（`listFindings` の N+1）、README の現在の状態を更新する。

## 持ち越し・既知の制限

- 進捗・実行制御・SSE は PR12b。本 PR の更新は手動の再取得だけである。
- 詳細（`GET /api/findings/:id`）をキャッシュしないので、同じ指摘を選び直すと再取得になる。
  件数が増えて問題になったら PR12b 以降で見直す。
- 絞り込みの状態は再読み込みで失われる（決定 10）。
- 本文末尾の改行 1 つぶんは表示に現れない（決定 5。ユーザーが確定）。
- 本文と右側（一覧・絞り込み・詳細）が独立してスクロールしない。1 万字程度の原稿で指摘へ移動すると、
  一覧が画面外に出る。**PR12b の CSS 作業で拾う**——本 PR ではブラウザでの目視確認をしていないため
  （`pnpm check` は jsdom 上のテストのみで、実ブラウザのレイアウト・スクロール挙動を検証しない）、
  見ずに CSS だけ足しても検証できないと判断し、この PR では手を付けない。
  → **解消済み（PR12b Task 9）**：`results-page.module.css` の 2 カラムに `height` と
  `overflow-y: auto` を与えて左右を独立させた。詳細は `docs/plans/2026-09-11-pr12b-run-control.md`
  決定 15。ただし指摘一覧が実際に長くなった状態での
  `.sideColumn` 側の内部スクロールと、「指摘へ移動」したときの `scrollIntoView` の挙動は
  PR12b の環境（LM Studio 無し）でも未確認のまま持ち越し。
- `App.test.tsx` のルーティング検査が「読み込み中…」という共通の初期表示しか見ておらず、
  `/runs`（一覧）と `/runs/:id`（結果）の描画先コンポーネントを取り違えてもテストが緑のまま通って
  しまう（テストの穴）。
- `finding-detail.tsx` は「LLM 引用・未確認」の出し分けを、見出しの文字列（`quote.heading === "原文"`）
  から再判定している。見出しの日本語（`"原文"`）を変えると、この判定ロジックも黙って壊れる。
- `navigate.ts`（`navigationTargetOf`）は位置未確定の指摘の移動先を求める際、`RunTargetDto.paragraphIds`
  を使わず `splitParagraphs(body)` で段落をその場で引き直している。結果は一致するが、サーバー側が
  既に持っている値（`paragraphIds`）を使っていない。

## タスク分解

> **エージェント向け**：superpowers:subagent-driven-development で 1 タスクずつ実装する。各タスクは
> 「失敗するテストを書く → 落ちるのを見る → 最小の実装 → 通す → コミット」を単位とし、完了時に
> `pnpm check` を通す。本書の決定 1〜16 と「画面ごとの仕様」「テスト」節が要件の正本で、タスクはその
> 割り付けである。相対 import は `.ts` / `.tsx` 拡張子付き。識別子は英語、コメント・コミットメッセージ
> は日本語。`git add -A` を使わず、変更したファイルを明示して stage する。

順序と依存：

```
Task 1（buildBodyView）→ Task 4（本文の描画）─┐
Task 2（API クライアント）─────────────────┤
Task 3（ラベル）───────────────────────────┴→ Task 5（結果画面の骨組みとルート差し替え）
  → Task 6（一覧と絞り込み）→ Task 7（詳細）→ Task 8（採否）→ Task 9（移動）
  → Task 10（実行一覧）→ Task 11（N+1 の計測）→ Task 12（漏えい検査とドキュメント）
```

Task 1・2・3 は互いに独立だが、**並列に実装しない**（同じ `packages/web` を触るため）。

### Task 1：`buildBodyView`（決定 4・5、申し送り 1・2・4・6）

**Files**
- Create: `packages/web/src/features/results/body-view.ts`
- Create: `packages/web/src/features/results/body-view.test.ts`

**Interfaces（後続タスクが使う）**

```ts
/** 強調の対象。`range` は保存済みの UTF-16 範囲 `[start, end)`。 */
export interface Highlight {
  readonly id: string;
  readonly range: { readonly start: number; readonly end: number };
}

/** 段落内の 1 区切り。`findingIds` が空なら素のテキスト。 */
export interface BodySegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly findingIds: readonly string[];
}

/** 段落 1 つ分。`id` は `splitParagraphs` の段落 ID（0 始まり）。 */
export interface BodyParagraph {
  readonly id: number;
  readonly segments: readonly BodySegment[];
}

export function buildBodyView(body: string, highlights: readonly Highlight[]): BodyParagraph[];
```

**規則（実装の契約）**

- 段落分割は `@shuten/shared` の `splitParagraphs` をそのまま使う。段落 ID・順序はその出力のまま。
- 各段落の**内容範囲**は、段落範囲の末尾から改行列（`\r\n` / `\n` / `\r`）を 1 つ分だけ落としたもの。
- 内容範囲が空の段落（空行）は `segments: []` を返す。
- 強調は内容範囲との共通部分に切り詰める。共通部分が空になる強調はその段落では無視する。
- `end <= start` の強調は全体として無視する。
- 切れ目は「内容範囲の両端 ∪ 切り詰めた強調の開始・終了」の昇順・重複なし。隣接する 2 点で
  セグメントを作り、`findingIds` は**そのセグメントを完全に覆う**強調の ID を `highlights` の
  順序のまま並べたもの。
- セグメントは内容範囲を隙間なく覆い、`text` は `body.slice(start, end)` と等しい。
- **書記素境界の計算をしない。** `Intl.Segmenter` も `grapheme-index.ts` も import しない。

**手順**

1. `body-view.test.ts` に次のテストを書く（R1）。

```ts
import { describe, expect, it } from "vitest";
import { buildBodyView } from "./body-view.ts";

describe("buildBodyView", () => {
  it("R1-1: 強調が無ければ段落ごとに 1 セグメント。改行文字は含まない", () => {
    // "あい\r\nうえ\n" → 段落 0 は [0,4)、段落 1 は [4,7)。内容範囲は [0,2) と [4,6)。
    expect(buildBodyView("あい\r\nうえ\n", [])).toEqual([
      { id: 0, segments: [{ start: 0, end: 2, text: "あい", findingIds: [] }] },
      { id: 1, segments: [{ start: 4, end: 6, text: "うえ", findingIds: [] }] },
    ]);
  });

  it("R1-2: 空行は segments が空", () => {
    expect(buildBodyView("あ\n\nい", [])).toEqual([
      { id: 0, segments: [{ start: 0, end: 1, text: "あ", findingIds: [] }] },
      { id: 1, segments: [] },
      { id: 2, segments: [{ start: 3, end: 4, text: "い", findingIds: [] }] },
    ]);
  });

  it("R1-3: 末尾の改行ぶんの空ブロックは足さない（決定 5）", () => {
    // LF・CRLF・CR・連続、いずれも「段落数 = splitParagraphs の段落数」。
    expect(buildBodyView("あ\nい\n", []).length).toBe(2);
    expect(buildBodyView("あ\r\nい\r\n", []).length).toBe(2);
    expect(buildBodyView("あ\rい\r", []).length).toBe(2);
    expect(buildBodyView("あ\nい", []).length).toBe(2);
    // 連続する末尾改行：2 つ目は空段落として残る。
    expect(buildBodyView("あ\n\n", [])).toEqual([
      { id: 0, segments: [{ start: 0, end: 1, text: "あ", findingIds: [] }] },
      { id: 1, segments: [] },
    ]);
  });

  it("R1-4: 段落内の強調を 3 つのセグメントに切る", () => {
    const view = buildBodyView("あいうえお", [{ id: "f1", range: { start: 1, end: 3 } }]);
    expect(view[0]?.segments).toEqual([
      { start: 0, end: 1, text: "あ", findingIds: [] },
      { start: 1, end: 3, text: "いう", findingIds: ["f1"] },
      { start: 3, end: 5, text: "えお", findingIds: [] },
    ]);
  });

  it("R1-5: 同一範囲・重なり・入れ子の findingIds", () => {
    const body = "あいうえお";
    const same = buildBodyView(body, [
      { id: "f1", range: { start: 1, end: 3 } },
      { id: "f2", range: { start: 1, end: 3 } },
    ]);
    expect(same[0]?.segments[1]).toEqual({ start: 1, end: 3, text: "いう", findingIds: ["f1", "f2"] });

    const overlap = buildBodyView(body, [
      { id: "f1", range: { start: 0, end: 3 } },
      { id: "f2", range: { start: 2, end: 5 } },
    ]);
    expect(overlap[0]?.segments).toEqual([
      { start: 0, end: 2, text: "あい", findingIds: ["f1"] },
      { start: 2, end: 3, text: "う", findingIds: ["f1", "f2"] },
      { start: 3, end: 5, text: "えお", findingIds: ["f2"] },
    ]);

    const nested = buildBodyView(body, [
      { id: "outer", range: { start: 0, end: 5 } },
      { id: "inner", range: { start: 2, end: 3 } },
    ]);
    expect(nested[0]?.segments.map((s) => s.findingIds)).toEqual([
      ["outer"],
      ["outer", "inner"],
      ["outer"],
    ]);
  });

  it("R1-6: 段落を跨ぐ強調は段落ごとに切り詰められ、改行には掛からない", () => {
    // "あい\nうえ" → 段落 0 の内容 [0,2)、段落 1 の内容 [3,5)。強調 [1,4) は両段落に掛かる。
    const view = buildBodyView("あい\nうえ", [{ id: "f1", range: { start: 1, end: 4 } }]);
    expect(view[0]?.segments).toEqual([
      { start: 0, end: 1, text: "あ", findingIds: [] },
      { start: 1, end: 2, text: "い", findingIds: ["f1"] },
    ]);
    expect(view[1]?.segments).toEqual([
      { start: 3, end: 4, text: "う", findingIds: ["f1"] },
      { start: 4, end: 5, text: "え", findingIds: [] },
    ]);
  });

  it("R1-7: 空の範囲と段落外の範囲は無視する", () => {
    expect(buildBodyView("あい", [{ id: "f1", range: { start: 1, end: 1 } }])[0]?.segments).toEqual([
      { start: 0, end: 2, text: "あい", findingIds: [] },
    ]);
    // 改行だけに掛かる強調（"あ\nい" の [1,2)）は、どの段落の内容範囲とも重ならない。
    const view = buildBodyView("あ\nい", [{ id: "f1", range: { start: 1, end: 2 } }]);
    expect(view.flatMap((p) => p.segments).every((s) => s.findingIds.length === 0)).toBe(true);
  });

  it("R1-8: 書記素境界に揃った範囲を切っても壊れない（単独サロゲートが無い）", () => {
    // 濁点付き（結合文字）、サロゲートペア、異体字セレクタ、ZWJ の家族、異体字付き絵文字。
    // エディタの正規化で崩れないよう、すべて明示のエスケープで書く（決定 15）。
    // 長さは 2 + 2 + 3 + 8 + 2 = 17 コード単位。
    const body =
      "\u304B\u3099" + // が（か + 結合濁点）
      "\u{29E3D}" + // サロゲートペア 1 つ
      "\u845B\u{E0100}" + // 葛 + 異体字セレクタ
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}" + // ZWJ の家族
      "\u2764\uFE0F"; // 異体字付きの絵文字
    const highlights = [
      { id: "f1", range: { start: 0, end: 2 } }, // か + 濁点
      { id: "f2", range: { start: 2, end: 4 } }, // サロゲートペア 1 つ
      { id: "f3", range: { start: 4, end: 7 } }, // 葛 + 異体字セレクタ
    ];
    const segments = buildBodyView(body, highlights).flatMap((p) => p.segments);
    // 連結すると元の本文に戻る。
    expect(segments.map((s) => s.text).join("")).toBe(body);
    // どのセグメントにも単独サロゲートが無い（申し送り 2）。
    for (const segment of segments) {
      for (let i = 0; i < segment.text.length; i += 1) {
        const code = segment.text.charCodeAt(i);
        const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
        const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
        if (isHighSurrogate) {
          const next = segment.text.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
          i += 1;
        } else {
          expect(isLowSurrogate).toBe(false);
        }
      }
    }
  });

  it("R1-9: セグメントの連結は本文から改行を除いたものに一致する", () => {
    const body = "あい\r\n\nうえお\r";
    const segments = buildBodyView(body, [{ id: "f1", range: { start: 5, end: 7 } }]).flatMap(
      (p) => p.segments,
    );
    expect(segments.map((s) => s.text).join("")).toBe("あいうえお");
    for (const segment of segments) {
      expect(segment.text).toBe(body.slice(segment.start, segment.end));
    }
  });
});
```

2. `pnpm --filter @shuten/web test` で落ちるのを見る（モジュールが無い）。
3. `body-view.ts` を実装する。段落ごとに `highlights` を走査する素朴な実装でよい（申し送り 6）。
4. テストを通す。
5. コミット。

**完了条件**：R1-1〜R1-9 が緑。`body-view.ts` が `Intl.Segmenter` も `grapheme-index.ts` も
import していない（`grep` で確認する）。

### Task 2：API クライアントに結果閲覧の 4 メソッドを足す（決定 3）

**Files**
- Modify: `packages/web/src/api/client.ts`
- Modify: `packages/web/src/api/client.test.ts`

**Interfaces（後続タスクが使う）**

```ts
// ApiClient に足す（既存のメソッドは変えない）
getRuns(options?: { signal?: AbortSignal }): Promise<RunSummaryDto[]>;
getFindings(runId: string, options?: { signal?: AbortSignal }): Promise<FindingDto[]>;
getFinding(findingId: string, options?: { signal?: AbortSignal }): Promise<FindingDetailDto>;
putJudgment(findingId: string, body: PutJudgmentRequest): Promise<JudgmentDto>;
```

**規則**

- URL は `/api/runs`、`/api/runs/${encodeURIComponent(runId)}/findings`、
  `/api/findings/${encodeURIComponent(findingId)}`、
  `/api/findings/${encodeURIComponent(findingId)}/judgment`。
- 配列の応答は `z.array(findingDtoSchema)` / `z.array(runSummaryDtoSchema)` で検証する
  （スキーマは `@shuten/shared` から取り、web で定義し直さない。配列の包みだけこの場で作る）。
- `putJudgment` は `PUT`、`JSON_HEADERS`、本文は `JSON.stringify(body)`。
- 既存の `request` / `withSignal` をそのまま使う。例外の写像は変えない。

**手順**

1. `client.test.ts` に R9 を足す。fake `fetch` で、4 メソッドそれぞれについて
   (a) 送った URL・メソッド・本文、(b) 正しい応答を返したときの戻り値、
   (c) 形のおかしい応答（`findings` の要素から `id` を落とす）で `ApiResponseError` になること、
   (d) `putJudgment` の `note` を省略したときに本文が `{"status":"held"}` になること、を検査する。
2. 落ちるのを見る。
3. `client.ts` に 4 メソッドを実装する。
4. 通す。ヘッダーの JSDoc の「一覧・停止・再開・再試行・指摘・採否・復旧確認・SSE は PR12 が担当」を
   実態に合わせて書き換える（本 PR で足したもの／PR12b に残るものを分けて書く）。
5. コミット。

**完了条件**：R9 が緑。`pnpm check`。

### Task 3：ラベルを `features/results/labels.ts` へ移して拡張する（決定 11）

**Files**
- Create: `packages/web/src/features/results/labels.ts`
- Create: `packages/web/src/features/results/labels.test.ts`
- Delete: `packages/web/src/features/run-receipt/labels.ts`、`labels.test.ts`
- Modify: `packages/web/src/features/run-receipt/run-receipt-page.tsx`（import 元だけ変える）

**Interfaces（後続タスクが使う）**

```ts
export const RUN_STATUS_LABELS: Record<RunStatus, string>;
export const RUN_STOP_REASON_LABELS: Record<RunStopReason, string>;
export const FINDING_CATEGORY_LABELS: Record<FindingCategory, string>;
export const INITIAL_VERDICT_LABELS: Record<InitialVerdict, string>;
export const RECHECK_VERDICT_LABELS: Record<RecheckVerdict, string>;
export const RECHECK_REASON_KIND_LABELS: Record<RecheckReasonKind, string>;
export const JUDGMENT_STATUS_LABELS: Record<JudgmentStatus, string>;
export const FINDING_LOCATE_STATUS_LABELS: Record<FindingLocateStatus, string>;
export const RECHECK_NOT_APPLICABLE_REASON_LABELS: Record<RecheckNotApplicableReason, string>;
export const UNIT_STATUS_LABELS: Record<UnitStatus, string>;
export const FAILURE_REASON_LABELS: Record<FailureReason, string>;
```

**規則**

- `Record<列挙, string>` の網羅性を型で担保する（キーを足し忘れたら型検査で落ちる）。
- `JUDGMENT_STATUS_LABELS` は仕様 5.3 の語をそのまま使う：
  `undecided` →「未判断」、`adopt-planned` →「採用予定」、`rejected` →「却下」、`held` →「保留」。
- `INITIAL_VERDICT_LABELS`：`likely-error` →「誤りの可能性が高い」、
  `confirm-with-author` →「作者への確認事項」。
- `RECHECK_VERDICT_LABELS`：`keep` →「維持」、`withdraw` →「撤回」、
  `confirm-with-author` →「作者への確認事項」。
- `RECHECK_NOT_APPLICABLE_REASON_LABELS`：`disabled` →「再確認なし（無効）」、
  `suppressed` →「再確認なし（許容語で抑制）」、`unlocated` →「再確認なし（位置未確定）」。
- `FINDING_LOCATE_STATUS_LABELS`：`located` →「位置確定」、`not-found` →「本文に見つからない」、
  `ambiguous` →「候補が複数あり特定できない」。
- 接続先 URL・API キーに関わる語はここに置かない。

**手順**

1. `labels.test.ts` を書く。各 `Record` のキー数が対応する定数配列の長さと一致すること
   （例：`expect(Object.keys(JUDGMENT_STATUS_LABELS)).toEqual([...JUDGMENT_STATUSES])`）、
   値が空文字でないこと。`run-receipt/labels.test.ts` の既存の検査もここへ移す。
2. 落ちるのを見る。
3. `labels.ts` を実装し、`run-receipt/labels.ts` と `labels.test.ts` を削除、
   `run-receipt-page.tsx` の import 元を `../results/labels.ts` に変える。
4. `pnpm check`。
5. コミット。

**完了条件**：`pnpm check` が緑。`packages/web` に `labels.ts` が 1 つだけある。

### Task 4：本文の描画（決定 6、申し送り 3・4）

**Files**
- Create: `packages/web/src/features/results/body-view.tsx`
- Create: `packages/web/src/features/results/body-view.test.tsx`
- Create: `packages/web/src/features/results/results.module.css`

**Interfaces（後続タスクが使う）**

```ts
export interface BodyViewProps {
  readonly paragraphs: readonly BodyParagraph[];
  /** 選択中の指摘 ID。無ければ null。 */
  readonly selectedFindingId: string | null;
  /** 強調をクリックしたとき。複数の指摘が重なる場合は先頭の ID が渡る（決定 8）。 */
  readonly onSelectFinding: (findingId: string) => void;
}
export function BodyView(props: BodyViewProps);

/** 段落コンポーネントの props。 */
export interface BodyParagraphProps {
  readonly paragraph: BodyParagraph;
  readonly selectedIdHere: string | null;
  readonly onSelectFinding: (findingId: string) => void;
}

/** `React.memo` に渡す比較関数。3 つの props をすべて参照等価で比べる。 */
export function paragraphPropsEqual(a: BodyParagraphProps, b: BodyParagraphProps): boolean;
```

**規則**

- 容器は `white-space: pre-wrap`。段落は `<p data-paragraph-id={id}>`。
  **改行文字を DOM に入れない。** 空段落は CSS の `min-height` でつぶさない。
- 強調は `<span data-findings="id1 id2" class={…}>`。素のセグメントはテキストノード
  （`<span>` で包まない）。
- 選択の塗り分けは props 経由（決定 6）。段落コンポーネントは `React.memo` で包み、
  props は `{ paragraph, selectedIdHere, onSelectFinding }`。`selectedIdHere` は
  「その段落に `selectedFindingId` を含むセグメントがあれば `selectedFindingId`、無ければ `null`」。
- `React.memo` には**明示の比較関数 `paragraphPropsEqual` を渡す**。これを export して単体テストで
  検査する（描画回数を数えるモックも DOM ノードの同一性も使わない）。
- 比較が効くように、呼び出し側は `paragraphs` を `useMemo`（`body` と `highlights` に依存）、
  `onSelectFinding` を `useCallback` で作り、参照を安定させる。安定していなければ `React.memo` は
  何も抑止しない。
- `dangerouslySetInnerHTML` を使わない。
- クリックのハンドラーは `<span>` に付ける（容器の委譲にしない。テストで要素を特定しやすい）。

**手順**

1. `body-view.test.tsx` に R2 を書く。`paragraphPropsEqual` の検査は
   「3 つとも同じ参照 → `true`」「`selectedIdHere` が `null` から `"f1"` に変わる → `false`」
   「`paragraph` が別インスタンス（内容が同じでも） → `false`」
   「`onSelectFinding` が別関数 → `false`」の 4 件。
   - 段落数が `paragraphs` の長さと一致し、`<p>` の `textContent` に `\n` も `\r` も含まれないこと。
   - `data-findings` の値が空白区切りの ID 列になっていること。
   - `[data-findings~="f1"]` で引けること（jsdom で `~=` が動くのは確認済み。申し送り 3）。
   - 強調をクリックすると `onSelectFinding` が先頭の ID で呼ばれること。
   - 選択中の指摘を含む `<span>` にだけ選択用の class が付き、選択を移すと前の `<span>` の class が
     戻ること（`className` の比較）。
   - 再描画の抑止は**比較関数 `paragraphPropsEqual` の単体テスト**で検査する（下記）。
     DOM ノードの同一性では検査しない——子が再描画されても同じ DOM ノードが再利用されるため、
     常に緑になって何も守らない。
   - 空段落が `<p>` として残ること。
2. 落ちるのを見る。
3. `body-view.tsx` と `results.module.css` を実装する。
4. 通す。
5. コミット。

**完了条件**：R2 が緑。`pnpm check`。

### Task 5：結果画面の骨組みとルートの差し替え（決定 1・2・3）

**Files**
- Create: `packages/web/src/features/results/results-page.tsx`
- Create: `packages/web/src/features/results/run-header.tsx`
- Create: `packages/web/src/features/results/results-page.test.tsx`
- Modify: `packages/web/src/App.tsx`（`ROUTES.run` の要素を `ResultsPage` に）
- Modify: `packages/web/src/App.test.tsx`（受付表示 → 結果画面）
- Delete: `packages/web/src/features/run-receipt/`（`run-receipt-page.tsx`、
  `run-receipt-page.test.tsx`、`run-receipt.module.css`）

**Interfaces（後続タスクが使う）**

```ts
// results-page.tsx が内部に持つ読み込み状態。
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

export interface RunHeaderProps {
  readonly run: RunDto;
  readonly manuscriptName: string;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}
export function RunHeader(props: RunHeaderProps);
```

**規則**

- 取得は決定 3 のとおり：`getRun` と `getFindings` を並行、`getManuscript` は `getRun` の後。
  3 つそろうまで本文も一覧も描かない。世代番号で古い応答を捨てる。
- 404（`ApiRequestError` の `status === 404`）は「その実行はありません」＋ホームへのリンク。
- `status === "stopped" && stopReason === "settings"` は「検査は開始できませんでした」と
  検査設定へ戻るリンクだけを出し、本文・一覧を描かない（PR11 決定 16 の踏襲）。
- 指摘 0 件の文言は決定 2 の表のとおり。`completed` 以外では「指摘はありません」と書かない。
- 本タスクでは一覧・詳細・採否・絞り込みは**まだ作らない**。右側は指摘の件数と
  「一覧は Task 6 で足す」ではなく、`findings.length` 件という事実だけを出す仮の表示にし、
  Task 6 が置き換える。

**手順**

1. `results-page.test.tsx` に R7 を書く。
   - 3 つの取得がそろうまで「読み込み中…」で、本文が描かれないこと。
   - そろったら段落が描かれること（`getManuscript` が返す本文の段落数）。
   - `getRun` が 404 のとき「その実行はありません」。
   - `getFindings` が失敗したときエラー表示になること（本文だけ描いて黙らない）。
   - `settings` 停止のとき本文を描かないこと。
   - `completed` で 0 件 →「指摘はありません」、`stopped` で 0 件 → その文言が**出ない**こと。
   - 「最新の状態を取得」で 3 つとも再取得されること。
2. 落ちるのを見る。
3. `results-page.tsx`・`run-header.tsx` を実装し、`App.tsx` のルートを差し替え、
   `features/run-receipt/` を削除する。`App.test.tsx` の「`/runs/:id` で受付表示画面が描画される」を
   結果画面の見出しに合わせて直す。
4. `pnpm check`。
5. コミット。

**完了条件**：R7 と既存の `App.test.tsx` が緑。`features/run-receipt/` が無い。

### Task 6：指摘一覧と絞り込み（決定 7・8・10）

**Files**
- Create: `packages/web/src/features/results/finding-filter.ts`
- Create: `packages/web/src/features/results/finding-filter.test.ts`
- Create: `packages/web/src/features/results/finding-filter.tsx`（操作子）
- Create: `packages/web/src/features/results/finding-list.tsx`
- Modify: `packages/web/src/features/results/results-page.tsx`（仮表示を一覧に差し替え）
- Modify: `packages/web/src/features/results/results-page.test.tsx`

**Interfaces（後続タスクが使う）**

```ts
export type RecheckState = "none" | "waiting" | "done" | "failed" | "not-applicable";

export interface FindingFilter {
  /** null は「すべて」。空配列は「どれも選んでいない」＝ 0 件。 */
  readonly categories: readonly FindingCategory[] | null;
  readonly judgments: readonly JudgmentStatus[] | null;
  readonly recheckStates: readonly RecheckState[] | null;
  readonly locateStates: readonly ("located" | "unlocated")[] | null;
  readonly showSuppressed: boolean;
  readonly showWithdrawn: boolean;
}

export const DEFAULT_FINDING_FILTER: FindingFilter; // すべて null、showSuppressed/showWithdrawn は false

export function recheckStateOf(finding: FindingDto): RecheckState;
export function matchesFilter(finding: FindingDto, filter: FindingFilter): boolean;
export function visibleFindings(
  findings: readonly FindingDto[],
  filter: FindingFilter,
): FindingDto[];
/** 決定 7：位置が確定した指摘だけを強調に渡す。 */
export function toHighlights(findings: readonly FindingDto[]): Highlight[];
```

**規則**

- `recheckStateOf`：`recheck === null` → `"none"`、`status` が `pending` / `running` → `"waiting"`、
  `done` → `"done"`、`failed` → `"failed"`、`not-applicable` → `"not-applicable"`。
- `matchesFilter` は上の 6 項目の積。`showSuppressed === false` なら `suppression !== null` を除き、
  `showWithdrawn === false` なら `recheck?.verdict === "withdraw"` を除く。
- `toHighlights` は `locateStatus === "located" && range !== null` の両方を見る（決定 7）。
- 一覧の並びはサーバーの順のまま。クライアントで再ソートしない。
- 絞り込みの状態は `results-page.tsx` のローカル状態。URL にも `localStorage` にも保存しない。
- 絞り込みの変更で選択中の指摘が一覧から消えたら、選択を `null` に戻す。
- **一覧の見出しで引用の文字列を切らない。** 引用は全文を DOM に置き、はみ出しは CSS
  （`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`）で省略表示する。
  ブラウザ側で文字列を切ると、結合文字・異体字セレクタ・ZWJ の絵文字を書記素の途中で割りうる。
  `String.prototype.slice` はコード単位、`Array.from(...).slice(...)` はコードポイント単位で、
  どちらも書記素境界ではない。書記素境界を計算する道（`Intl.Segmenter`）は申し送り 1 で閉じている
  ので、**切らない**のが唯一の整合した解である。長い引用も 1 行に収まる。

**手順**

1. `finding-filter.test.ts` に R3 を書く。`recheckStateOf` の 5 通り、既定で抑制候補・撤回候補が
   隠れること、各項目の述語、`toHighlights` が `not-found` / `ambiguous` / `range === null` を
   落とすこと、隠れている指摘が `toHighlights` に渡らないこと（`visibleFindings` → `toHighlights`
   の合成で確認）。
2. 落ちるのを見る。
3. `finding-filter.ts` を実装する。
4. `finding-list.tsx`（行：分類ラベル・引用の見出し・採否・再確認状態・
   位置特定失敗の印）と `finding-filter.tsx`（チェックボックス群と 2 つの切り替え）を実装し、
   `results-page.tsx` の仮表示を置き換える。選択状態（`selectedFindingId`）を
   `results-page.tsx` が持ち、`BodyView` と一覧の両方に渡す。
5. `results-page.test.tsx` に「絞り込みを変えると強調も減ること」「選択中の指摘が消えたら
   選択が外れること」を足す。
6. `pnpm check`。
7. コミット。

**完了条件**：R3 と R7 が緑。**一覧の見出しで引用の文字列を切っていないこと**（下記）。

### Task 7：指摘詳細（決定 3・9・12）

**Files**
- Create: `packages/web/src/features/results/finding-detail.ts`（表示規則の純関数）
- Create: `packages/web/src/features/results/finding-detail.test.ts`
- Create: `packages/web/src/features/results/finding-detail.tsx`
- Modify: `packages/web/src/features/results/results-page.tsx`（詳細の取得と差し込み）
- Modify: `packages/web/src/features/results/results-page.test.tsx`

**Interfaces（後続タスクが使う）**

```ts
export type VerdictDisplay =
  | { readonly kind: "recheck"; readonly verdict: RecheckVerdict }
  | { readonly kind: "initial"; readonly verdict: InitialVerdict }
  | { readonly kind: "initial-unverified"; readonly verdict: InitialVerdict };

export interface RecheckDisplay {
  /** 「再確認済み」「再確認待ち」「再確認失敗」「再確認なし」など。 */
  readonly stateLabel: string;
  /** 表示上の最終判定（決定 12 の表）。 */
  readonly finalVerdict: VerdictDisplay;
  /** 初回判定。`finalVerdict` が recheck のときは履歴として併記する。 */
  readonly initialVerdict: InitialVerdict;
  /** 修正案を「有効な修正案」として出してよいか（決定 12）。 */
  readonly suggestionUsable: boolean;
}
export function describeRecheck(finding: FindingDto): RecheckDisplay;

/** 決定 8 の 2 群を選択中の指摘から作る。自分自身は含めない。 */
export function relatedFindings(
  selected: FindingDto,
  visible: readonly FindingDto[],
): { readonly sameRange: FindingDto[]; readonly overlapping: FindingDto[] };

export interface FindingDetailProps {
  readonly finding: FindingDto;
  readonly detail: FindingDetailDto | null; // 取得中は null
  readonly body: string;
  /** `range` が完全に一致する他の指摘（決定 8）。 */
  readonly sameRange: readonly FindingDto[];
  /** 範囲が重なるが一致しない他の指摘（決定 8）。 */
  readonly overlapping: readonly FindingDto[];
  readonly onSelectFinding: (findingId: string) => void;
  readonly onNavigate: () => void;
}
```

**規則**

- `suggestionUsable` は `recheck?.suggestionValid === false` または
  `recheck?.reasonKind === "suggestion-inappropriate"` のとき `false`。
- 位置確定時の「原文」は `body.slice(range.start, range.end)`。位置特定失敗時は `finding.quote` を
  「LLM の引用（原文との一致未確認）」の見出しで出す。
- **`finding.paragraphId` を表示しない**（決定 9。位置未確定時は LLM の申告値）。
- 抑制候補は「許容語『〜』により抑制」と明示する。
- 元候補（`detail.candidates`）と位置診断（`detail.diagnostics`）は詳細の末尾に畳んで置く。
  `candidates[].locateStatus` の `outside-target` はここにだけ出る。
- 確信度に類する数値を出さない。

**手順**

1. `finding-detail.test.ts` に R4 の純関数部分を書く。決定 12 の表の 5 行を 1 件ずつ、
   `suggestionUsable` の 2 通り、初回判定が必ず残ることを検査する。
2. 落ちるのを見る。
3. `finding-detail.ts` を実装する。
4. `finding-detail.tsx` を実装し、`results-page.tsx` から選択時に `getFinding` を呼んで渡す
   （取得中は `detail: null` で候補・診断の欄だけ「読み込み中」）。世代番号で古い応答を捨てる。
   `sameRange` は選択中の指摘と `range.start` / `range.end` が**完全に一致**する可視の指摘、
   `overlapping` は**重なるが一致しない**可視の指摘（どちらも自分自身を除く）。決定 8 のとおり
   見出しを分け、後者を「同じ箇所」と呼ばない。
5. `finding-detail.test.ts` に「`[0,10)` と `[0,10)` は `sameRange`、`[0,10)` と `[9,20)` は
   `overlapping`、`[0,10)` と `[10,20)`（隣接するだけ）はどちらにも入らない」を足す。
   `results-page.test.tsx` に「選択すると `getFinding` が 1 回呼ばれる」「取得前でも引用と理由が
   出る」「他の指摘のリンクで選択が移る」を足す。
6. `pnpm check`。
7. コミット。

**完了条件**：R4 が緑。詳細パネルに `paragraphId` が出ない（テストで確認する）。

### Task 8：採否と判断メモ（決定 13）

**Files**
- Create: `packages/web/src/features/results/judgment-control.tsx`
- Create: `packages/web/src/features/results/judgment-control.test.tsx`
- Modify: `packages/web/src/features/results/finding-detail.tsx`（採否を差し込む）
- Modify: `packages/web/src/features/results/results-page.tsx`（保存と一覧の更新）

**Interfaces**

```ts
export interface JudgmentControlProps {
  readonly judgment: JudgmentDto;
  /** 保存を試みる。失敗したら reject する（呼び出し側が握りつぶさない）。 */
  readonly onSave: (status: JudgmentStatus, note: string | null) => Promise<void>;
}
export function JudgmentControl(props: JudgmentControlProps);
```

**規則**

- 4 状態はラジオ、メモは `<textarea maxLength={2000}>`。空欄は `null` として送る。
- 保存ボタンを押すまで送らない。保存中はボタンを無効にする。
- 成功したら `results-page.tsx` が応答の `JudgmentDto` でその指摘の `judgment` を差し替える
  （一覧を取り直さない）。失敗したらその場にエラーを出し、入力を保存前の値に戻す。
- 「採用予定を選んでも本文は書き換わりません」を操作子の直下に常時表示する（決定 13）。

**手順**

1. `judgment-control.test.tsx` に R5 を書く。4 状態の選択、メモの入力と `null` 送信、
   保存中の無効化、失敗時に元へ戻ること、注記が常に見えること。
2. 落ちるのを見る。
3. 実装する。`results-page.tsx` は `putJudgment` を呼び、成功時に `findings` の該当要素を差し替える。
4. `pnpm check`。
5. コミット。

**完了条件**：R5 が緑。`putJudgment` の呼び出しが `finding-detail.tsx` ではなく
`results-page.tsx` に閉じている（状態の持ち主が 1 か所）。

### Task 9：指摘から本文への移動（決定 9、申し送り 3）

**Files**
- Create: `packages/web/src/features/results/navigate.ts`
- Create: `packages/web/src/features/results/navigate.test.ts`
- Modify: `packages/web/src/features/results/results-page.tsx`
- Modify: `packages/web/src/features/results/results-page.test.tsx`

**Interfaces**

```ts
export type NavigationTarget =
  | { readonly kind: "finding"; readonly findingId: string }
  | { readonly kind: "paragraph"; readonly paragraphId: number };

/** 指摘の移動先を決める。位置未確定なら検査対象範囲を含む段落（決定 9）。見つからなければ null。 */
export function navigationTargetOf(
  finding: FindingDto,
  targets: readonly RunTargetDto[],
  body: string,
): NavigationTarget | null;

export function findTargetElement(
  container: HTMLElement,
  target: NavigationTarget,
): HTMLElement | null;

/** jsdom には scrollIntoView が無い（申し送り 3）。有るときだけ呼ぶ。 */
export function scrollIntoViewIfPossible(element: Element): void;
```

**規則**

- `navigationTargetOf`：`locateStatus === "located" && range !== null` なら
  `{ kind: "finding", findingId }`。そうでなければ `targets` から `finding.targetId` の要素を探し、
  `splitParagraphs(body)` で `target.target.start` を含む段落の `id` を返す。
  該当が無ければ `null`（移動の操作子を出さない）。
- `findTargetElement`：`finding` は `[data-findings~="<id>"]` の最初の要素、
  `paragraph` は `[data-paragraph-id="<id>"]`。ID は `CSS.escape` を通す。
- `scrollIntoViewIfPossible`：`typeof element.scrollIntoView === "function"` のときだけ呼ぶ。
  `getBoundingClientRect` は使わない。

**手順**

1. `navigate.test.ts` に R6 を書く。位置確定の指摘 → `finding`、`not-found` の指摘 →
   検査対象範囲を含む段落 ID、`targets` に無い `targetId` → `null`、
   `findTargetElement` が jsdom の DOM から正しい要素を引くこと、
   `scrollIntoViewIfPossible` が関数の無い要素で例外を投げないこと。
2. 落ちるのを見る。
3. 実装する。`results-page.tsx` に本文容器の `ref` を持たせ、選択のたびに移動する。
4. `results-page.test.tsx` に「一覧の行をクリックすると、正しい要素に対して `scrollIntoView`
   （テストで代入したスタブ）が呼ばれる」を足す。幾何は検査しない。
5. `pnpm check`。
6. コミット。

**完了条件**：R6 が緑。`getBoundingClientRect` を使っていない。

### Task 10：実行一覧 `/runs`（決定 3、画面ごとの仕様）

**Files**
- Create: `packages/web/src/features/run-list/run-list-page.tsx`
- Create: `packages/web/src/features/run-list/run-list-page.test.tsx`
- Create: `packages/web/src/features/run-list/run-list.module.css`
- Modify: `packages/web/src/app/routes.ts`（`runs: "/runs"` を足す）
- Modify: `packages/web/src/App.tsx`（ルートを足す）
- Modify: `packages/web/src/app/header.tsx`（「検査結果」のリンク）
- Modify: `packages/web/src/app/header.test.tsx`

**規則**

- `GET /api/runs` の結果を `startedAt` 降順に並べる（サーバーの順に依存しない）。
- 行は原稿名・モデル ID・状態ラベル・開始時刻・終了時刻。行全体が `/runs/:id` へのリンク
  （`runPath(id)`）。
- 0 件は「保存された検査実行はありません」＋ホームへのリンク。
- 取得失敗はエラー表示（空一覧として見せない）。

**手順**

1. `run-list-page.test.tsx` に R8 を書く。並び、0 件、リンク先、取得失敗。
   `header.test.tsx` に「検査結果」のリンクが `/runs` を指すことを足す。
2. 落ちるのを見る。
3. 実装する。
4. `pnpm check`。
5. コミット。

**完了条件**：R8 とヘッダーのテストが緑。

### Task 11：`listFindings` の N+1 を計測して決着させる（決定 14）

**Files**
- Create: `packages/server/src/api/findings.perf.test.ts`
- Modify: `docs/plans/2026-09-07-mvp-roadmap.md`（持ち越しの行を計測結果に書き換える）
- Modify: `docs/plans/2026-09-11-pr12a-result-view.md`（決定 14 に実測値を追記する）

**規則**

- 既存のテスト補助（`packages/server/src/api/*.test.ts` が使っている DB とアプリの組み立て）を
  そのまま使い、**サーバーの実装を変えない**。
- 指摘 800 件を投入し、`GET /api/runs/:id/findings` の所要時間を測る。
  `performance.now()` の差で 1 回測り、**1,000 ms 未満**を検査する（CI のばらつきに耐える上限。
  判断のための実測値は作業報告とロードマップに数値で残す）。
- 実測が 100 ms 以下なら据え置き、超えるならサーバー側の後続 PR に回す（決定 14）。
  どちらの場合もロードマップの持ち越しの行を事実で置き換える。

**手順**

1. `findings.perf.test.ts` を書いて走らせ、実測値を得る。
2. 決定 14 に実測値と結論（据え置き／後続 PR）を追記する。
3. ロードマップ 262 行目付近の「`listFindings` の N+1 は PR12a で件数を見て判断する（持ち越しのまま）」を
   結論に書き換える。
4. `pnpm check`。
5. コミット。

**完了条件**：計測値が計画書とロードマップに残り、持ち越しが消える。

### Task 12：漏えい検査とドキュメント（決定 16、完了条件）

**Files**
- Modify: `packages/web/src/leak.test.tsx`
- Modify: `packages/web/src/App.test.tsx`（`/runs` の描画）
- Modify: `docs/plans/2026-09-07-mvp-roadmap.md`（PR12a 節を実施済みにする）
- Modify: `README.md`（現在の状態）
- Modify: `docs/plans/2026-09-11-pr12a-result-view.md`（状態行を「実装済み」にする）

**規則**

- W9-7 を `/runs` と結果画面にも広げる。番兵の接続先 URL（`leak-sentinel.invalid`）と API キーを
  `localStorage` と接続設定に置いた状態で `/runs`・`/runs/:id` を描画し、
  `document.body.textContent` にも `localStorage` のどの値にも出ないことを見る。
- 結果画面は `RunDto`・`ManuscriptVersionDto`・`FindingDto` を描くので、
  原稿名・停止メッセージ・モデル ID を経由した漏えいも同時に見ることになる。
- README は「現在の状態」の PR11c までの記述に PR12a を足す。**実原稿の断片を書かない。**

**手順**

1. `leak.test.tsx` に R10 を足し、落ちることを一度確認する（番兵を意図的に描画して赤くしてから戻す）。
2. 実装・文書を直す。
3. `pnpm check` と `pnpm build` を通す。
4. コミット。

**完了条件**：`pnpm check` と `pnpm build` が緑。ロードマップ・README・本計画書が実態と一致する。

### 実装後（マージ前）

1. CI を Ubuntu・Windows とも緑にする。
2. **ローカルの Windows 実機確認は行わない**（完了条件の節のとおり）。その旨を PR 本文に明記する。
3. マージはユーザーが行う。
