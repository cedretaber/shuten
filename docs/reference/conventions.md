# 開発規約

## コミット・ブランチ

- `main` に直接コミットせず、作業ごとにブランチを切る。
- コミットメッセージは日本語。1 行目に変更の要約、必要なら空行を挟んで理由を書く。
- 仕様書を改訂したら、`docs/spec/mvp-spec.md` の改訂記録（15 節）に追記し、同じコミットに含める。
- プロンプトのスナップショット（`packages/server/src/prompts/__snapshots__/`）を更新するときは、
  `PROMPT_VERSION`（`packages/shared/src/versions.ts`。初版は `"1"`）の更新と同じコミットで行う。
- 設計上の決定は `docs/decisions/` に連番で追加する。結論と理由だけを短く書き、
  検証の手順や生データは `docs/experiments/` に置いて参照する。
- Windows で未確認の変更は、その旨を PR やコミットメッセージに書く。
- CI（`.github/workflows/ci.yml`）は Ubuntu と Windows で `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` を実行する。
  PR は CI が通ってからマージする。Node と pnpm の版は `.node-version` と `packageManager` から読むので、更新時にワークフローの変更は不要。
- GitHub の Ruleset（`main branch`）で、`main` へのマージに `check (ubuntu-latest)` と `check (windows-latest)` の成功を必須にし、
  `main` の削除と force push を禁止している（#4）。バイパスできるアクターはいない。
  ワークフローの `GITHUB_TOKEN` 権限は `contents: read` に固定する。書き込みが必要なジョブを足すときはジョブ単位で権限を広げる。

## パッケージ構成

- `packages/shared` — 位置換算、段落・書記素クラスタ分割、引用照合、許容語判定、共有型
- `packages/server` — HTTP API、単一実行キュー、永続化、LM Studio クライアント、静的配信
- `packages/web` — UI
- `packages/cli` — 評価用 CLI。原稿ファイルに検査パイプラインを回して結果 JSON を出す

単位ごとに責務を 1 つに絞り、テストしやすい境界を作る。
特に「分割」「照合」「統合・抑制」「LM Studio クライアント」「永続化」は独立させる。

## コード

詳細と理由は `docs/decisions/0002-scaffold-conventions.md`。

- 識別子（変数名・関数名・ファイル名）は英語。コメントは日本語。
- 相対 import と `@shuten/shared` 内の import には `.ts` 拡張子を必ず付ける。Node が直接実行するため。
- `erasableSyntaxOnly`：`enum`、`namespace`、パラメータプロパティ、`import x = require()` を使わない。
- `shared` はビルドしない。`exports` は `src/index.ts` を直接指す。公開する関数は `src/index.ts` から再エクスポートする。
- 依存の版は完全固定（`^` なし）。更新は意図的に行い、コミットメッセージに理由を書く。
- `@shuten/server` の `undici` は **7 系**に固定する。`undici@8` の `Agent` を Node 24 の内蔵 `fetch` に
  `dispatcher` として渡すと `UND_ERR_INVALID_ARG` になるため。版を上げるときは
  `packages/server/src/lmstudio/client.test.ts` の C47〜C49 が通ることを確認する。詳細は決定記録 0003。
- Node.js の完全版は `.node-version` と `package.json` の `volta` に同じ値で固定し、`engines` はサポート範囲を示す。
  更新時は 3 箇所を同時に変える。pnpm は `packageManager` で固定。
- `package.json` の scripts は Windows でも動く書き方に限定する（`rm -rf`、`&&` 以外のシェル構文、環境変数の inline 代入を使わない）。
- 実装時に仕様の解釈に迷ったら、推測で進めずコメントかドキュメントで疑問点を残す。

## テスト

- テストはソースと同じディレクトリに `*.test.ts` として置く。
- CRLF・CR・BOM を含む原稿ファイルは `packages/*/test/fixtures/` に置き、`.gitattributes` の `-text` で改行変換から守る。
  fixture はエディタで保存せず、`packages/shared/test/generate-fixtures.mjs` でバイト単位に生成する。追加したら `git ls-files --eol` で `attr/-text` を確認する。
- `packages/*/test/fixtures/` に置く合成テキスト（CRLF・CR・BOM を含まないもの）は LF 改行で保存する
  （`-text` によりそのままコミットされるため）。CRLF を含む期待値が必要なときは fixture ではなくテスト内の文字列リテラルで作る。
- 仕様書 11 節の受け入れ条件を、可能な限り自動テストに落とす。
- 以下は境界条件テストを必須とする。
  - 段落分割: CRLF・LF・CR の混在、末尾改行の有無、空行、単一の長い段落
  - 書記素クラスタ境界: サロゲートペア、異体字セレクタ、結合文字、絵文字の ZWJ 連結
  - 位置換算: UTF-16 コード単位と書記素クラスタ数のずれがある本文
  - 引用照合: 同一引用の反復、検査対象と参考文脈の境界をまたぐ引用、本文端
  - LLM 応答: 不正 JSON、`reasoning_content` の分離、`finish_reason == "length"`、空配列
- LLM を実際に呼ぶテストはローカル環境依存なので、通常のテストからは分離する。

## コマンド

```sh
pnpm install          # 依存の導入（better-sqlite3 は同梱のビルド済みバイナリを使い、ビルドしない）
pnpm check            # typecheck + lint + test をまとめて実行
pnpm typecheck        # パッケージごとに tsc -p --noEmit
pnpm lint             # biome check .
pnpm format           # biome format --write .
pnpm test             # vitest run（全パッケージ）
pnpm build            # web のビルド
pnpm dev              # server（node --watch）と web（vite）を同時起動
pnpm start            # server を起動し、ビルド済み web を配信
```
