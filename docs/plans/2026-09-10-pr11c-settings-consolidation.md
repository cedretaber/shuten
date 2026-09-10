# PR11c 詳細計画：設定画面の統合とナビゲーション（web）

PR11（#17、`67549fb`）で作った画面を実際に触って見つかった 2 点を直す、小さな後続 PR。
機能は増やさない。**画面の配置換えと導線の追加**だけを行う。

規模として PR11 のような設計書は要らないと合意したので、この文書は決定と作業の一覧に絞る。

## 発端

1. 接続設定画面（`/settings/connection`）から**元の画面へ戻る導線が無い**。ブラウザバックか URL の
   打ち直ししかない。受付画面と 404 画面には戻りリンクを置いたのに、接続設定画面だけ入る導線しか
   作っていなかった。ヘッダーの「朱点」も `<p>` でリンクではない。PR11 の計画書のどこにも戻りリンクの
   記述が無く、レビューでも拾われなかった**設計の抜け**。
2. メイン画面の折りたたみ「詳細設定」と、別画面の「接続設定」は、どちらも「めったに触らない設定」で
   ある。2 か所に散らす理由が無い。

## 目標

- 設定を 1 枚の画面（`/settings`）に集め、メイン画面には**要約と入口**だけを残す。
- どの画面からもメイン画面へ戻れるようにする。
- 保存の所有者を画面ごとに分け、一方の画面の保存が他方の値を巻き添えにしないようにする。

## 対象外（MUST NOT）

- 仕様書の改訂（決定 10 のとおり不要）。
- 設定項目の追加・削除・既定値の変更。`RUN_SETTINGS_DEFAULTS` は触らない。
- 結果画面、SSE、実行制御（PR12a・PR12b）。
- CSS の全面的な見直し。既存のクラスを流用し、増えた区画のぶんだけ足す。
- 旧パス `/settings/connection` の恒久サポートの約束。公開前なので、リダイレクトは移行の親切であって
  互換性の保証ではない。

## 決定

### 決定 1：詳細設定を設定画面へ寄せる（逆向きにしない）

PR11 の決定 2（接続を別画面へ）と決定 12（詳細設定を折りたたむ）の理由はどちらも
「めったに触らないものを主動線から外す」である。詳細設定はまさにそれなので、設定画面へ移す。

逆向き（接続設定をメイン画面へ）は採らない。API キーのパスワード欄と接続先 URL が主動線に出てきて、
**PR11 決定 18 の封じ込め**（接続先 URL を画面へ出してよいのは接続設定画面だけ）を崩すためである。

### 決定 2：ルートは `/settings`。旧パスはリダイレクトする

`ROUTES.connectionSettings`（`/settings/connection`）を `ROUTES.settings`（`/settings`）に改め、
旧パスは `ROUTES.legacyConnectionSettings` として残して `<Navigate to={ROUTES.settings} replace />`
を割り当てる。`replace` にするのは、戻るボタンで旧パス → 新パスの往復に落ちないようにするため。

### 決定 3：設定画面は 3 節。`<form>` と保存ボタンを節ごとに分ける

| 節 | 中身 | 保存先 | 効くのはいつか |
| --- | --- | --- | --- |
| LM Studio への接続 | 接続先 URL、API キー | サーバー（`PUT /api/settings/connection`） | 「保存」を押した時点。実行中は 409 `runs-active` で拒まれる |
| 生成に使うモデル | モデルの選択とロード状態 | ブラウザ（`localStorage`） | 選んだ時点 |
| 詳細な検査設定 | 生成パラメーター、タイムアウト、丸め許容、入力上限 | ブラウザ（`localStorage`） | 次に**開始する**検査から |

保存先も効く時期も違うので、**同じ `<form>` にも同じ保存ボタンにも入れない**。現状はモデル選択の
`fieldset` が接続の `<form>` の中にあり、モデルの radio に合わせて Enter を押すと接続設定が
送信されてしまう。この PR で外に出す。

各節の見出しの下に、上の表の「効くのはいつか」を 1 行で書く。1 枚の画面に保存ボタンが 1 つだけ
見えている状態は、その 1 つが画面全体に効くと誤解させる。

### 決定 4：`localStorage` のキーは変えず、所有者ごとの部分更新にする

`shuten.v1.runSettings` の 1 キーに全項目が入っている形は変えない。ただし、この 1 つの値を
**2 つの画面が別々の部分だけ持つ**ようになるので、書き込みは全体の置き換えではなく
**読み出し → 自分の持ち分だけ差し替え → 書き戻し**にする。

