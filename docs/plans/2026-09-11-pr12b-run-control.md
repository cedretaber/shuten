# PR12b（web：実行制御と進捗）計画書

> **エージェント向け**：superpowers:subagent-driven-development で 1 タスクずつ実装する。
> 本書の「決定 1〜17」「画面ごとの仕様」「テスト」節が要件の正本で、タスク分解はその割り付けである。

- ロードマップ：`docs/plans/2026-09-07-mvp-roadmap.md`（PR12b の節）
- 仕様：`docs/spec/mvp-spec.md` の 4（手順 4〜5）、5.3（上部）、8.2、9
- 前提 PR：PR12a（`docs/plans/2026-09-11-pr12a-result-view.md`。結果画面の骨組み・`run-header.tsx`）
- 不変条件：`docs/reference/invariants.md`

## 目標

結果画面（`/runs/:id`）に、実行の**進捗**と**制御**を足す。検査を開始した直後から完了まで、
画面を開いたまま状態が追えるようにし、停止・再開・失敗単位の再試行・復旧確認を画面から行えるようにする。
更新の合図は SSE（`GET /api/runs/:id/events`）で受け、表示する値は必ず DB（REST）から取り直す。

## 対象外（MUST NOT）

- **サーバー側の口を足さない。** 使うのは PR10 までに在るものだけ
  （`GET /api/runs/:id`、`/units`、`/findings`、`/events`、`POST /api/runs/:id/stop`・`resume`・
  `retry-failed`、`GET /api/recovery`、`POST /api/recovery/confirm`）。
  `GET /api/runs/:id/findings` の 3N+1 は PR12c の担当で、本 PR では触らない。
- **進捗をイベントの差分から数えない。** SSE は「取り直せ」という合図で、件数・状態の正本は DB である
  （不変条件「SSE は通知手段、正本は DB」）。
- **残り時間・完了予定時刻・進捗率の推定値を出さない**（仕様 9「根拠のない残り時間を示さない」）。
  出してよいのは実測の件数（「12 / 40 件 完了」など）だけである。
- **ブラウザで位置を再計算しない**（PR12a 決定 6 の継続）。`Intl.Segmenter` と `shared` の
  `grapheme-index.ts` を `features/results/` から使わない。
- **`UnitFailureDto.message`、`CheckUnitDto.pendingNote` / `RecheckUnitDto.pendingNote`、
  `UnitFailureDto.finishReason` を画面に描画しない**（決定 12）。`failure.message` は
  `LmStudioError.message` そのままで、**接続先 URL を含みうる**
  （`packages/server/src/api/messages.ts` の冒頭コメント・不変条件）。
- **未処理範囲がある状態を「問題なし」と表示しない**（仕様 8.2）。PR12a 決定 2 をそのまま引き継ぐ：
  「指摘はありません」は `status === "completed"` のときだけ出す。実行中の実行は指摘 0 件から始まるので、
  この規則は本 PR でいっそう効く。
- **停止・再開・再試行の可否をクライアント側の意味論として書き写さない。** 画面が持つのはボタンの
  出し分け（決定 6 の表）だけで、受け付けるかどうかの判定はサーバーが行う。409 が返ったら取り直して従う。
- 実行一覧（`/runs`）に自動更新を足さない（本 PR の範囲は `/runs/:id`）。

## 全体の制約

