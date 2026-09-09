# Windows での動作確認手順

MVP の標準実行環境は Windows で、バックエンドも Windows 上で動かす（仕様書 2 節）。
開発ツールを WSL で使うことと、アプリを WSL で実行することは区別する。

確認の内容は 3 つに分かれる。**人が手を動かすのは 2 番目だけ**である。

1. **CI が毎回確認していること** — 人の作業は要らない。
2. **Windows で人が確認すること** — CI では代替できない。PR11 のマージ条件。
3. **診断のときだけ使う手順** — 改行の問題が起きたときに使う。常時のゲートではない。

## 1. CI が毎回確認していること

`.github/workflows/ci.yml` の `check` ジョブは `matrix: [ubuntu-latest, windows-latest]` で回っている。
Windows 側で次がすべて通っている。

| 確認対象 | CI の該当ステップ |
| --- | --- |
| 依存の導入（node-gyp を起動しない。Visual Studio Build Tools を要求しない） | `pnpm install --frozen-lockfile` |
| 型検査・lint・テスト | `pnpm typecheck` / `pnpm lint` / `pnpm test` |
| web の本番ビルド | `pnpm build` |
| better-sqlite3 の同梱バイナリが読み込めること | `node -e "…require('better-sqlite3')…"` |
| Windows のパスでのファイル DB の作成・書き込み・閉じる・開き直す往復 | `pnpm test`（server のリポジトリ層のテスト） |
| CRLF・BOM・異体字セレクタ・結合文字・絵文字を含む本文の永続化と往復 | `pnpm test`（shared の fixture のテスト） |
| `.gitattributes` による fixture の改行の保持 | `pnpm test`（壊れていれば fixture のテストが落ちる） |

これらを Windows で手動で再確認する必要はない。**CI が赤いまま手元で確かめても、直すべきなのは CI である。**

## 2. Windows で人が確認すること

CI が一度も `pnpm start` を実行しないため、**サーバーを起動してブラウザから使う経路**だけが未確認で残る。
静的配信、SPA の直リンク、LM Studio への接続、コンソールからの終了がこれにあたる。

**実施の時期：PR11（web の画面）を実装し、CI が Ubuntu・Windows とも緑になった後、マージする前。**
PR11 より前に実施しても、確認対象の画面が PR11 で置き換わるため意味が薄い。

### 前提

- Node.js（`.node-version` に固定した版）と pnpm（`package.json` の `packageManager`）
- LM Studio が起動し、生成に使えるモデル（`llm` か `vlm`）が 1 つロード済み
- 数百字程度の**合成した文章**（実原稿は使わない。記録にも残さない）

```powershell
node --version
pnpm --version
```

### 手順

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm start
```

起動したまま、ブラウザと別のターミナルで次を確認する。

- [ ] `curl.exe http://127.0.0.1:3000/api/health` が JSON を返す
- [ ] ブラウザで `http://127.0.0.1:3000/` が表示される（静的配信が効いている）
- [ ] `http://127.0.0.1:3000/settings/connection` を**直接開いて**表示できる（SPA フォールバック）
- [ ] `http://127.0.0.1:3000/runs/does-not-exist` を直接開くと、サーバーの 404 ではなく
      **画面内の「その実行はありません」**が表示される
- [ ] 接続設定で `http://127.0.0.1:1234` に接続確認でき、ロード済みモデルが一覧に出る
- [ ] 合成した短い原稿を確定し、検査を 1 回開始できる。実行 ID と状態が表示される
- [ ] コンソールで Ctrl+C を押すと `shutdown: done` まで進み、プロセスが終了する
- [ ] もう一度 `pnpm start` して起動できる（SQLite のハンドルが正しく閉じられている）

最後の 2 つを外さないこと。`packages/server/src/index.ts` の graceful shutdown は
**Windows には `SIGTERM` が届かず、コンソールの Ctrl+C（`SIGINT`）だけが対象**という前提で書いてあるが、
その経路は CI を通らない。ここで初めて実機で通る。

品質の評価は不要である。Windows 上のブラウザ・バックエンド・SQLite・LM Studio が一周つながることだけ見る。

## 記録

確認結果は `docs/decisions/0002-scaffold-conventions.md` の「検証状況」に追記する。
`pnpm install` で node-gyp が起動した場合は設定の問題なので、その旨を必ず残す。
**合成原稿の本文や、機器固有の値（IP アドレス、ユーザー名を含むパス）は記録に含めない。**

## 3. 診断：改行が壊れたとき

fixture のテストが Windows でだけ落ちる、本文の改行が想定と違う、といった場合に使う。
常時のゲートではない。

```powershell
git config core.autocrlf
git ls-files --eol packages/shared/test/fixtures
```

`.gitattributes` の `-text` は `core.autocrlf` より優先される。4 ファイルとも `attr/-text` で、
`i/` と `w/` が同じであること。期待値は `bom-crlf.txt` と `crlf.txt` が `i/crlf w/crlf`、
`cr-mixed.txt` が `i/-text w/-text`（単独 CR を git がバイナリと判定する）、
`invalid-utf8.txt` が `i/lf w/lf`。