| 持ち分 | 項目 |
| --- | --- |
| メイン画面（基本） | `perspectives`、`recheckEnabled`、`chunkSettings.targetGraphemes`、`chunkSettings.contextGraphemes`、`chunkSettings.recheckContextGraphemes` |
| 設定画面（詳細） | `generation.*`、`chunkSettings.roundingTolerance`、`chunkSettings.maxInputGraphemes`、`timeouts.*` |

`chunkSettings` は**両方にまたがる**ので、差し替えは項目単位で行う（`chunkSettings` を丸ごと
置き換えると相手の 2 項目が消える）。この読み書きは `storage/run-settings.ts` に閉じ込め、
画面から `writeStored(STORAGE_KEYS.runSettings, ...)` を直接呼ばない。

キーを分ける案（基本用と詳細用の 2 キー）も検討したが、保存形式の変更（PR11 決定 6 の `v1` → `v2`）と
古い値の後始末が要るわりに、得られるのは上の 10 行の関数だけなので採らない。

### 決定 5：「既定値に戻す」は削除ではなく既定値の上書き保存

フォームの state を戻すだけでは、再読み込みで `localStorage` の古い値が復活する。
かといってキーごと消すと、メイン画面の持ち分（検査観点や分割長）まで巻き添えになる。
そこで**詳細の持ち分にだけ既定値を書き込む**。保存済みの値が確かに既定値へ変わるので、
「削除まで含める」という要求は満たす。

`resetAdvancedRunSettings()` は**書き込んだ既定値を返し**、呼び出し側はその戻り値で state を
更新する。`localStorage` を書くだけにすると、決定 7 でマウント時に読んだ state が古い値のまま残り、
画面の要約と次の開始要求だけが「戻す前」に取り残される（レビュー指摘）。保存と表示の出どころを
1 つにして、この食い違いを起こせなくする。

### 決定 6：メイン画面には要約と入口を残す

別画面へ移しただけだと「自分が変えた覚えの無い設定で検査が走る」状態を作れてしまう。
メイン画面の詳細設定があった位置に、次の 3 つを置く。

- **既定値と違う項目を名前と値で**出す要約。件数だけにしない（以前上げた温度や伸ばした
  タイムアウトを見落とす）。**先頭 2 件を名前と値で出し、残りは「ほか N 項目」で畳む。**
  例：`詳細設定：温度 0.8、思考の強さ 強い、ほか 2 項目`。すべて既定値なら `詳細設定：既定値`。
- 設定画面へのリンク。
- 「既定値に戻す」ボタン（既定値のままなら disabled）。

要約の文言づくりは DOM から切り離した純関数
`describeAdvancedChanges(settings): readonly { label, value }[]` に置き、表示単位（秒・%）への
変換は `units.ts` を通す。並び順は固定にして、出力が入力だけで決まるようにする。

### 決定 7：詳細設定の値はマウント時に 1 回読み、表示と送信の両方に使う

メイン画面は詳細設定を編集しないので、値を持つ必要があるのは「要約の表示」と「開始要求の組み立て」の
2 つだけである。マウント時に 1 回読んだ値を state に持ち、**その同じ値**を要約にも
`StartRunRequest` にも使う。開始の直前に読み直す案は採らない：画面に出ている要約と実際に送る値が
食い違いうる（決定 6 が防ごうとしているのと同じ状態を、別の経路で作ってしまう）。

設定画面は別ルートなので、戻ってくればメイン画面は再マウントされ、最新の値を読み直す。

### 決定 8：送信前に止まった失敗には設定画面への導線を付ける

`validateChunkSettings` は分割長・参考文脈（メイン画面）と丸め許容・入力上限（設定画面）を
**まとめて**見る。とくに `maxInputGraphemes ≧ targetGraphemes + 丸め幅` は 2 画面にまたがるため、
分割長を上げただけでメイン画面に「画面上に無い値についてのエラー」が出る。不変条件
（`docs/reference/invariants.md`：入力上限超過は黙って切り詰めず設定変更を案内する）を
画面の側で満たすには、エラーから設定画面へ行けなければならない。