- TypeScript strict（`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、
  `noUncheckedIndexedAccess`）。相対 import は `.ts` / `.tsx` 拡張子付き。
- Vitest は `globals: true` を使わない（`import { describe, expect, it } from "vitest"`）。
  web は jsdom + @testing-library/react。`JSX.Element` の戻り値注釈は書かない（React 19 の型）。
- React 19 + react-router 8.3.1（宣言的 API のみ）。CSS Modules と `styles/tokens.css`。
- 識別子は英語、コメント・コミットメッセージ・ドキュメントは日本語。
- 公開リポジトリ。個人情報・機器固有の値（IP、ユーザー名を含むパス）・実原稿をコミットしない。
- `git add -A` / `git add .` を使わない（変更したファイルを明示して stage する）。
- 各タスクの完了前に `pnpm check` を通す。

## 作るもの

| ファイル | 役割 |
| --- | --- |
| `packages/web/src/api/events.ts`（新） | `subscribeRunEvents`。SSE の購読と `run-settled` での自己切断 |
| `packages/web/src/api/client.ts`（変更） | `getRunUnits` / `stopRun` / `resumeRun` / `retryFailedUnits` / `getRecovery` / `confirmRecovery` |
| `packages/web/src/features/results/run-progress.ts`（新） | 進捗の集計（純関数）。観点別の件数 |
| `packages/web/src/features/results/run-progress.tsx`（新） | 進捗の描画 |
| `packages/web/src/features/results/run-control.ts`（新） | 操作の出し分けと案内文（純関数） |
| `packages/web/src/features/results/run-control.tsx`（新） | 停止・再開・再試行・復旧確認のボタンと案内 |
| `packages/web/src/features/results/failed-units.tsx`（新） | 失敗単位の一覧と個別再試行 |
| `packages/web/src/features/results/use-run-stream.ts`（新） | 購読と再取得の合流を担う hook |
| `packages/web/src/features/results/run-header.tsx`（変更） | 進捗・操作を上部に組み込む |
| `packages/web/src/features/results/results-page.tsx`（変更） | 自動更新の結線、静かな再取得 |
| `packages/web/src/features/results/labels.ts`（変更） | 失敗の出所・再試行の不可理由などのラベル |
| `packages/web/src/features/results/results-page.module.css`（変更） | 上部のレイアウト、左右の独立スクロール |
| `packages/web/src/leak.test.tsx`（変更） | 単位・失敗・SSE を通した漏えい検査（決定 12） |

---

## 決定

### 決定 1：SSE は `status === "running"` の間だけ張り、`run-settled` で自分から閉じる

`packages/server/src/api/events.ts` は、購読の時点で実行が終端状態なら**合成した `run-settled` を
1 件送って接続を閉じる**。`EventSource` は閉じられた接続を自動で再接続するので、受け取った側が
`close()` を呼ばないと「接続 → `run-settled` → 切断 → 再接続」の無限ループになる
（ブラウザの Network で `/events` の要求が延々と並ぶ形で現れる）。

規則を 2 つ置く。

1. `subscribeRunEvents` は `run-settled` を受け取ったら、**ハンドラーを呼ぶ前に自分で `close()` する**。
   この不変条件はこの関数 1 か所に閉じ込め、単体テストで守る（テスト B2）。
2. 画面側の購読は `run.status === "running"` **かつ** `streamEnded === false` のときだけ張る。
   終端状態の実行では 1 本も張らない。
3. `run-settled` を受けたら `streamEnded` を立てる（＝購読を張り直さない印）。
4. **取り直しが成功したときだけ** `streamEnded` を下ろす：成功した応答の `status` が `running` なら
   `streamEnded = false` にする（`useEffect` の依存が変わり、購読が張り直される）。終端状態なら
   `streamEnded` を立てたままにする。

`useEffect` の依存は `[runId, run.status === "running" && !streamEnded]` である。

**規則 3・4 が無いと自動更新が永久に止まる**（レビュー指摘 1）。`run-settled` を受けて購読を閉じた後、
続けて走る取り直しが失敗すると、画面の `run.status` は `running` のまま・依存も変わらないので
`useEffect` は再実行されず、購読は二度と張られない。しかも画面には「再接続を試みています」と出ており、
表示と実態が食い違う。

**張り直しの合図を「取り直しの成功」に限る理由**：成功した応答は DB の正本なので、そこで `running`
なら購読しても合成 `run-settled` は返らない（サーバーは同じ DB を読む）。取り直しに失敗している間は
実行が終端かどうか分からず、そこで自動的に張り直すと「購読 → 合成 `run-settled` → 張り直し」の
ループが復活する。失敗している間は張らず、「自動更新は停止しています。『最新の状態を取得』を
押してください。」と出して手動の復旧に委ねる（決定 4）。

「`run-settled` 後の再購読」（ロードマップ）はこの規則の帰結として起きる：再開・再試行を受け付けた
後の取り直しが成功して `status` が `running` に戻れば、`streamEnded` が下りて `useEffect` が
もう一度購読する。

購読の解除はアンマウント・ルート離脱・`runId` の変更でも行う（`useEffect` の cleanup）。
`close()` は何度呼んでも安全にする。React の StrictMode による二重マウントでも接続が残らないことを
テストで見る（B3）。

### 決定 2：イベントは合図、表示する値は DB から取り直す

`RunEventDto` の中身を画面の状態に積まない。イベントを受けたら「何を取り直すか」だけを決める。
進捗の件数を `check-finished` の到着数で数えると、再接続で取りこぼした分だけ恒久的にずれる
（サーバーは再送しない。`events.ts` の規則 7）。

| イベント | 取り直すもの |
| --- | --- |
| `target-planned` / `check-started` / `recheck-started` | 軽い取り直し（`getRun` + `getRunUnits`） |
| `check-finished` / `target-merged` / `recheck-finished` / `save-rolled-back` | 重い取り直し（軽い + `getFindings` + 選択中の詳細） |
| `stop-requested` | 軽い取り直し |
| `generation-slow` | 取り直さない（決定 10 の通知だけ） |
| `run-settled` | 重い取り直し（接続は決定 1 で既に閉じている） |
| 接続が開いた（初回・再接続） | 重い取り直し（切断中の取りこぼしを埋める） |
| スキーマ検証に失敗したイベント | 重い取り直し（中身が読めないので、安全側に倒す） |

`save-rolled-back` を重い側に置くのは、保存の巻き戻しで指摘が消えうるためである。

**初回読み込みの直後に `onOpen` で重い取り直しが 1 回重なるのは意図的である。** サーバーは再送しない
（`events.ts` の規則 7）ので、最初の `getRun` と購読の確立の間に起きた出来事は他に埋めようがない。
無駄な 1 回に見えるが、これを削ると「読み込み → 購読」の隙間の取りこぼしが恒久的に残る。

### 決定 3：再取得は合流させる。デバウンスは入れない

`GET /api/runs/:id/findings` は実質 3N+1 で、指摘 800 件のとき中央値 110〜130 ms かかる
（PR12a 決定 14。解消は PR12c）。イベント 1 件ごとに素直に取り直すと要求が積み上がる。

合流の規則：

- 取り直しは同時に 1 本だけ（`inFlightRef`）。
- 走っている最中に来た合図は `dirtyRef`（`"light"` / `"heavy"` の強い方）に畳む。
- 1 本が終わったら `dirtyRef` を**取り出して空にし**、値があればもう 1 本走らせる。
  これを **`dirtyRef` が空になるまで繰り返す**。

「追い 1 本だけ」にしてはならない（レビュー指摘 3）。1 本目の追い取得の最中に届いたイベントが
黙って捨てられ、そのイベントぶんの更新が画面に永久に出ない。実装は「終了時に取り出して空にし、
値があれば再帰的に次を回す」1 本のループにする。

固定時間のデバウンスは入れない。取り直しの所要時間そのものが間隔を決めるので、遅い環境ほど自然に
間隔が空く。測っていない待ち時間を足さない。

**手動の取り直し（「最新の状態を取得」）も同じ門を通す。** 自動の取り直しが走っている最中に押されたら、
`dirtyRef` に `"heavy"` を積み、**追い取得が終わるまで** `refreshing` を立て続ける
（失敗は手動側の `refreshError` に出す。決定 4）。門を通さないと 3N+1 の取得が 2 本同時に走るか、
「更新中…」と出ているのに実際には何も走っていない状態になる。

**初回読み込みでも `/units` を取る**（`getRun` / `getFindings` / `getManuscript` と同じ 1 回目）。
後回しにすると `controlAvailability(run, null)` が最初の描画で「再試行できない」と判断し、
失敗単位の再試行ボタンが一拍遅れて現れる。

**取り直しの反映は 2 段に分ける**（レビュー指摘 2）。初回読み込み（PR12a 決定 3）は 3 本すべてが
揃うまで何も描かないが、**取り直しは違う**。

1. `getRun` + `getRunUnits` が成功したら、**その時点で**状態・進捗・操作の可否に反映する。
2. `getFindings` と選択中の詳細は別に反映し、**失敗しても 1 の反映を戻さない**。

1 本でも失敗したら全部を捨てる作りにすると、3N+1 の `getFindings`（指摘が多いほど失敗しやすい）が
こけただけで、停止・再開の後の新しい状態がボタンにも進捗にも出なくなる。操作の直後は
「押した操作が効いたかどうか」が最も知りたい情報なので、そこを重い取得の道連れにしない。
失敗した側は決定 4 の案内（自動なら 1 行、手動なら `refreshError`）で伝える。

### 決定 4：SSE 由来の取り直しは「静かに」行う

PR12a の `refresh()`（「最新の状態を取得」ボタン）は `refreshing` を立てて文言を「更新中…」に変え、
失敗したら `refreshError` を出す。自動更新で同じことをすると、ボタンが点滅し続け、一時的な切断の
たびにエラーが出る。

- `refreshing`（ボタンの `disabled` と「更新中…」）は**手動の取り直しのときだけ**立てる。
- 自動更新の状態は次の 3 つを 1 行で表す。同時に 2 行出さない（上から優先）。

  | 状態 | 出す文 |
  | --- | --- |
  | `streamEnded` かつ `run.status === "running"`（決定 1 の規則 3・4。取り直しが失敗したままの状態） | 「自動更新は停止しています。「最新の状態を取得」を押してください。」 |
  | SSE が切れている（`onError` を受けてから次の `onOpen` まで） | 「サーバーとの接続が切れました。再接続を試みています。」 |
  | 自動の取り直しが失敗した（`autoRefreshError`） | 「自動更新に失敗しました。再接続を試みています。」 |

- `onError`（`EventSource` の接続断。自動再接続が走る）は `streamDisconnected` を立てるだけで、
  取り直しは行わない（切れている間に取っても意味が無い）。次の `onOpen` で下ろす。
- `autoRefreshError` は自動の取り直しが 1 回でも成功したら消す。連続して失敗しても行は増えない。
- 手動の `refreshError`（PR12a で入れた、内容を消さずに出す帯）はそのまま残す。

### 決定 5：観点別の進捗は `GET /api/runs/:id/units` を数えて作る

仕様 5.3 は「観点別の処理進捗」を求めるが、`RunDetailDto.progress`（`ProgressDto`）は
`checkUnits` / `recheckUnits` の**状態別合計**しか持たない。観点の内訳が無い。

採る案：結果画面で `GET /api/runs/:id/units`（PR10 で作ってあり、web からは未使用）も取り、
`CheckUnitDto.perspective` × `status` をクライアントで数える。数えるだけで、位置の計算ではない。
サーバーを変えないので PR12b は web だけで閉じる。

採らなかった案と理由：

- **合計だけを出し、観点別は仕様の改訂で落とす**：仕様 5.3 の明文を実装の都合で削ることになる。
  未決事項ではなく既に合意済みの機能なので、勝手に狭めない。
- **サーバーの `ProgressDto` に観点別を足す**：口の変更になり、PR12c（同じ `findings` 周りの
  問い合わせを触る PR）と衝突する。PR12b は web だけで閉じる方が安全。

`/units` は `GET /api/runs/:id` と同じ頻度で取り直す（決定 2 の「軽い取り直し」に含める）。
`buildRunUnits`（`packages/server/src/api/run-view.ts`）は一覧の問い合わせ 3 本
（対象・検査単位・再確認単位）だけで、`findings` のような単位ごとの追加問い合わせを出さない
（確認済み）。3N+1 にはなっていない。

表示は `progress`（合計）と `/units`（観点別）の両方を使う。合計は `progress` を正とする
（`/units` を数え直した値と食い違ったら `progress` を出す。どちらもサーバーの同じ DB から来るが、
取得の瞬間がずれうるため、合計の正本を 1 つに決めておく）。

### 決定 6：操作の出し分け

画面が出すボタンの表。**受け付けるかどうかの最終判断はサーバー**（`orchestrator.ts` の
`stopRun` / `resumeRun` / `retryFailedUnits`）で、この表は「押せる見込みがあるものだけ見せる」ための
ものである。表と実際の判定がずれたら 409 が返る（決定 8 が受ける）。

| `status` | `stopReason` | 停止 | 再開 | 失敗単位の再試行 |
| --- | --- | --- | --- | --- |
| `running` | — | ○（`stopRequestedAt === null` のときだけ押せる） | × | × |
| `recovery-waiting` | — | × | ○（決定 7 の「確認して再開」） | × |
| `stopped` | `settings` | × | ×（「新しい検査を開始する」へ案内） | 失敗単位があるときだけ ○ |
| `stopped` | それ以外 | × | ○ | 失敗単位があるときだけ ○ |
| `partially-failed` | — | × | ×（「失敗した単位の再試行」へ案内） | ○ |
| `completed` | — | × | × | × |

根拠（`orchestrator.ts`）：

- `resumeRun` が受け付けるのは `stopped` と `recovery-waiting` だけで、`stopReason === "settings"` は
  拒否する（`rejected(existing, "settings")`）。`partially-failed` も拒否し、再試行へ案内する。
- `retryFailedUnits` が受け付けるのは `partially-failed` と `stopped` だけ（`recovery-waiting` は不可。
  復旧ゲートを開けられるのは `resumeRun` と `confirmRecovery` だけだから）。
- 「失敗単位がある」は `/units` から判定する：`recheckUnits` に `status === "failed"` があるか、
  `checkUnits` に `status === "failed"` かつ `failure?.reason !== "input-too-long"` のものがあるか。
  `input-too-long` を除くのは `collectRetryTargets` が同じ条件で対象から除くためで、
  除かずにボタンを出すと 400 `invalid-retry-target` になる。
- `stopRun` は「走っているループがあるか」（サーバー側のレジストリ）で判定する。DB の `status` は
  正本ではないので、`running` でも 409 `run-not-active` が返りうる（決定 8 が受ける）。

再開のボタンの文言には「同じ検査の続きから再開します（実行 ID は変わりません）」を添える
（仕様 8.2「『再開』と『新規検査の開始』を区別する」）。

### 決定 7：復旧待ちは「確認して再開」を主、「確認だけ記録」を副にする

`recovery-waiting` は、生成の終了を確認できないまま上限時間を過ぎた状態で、
仕様 8.2 は表示文を定めている：**「生成の停止を確認できません。LM Studio側を確認して再開してください」**。
この文をそのまま出す。

操作は 2 つ置く。

- 主：**「LM Studio 側で生成が止まったことを確認した → 再開する」** → `POST /api/runs/:id/resume`。
  `resumeRun` は `recovery-waiting` の claim に成功したときだけ復旧ゲートを開ける（決定 39）ので、
  確認と再開が 1 回の操作で済む。版が変わっている・接続先が違う場合は 409 で拒否されるが、
  そのときも `markRecoveryConfirmed` が走ってゲートは開く（`orchestrator.ts` の拒否 2 経路）。
- 副：**「確認だけ記録する（この検査は再開しない）」** → `POST /api/recovery/confirm`。
  この実行を続けずに、別の新しい検査を始めたいときの経路。`confirmRecovery` は実行の `status` を
  変えずにゲートだけ開ける。

副のボタンを押した後、実行は `recovery-waiting` のまま `recoveryConfirmedAt !== null` になる
（`confirmRecovery` は `status` を変えない）。この状態では「復旧の確認を記録済みです。」と出し、
**副のボタンを隠す**（主の「確認して再開」は残す）。

どちらのボタンにも「時間が経ったことは終了の証拠になりません。LM Studio 側で生成が止まったことを
確かめてから押してください。」を添える（仕様 8.2「時間経過を終了の証拠とみなさない」）。

`stopReason === "recovery-blocked"` の実行（別の実行の復旧待ちに巻き込まれて止まったもの）は、
`GET /api/recovery` を取り、`runIds` に載っている実行へのリンク（`runPath`）を出す。
文言は「別の検査の復旧待ちのため停止しています。先にそちらを確認してください。」とする。
`runIds` が空、または取得に失敗したときはリンクを出さず文言だけを出す（`/api/recovery` の失敗で
画面全体を落とさない）。

### 決定 8：409 とその他の失敗は「取り直して従う」

操作の要求が失敗したら、**必ず `GET /api/runs/:id` を取り直してから**表示を決める。
画面の状態を要求の応答で継ぎ当てしない（202 の本文は `RunDto` で、`RunDetailDto` ではない。
進捗も対象も入っていない）。

| `code` | 出す文 |
| --- | --- |
| `run-not-active` | 「この検査はすでに動いていません。最新の状態を取得しました。」 |
| `run-rejected-running` | 「すでに実行中です。最新の状態を取得しました。」 |
| `run-rejected-settings` | 「設定エラーで停止した検査は再開できません。設定を見直して新しい検査を開始してください。」＋ `/` へのリンク |
| `run-rejected-stale-version` | 「アプリの更新で版が変わったため、この検査は再開・再試行できません。新しい検査を開始してください。」＋ `/` へのリンク |
| `run-rejected-connection` | 「接続先が検査開始時と異なるため再開・再試行できません。接続設定を戻すか、新しい検査を開始してください。」＋ `/settings` と `/` へのリンク |
| `run-rejected-status` | 「現在の状態からは受け付けられません。最新の状態を取得しました。」 |
| `invalid-retry-target` | 「再試行できる失敗単位がありません。」 |
| それ以外・通信の失敗 | 「操作を受け付けられませんでした。時間をおいて試してください。」 |

サーバーの `error.message` は**転記しない**。表の定型文だけを出す（`REJECT_MESSAGES` の文面には
実行 ID が入っており、また文面はサーバー側の都合で変わりうる）。案内は `code` から引く。
未知の `code` は「それ以外」に落ちる（`Record` の網羅ではなく既定値つきの索引にする。
サーバー側が `code` を増やしても画面が落ちないようにするため）。

`pending !== null`（いずれかの操作を送信中）の間は、**実行制御のボタンをすべて** `disabled` にする
（レビュー指摘 4）。当該ボタンだけを無効にすると、`recovery-waiting` で同時に出ている
「確認して再開」と「確認だけ記録」を並行して送れてしまう。サーバー側は壊れないが、
2 つの応答と 2 つの案内文が競合して、画面がどちらの結果を表しているのか分からなくなる。
202 を受けたら必ず取り直す。

### 決定 9：中間状態は `RunDto` の項目から出す

仕様 8.2 が表示を求めている状態は、すべて `RunDto` に現れている。

| 条件 | 出す文 |
| --- | --- |
| `status === "running" && stopRequestedAt !== null` | 「停止を要求しました。実行中の要求の終了を待っています。」（停止ボタンは `disabled`） |
| `generationUnconfirmed === true` | 「LM Studio 側の生成が終了したか確認できていません。」 |
| `status === "recovery-waiting"` | 決定 7 の仕様文（そのまま） |
| `status === "partially-failed"` | 「一部の検査が失敗しました。未処理の範囲があります。」 |
| `status === "stopped"` | 「停止中です。未処理の範囲が残っている可能性があります。」 |

`completed` のときだけ、未処理が無いことを前提にした表示（「指摘はありません」を含む）を許す。

### 決定 10：`generation-slow` は消える通知として出す

仕様 8.2 は「タイムアウトは打ち切りの上限ではなく、遅延の通知の閾値」と定める。
`generation-slow` を受けたら `unitId` を集合に足し、「生成が遅延しています（n 件）。応答を待っています。」
を出す。**打ち切りではないので、操作を促す文言にしない。**

消える条件：`/units` を取り直すたびに、集合の `unitId` のうち対応する単位が `status !== "running"` に
なったものを落とす。`run-settled` の後は集合を空にする。`check-finished` の DTO は `targetIndex` と
`perspective` しか持たず `unitId` を持たないので、イベントだけでは対応が取れない。`/units` の
`id` と突き合わせる（決定 5 で取っているので追加の要求は要らない）。
`generation-slow` の `unitId` は**検査単位と再確認単位のどちらでもありうる**ので、
突き合わせは `checkUnits` と `recheckUnits` の両方を見る。

### 決定 11：進捗の表し方

- 検査：状態別の件数（`progress.checkUnits`）から「完了 n / 全 m 件」を出す。
  `m` は 5 状態の合計。`not-applicable` は分母に含め、内訳として別に出す。
- 再確認：`progress.recheckUnits` から同じ形で出す。`recheckEnabled === false` なら
  「再確認なし」とだけ出す。
- 観点別：`/units` の `checkUnits` を `perspective` で分け、状態別の件数を出す（決定 5）。
- **割合・残り時間・予定時刻を出さない。** `<progress>` 要素も使わない（割合の表示になるため）。
- 数値は「n / m 件」の形で、`m === 0` のときは「準備中」と出す（0 / 0 を「完了」に見せない）。

### 決定 12：単位の情報から描画してよいものを限定する

`UnitFailureDto.message` は `LmStudioError.message` そのままで、**接続先 URL を含みうる**
（`api/messages.ts` の冒頭コメント、`executor.ts` の `toFailure`）。`pendingNote` は定型文だが、
出所が実行時の文字列であることに変わりはない。`finishReason` は LLM API の生の値である。

描画してよいのは次だけとする。

- `status`（`UNIT_STATUS_LABELS`）
- `perspective`（観点名）と `targetIndex`（「範囲 3」のような並び番号）
- `failure.reason`（`FAILURE_REASON_LABELS`）
- `failure.origin`（新しいラベル。`ensure-loaded` →「モデルの準備」、`chat` →「生成」、`local` →「アプリ内」）
- `attempts`、`elapsedMs`、時刻（`formatDateTime`）

`message` / `pendingNote` / `finishReason` は**受け取っても描画しない**。
漏えい検査（`leak.test.tsx`）を拡張し、`/units` の応答に番兵（接続先 URL・API キー・原稿の断片）を
入れた状態で結果画面を描画し、`document.body.textContent` に出ないことを見る（テスト B11）。

### 決定 13：一覧の途中挿入は許す。並べ替えの状態を持たない

`listFindings` は `start` 昇順（未確定を末尾）で返すので、実行中に届いた指摘は一覧の**途中**に入る。
利用者が読んでいる最中に行がずれることになるが、仕様 4 の手順 5「完了した範囲から結果を確認する」は
この形を前提にしている。並べ替えの選択肢や「新着だけ後ろに積む」表示は入れない（MVP の範囲を広げない）。

選択中の指摘は id で維持する（PR12a の `[visible, selectedFindingId]` の effect がそのまま働く）。
スクロール位置はこちらから動かさない（指摘を選んだときの移動だけが `scrollIntoView` を呼ぶ）。

### 決定 14：開始 → 進捗の流れは既にあるものに乗せる

`/`（`home-page.tsx`）は開始が成功すると `/runs/:id` へ遷移する（PR11）。本 PR は遷移先の画面に
進捗と操作が出るようにするだけで、開始の経路には手を入れない。新規開始が常に新しい実行 ID を作る
ことも既存のまま（仕様 8.2）。

`status === "stopped" && stopReason === "settings"` のときに通常の状態表示を出さない PR11 決定 16 の
振る舞い（`isSettingsStop`）はそのまま残す。この場合は進捗も操作も出さず、「検査は開始できませんでした」
と停止メッセージ、設定へ戻るリンクだけを出す。ただし失敗単位の再試行だけは、決定 6 の表のとおり
失敗単位があるときに限り出す（実行の途中で `input-too-long` により `settings` 停止し、
それとは無関係な `failed` が残っている形が実在する。`orchestrator.ts` の `retryFailedUnits` のコメント）。

### 決定 15：左右の独立スクロールを、この PR の CSS 作業で入れる

PR12a の持ち越し。本文（左）と一覧・詳細（右）が一緒にスクロールするため、長い原稿で指摘へ移動すると
一覧が画面外に出る。`results-page.module.css` の 2 カラムに `height` と `overflow-y: auto` を与えて
左右を独立させる。

jsdom はレイアウトを計算しない（`getBoundingClientRect()` は常に 0）ので、**この変更はテストで検証できない**。
実ブラウザで確認する（テスト S1）。確認しないまま CSS だけ足すのは PR12a で見送った判断と同じなので、
本 PR では確認までを 1 つのタスクにする。

### 決定 16：`subscribeRunEvents` の形

```ts
/** SSE の購読。戻り値を呼ぶと切断する（何度呼んでもよい）。 */
export function subscribeRunEvents(
  runId: string,
  handlers: RunEventHandlers,
  deps?: { EventSource?: EventSourceConstructor },
): () => void;

