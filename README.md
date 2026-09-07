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

scaffold と CI（Ubuntu / Windows）が完了。LM Studio との接続検証は完了。仕様は確定（v0.8）。
実装はロードマップ（`docs/plans/2026-09-07-mvp-roadmap.md`）の PR 単位で進めており、PR5（設定と LM Studio クライアント）まで完了。次は PR6（プロンプトと要求の組み立て）。

## 技術スタック

| 領域 | 選択 |
| --- | --- |
| 言語・ランタイム | TypeScript（strict）、Node.js LTS |
| 構成 | pnpm workspace の monorepo（`packages/shared`, `packages/server`, `packages/web`） |
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

実 LM Studio を使う統合テストは通常のテストから分離してある。`SHUTEN_LM_STUDIO_URL` を設定して `pnpm test:llm`
を実行する（未設定なら全件 skip）。モデルは `SHUTEN_LM_STUDIO_MODEL` で指定でき、未指定ならロード済みの
`llm` / `vlm` の最初のものを使う。

Windows での確認手順は [docs/guides/windows-verification.md](docs/guides/windows-verification.md)。

## リポジトリ構成

```
packages/shared   位置換算、分割、照合、許容語判定、共有型（ビルドなし、ソースを直接参照）
packages/server   Hono の HTTP API、実行キュー、SQLite 永続化、LM Studio クライアント、静的配信
packages/web      React + Vite の UI
docs/             仕様書、参照資料、決定記録、検証記録、手順
```

## 参照

- [LM Studio: OpenAI 互換 API](https://lmstudio.ai/docs/developer/openai-compat)
- [LM Studio: 構造化出力](https://lmstudio.ai/docs/developer/openai-compat/structured-output)

## ライセンス

[MIT](LICENSE)