`StartOutcome.failed` に `hint: "none" | "settings"` を足し、**送信前に止まった失敗**
（接続確認の例外、モデル未準備、`safeParse` 失敗、`InvalidChunkSettingsError`）を `"settings"`、
**送信後に決まった失敗**（4xx・結果不明・保険の catch-all）を `"none"` とする。
`"settings"` のときだけ、エラーの下に設定画面へのリンクを出す。

これは PR11 の計画書が「通らなければ `POST /api/runs` を投げず、接続設定へのリンク付きで
エラーを出す」と書きながら、実際にはモデル未選択のときしかリンクが出ていなかった抜けも塞ぐ。

### 決定 9：ヘッダーの「朱点」をホームへのリンクにする

`<p className={styles.title}>朱点</p>` を `<Link to={ROUTES.home}>` にする。あわせて
「接続設定」リンクの文言を「設定」に改める（接続以外も入ったため）。これで全画面に戻る導線が
できるので、画面ごとに個別の「戻る」を足す必要は無い。

### 決定 10：仕様書は改訂しない

仕様 5.1 は「接続・入力」として接続先 URL・モデル選択・API キーと原稿入力を同じ節にまとめており、
画面を 2 枚に割ったのは仕様の要求ではなく PR11 の決定 2 である。5.2 の表にも生成パラメーターは無く、
詳細設定は PR11 の決定 12 で足したものである。したがってこの PR は**合意した機能範囲の中の配置換え**で、
仕様書の改訂記録（15 節）に書くことは無い。PR11 の計画書の決定 2・12・20 に、ここで改めた旨を
1 行ずつ足す。

## 画面ごとの仕様

### `/settings` — 設定

`<h1>設定</h1>` と決定 3 の 3 節。接続の節は現行の `ConnectionSettingsPage` の前半をそのまま使う
（初回 GET の `settingsDirtyRef` によるガード、API キーの三状態、409 の扱いは変えない）。
モデルの節は `<form>` の外へ出す。詳細の節は自動保存で、保存ボタンは置かない。

### `/settings/connection`（旧）

`<Navigate to="/settings" replace />` のみ。

### `/` — 検査設定と開始

仕様 5.2 の 6 項目はそのまま。折りたたみ `<details>` は消し、決定 6 の要約・リンク・
「既定値に戻す」に置き換える。開始ボタンとエラー表示の位置は変えない。エラーには決定 8 の
リンクが加わる。

### ヘッダー

「朱点」がホームへのリンク、右端が「設定」。接続状態・選択モデル・最終確認時刻・「再確認」は
そのまま。**接続先 URL を出さない**（PR11 決定 18）のも変わらない。

## 触るファイル

| ファイル | 変更 |
| --- | --- |
| `packages/web/src/app/routes.ts` | `settings: "/settings"`、`legacyConnectionSettings: "/settings/connection"` |
| `packages/web/src/App.tsx` | ルート 2 本（新パスとリダイレクト） |
| `packages/web/src/app/header.tsx` | 「朱点」を `Link` に、「接続設定」→「設定」 |
| `packages/web/src/app/settings-page.tsx` | 新規。3 節を並べる器。`features/connection/` と `features/settings/` の両方を束ねるので、`app/home-page.tsx` と同じ位置に置く |
| `packages/web/src/features/connection/connection-section.tsx` | `connection-settings-page.tsx` から改名。接続の節だけを持つ |
| `packages/web/src/features/connection/model-section.tsx` | 新規。モデル選択の節（`<form>` の外） |
| `packages/web/src/features/connection/connection.module.css` | `connection-settings-page.module.css` から改名。2 つの節で共有 |
| `packages/web/src/features/settings/advanced-settings-section.tsx` | 新規。詳細設定の入力一式（現行の `<details>` の中身） |
| `packages/web/src/features/settings/advanced-settings-description.ts` | 新規。`describeAdvancedChanges`（純関数） |
| `packages/web/src/features/settings/advanced-settings-summary.tsx` | 新規。メイン画面の要約・リンク・「既定値に戻す」 |
| `packages/web/src/features/settings/run-settings-form.tsx` | 詳細の入力と state を撤去。要約を差し込み、開始要求は決定 7 の値で組み立てる |
| `packages/web/src/features/settings/use-start-run.ts` | `StartOutcome.failed` に `hint` |
| `packages/web/src/storage/run-settings.ts` | 新規。決定 4・5 の読み書き |
| `packages/web/src/settings-round-trip.test.tsx` | 新規。画面をまたぐ結合テスト（S7） |
| `docs/guides/windows-verification.md` | 直リンク先を `/settings` へ。旧パスのリダイレクトを 1 行足す |
| `docs/plans/2026-09-10-pr11-web-shell.md` | 決定 2・12・20 に「PR11c で改めた」を 1 行ずつ |
| `docs/plans/2026-09-07-mvp-roadmap.md` | PR 一覧・依存の並び・チェックポイントに PR11c |