export interface RunEventHandlers {
  /** 接続が開いた（初回・再接続とも）。決定 2：重い取り直しの合図。 */
  onOpen(): void;
  /** 検証を通ったイベント。`run-settled` はこの呼び出しの**前に**接続を閉じてある。 */
  onEvent(event: RunEventDto): void;
  /** 検証を通らないイベントが届いた。決定 2：安全側に倒して重い取り直しをする。 */
  onUnknownEvent(): void;
  /** 接続が切れた（`EventSource` は自動で再接続を試みる）。 */
  onError(): void;
}
```

- **jsdom に `EventSource` は無い**（確認済み：`typeof EventSource === "undefined"`）。
  `createApiClient({ fetch })` と同じく構築子を注入できるようにし、テストは fake を渡す。
  省略時は `globalThis.EventSource` を使う。
- サーバーは名前付きイベント（`event: <type>`）で送る（`stream.writeSSE({ event: dto.type, ... })`）ので、
  `onmessage` では受け取れない。型ごとに `addEventListener` する。型の一覧は
  `as const satisfies Record<RunEventDto["type"], true>` のオブジェクトから引き、
  `shared` 側でイベントが増えたら型検査で落ちるようにする。
- `data` は `JSON.parse` → `runEventDtoSchema.safeParse` で検証する。失敗したら `onUnknownEvent()`。
  **中身はログにも画面にも出さない**（原稿の断片・接続先が混ざりうる）。
- `run-settled` を受けたら、`onEvent` を呼ぶ前に `close()` する（決定 1）。
- `: ping` は `EventSource` がコメントとして無視する（何もしなくてよい）。
- **注入点は `ApiClient` に一本化する。** `ResultsPage` は `<Route>` が props 無しで描くので、
  画面のテストから直接 `deps` を渡せない。`createApiClient({ fetch, EventSource })` に構築子を受け、
  `ApiClient` に `subscribeRunEvents(runId, handlers): () => void` を足す。
  `App({ client })` が唯一の注入点である状態を崩さない（PR11 決定 14）。`subscribeRunEvents`
  そのものは `api/events.ts` の独立した関数として持ち、`client.ts` はそれを包むだけにする。

### 決定 17：文言とラベルの置き場所

日本語の文言は `features/results/labels.ts`（列挙のラベル）と、それぞれのコンポーネントの近くに置く。
決定 8 の `code` → 案内の索引は `run-control.ts` に置き、純関数として単体テストする。
接続先 URL・API キーに関わる語はどこにも書かない。

---

## 画面ごとの仕様

### `/runs/:id` 上部（`run-header.tsx`）

上から順に：

1. 原稿名（`<h1>`）
2. 状態（`RUN_STATUS_LABELS`）・停止理由・停止メッセージ・モデル ID・開始/終了時刻（PR12a のまま）
3. 中間状態の案内（決定 9）
4. 遅延の通知（決定 10）
5. 進捗（決定 11）：検査・再確認の「完了 n / 全 m 件」と観点別の内訳
6. 操作（決定 6・7）：停止／再開／失敗単位の再試行／復旧の確認
7. 操作の結果の案内（決定 8）
8. 「最新の状態を取得」（PR12a のまま）と、自動更新の失敗の 1 行（決定 4）

`isSettingsStop(run)` が真のときは 3〜5 を出さない（決定 14）。

### 失敗単位の一覧（`failed-units.tsx`）

`status` が `partially-failed` か `stopped` のときだけ出す。`/units` の `failed` を並べ、
1 件ごとに「範囲 n・観点・失敗理由・出所・試行回数」と「この単位を再試行」ボタンを置く
（`POST /api/runs/:id/retry-failed` に `{ unitIds: [id] }`）。
`input-too-long` の検査単位は「入力が長すぎるため再試行できません（分割長を見直して新しい検査を開始してください）」
と出し、ボタンを置かない（決定 6）。
一覧の上に「すべて再試行」（本文なしの `POST`）を置く。
再確認単位は `findingId` を持つので「指摘 → 再確認」と分かる表示にする（指摘の本文は出さない。
一覧の行から指摘を選べるようにするのは持ち越し）。

---

## テスト

jsdom の制約（PR12a で確認済み）：`getBoundingClientRect()` は常に 0、`scrollIntoView` は無い、
`EventSource` は無い。レイアウトに依存する検証は実ブラウザで行う。

| 番号 | 内容 |
| --- | --- |
| B1 | `subscribeRunEvents` が名前付きイベントを受け取り、`runEventDtoSchema` を通した値を `onEvent` に渡す |
| B2 | `run-settled` を受けたら `onEvent` を呼ぶ**前に** `close()` が呼ばれている（決定 1。fake の `EventSource` が呼び出し順を記録する） |
| B3 | 返り値を呼ぶと `close()` される。二重に呼んでも 1 回しか閉じない。アンマウントで閉じる |
| B4 | 検証を通らない `data` は `onUnknownEvent` になり、`onEvent` は呼ばれない。中身がどこにも出ない |
| B5 | 決定 3 の合流：取り直しの最中に来た 2 件の合図が 1 本に畳まれ、終わった後に追い取得が走る。**その追い取得の最中にもう 1 件送ると 3 本目が走る**（「追い 1 本だけ」の実装なら赤くなる） |
| B6 | 決定 2 の割り付け：軽い合図では `getFindings` を呼ばず、重い合図では呼ぶ |
| B7 | 決定 4：自動更新では「更新中…」にならず、失敗しても内容が消えず 1 行の案内だけが出る。手動の取り直しは従来どおり |
| B8 | 決定 5・11：観点別の件数が `/units` から作られ、割合・残り時間がどこにも出ない |
| B9 | 決定 6：状態ごとにボタンの出し分けが表のとおりになる（`running` / `recovery-waiting` / `stopped`(settings) / `stopped`(その他) / `partially-failed` / `completed` の 6 通り） |
| B10 | 決定 8：409 の `code` ごとに案内が変わり、必ず `getRun` が取り直される。`error.message` が画面に出ない |
| B11 | 決定 12：`/units` の `failure.message` / `pendingNote` / `finishReason` に番兵を入れても画面に出ない（`leak.test.tsx`） |
| B12 | 決定 9・10：中間状態の文と遅延の通知が出る／消える |
| B13 | 決定 1・2：`status === "running"` でないときは購読しない。`running` になったら購読する |
| B14 | 決定 1 の規則 3・4：`run-settled` の後の取り直しが**失敗**したら購読は張り直されず、「自動更新は停止しています」が出る。その後の手動の取り直しが**成功**し、`status` がまだ `running` なら購読が張り直される |
| B15 | 決定 3 の 2 段反映：取り直しで `getRun` + `getRunUnits` が成功し `getFindings` が失敗したとき、状態・進捗・ボタンは新しい値に追従し、既に出ている指摘一覧は消えない |
| B16 | 決定 4：`onError` で「サーバーとの接続が切れました」が出て、`onOpen` と続く取り直しの成功で消える。行は同時に 2 つ出ない |
| S1 | 実ブラウザでの確認（決定 15）：`/events` の要求が決着後に増え続けないこと、左右が独立にスクロールすること |

S1 の手順（Playwright、`pnpm dev`）：

1. 合成の原稿（同じ段落を繰り返した 1 万字程度。**実原稿を使わない**）を貼って検査を開始する。
   LM Studio に接続しない状態なら実行はすぐ終端状態になる。
2. `/runs/:id` を開き、Network に `/events` の要求が**1 本も出ない**ことを見る
   （決定 1 の規則 2：終端状態の実行では購読しない）。
3. 本文を下までスクロールし、右側の一覧・詳細が画面に残ることを見る（決定 15）。
4. 画面の写真・原稿・接続先はコミットしない。

**この手順では決定 1 の無限ループそのものは踏めない**（LM Studio が無いと実行は画面を開く前に
終端状態になり、購読が 1 本も張られないため）。無限ループの担保は B2（単体テスト）で、S1 は
「終端状態で購読しない」ことと決定 15 の目視だけを見る。

実 LLM を動かしての「実行中」の表示（進捗の更新、遅延の通知、停止の効き方、`run-settled` 後に
`/events` が増え続けないこと）は、この環境では確認できない。PR 本文に**未確認**と明記し、
ユーザーの手元での確認に委ねる（Windows 未確認と同じ扱い）。

---

## 受け入れ条件（仕様 11 節）との対応

| 項 | 内容 | 本 PR の担当 |
| --- | --- | --- |
| 3 | 全本文が検査対象として割り当てられ、**選択した観点ごとの処理状態**を確認できる | 決定 5・11（観点別の進捗） |
| 5 | 再確認の有無を切り替えて比較でき、撤回候補も確認できる | 再確認単位の進捗（決定 11）。切り替えは設定画面、撤回候補の閲覧は PR12a の絞り込みが担当済み |
| 14 | 中断後に未完了分を**同じ実行 ID で再開**でき、**失敗を指摘ゼロと誤表示しない** | 決定 6・9（再開と再試行、未処理がある状態の表示） |
| 18 | 生成終了を確認できない場合に「復旧待ち」となり、自動で後続生成を送信しない | 決定 7（画面側の案内と確認操作。送信を止めるのはサーバー側で実装済み） |

## 完了条件

- `pnpm check`（typecheck + lint + test）が緑。
- `pnpm build` が緑。
- `git diff --check main...HEAD` が無出力（行末の空白・衝突マーカーが無い）。
- B1〜B13 のテストが在り、S1 の確認を実施して結果を PR 本文に書いてある。
- `docs/plans/2026-09-07-mvp-roadmap.md` の PR12b を実施済みにし、持ち越しを書き足してある。
- `README.md` の「現在の状態」を更新してある。
- `packages/web/src/api/client.ts` と `features/results/run-header.tsx` の「PR12b が担当」という
  コメントを実態に合わせて直してある。
- 仕様書の改訂は**予定していない**。改訂が要ると判断したら 15 節の改訂記録を同じコミットに含める。

## 持ち越し・既知の制限

- 実 LLM を動かした「実行中」の表示（進捗の更新、遅延の通知、停止の効き方）は未確認。
- Windows 未確認。
- `GET /api/runs/:id/findings` の 3N+1 は PR12c。本 PR の合流（決定 3）は緩和であって解消ではない。
- 失敗単位の一覧から、その単位が出した指摘へ移動する経路は持ち越し。
- 実行一覧（`/runs`）は自動更新しない。

---

## タスク分解

> **エージェント向け**：1 タスクずつ「失敗するテストを書く → 落ちるのを見る → 最小の実装 → 通す →
> `pnpm check` → コミット」を単位に進める。決定 1〜17 と「画面ごとの仕様」「テスト」節が要件の正本で、
> タスクはその割り付けである。相対 import は `.ts` / `.tsx` 拡張子付き。識別子は英語、コメントと
> コミットメッセージは日本語。`git add -A` を使わず変更したファイルを明示して stage する。

順序と依存：

```
Task 1（API の口・ラベル）─┬→ Task 3（進捗）─┐
                          ├→ Task 4（操作の判定）─┴→ Task 5（上部への組み込み）
