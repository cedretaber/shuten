# 0001. 技術スタックの選定

日付：2026-09-07  
状態：決定

## 決定

| 領域 | 選択 |
| --- | --- |
| 言語・ランタイム | TypeScript（strict）、Node.js LTS |
| パッケージ管理・構成 | pnpm workspace による monorepo |
| バックエンド | Hono（Node.js アダプター） |
| フロントエンド | React + Vite |
| 保存 | SQLite。better-sqlite3 + Drizzle ORM |
| LM Studio 接続 | 標準の `fetch`。中断は `AbortController` |
| 進捗通知 | SSE（Server-Sent Events） |
| テスト | Vitest |
| スキーマ検証 | zod（LLM 応答、API 入出力） |
| lint / format | Biome |
| 書記素クラスタ分割 | `Intl.Segmenter`（標準 API） |

パッケージ構成：

- `packages/shared` — 文字位置の換算、段落・書記素クラスタ分割、引用照合、許容語判定、API と DB の型
- `packages/server` — HTTP API、単一実行キュー、永続化、LM Studio クライアント、静的配信
- `packages/web` — 結果画面、接続・入力画面

起動は `server` が `web` のビルド成果物を静的配信する単一プロセスとし、ループバックアドレスで待ち受ける。開発時のみ Vite の開発サーバーを別に立てる。

## 理由

### TypeScript を単一言語とする

- LLM は LM Studio の OpenAI 互換 API を HTTP で呼ぶだけで、Python の LLM ライブラリの強みを活かす場面がない。
- フロントエンドは TypeScript で書くため、言語を 1 つに絞ると開発と qwen への委譲の負荷が下がる。
- 開発者が TypeScript に習熟しており、Python は不得手である。
- 仕様書は指摘位置の単位を UTF-16 コード単位に統一している。これは JavaScript 文字列の内部表現そのものであり、フロントとバックで同じ換算コードを使える。

### その他の選択

- **Node.js LTS**：Windows でのネイティブ実行が標準環境であり、実績とライブラリ互換性が最も安定している。
- **pnpm monorepo**：本文処理を `shared` に切り出し、境界を明確にする。
- **Hono**：軽量で型が強く、Node.js での静的配信と SSE を標準で持つ。
- **React + Vite**：情報量と対応ライブラリが最大で、qwen の生成精度も見込める。
- **SQLite + better-sqlite3 + Drizzle**：原稿版・実行・候補・診断・採否を関連付けて保存し、再起動後に再開する要件に合う。同期 API は単一キューと相性がよい。Drizzle は better-sqlite3 を公式にサポートし、スキーマと型を一元管理できる。
- **素の fetch**：使うエンドポイントは 2 つだけ。切断や `finish_reason` の検査、仕様の「自動再試行 1 回」を自前で制御できる。SDK の暗黙の再試行と衝突しない。
- **SSE**：サーバーからの一方向通知で足りる。WebSocket は過剰。

## 設計上の制約（レビューによる補足）

### 分割結果と確定位置の正本はサーバー側

`Intl.Segmenter` の境界判定は実装（ICU の版）に依存し、Node.js とブラウザで必ず一致するとは限らない。したがって：

- 段落範囲、検査対象範囲、参考文脈範囲、指摘の確定位置は、サーバーが計算して UTF-16 範囲として保存したものを正本とする。
- ブラウザは保存済みの範囲を表示に使い、独自に再計算した結果で上書きしない。
- 再開時も保存済みの分割範囲を使い、再計算しない。
- 分割・照合のコードを `shared` に置くことと、両側で再計算することは別。`shared` への配置はテストと型共有のためであり、正本はサーバーの保存値である。

### SSE 接続と検査ジョブの寿命を分離する

- ブラウザの切断は SSE の購読を終了するだけで、検査は継続する。
- 再接続時は保存済みの状態を API で取得して表示を復元する。進捗イベントの受信に結果の保持を依存させない。
- SSE は通知手段であり、状態の正本は DB である。

### AbortController は「通信の中断」であり生成終了の確認ではない

- `AbortController` による中断は、アプリと LM Studio 間の HTTP 通信を切ることを意味する。LM Studio 側で生成が終了したことの確認とは区別する（仕様書 8.2 節）。
- 何を中断するかは操作ごとに分ける。
  - 停止操作：新規要求の送信を止める。実行中の HTTP 要求は中断してよいが、生成終了は未確認として扱う。
  - タイムアウト：当該 HTTP 要求を中断し、生成終了は未確認として扱う。
  - SSE 切断：何も中断しない。購読が終わるだけ。
- 生成終了が未確認の間は後続の生成を送信せず、上限を超えたら「復旧待ち」にする。

### scaffold 時の確認事項

- Node.js と pnpm の版を固定する（`.node-version` または `engines`、`packageManager` フィールド）。
- better-sqlite3 は主要環境向けのビルド済みバイナリを提供するが、採用する Node.js の版と Windows 環境でインストールと DB 読み書きを実際に確認する。
- pnpm の依存パッケージのビルド許可（`onlyBuiltDependencies` など、使用する版の方式）を記録する。
- DB トランザクションには LLM 応答待ちを含めない。トランザクションは短い更新処理に限定し、LLM 要求の前後で分ける。

## 参照

- [Drizzle ORM: better-sqlite3](https://orm.drizzle.team/docs/get-started-sqlite)
- [Hono: Node.js](https://hono.dev/docs/getting-started/nodejs)
- [Hono: Streaming Helper（SSE）](https://hono.dev/docs/helpers/streaming)
- [ECMA-402: Intl.Segmenter](https://tc39.es/ecma402/#segmenter-objects)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [pnpm](https://pnpm.io/)
