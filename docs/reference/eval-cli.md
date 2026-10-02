# 評価用 CLI（`packages/cli`）

原稿ファイルに検査パイプラインを回して結果 JSON を出し、正解データと突き合わせて仕様書 10 節の指標を
出す評価用の CLI。サブコマンドは `run`（既定）／`evaluate`／`aggregate`／`hash`／`full-chat`／`check-truth`。
先頭の引数が `--` で始まる場合と引数が無い場合は `run` に振られるので、旧来の起動
（`... --manuscript x --model y`）もそのまま動く。ルートの `pnpm eval` はこの CLI のショートカットで、
次の 2 つはどちらも同じように動く。

```sh
pnpm eval <サブコマンド> [オプション...]
node packages/cli/bin/shuten-eval.ts <サブコマンド> [オプション...]
```

## `run`：検査パイプラインを回す

```sh
pnpm eval run --manuscript <path> --model <id>
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
思考ありで動かすときは `--reasoning-effort low|medium|high` を渡す（決定記録 [0003](../decisions/0003-lm-studio-connection.md) の 2026-09-09 の追記）。

分割長などの既定値は実原稿での評価（決定記録 [0004](../decisions/0004-evaluation-settings.md)）に基づく仮置きで、使用の中で見直す。`--max-tokens` の既定は 4,000（分割方式向け。`--mode full-text` では 16,000 程度を明示する）。

## `evaluate` / `aggregate`：正解データと突き合わせる

正解ファイル（`--truth`）の書き方は [truth-format.md](truth-format.md)。
原稿・正解ファイル・結果 JSON の本文ハッシュが一致していることを確認してから採点する
（`pnpm eval hash` でハッシュ値を取れる。後述）。

```sh
pnpm eval evaluate --manuscript <原稿> --truth <正解.json> --result <結果.json> \
                   [--out <指標.json>] [--report <レポート.md>]
pnpm eval aggregate --manuscript <原稿> --truth <正解.json> \
                    --result <結果1.json> --result <結果2.json> [--result ...] \
                    [--out <集計.json>] [--report <レポート.md>]
```

`evaluate` は 1 回の実行を仕様書 10 節の指標（誤りの検出率、誤検出、位置特定失敗率、許容語の抑制、
実行性能）で採点する。率はすべて `{ numerator, denominator, rate }` で、分母が 0 なら `rate` は `null`。
人手で判断する指標（修正案の妥当性、人間の確認負担、診断候補の正誤）はレポートに空欄の列として示す。
指標 JSON には持たない。

`aggregate` は同じ条件で複数回実行した結果のぶれを、`--result`（2 本以上必須）から集計する。
各指標の最小・中央値・最大と、正解項目ごとの検出回数 k/N を出す。実行条件（モデル・観点・分割設定・
タイムアウトなど）が 1 本でも食い違うと、ぶれを測れないため集計せずエラーになる。

どちらも `--out` を指定しなければ指標 JSON を標準出力に書く。`--report` を指定すると Markdown の
レポート（人手の欄を含む）を追加で書く。品質の合否は判定しない（終了コードは指標の良し悪しでは変わらない。
数値目標は未決のまま。仕様書 10・13 節）。

**`--export`（サーバー経由の実行結果）を使う場合。** `--result`（CLI が書いた結果 JSON）の代わりに、
`GET /api/runs/:id/export` が返すエクスポート JSON を渡せる。本文がエクスポートに埋め込まれているため、
`--export` を使うときは `--manuscript` を渡さない。

```sh
pnpm eval evaluate --export <エクスポート.json> --truth <正解.json> \
                   [--out <指標.json>] [--report <レポート.md>]
pnpm eval aggregate --export <エクスポート1.json> --export <エクスポート2.json> [--export ...] \
                    --truth <正解.json> [--out <集計.json>] [--report <レポート.md>]
```

`aggregate` は `--result` と `--export` を混ぜて渡すこともできるが、CLI 経由の実行とサーバー経由の
実行を混ぜた集計は、実行条件（`versions.result`）が異なるため必ず条件不一致で止まる。同じ種類どうし
（`--result` どうし／`--export` どうし）なら集計できる。

エクスポートは、サーバーが待ち受けているアドレスに対して次のように取得する
（実行 ID は `GET /api/runs` などで確認する）。

```sh
curl http://localhost:<ポート>/api/runs/<実行ID>/export -o export.json
```

## `full-chat`：全文チャット方式で 1 回生成する

仕様書 10 節が比較対象としている「現在の全文チャット方式」を、同じ条件で記録できるようにしたもの。
現在の全文チャット方式とは、利用者が LM Studio のチャットに原稿を貼り、自分の指示で校正させている運用を指す。

```sh
pnpm eval full-chat --manuscript <原稿> --model <id> --prompt-file <プロンプト.txt> \
                    [--system-prompt-file <system.txt>] \
                    [--out <結果.json>] [--max-tokens N] [--temperature X] [--seed N] \
                    [--reasoning-effort none|low|medium|high] [--check-timeout-ms N]
