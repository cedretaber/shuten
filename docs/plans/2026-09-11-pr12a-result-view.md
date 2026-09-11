# PR12a 詳細計画：結果閲覧（web）

作成日：2026-09-11
状態：設計（決定まで。タスク分解は決定の確認後に追記する）
仕様：`docs/spec/mvp-spec.md`（v0.9）4（手順 5〜7）、5.3（上部の状態表示を除く）、5.4、
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

### 決定 5：本文末尾の改行の扱い（**ユーザーの確認待ち**）

申し送り 8 のとおり、`splitParagraphs` は末尾の区切りの後に段落を作らないので、素直に作ると
**本文末尾の改行 1 つぶんが表示に現れない**（改行 n 個なら空行 n−1 個になる）。途中の空行は正しく残る。
位置の対応はどちらでも変わらない。

- **案 A（足す）**：本文が改行で終わるとき、末尾に空のブロックを 1 つ足す。原稿の行数と表示の行数が
  一致する。ただし段落 ID を持たないブロックが 1 つできるので、`BodyParagraph.id` を `number | null` に
  するか、末尾ブロックを別のフィールドで返す必要がある（型と描画がその分だけ複雑になる）。
- **案 B（足さない。推奨）**：現状のまま。失われるのは末尾の空行 1 つだけで、校正に必要な情報を
  含まない。型は素直なまま。計画書に明記し、末尾が LF・CRLF・CR の 3 通りと連続する末尾改行の
  検査を置く。

**推奨は案 B。** 確認後に確定し、この節を書き換える。

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
- 詳細パネルの先頭に「同じ箇所の他の指摘（N 件）」を出し、各行のクリックでそちらへ切り替える。
- 循環選択（クリックのたびに次へ移る）はしない。クリックの結果が毎回同じになる方を採る。

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
- 確信度に類する数値は出さない（仕様 5.4）。

### 決定 13：採否の操作には「本文を書き換えない」ことを添える

仕様 5.3「『採用予定』は本文を書き換えないことを操作付近に明示する」。採否の操作子の直下に
固定の注記を置く（採用予定を選んだときだけ出す、にはしない）。判断メモは `note`（2,000 字以下。
`putJudgmentRequestSchema`）で、空欄は `null` として送る。

保存は明示の操作（保存ボタン）で行い、成功するまで一覧の表示を変えない。失敗したらその場に
エラーを出し、元の値に戻す（「保存したつもりで保存されていない」を作らない）。

### 決定 14：`listFindings` の N+1 は本 PR で計測して決着させる

ロードマップの持ち越し「`listFindings` の N+1 は PR12a で件数を見て判断する」。
`GET /api/runs/:id/findings` は指摘 1 件ごとに `findRecheckUnitByFinding` と `findJudgment` を
呼んでいる（`packages/server/src/api/findings.ts`）。better-sqlite3 は同期なので、実測して決める。

- 指摘 800 件（スパイクと同じ規模）を投入した DB に対する `GET /api/runs/:id/findings` の所要時間を
  `packages/server` のテストで測る。
- **100 ms 以下なら据え置き**（テストに計測を残し、ロードマップの持ち越しを「計測して据え置き」に
  書き換える）。**超えるならサーバー側の後続 PR に回す**（本 PR ではサーバーの実装を変えない。
  結果を計画書とロードマップに記録する）。

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
  本文末尾の改行（決定 5 の確定に従う）、絵文字・異体字セレクタ・結合文字・サロゲートペア、
  「どのセグメントにも単独サロゲートが無い」、セグメントの連結が元の本文（改行を除く）に一致すること。
- **R2：本文の描画（`features/results/body-view.test.tsx`）** — 段落数、改行文字が DOM に無いこと、
  `data-findings` の値、強調のクリックで選択が変わること、選択の切り替えで本文全体が
  作り直されないこと（段落コンポーネントの描画回数で見る）。
- **R3：絞り込み（`features/results/finding-filter.test.ts`）** — 既定で抑制候補・撤回候補が隠れること、
  各項目の述語、隠れている指摘が強調に渡らないこと（決定 7）、選択中の指摘が消えたら選択が外れること。
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
- 本文末尾の改行の扱いは決定 5 のとおり（確定後に追記する）。