Task 2（SSE 購読）─────────┘                        → Task 6（失敗単位）→ Task 7（復旧）
                                                    → Task 8（自動更新の結線）
                                                    → Task 9（CSS と実ブラウザ確認）
                                                    → Task 10（漏えい検査）→ Task 11（ドキュメント）
```

同じ `packages/web` を触るので**並列に実装しない**。

### Task 1：API クライアントの口とラベルの整理

**Files**
- Modify: `packages/web/src/api/client.ts`
- Modify: `packages/web/src/api/client.test.ts`
- Modify: `packages/web/src/features/results/labels.ts`
- Modify: `packages/web/src/features/results/finding-detail.tsx`（`PERSPECTIVE_LABELS` の import に差し替え）

`features/settings/run-settings-form.tsx` は**触らない**（後段のとおり、設定画面から結果画面を
参照する向きを作らない。同じ文言の定義がこの 1 か所に残るのは承知のうえで残す）。

**Interfaces（後続タスクが使う）**

```ts
// api/client.ts の ApiClient に足す
getRunUnits(runId: string, options?: { signal?: AbortSignal }): Promise<RunUnitsDto>;
stopRun(runId: string): Promise<RunDto>;
resumeRun(runId: string): Promise<RunDto>;
retryFailedUnits(runId: string, body?: { unitIds: readonly string[] }): Promise<RunDto>;
getRecovery(options?: { signal?: AbortSignal }): Promise<RecoveryDto>;
confirmRecovery(runId: string): Promise<RecoveryDto>;
/** Task 2 の `subscribeRunEvents` を包むだけ（決定 16）。実装は Task 2 で入れ、ここでは型だけ置かない。 */
subscribeRunEvents(runId: string, handlers: RunEventHandlers): () => void;
```

`subscribeRunEvents` も**このタスクで `ApiClient` に足す**（中身は Task 2 で実装するので、
ここでは `api/events.ts` に置く仮実装——購読せず何もしない `unsubscribe` を返す——でよい）。
`ApiClient` を丸ごと偽装しているテストはこのタスクで 1 度だけ直す（7 つまとめて足し、2 度壊さない）。

- `stop` / `resume` / `retry-failed` の 202 の本文は `{ run: RunDto }`。`@shuten/shared` に同じ形は
  無いので、`client.ts` の中に `z.object({ run: runDtoSchema }).strict()` を持ち、`run` だけを返す
  （サーバー側 `runs.ts` の `runActionDtoSchema` と同じ形）。
- `retryFailedUnits` は `body` 省略で本文なしの `POST`（サーバーは「全件」と読む）。
  `{ unitIds: [] }` は送らない（サーバーが 400 にする）。
- `confirmRecovery` の本文は `{ runId }`、応答は `RecoveryDto`。
- ラベル：`labels.ts` に `PERSPECTIVE_LABELS`（`typo` →「誤字・脱字」、`naturalness` →
  「日本語の自然さ」）と `FAILURE_ORIGIN_LABELS`（`ensure-loaded` →「モデルの準備」、
  `chat` →「生成」、`local` →「アプリ内」）を足し、`satisfies Record<...>` で網羅を担保する。
  `finding-detail.tsx` のローカル定義は削って `labels.ts` から引く（両者の文言は一致しているのを
  確認済み。「`labels.ts`（変更禁止）」というコメントは PR12a のタスク都合なので消す）。
  **`features/settings/run-settings-form.tsx` は触らない**：設定画面が結果画面の
  `features/results/` を参照するのは層が逆で、重複を消すために依存の向きを壊さない。

**Steps**

1. `client.test.ts` に、6 つの口それぞれについて「メソッドと URL と本文が正しい」「応答が
   スキーマ検証を通る」「非 2xx が `ApiRequestError` になる」テストを書く。落ちるのを見る。
2. `client.ts` に実装する。既存の `request()` をそのまま使う。
3. `labels.ts` にラベルを足し、`finding-detail.tsx` のローカル定義を import に差し替える
   （`run-settings-form.tsx` は触らない）。
4. `pnpm check` を通してコミットする。

### Task 2：`subscribeRunEvents`（SSE の購読）

**Files**
- Create: `packages/web/src/api/events.ts`
- Create: `packages/web/src/api/events.test.ts`

**Interfaces**：決定 16 の宣言そのまま。加えて

```ts
export type EventSourceConstructor = new (url: string) => EventSourceLike;

