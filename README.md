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
受け入れ条件のうち 11 節 3・4・5・11・14・15・16・18 項をサーバー側で満たした（画面がまだ無いため、利用者が
実際に触って確認できるのは PR11・PR12 の完了後）。詳細計画は `docs/plans/2026-09-09-pr9-orchestration.md`
（決定 1〜23）、`docs/plans/2026-09-09-pr9b-orchestrator.md`（決定 24 以降）、
`docs/plans/2026-09-09-pr10-http-api.md`（HTTP API と SSE）。次は Windows でのローカル確認（チェックポイント）と
PR11（接続・入力・設定画面）。2026-09-09 に残りの工程を見直し、PR11b・PR12a/12b・PR13a/13b に
分け直した（ロードマップの「2026-09-09 の見直し」節）。評価原稿と正解データの準備は並行して進める。

一括エクスポート（`GET /api/runs/:id/export`）は形式を評価ツールと揃えるため PR13a に回した。
保存済み結果の再閲覧は `GET /api/runs/:id` と `GET /api/runs/:id/findings` で行う。

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

原稿ファイルに検査パイプラインを回し、結果 JSON を出す試運転用の CLI。

```sh
node packages/cli/bin/shuten-eval.ts --manuscript <path> --model <id>
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
