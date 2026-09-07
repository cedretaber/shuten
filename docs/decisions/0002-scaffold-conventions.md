# 0002. scaffold の規約と版の方針

日付：2026-09-07  
状態：決定

## 決定

### 版の方針

主要ツールは公開時点の最新安定版を採用し、`package.json` で完全固定する（`^` を付けない）。

| ツール | 版 | 備考 |
| --- | --- | --- |
| Node.js | 24.20.0（`.node-version`、`volta` に完全版）。`engines` は `>=24 <25` をサポート範囲として別に明記 | Active LTS。24 系の最新を選び、セキュリティ修正に追随する |
| pnpm | 10.17.1（`packageManager`） | pnpm 10 は `packageManager` の版を自動で使う。corepack 不要 |
| TypeScript | 7.0.2 | Go 製のネイティブコンパイラ。2026-07 公開 |
| Vite | 8.2.2 | |
| Vitest | 5.0.0 | 2026-09-03 公開 |
| Biome | 2.5.12 | |

TypeScript 7 と Vitest 5 は公開から日が浅い。ツール間の互換問題が出た場合は、
TypeScript 6.0.x（JS 実装の最終メジャー）、Vite 7.x、Vitest 4.x へ戻す。
scaffold 時点では型検査・テスト・ビルドがすべて通ることを確認済み。

### 開発時のランタイム

- サーバーは Node.js 24 の標準の型除去で `.ts` を直接実行する（`node src/index.ts`）。tsx などの変換ツールは入れない。
- そのため TypeScript は `erasableSyntaxOnly` を有効にし、`enum`・`namespace`・パラメータプロパティなど
  型除去で消せない構文を禁止する。
- 相対 import と `shared` 内の import は `.ts` 拡張子を必ず付ける（`allowImportingTsExtensions`）。
- `shared` はビルドしない。`exports` が `src/index.ts` を直接指し、Vite と Node の双方がソースを読む。
- 型検査は `tsc -p --noEmit` をパッケージごとに実行する。project references は `noEmit` と併用できないため使わない。

### ワークスペース

- pnpm 10 は依存パッケージのインストールスクリプトを既定で実行しない。
  better-sqlite3 13 はビルド済みバイナリ（win32-x64、linux-x64 など）を npm パッケージ内に同梱しているため、
  ビルドを**許可しない**（`ignoredBuiltDependencies`）。許可すると node-gyp のソースビルドが走り、コンパイラのない
  環境や node-gyp が Visual Studio を認識できない環境で失敗する。esbuild の postinstall だけを `onlyBuiltDependencies` で許可する。
- `.gitattributes` で全体を `eol=lf` に正規化し、`packages/*/test/fixtures/` だけ `-text` にする。
  fixture は CRLF・単独 CR・BOM を意図的に含むため、git の改行変換を禁止する。
- Biome も `lineEnding: lf` を明示し、fixture を除外する。
- SQLite ファイルは `.data/`（`SHUTEN_DATA_DIR` で変更可）に置き、git 管理しない。

### サーバーの既定値

| 環境変数 | 既定値 | 用途 |
| --- | --- | --- |
| `SHUTEN_HOST` | `127.0.0.1` | 待ち受けアドレス（仕様書 9 節。既定はループバックのみ） |
| `SHUTEN_PORT` | `3000` | 待ち受けポート |
| `SHUTEN_DATA_DIR` | `.data` | SQLite などの保存先 |
| `SHUTEN_WEB_DIST` | `../web/dist` | 静的配信するビルド成果物。存在しなければ API のみ |

## 検証状況

- WSL（Linux、Node 24.8.0、pnpm 10.17.1）で `pnpm install`、型検査、Biome、テスト 11 件、web ビルド、
  サーバー起動と `/api/health` の応答、静的配信、127.0.0.1 での待ち受けを確認済み。
- 当初は `onlyBuiltDependencies` で better-sqlite3 のビルドを許可していたため、WSL でも CI の Windows でも node-gyp の
  ソースビルドが走った（Windows の CI は Visual Studio の検出に失敗）。同梱のビルド済みバイナリを使う設定に改めてからは、
  WSL と CI（Ubuntu / Windows）でビルドなしにバインディングを読み込めることを確認済み。手順は `docs/guides/windows-verification.md`。
- `@types/node` はランタイムに合わせて 24.x に固定する（26.x ではランタイムに無い API を型が許してしまう）。
- `drizzle-kit generate` が動作することを確認済み。生成物（`packages/server/drizzle/`）は仕様書 8.1 節の
  スキーマが入るまでコミットしない。
- `.gitattributes` の `-text` は、CRLF を含むファイルを `git add` して `git ls-files --eol` で
  `i/crlf w/crlf attr/-text` になることを確認済み。
- サーバーの既定パス（`.data`、`../web/dist`）は `packages/server` からの相対で解決する。
  `pnpm start` / `pnpm dev` 経由で起動すること。
- 既知の残課題（2026-09-07 時点）：drizzle-kit 経由で esbuild 0.18.20 が lockfile に残る。
  既知の脆弱性は esbuild の開発サーバー機能を使う場合に限られ、本プロジェクトでは使わない。
  依存更新時に追跡する。web の Vite 経由で `@types/node` 26.x も推移的に残るが、型検査が読むのは
  直接依存の 24.x であることを確認済み。
- Windows での確認：CI（`windows-latest`、Node 24.20.0）で install、typecheck、lint、test、build、
  better-sqlite3 のバインディング読み込みが通ることを確認済み（2026-09-07）。ユーザー環境の Windows での
  LM Studio を含む動作確認は未実施。
- PR1（原稿の取り込みと段落モデル）後：テスト 101 件が WSL と CI（Ubuntu / Windows）で通過（2026-09-07）。
- PR2（検査範囲と参考文脈の分割）後：テスト 180 件が WSL と CI（Ubuntu / Windows）で通過（2026-09-07）。
- PR3（引用照合・位置確定・診断候補）後：テスト 247 件が WSL と CI（Ubuntu / Windows）で通過（2026-09-07）。
- PR4（LLM 出力スキーマ、重複統合、許容語抑制）後：テスト 360 件が WSL と CI（Ubuntu / Windows）で通過（2026-09-08）。shared に zod 4.5.4 を追加。

## 却下した案

- **tsx による開発実行**：Node 24 の標準機能で足りるため依存を増やさない。
- **project references（`tsc -b`）**：`noEmit` の参照先を許可しないため、パッケージごとの `tsc -p` に変更した。
- **`shared` のビルド工程**：Vite も Node もソースを直接解決できるため不要。