/** テストから差し替えられる最小の面。`EventSource` はこの形を満たす。 */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}
```

**実装の要点**

- 購読先は `` `/api/runs/${encodeURIComponent(runId)}/events` ``。
- 型の一覧は網羅を型で担保する：

```ts
const RUN_EVENT_TYPES = {
  "target-planned": true,
  "check-started": true,
  "check-finished": true,
  "target-merged": true,
  "recheck-started": true,
  "recheck-finished": true,
  "generation-slow": true,
  "save-rolled-back": true,
  "stop-requested": true,
  "run-settled": true,
} as const satisfies Record<RunEventDto["type"], true>;
```

  `Object.keys(RUN_EVENT_TYPES)` を回して `addEventListener` する。`shared` にイベントが増えたら
  この定義が型検査で落ちる（`satisfies` が網羅を要求する）。
- 受信：`JSON.parse` → `runEventDtoSchema.safeParse`。失敗（`JSON.parse` の例外を含む）は
  `onUnknownEvent()`。**中身をログにも画面にも出さない**。
- `run-settled` は `close()` → `onEvent()` の順（決定 1）。
- 戻り値の `unsubscribe` は冪等（`closed` フラグ）。閉じた後はハンドラーを呼ばない。
- `deps?.EventSource` が省略され `globalThis.EventSource` も無い環境では、購読せずに
  「何もしない `unsubscribe`」を返す（jsdom のテストが落ちないようにする。決定 16）。

**Steps**

1. `events.test.ts` に fake の `EventSource`（`addEventListener` の登録を記録し、任意のイベントを
   発火でき、`close()` の呼び出し順を記録する）を書く。
2. B1〜B4 を書いて落ちるのを見る。とくに B2 は「`onEvent` が呼ばれた時点で `close()` が済んでいる」
   ことを、呼び出し順の配列（`["close", "event"]`）で確かめる。
3. 実装して通す。`pnpm check` → コミット。

### Task 3：進捗の集計と描画

**Files**
- Create: `packages/web/src/features/results/run-progress.ts` / `.test.ts`
- Create: `packages/web/src/features/results/run-progress.tsx` / `.test.tsx`

**Interfaces**

```ts
export interface UnitTally {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly running: number;
  readonly pending: number;
  readonly notApplicable: number;
}

