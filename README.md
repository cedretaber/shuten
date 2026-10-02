# 朱点（shuten）

[![CI](https://github.com/cedretaber/shuten/actions/workflows/ci.yml/badge.svg)](https://github.com/cedretaber/shuten/actions/workflows/ci.yml)

日本語の小説から誤字・脱字と日本語として不自然な箇所を検出する校正ツール。
LM Studio 上のローカル LLM を使い、Windows 上の単一ユーザー環境で動作する。

## 目的

細部まで読み直す負担を減らし、誤りの見逃しを減らす。指摘数を増やすこと自体は目的にしない。
作者の文体や表現意図を尊重し、本文の書き換えは作者の判断に委ねる。MVP では本文を書き換える機能を持たない。

主な特徴は次のとおり。

- 本文を一定長に分割し、前後の参考文脈を付けて誤字・脱字と日本語の自然さを別々に検査する
- 指摘候補は文脈を広げて再確認し、「維持」「撤回」「作者への確認事項」を判定する
- 指摘から本文の該当箇所へ移動し、範囲を強調表示する
- 採否（採用予定・却下・保留）を記録し、再起動後も結果を読み込める
- 原稿と結果はローカルにのみ保存する

## 現在の状態

ロードマップ（`docs/plans/2026-09-07-mvp-roadmap.md`）の PR13b まで、実装と評価が終わっている。
仕様は確定している（v0.9.3）。ブラウザの画面からは次のことができる。

- 設定（LM Studio への接続、生成に使うモデル、詳細な検査設定）
- 原稿の確定（貼り付け／ファイル読み込み）と、検査の開始・停止・再開・失敗単位の個別再試行
- 検査中の進捗の表示と、結果の閲覧（本文の強調表示、指摘一覧と詳細、採否の記録）
- 過去の実行の再閲覧（`/runs`）

実行 1 件ぶんの結果は、API（`GET /api/runs/:id/export`）から JSON で取り出せる。画面にボタンはない。

評価用 CLI（後述）では、原稿ファイルに検査を回し、正解データと突き合わせて指標を出せる。

分割長や `max_tokens` などの既定値は、実原稿 2 本での評価に基づく**仮置き**で、使いながら見直す
（`docs/decisions/0004-evaluation-settings.md`）。

まだ確かめていないことは次のとおり。

- ローカルの Windows 環境で確かめたのは PR11 の 9 項目まで。PR11c 以降は実機で確認しておらず、
  Windows では CI（`pnpm check`）だけが通っている。
- 実 LLM を動かした画面の通し確認は、WSL2 上のサーバーと Chrome でだけ行った
  （`docs/experiments/2026-10-02-browser-check/`）。Windows のブラウザでは表示だけを確かめた。
- 実原稿での評価（PR13b）では、命令文を含む原稿での取り直し、全文チャット方式の人手集計、
  確認時間の実測を行っていない。画面経由の実行は、採用モデル・既定の設定で 1 回行った。

PR ごとの経過は [docs/history.md](docs/history.md) に記録している。

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
| [docs/reference/eval-cli.md](docs/reference/eval-cli.md) | 評価用 CLI（`pnpm eval`）のサブコマンド、オプション、終了コード |
| [docs/reference/truth-format.md](docs/reference/truth-format.md) | 評価用の正解ファイルの書き方（`pnpm eval evaluate` / `aggregate` の入力） |
| [docs/decisions/](docs/decisions/) | 設計上の決定記録（技術スタック、scaffold の規約、LM Studio 接続検証、評価設定の仮置き） |
| [docs/experiments/](docs/experiments/) | 検証の手順・要求・結果。再検証できる形で残す |
| [docs/plans/](docs/plans/) | 実装計画。PR 単位のロードマップと、各 PR の詳細計画 |
| [docs/history.md](docs/history.md) | 開発の経過。PR ごとに何ができるようになったか |
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
**走っている検査は待たない。** LM Studio 側の生成は止められないので、次回起動時の照合が
「バックエンド再起動で中断」として扱う。生成の応答を待っている最中に終了した場合は、接続を閉じる段を
1 秒で切り上げて `shutdown: client drain skipped` を出す（終了コードは 0 のまま）。
手順のどこかが本当に固まったときのために全体に 5 秒の上限があり、超えると `shutdown: timeout` を出して
終了コード 1 で落ちる。2 回目のシグナルは待たずに終了する。

**Windows では `SIGTERM` が届かない。** 対象はコンソールの Ctrl+C（`SIGINT`）だけになる。
なお Windows での動作確認は CI（`windows-latest` の `pnpm check`）でのみ行っており、**ローカルの
Windows 環境では未確認**（`docs/guides/windows-verification.md` のチェックポイントで確認する）。

## 評価用 CLI（`packages/cli`）

原稿ファイルに検査パイプラインを回して結果 JSON を出し、正解データと突き合わせて仕様書 10 節の指標を
出す CLI。`pnpm eval <サブコマンド> [オプション...]` で起動する。

| サブコマンド | 用途 |
| --- | --- |
| `run`（既定） | 原稿に検査パイプラインを回し、結果 JSON を出す |
| `check-truth` | 正解ファイルを、LLM を回さずに原稿と照らして検証する |
| `evaluate` | 1 回の実行結果を正解データと突き合わせ、指標を出す |
| `aggregate` | 同じ条件で複数回実行した結果のぶれを集計する |
| `full-chat` | 比較用に「現在の全文チャット方式」で 1 回生成する（自動採点はしない） |
| `hash` | 正解ファイルに貼る原稿の本文ハッシュを出す |

```sh
pnpm eval run --manuscript <原稿> --model <id> --out <結果.json>
pnpm eval evaluate --manuscript <原稿> --truth <正解.json> --result <結果.json> --report <レポート.md>
```

接続先と API キーは引数では渡さず、環境変数 `SHUTEN_LM_STUDIO_URL` と `SHUTEN_LM_STUDIO_API_KEY` から読む。
オプション・既定値・終了コードは [docs/reference/eval-cli.md](docs/reference/eval-cli.md)、
正解ファイルの書き方は [docs/reference/truth-format.md](docs/reference/truth-format.md) にある。

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
