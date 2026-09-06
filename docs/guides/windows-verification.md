# Windows での動作確認手順

MVP の標準実行環境は Windows（仕様書 2 節）。scaffold は WSL で検証済みだが、
Windows では特に better-sqlite3 の同梱バイナリと改行の扱いを確認する必要がある。
この手順は Windows 側の Claude Code がそのまま実行できるように書いている。

## 前提

- Node.js 24.20.0（`.node-version` に完全版を固定。`engines` の範囲は 24 系全体）
- pnpm 10.17.1（`package.json` の `packageManager`）。`npm install -g pnpm@10.17.1` か、
  volta を使うなら `volta install pnpm@10.17.1`
- git の `core.autocrlf` が `true` でも `.gitattributes` が優先されるが、念のため確認する

```powershell
node --version
pnpm --version
git config core.autocrlf
```

## 手順

1. 依存のインストール。better-sqlite3 はビルドしない設定（`pnpm-workspace.yaml` の `ignoredBuiltDependencies`）なので、
   node-gyp が起動しないこと、Visual Studio Build Tools を要求されないことを確認する。
   CI の `windows-latest` では確認済み。

   ```powershell
   pnpm install
   ```

2. better-sqlite3 のバインディングが読み込めることを確認する。

   ```powershell
   node -e "const D=require('./packages/server/node_modules/better-sqlite3'); console.log(D(':memory:').prepare('select sqlite_version() v').get())"
   ```

3. 型検査、lint、テストをまとめて実行する。テストには DB のメモリ往復と
   `Intl.Segmenter` の書記素判定（絵文字 ZWJ、異体字セレクタ、CRLF）が含まれる。

   ```powershell
   pnpm check
   ```

4. web をビルドし、サーバーを起動して確認する。

   ```powershell
   pnpm build
   pnpm start
   ```

   別のターミナルで：

   ```powershell
   curl.exe http://127.0.0.1:3000/api/health
   ```

   `{"status":"ok","node":"v24.x.x","graphemeCheck":1}` が返り、ブラウザで
   `http://127.0.0.1:3000/` を開くと「朱点」の画面にサーバー側とブラウザ側の書記素計数が
   どちらも 1 と表示されること。

5. fixture の改行が保持されていることを確認する（fixture を追加した後に実施）。

   ```powershell
   git ls-files --eol packages/shared/test/fixtures
   ```

   `i/crlf` や `i/mixed` のファイルが `w/` 側でも同じであること。

## 記録

確認結果は `docs/decisions/0002-scaffold-conventions.md` の「検証状況」に追記する。
better-sqlite3 で node-gyp が起動した場合は設定の問題なので、その旨を必ず残す。