/** `UnitStatusCounts`（`progress` の合計）から作る。 */
export function tallyOf(counts: UnitStatusCounts): UnitTally;

/** 観点ごとの内訳（決定 5）。`units` が null（未取得・失敗）なら空配列。 */
export function perspectiveTallies(
  units: RunUnitsDto | null,
): readonly { readonly perspective: Perspective; readonly tally: UnitTally }[];

/** 決定 10：遅延通知の集合から、まだ `running` の単位だけを残す。 */
export function pruneSlowUnitIds(
  slowUnitIds: ReadonlySet<string>,
  units: RunUnitsDto | null,
): ReadonlySet<string>;
```

- 観点の並びは `PERSPECTIVE_ORDER`（`typo` → `naturalness`）に従う。`units` に現れない観点は出さない。
- `RunProgress` コンポーネントは `progress`・`units`・`recheckEnabled`・`slowUnitCount` を受け取り、
  決定 11 のとおりに描く。**割合・残り時間・`<progress>` 要素を出さない。**
- `total === 0` は「準備中」。

**Steps**

1. `run-progress.test.ts` に B8 の純関数側（集計・剪定）を書いて落ちるのを見る → 実装。
2. `run-progress.test.tsx` に描画のテスト（件数の文字列が出る、`%` と「残り」がどこにも出ない、
   `recheckEnabled === false` で「再確認なし」）を書いて落ちるのを見る → 実装。
3. `pnpm check` → コミット。

### Task 4：操作の出し分けと案内（純関数）

**Files**
- Create: `packages/web/src/features/results/run-control.ts` / `.test.ts`

**Interfaces**

```ts
export interface ControlAvailability {
  readonly canStop: boolean;
  readonly canResume: boolean;
  readonly canRetryFailed: boolean;
  /** 決定 7：復旧待ちの 2 つの操作を出すか。 */
  readonly canConfirmRecovery: boolean;
}