`packages/web/src/storage/local.ts` の `StoredRunSettings` と `storedRunSettingsSchema` は変えない
（決定 4）。`README.md` の `/api/settings/connection` は API のパスなので触らない。

## テスト

新規は `S` 群。既存の W 群は PR11 の計画書の一覧のままにし、この PR で動いたものだけをここに書く。

### S1：ルーティング（`App.test.tsx`）

- S1-1：`/settings` で設定画面が出る
- S1-2：`/settings/connection` を開くと `/settings` へ置き換え遷移する（履歴に旧パスが積まれない）

### S2：ヘッダー（`app/header.test.tsx`）

- S2-1：「朱点」がホームへのリンクである
- S2-2：「設定」リンクの行き先が `/settings`

### S3：設定画面の区画（`app/settings-page.test.tsx`）

- S3-1：3 つの節の見出しが出る
- S3-2：モデル選択の radio が接続の `<form>` の**外**にある。判定は DOM の構造で行う
  （`getByRole("radio").closest("form")` が `null`）。「モデルを選んでも `PUT` が飛ばない」は
  現状のコードでも通ってしまうので、確認にならない

### S4：詳細設定の保存（`storage/run-settings.test.ts`、`features/settings/advanced-settings-section.test.tsx`）

- S4-1：詳細を書いても基本の持ち分（検査観点・分割長）が残る
- S4-2：基本を書いても詳細の持ち分（温度・タイムアウト）が残る
- S4-3：`chunkSettings` は項目単位で混ざる（`targetGraphemes` と `maxInputGraphemes` が同居する）
- S4-4：`seed` は未設定のとき書き戻してもキーごと現れない
- S4-5：`resetAdvancedRunSettings()` が既定値を書き込んで返し、基本の持ち分は残す
  （関数と「既定値に戻す」ボタンは同じ Task 4 で作る。レビュー指摘）
- S4-6：詳細の入力を変えると保存され、再マウントで復元される

### S5：要約（`features/settings/advanced-settings-description.test.ts`、`advanced-settings-summary.test.tsx`）

- S5-1：すべて既定値なら空の配列（表示は「既定値」）
- S5-2：変更した項目だけが、表示単位（秒・%）で並ぶ
- S5-3：3 件以上のとき「ほか N 項目」に畳まれる
- S5-4：「既定値に戻す」は既定値のとき disabled

### S6：開始の導線（`features/settings/use-start-run.test.tsx`、`run-settings-form.test.tsx`）

- S6-1：送信前に止まった失敗の `hint` が `"settings"`（4 経路）
- S6-2：送信後に決まった失敗の `hint` が `"none"`（4xx・結果不明）
- S6-3：`hint === "settings"` のときだけエラーの下に設定画面へのリンクが出る
- S6-4：`validateChunkSettings` に反する詳細設定（保存値）で開始すると、エラーとリンクが出て
  `startRun` を呼ばない（W7-7 の移設版。画面から丸め許容を変えられなくなるため、
  `localStorage` に値を仕込んでから開始する）

### S7：詳細設定の往復（`settings-round-trip.test.tsx`。画面をまたぐ結合テスト）

S4・S5 は「保存値」と「再マウント後」しか見ない。実装が `localStorage` だけを更新して state を
放置しても、その 2 つは通ってしまう（レビュー指摘）。決定 5・決定 7 の接合部を 1 本で通して確かめる。

- S7-1：次の順序を 1 つのテストで通す。
  1. `/settings` で詳細設定（温度・初回検査のタイムアウト）を変える
  2. ヘッダーの「朱点」でホームへ戻る
  3. 要約に変更後の値が名前と値で出る
  4. そのまま開始し、`startRun` の要求本文に変更後の値（API の単位）が入る
  5. 「既定値に戻す」を押す
  6. **再マウントせずに**要約が「既定値」になり、ボタンが disabled になる
  7. そのまま開始し、要求本文に既定値が入る
  8. 基本の持ち分（検査観点・分割長）は 1〜7 のあいだ変わらない

  4 と 7 の `startRun` は、**要求本文を記録したうえで確定した 4xx を返す** fake にする。成功を返すと
  ホーム画面が `/runs/:id` へ遷移してしまい、5 の「既定値に戻す」を押せない（レビュー指摘）。
  4xx なら決定 15 のとおりスナップショットは破棄され、再試行の案内も残らない。

  6 と 7 が決定 5 の戻り値の規定を、3 と 4 が決定 7 を守らせる。`resetAdvancedRunSettings()` が
  state を更新しない実装にすると 6 と 7 が落ちることを、実装後に実際に落として確かめる。

