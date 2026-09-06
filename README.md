# 朱点（shuten）

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

実装前。仕様は確定（v0.5）、技術スタックは決定済み。次の段階は scaffold と LM Studio との接続検証。

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
| [docs/decisions/](docs/decisions/) | 設計上の決定記録 |
| [AGENTS.md](AGENTS.md) | AI エージェントと開発者向けの規約。不変条件、対象外、開発規約 |
| [CLAUDE.md](CLAUDE.md) | Claude Code 固有の事項 |

## セットアップ・起動（scaffold 後に追記）

未整備。scaffold 後に、Node.js と pnpm の版、インストール、起動、テストの各手順を記載する。

## 参照

- [LM Studio: OpenAI 互換 API](https://lmstudio.ai/docs/developer/openai-compat)
- [LM Studio: 構造化出力](https://lmstudio.ai/docs/developer/openai-compat/structured-output)