/** 決定 6 の表。`units` が null のときは失敗単位が分からないので `canRetryFailed` は false。 */
export function controlAvailability(run: RunDto, units: RunUnitsDto | null): ControlAvailability;

/** 決定 6：再試行できる失敗単位の ID（`input-too-long` の検査単位を除く）。 */
export function retryableUnitIds(units: RunUnitsDto | null): readonly string[];

/** 決定 9 の中間状態の案内文（出さないときは null）。 */
export function statusNotice(run: RunDto): string | null;

/** 決定 8：操作の失敗を案内文に写す。未知の code は既定の文に落ちる。 */
export interface ControlFailure {
  readonly message: string;
  /** 追加で出すリンク（`"home"` = 新しい検査、`"settings"` = 接続設定）。 */
  readonly links: readonly ("home" | "settings")[];
}
export function controlFailureOf(cause: unknown): ControlFailure;
```

- `controlFailureOf` は `ApiRequestError` の `code` だけを見る（`message` は転記しない。決定 8）。
  `ApiRequestError` 以外（通信の失敗・スキーマ不一致）は既定の文にする。
- `statusNotice` は決定 9 の表をそのまま実装する。優先順は上から（`stopRequestedAt` が最優先）。

**Steps**

1. `run-control.test.ts` に B9・B10 の純関数側を書く。決定 6 の 6 通り × `units` の有無、
   決定 8 の `code` 7 種＋未知の `code` ＋ `Error` を並べる。落ちるのを見る。
2. 実装して通す。`pnpm check` → コミット。

### Task 5：上部への組み込み（進捗・中間状態・操作）

**Files**
- Create: `packages/web/src/features/results/run-control.tsx` / `.test.tsx`
- Modify: `packages/web/src/features/results/run-header.tsx` / `.test.tsx`（無ければ新規）
- Modify: `packages/web/src/features/results/results-page.module.css`

**Interfaces**

```ts
export interface RunControlProps {
  readonly run: RunDto;
  readonly units: RunUnitsDto | null;
  /** 押されたら親が API を呼び、終わったら必ず取り直す（決定 8）。 */
  readonly onStop: () => void;
  readonly onResume: () => void;
  readonly onRetryFailed: () => void;
  readonly onConfirmRecovery: () => void;
  /** 送信中の操作（重複送信を防ぐ。null なら送信していない）。 */
  readonly pending: "stop" | "resume" | "retry" | "confirm" | null;
  readonly failure: ControlFailure | null;
}
```

- `RunHeader` に `units`・`slowUnitCount`・操作のハンドラー・`pending`・`failure` を足し、
  「画面ごとの仕様」の並び（1〜8）で描く。
- `isSettingsStop(run)` が真なら進捗・中間状態・停止/再開を出さない（決定 14）。
  失敗単位の再試行だけは `controlAvailability` に従う。
- 再開のボタンには「同じ検査の続きから再開します（実行 ID は変わりません）」を添える。
- 停止は `run.stopRequestedAt !== null` のとき `disabled` にし、決定 9 の文を出す。
- `pending !== null` の間は**すべての**実行制御ボタンを `disabled` にする（決定 8）。
  `recovery-waiting` で 2 つのボタンが同時に出るので、当該ボタンだけでは足りない。

**Steps**

1. `run-control.test.tsx` に B9（描画側）・B12 を書いて落ちるのを見る → 実装。
2. `run-header` に組み込み、既存のテストが通ることを確かめる。
3. `pnpm check` → コミット。

### Task 6：失敗単位の一覧と個別再試行

**Files**
- Create: `packages/web/src/features/results/failed-units.tsx` / `.test.tsx`
- Modify: `packages/web/src/features/results/results.module.css`

**要件**：「画面ごとの仕様」の「失敗単位の一覧」節と決定 12。

- 出すのは `status` / `perspective` / `targetIndex` / `failure.reason` / `failure.origin` /
  `attempts` / `elapsedMs` / 時刻だけ。**`failure.message`・`pendingNote`・`finishReason` を
  読み取りもしない**（props の型からも外す。`RunUnitsDto` をそのまま渡し、コンポーネントが
  必要な項目だけを読む形でよいが、描画に使わないことをテストで担保する）。
- `input-too-long` の検査単位は再試行ボタンを置かず、案内文だけを出す。
- 「すべて再試行」は `retryableUnitIds` が 1 件以上のときだけ出す。

**Steps**

1. `failed-units.test.tsx` に「`input-too-long` にボタンが無い」「個別の再試行が `unitIds` を
   1 件で呼ぶ」「`message` を混ぜても描画に出ない」を書いて落ちるのを見る → 実装。
2. `pnpm check` → コミット。

### Task 7：復旧待ち・復旧ブロックの案内

**Files**
- Create: `packages/web/src/features/results/recovery-notice.tsx` / `.test.tsx`
- Modify: `packages/web/src/features/results/run-control.tsx`

**要件**：決定 7。

- `status === "recovery-waiting"`：仕様 8.2 の文をそのまま出し、主（確認して再開）と
  副（確認だけ記録）の 2 つのボタン、および「時間経過は終了の証拠になりません」の注記を出す。
- `stopReason === "recovery-blocked"`：`GET /api/recovery` を取り、`runIds` のうち
  **表示中の実行以外**へのリンクを出す（`runPath`）。取得に失敗した・空のときはリンクを出さず
  文言だけを出す。`/api/recovery` の失敗で画面を落とさない。
- `/api/recovery` を取るのは `stopReason === "recovery-blocked"` のときだけ（常時は取らない）。

**Steps**

1. `recovery-notice.test.tsx` に「仕様文がそのまま出る」「2 つのボタンが正しい API を呼ぶ」
   「`recovery-blocked` でリンクが出る／取得失敗でも文言だけ出て落ちない」を書く → 実装。
2. `pnpm check` → コミット。

### Task 8：自動更新の結線

**Files**
- Create: `packages/web/src/features/results/use-run-stream.ts` / `.test.tsx`
- Modify: `packages/web/src/features/results/results-page.tsx` / `.test.tsx`

**Interfaces**

```ts
export type RefreshKind = "light" | "heavy";