```

**プロンプトは利用者が書く**。こちらでは書かない（書いた時点で比較対象ではなく別のアプリの
プロンプトになる）。プロンプトファイルには原稿を差し込む位置を `{{manuscript}}` で示す。
1 つも無ければエラーになり、2 つ以上あればすべて置換される。

- 構造化出力は使わない。分割も参考文脈も許容語の抑制も位置特定も通らない
- 既定では `user` 1 通だけ。`--system-prompt-file` を渡すとその内容をそのまま `system` として
  先頭に付ける（差し込みはしない）。普段 system に指示を置いて原稿を user で貼っている運用を
  再現するには、`--prompt-file` に `{{manuscript}}` だけを書いたファイルを渡す
- 生成は **1 回だけ**。`run` と違って再試行しない
- `--max-tokens` の既定は 16,000 で、`run` の既定（4,000。分割方式向け）とは別。応答全体を 1 要求で
  受けるため長く、打ち切り（`length`）は失敗になるので、必要なら上げる
- `finish_reason` が `stop` 以外（打ち切り `length`、`tool_calls` など）はすべて失敗として記録し、
  打ち切られた本文を成功として保存しない
- 結果 JSON に**原稿本文もプロンプトも入れない**。どのプロンプトで取ったかは `promptHash`
  （差し込み前のプロンプトのハッシュ）で照合する。`systemPromptHash`（未指定なら `null`）も同様
- 終了コードは 0 = 成功、1 = 引数・入出力の誤り、2 = 生成の失敗。失敗でも結果 JSON は書く

**`evaluate` / `aggregate` には渡せない**。自由形式の応答から指摘を機械的に取り出すことはできないため
自動採点しない（結果 JSON の `formatVersion` は `"full-chat/2"` で、`"full-chat/"` 始まりはすべて拒否される）。
応答は人が読んで正解ファイルと突き合わせる。

1 万字を 1 要求で投げるので、既定のタイムアウト（300 秒）では足りない場合がある。
`--check-timeout-ms` で伸ばすこと。

## `check-truth`：正解ファイルを検証する

```sh
pnpm eval check-truth --manuscript <原稿> --truth <正解.json> [--report <失敗レポート.md>]
```

利用者が手で書く正解ファイルを、LLM を回さず・結果 JSON も無しで検証する。検査するのは次の 4 点。

- 正解ファイルの形式（zod 検証。`docs/reference/truth-format.md`）
- 原稿との `bodyHash` 照合（`hash` で取った値と正解ファイルの `manuscript.bodyHash` が一致するか）
- `paragraphId` が原稿の段落数の範囲内か
- `quote` が該当する段落の本文に存在し、`occurrence` 番目の出現まで足りているか

LM Studio には接続しない。

終了コードは 0 = 検証を通った、1 = 引数・入出力の誤り（読み込めない、出力先の衝突、レポートの
書き出し失敗を含む）、2 = 正解ファイルの内容の誤り（JSON 構文、zod 検証、`bodyHash` 不一致、
位置解決の失敗）。両方が起きたとき（内容に誤りがあり、かつレポートを書けなかったとき）は 1 を返す。

標準エラーに出るのは失敗した項目の `id`・段落番号・件数だけ。**本文の該当箇所を添えた詳細は
`--report` を指定したときだけ**そのファイルに出す（引用や原稿本文を標準出力・標準エラーに出さない
ため）。

`evaluate` は結果 JSON が無いと使えない（LLM を回す必要がある）ため、正解ファイルを書きながら
繰り返し検証したいときはこちらを使う。

## `hash`：原稿の本文ハッシュを出す

```sh
pnpm eval hash --manuscript <原稿>
```

正解ファイルの `manuscript.bodyHash` に貼るハッシュ値を標準出力に 1 行だけ出す。LM Studio には接続しない。
`sha256sum` の結果とは一致しない（BOM を除いた本文文字列のハッシュのため）ので、必ずこのコマンドで取る。
