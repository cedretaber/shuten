# 0002. scaffold の規約と版の方針

日付：2026-09-07  
状態：決定

## 決定

### 版の方針

主要ツールは公開時点の最新安定版を採用し、`package.json` で完全固定する（`^` を付けない）。

| ツール | 版 | 備考 |
| --- | --- | --- |
| Node.js | 24.x（`engines`、`.node-version`、`volta`） | Active LTS |
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
  `pnpm-workspace.yaml` の `onlyBuiltDependencies` で `better-sqlite3` と `esbuild` を許可する。
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
- WSL では better-sqlite3 のビルド済みバイナリ取得に失敗し、node-gyp でのソースビルドにフォールバックした
  （ビルド自体は成功）。Windows では別途確認が必要。手順は `docs/windows-verification.md`。
- Windows での確認は未実施。

## 却下した案

- **tsx による開発実行**：Node 24 の標準機能で足りるため依存を増やさない。
- **project references（`tsc -b`）**：`noEmit` の参照先を許可しないため、パッケージごとの `tsc -p` に変更した。
- **`shared` のビルド工程**：Vite も Node もソースを直接解決できるため不要。