export interface RunStreamOptions {
  readonly runId: string;
  /** 決定 1：`running` のときだけ購読する。 */
  readonly running: boolean;
  /** 合図。実際の取得は呼び出し元が行う（決定 2・3）。 */
  readonly onRefresh: (kind: RefreshKind) => void;
  /** 決定 10：遅延通知の unitId。 */
  readonly onGenerationSlow: (unitId: string) => void;
  readonly deps?: { EventSource?: EventSourceConstructor };
}

export function useRunStream(options: RunStreamOptions): void;
```

- 合流（決定 3）は `results-page.tsx` 側に置く：`inFlightRef`（真偽）と `dirtyRef`
  （`null | "light" | "heavy"`、強い方を残す）で、取り直しが終わったら `dirtyRef` を取り出して
  空にし、値があれば次を走らせる。**`dirtyRef` が空になるまで繰り返す**（B5）。
- 取り直しの中身：
  - `light` = `getRun` + `getRunUnits`
  - `heavy` = `light` + `getFindings` + 選択中の指摘の詳細（PR12a の `fetchDetail` を再利用）
  - どちらも PR12a の世代カウンター（`generationRef`）で古い応答を捨てる。
- 反映は 2 段（決定 3）：`getRun` + `getRunUnits` の成功をまず反映し、`getFindings` と詳細は
  別に反映する。後者の失敗で前者を巻き戻さない（B15）。
- `refreshing` は手動のときだけ立てる。自動の失敗は `autoRefreshError`（真偽値）に畳む（決定 4）。
- `streamEnded` / `streamDisconnected` を持ち、決定 1 の規則 3・4 と決定 4 の 3 行の出し分けを行う
  （B14・B16）。
- 操作（stop/resume/retry/confirm）の後は、成功・失敗を問わず `heavy` で取り直す（決定 8）。
  2 段反映があるので、`getFindings` がこけても操作の結果はボタンと進捗に出る。

**Steps**

1. `use-run-stream.test.tsx` に B13・B14（購読の張り直しの条件）を書いて落ちるのを見る → 実装。
2. `results-page.test.tsx` に B5・B6・B7・B15・B16 を書いて落ちるのを見る → 合流・2 段反映・
   静かな更新を実装する。B5 は「追い取得の最中にもう 1 件」を必ず含める（含めないと
   「追い 1 本だけ」の実装でも緑になり、指摘 3 の判別ができない）。
3. `pnpm check` → コミット。

### Task 9：左右の独立スクロールと実ブラウザ確認

**Files**
- Modify: `packages/web/src/features/results/results-page.module.css`

**Steps**

1. 2 カラムに `height`（`calc(100vh - <ヘッダー分>)` など）と `overflow-y: auto` を与え、
   左右が独立してスクロールするようにする。`tokens.css` の値を使う。
2. `pnpm dev` を起動し、Playwright で S1 の手順 1〜4 を実施する。
   **合成の原稿を使う**（同じ段落の繰り返し。実原稿・個人情報を入れない）。
   **利用者の実データに触れないよう、`SHUTEN_DATA_DIR` をスクラッチの一時ディレクトリに向け、
   `SHUTEN_PORT` も既定（3000）から変えて起動する**（既定では `.data/shuten.db` を開く。
   `packages/server/src/config.ts`・`db/path.ts`）。
3. 確認結果（`/events` の本数、スクロールの独立）を作業報告に書く。画像はコミットしない。
4. `pnpm check` → コミット。

### Task 10：漏えい検査の拡張

**Files**
- Modify: `packages/web/src/leak.test.tsx`

**Steps**

1. fake の `fetch` に `GET /api/runs/:id/units` の応答を足し、`failure.message` に
   接続先の番兵（`leak-sentinel.invalid`）と API キーの番兵、`pendingNote` に原稿の断片を
   模した番兵を入れる。`status` は `partially-failed` にして失敗単位の一覧を描画させる。
2. `document.body.textContent` と `localStorage` に番兵が出ないことを見る（B11）。
3. **実装を一時的に誤らせて赤くなることを手作業で確認**してから戻す（PR12a と同じ手順。
   `failed-units.tsx` に `failure.message` を描画する 1 行を足して赤くなることを見る）。
   確認したことを作業報告に書く。
4. `pnpm check` → コミット。

### Task 11：ドキュメントとコメントの更新

**Files**
- Modify: `docs/plans/2026-09-07-mvp-roadmap.md`
- Modify: `README.md`
- Modify: `packages/web/src/api/client.ts`（冒頭コメント）
- Modify: `packages/web/src/features/results/run-header.tsx`（冒頭コメント）
- Modify: `docs/plans/2026-09-11-pr12a-result-view.md`（持ち越しの解消を追記）

**Steps**

1. ロードマップの PR12b を「（完了）」にし、「作った」「作らなかった」「持ち越し」を実態に合わせる。
   PR12a の持ち越し（独立スクロール）を解消済みとして両方の計画書に書く。
2. `README.md` の「現在の状態」を更新する。
3. `client.ts` の「停止・再開・再試行・復旧確認・SSE は PR12b が担当」、`run-header.tsx` の
   「`progress` はここでは読まない（PR12b の担当）」を実態に合わせて直す。
4. `pnpm check` → コミット。
