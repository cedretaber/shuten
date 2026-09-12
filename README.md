# 朱点（shuten）

[![CI](https://github.com/cedretaber/shuten/actions/workflows/ci.yml/badge.svg)](https://github.com/cedretaber/shuten/actions/workflows/ci.yml)

日本語の小説から誤字・脱字と日本語として不自然な箇所を検出する校正ツール。
LM Studio 上のローカル LLM を使い、Windows 上の単一ユーザー環境で動作する。

## 目的

細部まで読み直す負担を減らし、誤りの見逃しを減らす。指摘数を増やすこと自体は目的にしない。
作者の文体や表現意図を尊重し、本文の書き換えは作者の判断に委ねる。MVP では本文を書き換える機能を持たない。

主な特徴：

- 本文を一定長に分割し、前後の参考文脈を付けて誤字・脱字と日本語の自然さを別々に検査する
- 指摘候補は文脈を広げて再確認し、「維持」「撤回」「作者への確認事項」を判定する
- 指摘から本文の該当箇所へ移動し、範囲を強調表示する
- 採否（採用予定・却下・保留）を記録し、再起動後も結果を読み込める
- 原稿と結果はローカルにのみ保存する

## 現在の状態

scaffold と CI（Ubuntu / Windows）が完了。LM Studio との接続検証は完了。仕様は確定（v0.9）。
実装はロードマップ（`docs/plans/2026-09-07-mvp-roadmap.md`）の PR 単位で進めており、**PR10（HTTP API と SSE）
まで完了**。DB を正本として、検査の開始・停止・再開・失敗単位の個別再試行・起動時照合（バックエンド再起動後の
状態整合）が動き、それらを `/api` 配下の HTTP エンドポイントと SSE から操作・観測できる。接続先 URL は
`settings` 表に保存して API（`PUT /api/settings/connection`）から上書きでき、API キーは
プロセスのメモリにだけ置く（応答・ログ・SSE・エラーには接続先 URL も API キーも出さない。
`packages/server/src/api/leak.test.ts` が全エンドポイントで検査している）。
2026-09-10 には PR11b（接続断で失敗した単位の復旧を 1 段にする）が完了し、接続断で失敗した検査単位も
再開だけで再実行できるようになった（それ以前は再開と失敗単位の個別再試行の 2 段が要った）。
受け入れ条件のうち 11 節 3・4・5・11・14・15・16・18 項をサーバー側で満たした。**PR11（接続・入力・設定画面）と
PR11c（設定画面の統合とナビゲーション）まで完了**し、ブラウザの画面から設定（`/settings`。「LM Studio への接続」
「生成に使うモデル」「詳細な検査設定」の 3 節）、原稿の確定（貼り付け／ファイル読み込み）、検査設定の入力と検査の
開始ができる。原稿と検査設定の画面（`/`）と設定の画面（`/settings`）、それらをつなぐアプリの骨格・API
クライアントを持つ（検査実行後に出ていた受付表示は Task 5 で結果画面に統合され、独立の画面としては
無くなった。後述のとおり、実行一覧 `/runs` と結果画面 `/runs/:id` は PR12a が作った）。
API キー・接続先 URL が画面の描画やブラウザの保存領域・接続設定以外の通信へ漏れないことは
`packages/web/src/leak.test.tsx` が検査している。詳細計画は `docs/plans/2026-09-09-pr9-orchestration.md`
（決定 1〜23）、`docs/plans/2026-09-09-pr9b-orchestrator.md`（決定 24 以降）、
`docs/plans/2026-09-09-pr10-http-api.md`（HTTP API と SSE）、`docs/plans/2026-09-10-pr11-web-shell.md`
（画面とクライアント）、`docs/plans/2026-09-10-pr11c-settings-consolidation.md`（設定画面の統合とナビゲーション）、
`docs/plans/2026-09-10-pr11b-one-step-recovery.md`（接続断で失敗した単位の 1 段復旧）。
Windows でのローカル確認は PR11 分の 9 項目（`docs/decisions/0002-scaffold-conventions.md`）で完了しており、
PR11c は実機確認を行っていない。SPA フォールバックがパス非依存（`app.get("*")`）で、旧パスの
リダイレクトはブラウザ内で完結するため、PR11 の実機確認と Windows CI で担保できると判断した
（PR11c 計画書の「Windows での再確認」節）。
2026-09-11 に強調表示のスパイク（PR12a の設計前のチェックポイント）を実施し、保存済みの UTF-16 範囲を
ブラウザ側で書記素境界を計算せずに DOM の強調へ変換できることを実ブラウザで確認した
（`docs/experiments/2026-09-11-highlight-spike/README.md`）。続けて**PR12a（結果閲覧）**で、
保存済みの実行を開いて本文・強調・指摘一覧・詳細を読み、採否を記録できるようになり、実行一覧
（`/runs`）から過去の実行を再閲覧できるようになった。
続けて**PR12b（実行制御と進捗）まで完了**し、結果画面（`/runs/:id`）を開いたまま検査の開始から
完了までを追えるようになった。原稿名・検査状態・観点別の処理進捗（`GET /api/runs/:id/units` を
クライアントで集計）を上部に表示し、状態に応じて停止・再開・失敗単位の個別再試行・復旧確認の
操作を出し分ける（受け付けるかどうかの最終判断はサーバー側。409 が返ったら取り直して従う）。
更新の合図は SSE（`GET /api/runs/:id/events`）で受け、表示する値は必ず DB（REST）から取り直す
（値の正本は SSE ではなく DB）。本文と右側（指摘一覧・詳細）は独立してスクロールするようになり、
PR12a からの持ち越しだったこの点は解消した。ただし実ブラウザでの確認は LM Studio 未接続で指摘 0 件の
実行でしか行えておらず、指摘一覧が実際に長い状態での右側の内部スクロールと、「指摘へ移動」したときの
`scrollIntoView` の挙動そのものは未確認。実 LLM を動かした「実行中」の表示（進捗の更新、遅延の通知、
停止の効き方）と Windows も未確認（詳細計画は `docs/plans/2026-09-11-pr12b-run-control.md`）。
最後に **PR12c（指摘一覧の 3N+1 解消）** で、`GET /api/runs/:id/findings` の問い合わせ回数を直した。
PR12a の計測で 100 ms を上回ったため据え置きをやめたもので、実行 1 件あたりの問い合わせを
`findRun` 1 ＋一覧側 4 本（`findings`・理由・再確認・採否）の計 5 本にまとめ、指摘の件数によらない
ことをクエリ本数のテストで検査している。同条件（指摘 800 件、WSL2 上の Linux。Windows 未確認）での
再計測は中央値 12 ms 前後で、改善前（110〜130 ms 台）の約 1/10 に縮んだ。索引・マイグレーションは
追加していない（詳細計画は `docs/plans/2026-09-11-pr12c-findings-batch.md`）。
2026-09-09 に残りの工程を見直し、PR11b・PR12a/12b・PR13a/13b に分け直した
（ロードマップの「2026-09-09 の見直し」節）。評価原稿と正解データの準備は並行して進める。

一括エクスポート（`GET /api/runs/:id/export`）は形式を評価ツールと揃えるため PR13a（後述の分割後は
PR13a-2）に回した。保存済み結果の再閲覧は `GET /api/runs/:id` と `GET /api/runs/:id/findings` で行う。

2026-09-12 に PR13a を 13a-1（評価ツール）・13a-2（エクスポート）・13a-3（全文チャット方式）の 3 本に
分け、**PR13a-1 が完了**した。正解ファイルの形式が決まり（`docs/reference/truth-format.md`。ユーザーが
これから正解データを用意できる状態になった）、評価用 CLI（`packages/cli`）をサブコマンド化して
（`run`／`evaluate`／`aggregate`／`hash`）、正解ファイルと結果 JSON を突き合わせ、仕様書 10 節の
自動集計分（誤りの検出率、誤検出、位置特定失敗率、許容語の抑制、実行性能）を指標 JSON として出し、
人手で判断する指標（修正案の妥当性、人間の確認負担、診断候補の正誤）は空欄で示す。同条件で複数回
実行した結果のぶれ（error 項目ごとの検出回数 k/N、各指標の最小・中央値・最大）も集計できる。
原稿・正解ファイル・結果 JSON の 3 者は本文ハッシュ（`pnpm eval hash`）で照合し、一致しなければ
集計せずエラー終了する。品質の合否は判定しない（数値目標は未決のまま。仕様書 10・13 節）。
詳細は `docs/plans/2026-09-12-pr13a-evaluation-export.md`（決定 1〜22）。エクスポート
（`GET /api/runs/:id/export`）と全文チャット方式（現在の全文チャット方式との比較用モード）は
PR13a-2・PR13a-3 に持ち越した。

続けて**PR13a-2（エクスポート）が完了**し、`GET /api/runs/:id/export` で検査実行 1 件ぶんを
丸ごと JSON で取り出せるようになった。応答は既存の DTO 射影だけを並べたもので、仕様書 8.1 節の
保存単位（原稿版・検査実行・検査対象・検査単位・指摘・元候補・位置診断・再確認単位・作者の判断）
をすべて含み、接続先 URL と API キーは含まない（`packages/server/src/api/leak.test.ts` の
エンドポイント一覧にも追加済み）。評価用 CLI の `evaluate` / `aggregate` は、CLI が書いた結果 JSON
（`--result`）の代わりにこのエクスポート JSON（`--export`）も入力にできるようになり、`--export` を
使うときは本文がエクスポートに含まれるため `--manuscript` を渡さない。`aggregate` は `--result` と
`--export` を混ぜて渡せるが、CLI 経由の実行とサーバー経由の実行を混ぜた集計は実行条件
（`versions.result`）が食い違うため必ず条件不一致で止まる。詳細は
`docs/plans/2026-09-12-pr13a-evaluation-export.md`（決定 16〜32）。全文チャット方式（PR13a-3）は
まだ着手していない。

## 技術スタック

| 領域 | 選択 |
| --- | --- |
| 言語・ランタイム | TypeScript（strict）、Node.js LTS |
| 構成 | pnpm workspace の monorepo（`packages/shared`, `packages/server`, `packages/web`, `packages/cli`） |
| バックエンド | Hono（Node.js） |
| フロントエンド | React + Vite |
| 保存 | SQLite。better-sqlite3 + Drizzle |
| LM Studio 接続 | OpenAI 互換 API を標準 `fetch` で呼ぶ |
| 進捗通知 | SSE |
| テスト / 検証 / lint | Vitest / zod / Biome |

選定理由と設計上の制約は [docs/decisions/0001-tech-stack.md](docs/decisions/0001-tech-stack.md) を参照。

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [docs/spec/mvp-spec.md](docs/spec/mvp-spec.md) | MVP 仕様書（正本）。機能範囲、検査処理、保存、評価方法、受け入れ条件 |
| [docs/reference/invariants.md](docs/reference/invariants.md) | 仕様から導いた不変条件と対象外。実装前に読む |
| [docs/reference/conventions.md](docs/reference/conventions.md) | 開発規約、パッケージ構成、コマンド |
| [docs/reference/truth-format.md](docs/reference/truth-format.md) | 評価用の正解ファイルの書き方（`pnpm eval evaluate` / `aggregate` の入力） |
| [docs/decisions/](docs/decisions/) | 設計上の決定記録（技術スタック、scaffold の規約、LM Studio 接続検証） |
| [docs/experiments/](docs/experiments/) | 検証の手順・要求・結果。再検証できる形で残す |
| [docs/plans/](docs/plans/) | 実装計画。PR 単位のロードマップと、各 PR の詳細計画 |
| [docs/guides/windows-verification.md](docs/guides/windows-verification.md) | Windows での動作確認手順 |
| [AGENTS.md](AGENTS.md) | コーディングエージェントへの指示 |
| [CLAUDE.md](CLAUDE.md) | Claude Code 固有の事項 |

## セットアップ

必要なもの：Node.js 24.20.0（`.node-version`。24 系の他の版でも動く想定）、pnpm 10.17.1（`package.json` の `packageManager` に固定。volta を使う場合は `volta` フィールドで自動選択される）。

```sh
pnpm install        # better-sqlite3 は同梱のビルド済みバイナリを使う（コンパイラ不要）
pnpm check          # 型検査 + lint + テスト
pnpm build          # web をビルド（packages/web/dist）
pnpm start          # http://127.0.0.1:3000 で起動し、ビルド済みの web を配信
```

開発時は `pnpm dev` でサーバー（`node --watch`）と Vite の開発サーバーを同時に起動する。
Vite は `/api` をサーバーへプロキシする。

環境変数：`SHUTEN_HOST`（既定 `127.0.0.1`）、`SHUTEN_PORT`（既定 `3000`）、`SHUTEN_DATA_DIR`（既定 `.data`）、
`SHUTEN_LM_STUDIO_URL`（既定 `http://127.0.0.1:1234`。LM Studio のルート URL。`/v1` を付けると起動時にエラー）、
`SHUTEN_LM_STUDIO_API_KEY`（省略可）。

`SHUTEN_DATA_DIR` の下に SQLite ファイル `shuten.db` を作る。起動時に `createApp` の前に
DB マイグレーションを適用し、失敗したら API を受け付けずにプロセスを非ゼロ終了させる。

実 LM Studio を使う統合テストは通常のテストから分離してある。`SHUTEN_LM_STUDIO_URL` を設定して `pnpm test:llm`
を実行する（未設定なら全件 skip）。モデルは `SHUTEN_LM_STUDIO_MODEL` で指定でき、未指定ならロード済みの
`llm` / `vlm` の最初のものを使う。

### 終了

`SIGINT`（コンソールの Ctrl+C）または `SIGTERM` を受けると、新規の接続を止め、SSE を閉じ、残った接続を切り、
LM Studio への接続を閉じ、DB を閉じてから終了する（`shutdown: done` を出して終了コード 0）。
**走っている検査は待たない**——LM Studio 側の生成は止められないので、次回起動時の照合が
「バックエンド再起動で中断」として扱う。生成の応答を待っている最中に終了した場合は、接続を閉じる段を
1 秒で切り上げて `shutdown: client drain skipped` を出す（終了コードは 0 のまま）。
手順のどこかが本当に固まったときのために全体に 5 秒の上限があり、超えると `shutdown: timeout` を出して
終了コード 1 で落ちる。2 回目のシグナルは待たずに終了する。

**Windows では `SIGTERM` が届かない。** 対象はコンソールの Ctrl+C（`SIGINT`）だけになる。
なお Windows での動作確認は CI（`windows-latest` の `pnpm check`）でのみ行っており、**ローカルの
Windows 環境では未確認**（`docs/guides/windows-verification.md` のチェックポイントで確認する）。

## 評価ハーネス（`packages/cli`）

原稿ファイルに検査パイプラインを回して結果 JSON を出し、正解データと突き合わせて仕様書 10 節の指標を
出す評価用の CLI。サブコマンドは `run`（既定）／`evaluate`／`aggregate`／`hash`。
先頭の引数が `--` で始まる場合と引数が無い場合は `run` に振られるので、旧来の起動
（`... --manuscript x --model y`）もそのまま動く。ルートの `pnpm eval` はこの CLI のショートカットで、
次の 2 つはどちらも同じように動く。

```sh
pnpm eval <サブコマンド> [オプション...]
node packages/cli/bin/shuten-eval.ts <サブコマンド> [オプション...]
```

### `run`：検査パイプラインを回す

```sh
pnpm eval run --manuscript <path> --model <id>
```

接続先と API キーは引数では渡さない（シェル履歴に残さないため）。環境変数
`SHUTEN_LM_STUDIO_URL`（既定 `http://127.0.0.1:1234`）と `SHUTEN_LM_STUDIO_API_KEY`（省略可）から読む。

終了コードは 0 = `completed`、1 = 引数・入出力の誤り、2 = `partially-failed`、3 = `stopped`。
進捗は標準エラーへ、結果 JSON は `--out` を指定しなければ標準出力へ出す。

`--check-timeout-ms` / `--recheck-timeout-ms` は、この CLI では従来どおり打ち切りの上限そのもの。
Web UI 側のオーケストレーター経路では同名の設定値の意味が異なり、超えた時点で打ち切るのではなく
「生成が遅延している」と通知する閾値になる（実際のハード上限は復旧確認の待機時間を加えた値。
仕様書 8.2節、決定7）。

`--mode full-text` では本文全体が 1 要求になるため、`--max-input-graphemes` を本文の書記素数より
大きい値に上げる必要がある（既定の 12,000 では長い原稿で停止する）。

`--reasoning-effort` の既定は `none`（思考なし）で、未指定でも `reasoning_effort: "none"` を明示的に送る。
思考ありで動かすときは `--reasoning-effort low|medium|high` を渡す（決定記録 [0003](docs/decisions/0003-lm-studio-connection.md) の 2026-09-09 の追記）。

分割長などの既定値は実測前の暫定値で、試運転の結果を見て調整する。

### `evaluate` / `aggregate`：正解データと突き合わせる

正解ファイル（`--truth`）の書き方は [docs/reference/truth-format.md](docs/reference/truth-format.md)。
原稿・正解ファイル・結果 JSON の本文ハッシュが一致していることを確認してから採点する
（`pnpm eval hash` でハッシュ値を取れる。後述）。

```sh
pnpm eval evaluate --manuscript <原稿> --truth <正解.json> --result <結果.json> \
                   [--out <指標.json>] [--report <レポート.md>]
pnpm eval aggregate --manuscript <原稿> --truth <正解.json> \
                    --result <結果1.json> --result <結果2.json> [--result ...] \
                    [--out <集計.json>] [--report <レポート.md>]
```

`evaluate` は 1 回の実行を仕様書 10 節の指標（誤りの検出率、誤検出、位置特定失敗率、許容語の抑制、
実行性能）で採点する。率はすべて `{ numerator, denominator, rate }` で、分母が 0 なら `rate` は `null`。
人手で判断する指標（修正案の妥当性、人間の確認負担、診断候補の正誤）はレポートに空欄の列として示す。
指標 JSON には持たない。

`aggregate` は同じ条件で複数回実行した結果のぶれを、`--result`（2 本以上必須）から集計する。
各指標の最小・中央値・最大と、正解項目ごとの検出回数 k/N を出す。実行条件（モデル・観点・分割設定・
タイムアウトなど）が 1 本でも食い違うと、ぶれを測れないため集計せずエラーになる。

どちらも `--out` を指定しなければ指標 JSON を標準出力に書く。`--report` を指定すると Markdown の
レポート（人手の欄を含む）を追加で書く。品質の合否は判定しない（終了コードは指標の良し悪しでは変わらない。
数値目標は未決のまま。仕様書 10・13 節）。

**`--export`（サーバー経由の実行結果）を使う場合。** `--result`（CLI が書いた結果 JSON）の代わりに、
`GET /api/runs/:id/export` が返すエクスポート JSON を渡せる。本文がエクスポートに埋め込まれているため、
`--export` を使うときは `--manuscript` を渡さない。

```sh
pnpm eval evaluate --export <エクスポート.json> --truth <正解.json> \
                   [--out <指標.json>] [--report <レポート.md>]
pnpm eval aggregate --export <エクスポート1.json> --export <エクスポート2.json> [--export ...] \
                    --truth <正解.json> [--out <集計.json>] [--report <レポート.md>]
```

`aggregate` は `--result` と `--export` を混ぜて渡すこともできるが、CLI 経由の実行とサーバー経由の
実行を混ぜた集計は、実行条件（`versions.result`）が異なるため必ず条件不一致で止まる。同じ種類どうし
（`--result` どうし／`--export` どうし）なら集計できる。

エクスポートは、サーバーが待ち受けているアドレスに対して次のように取得する
（実行 ID は `GET /api/runs` などで確認する）。

```sh
curl http://localhost:<ポート>/api/runs/<実行ID>/export -o export.json
```

### `hash`：原稿の本文ハッシュを出す

```sh
pnpm eval hash --manuscript <原稿>
```

正解ファイルの `manuscript.bodyHash` に貼るハッシュ値を標準出力に 1 行だけ出す。LM Studio には接続しない。
`sha256sum` の結果とは一致しない（BOM を除いた本文文字列のハッシュのため）ので、必ずこのコマンドで取る。

Windows での確認手順は [docs/guides/windows-verification.md](docs/guides/windows-verification.md)。

## リポジトリ構成

```
packages/shared   位置換算、分割、照合、許容語判定、共有型（ビルドなし、ソースを直接参照）
packages/server   Hono の HTTP API、実行キュー、SQLite 永続化、LM Studio クライアント、静的配信
packages/web      React + Vite の UI
packages/cli      評価用 CLI。原稿ファイルに検査パイプラインを回して結果 JSON を出す
docs/             仕様書、参照資料、決定記録、検証記録、手順
```

## 参照

- [LM Studio: OpenAI 互換 API](https://lmstudio.ai/docs/developer/openai-compat)
- [LM Studio: 構造化出力](https://lmstudio.ai/docs/developer/openai-compat/structured-output)

## ライセンス

[MIT](LICENSE)