### 動く既存テスト

| テスト | どうなるか |
| --- | --- |
| W7-1（初期値と単位表示） | 詳細 8 項目の確認が `advanced-settings-section.test.tsx` へ移る。基本 6 項目はそのまま残る |
| W7-7（クライアント検証） | S6-4 に置き換え |
| W7-17（開始ボタンの無効化） | 「接続設定へのリンク」を「設定へのリンク」に |
| W7-19（保存と復元） | 基本の持ち分だけを見るように。詳細は S4-6 |
| `header.test.tsx` の「接続設定へのリンクがある」（番号なし） | 文言と行き先が変わる（S2-2） |
| W5 群（接続設定画面） | ファイル名が `connection-section.test.tsx` になる。モデル選択を見ている W5-6・W5-7 は `model-section.test.tsx` へ |
| W9-7（漏えい：`leak.test.tsx`） | `ROUTES.connectionSettings` → `ROUTES.settings`。**接続先 URL が設定画面以外に出ない**という検査自体は変えない |

## タスク分解

順序に意味がある（3 は 4 の前、2 は 4 の前）。1 タスク 1 コミット。

1. **ルートとナビゲーション**（決定 2・9）：`routes.ts`、`App.tsx`、`header.tsx`。S1・S2。
   この時点では `/settings` は現行の接続設定画面のまま。
2. **設定画面の 3 節化**（決定 3）：`settings-page.tsx` を作り、接続とモデルを分ける。
   詳細の節は空の器だけ置く。S3。
3. **保存の所有分離**（決定 4）：`storage/run-settings.ts` に読み出しと所有者ごとの書き込みを作り、
   `run-settings-form.tsx` の全体書き込みをこれに置き換える。画面の見た目は変えない。S4-1〜S4-4。
   `resetAdvancedRunSettings()` はここでは作らない（使う相手がまだ無いため。レビュー指摘）。
4. **詳細設定の移設と要約**（決定 1・5・6・7）：`advanced-settings-section.tsx`、
   `advanced-settings-description.ts`、`advanced-settings-summary.tsx`、`resetAdvancedRunSettings()`。
   `run-settings-form.tsx` から詳細の state を撤去。S4-5・S4-6・S5・S7、動く既存テストの手当て。
5. **開始エラーの導線とドキュメント**（決定 8・10）：`use-start-run.ts` の `hint`、
   `run-settings-form.tsx` の表示、`docs/` の 3 ファイル。S6。

## 完了条件

- `pnpm check` と `pnpm build` の両方が通る（PR11 決定 20 と同じ）。
- 上の「動く既存テスト」がすべて手当てされ、テスト総数が減っていないこと（減るなら理由を書く）。
- 決定 8 の 4 経路が実際に `"settings"` を返すことを、テストを落として（`"none"` に変えて）確かめる。
- S7-1 が、`resetAdvancedRunSettings()` の戻り値で state を更新しない実装（`localStorage` だけを
  書く実装）で落ちることを確かめる。
- Windows での確認は下記の 2 点だけ。

## Windows での再確認

React と CSS の配置換えが主なので、`docs/guides/windows-verification.md` の 9 項目をやり直す必要は
ない。次の 2 点だけを見る。

- `http://127.0.0.1:3000/settings` を**直接開いて**設定画面が出る（SPA フォールバックが新しいパスで
  効く）。
- `http://127.0.0.1:3000/settings/connection` を直接開くと `/settings` へ移る。

## 参照

- 仕様：`docs/spec/mvp-spec.md` v0.9 の 5.1・5.2
- 不変条件：`docs/reference/invariants.md`（入力上限超過は黙って切り詰めない）
- PR11 の計画書：`docs/plans/2026-09-10-pr11-web-shell.md`（決定 2・6・9・12・18・20、W4・W5・W7・W9）
- ロードマップ：`docs/plans/2026-09-07-mvp-roadmap.md`（PR11b の前に入れる）
