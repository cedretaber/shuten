# LM Studio 接続検証（2026-09-07）

仕様書 13 節の「実装前・初期検証で決める事項」のうち、LM Studio との接続に関わる項目を実測した。
結論は `docs/decisions/0003-lm-studio-connection.md` にまとめている。本書は手順と結果の記録で、
同じ要求とスクリプトで再検証できるようにしてある。

## 検証環境

| 項目 | 値 |
| --- | --- |
| OS | Windows 11 Pro（26200）。検証は WSL2（2.5.10、Ubuntu）から実施 |
| CPU / メモリ | Intel Core Ultra 9 285K / 128 GB |
| GPU | NVIDIA GeForce RTX 5090（VRAM 32 GB）、ドライバ 616.56 |
| LM Studio | 0.4.23、推論ランタイム llama.cpp CUDA 12 版 2.33.0 |
| モデル | `qwen/qwen3.8-27b`（Q4_K_M、17.7 GB）、ロード時コンテキスト長 約 20 万トークン |
| LM Studio 側の並列数 | 4 |

WSL2 から Windows 側の LM Studio へ接続するには、`localhost` ではなく Windows ホストの IP を使う。
WSL2 の既定のネットワークではデフォルトゲートウェイがそれに当たる。

```sh
export LM_STUDIO_URL="http://$(ip route | awk '/default/ {print $3}'):1234"
```

LM Studio 側は「ローカルネットワークに公開」を有効にしておく。
モデルの状態は Windows 側の CLI `lms ps`（`%USERPROFILE%\.lmstudio\bin\lms.exe`）で観察できる。
WSL からは `/mnt/c/Users/<ユーザー名>/.lmstudio/bin/lms.exe` を `LMS` 環境変数で指定する。

## 手順と結果

要求は `requests/`、スクリプトは `scripts/` にある。`scripts/send.sh <request.json>` で送信できる。

### 1. 接続確認と最小の生成（`01-minimal.json`）

- `GET /v1/models` は登録モデルの一覧だけを返し、ロード状態を含まない。
- `GET /api/v0/models`（LM Studio 固有）は `state`（loaded / not-loaded）、`quantization`、`max_context_length`、
  ロード中なら `loaded_context_length` を返す。
- モデル名を指定しない生成要求は、未ロード時に 400（`No models loaded`）で即座に返る。
- **モデル名を指定した生成要求は、未ロードなら JIT ロードを起こす。** LM Studio 側のモデル既定値である
  コンテキスト長（約 26 万トークン）でロードしようとして VRAM が溢れ、約 104 秒後に
  `{"error": "Model unloaded by user or API request."}` が返った。手動でコンテキスト長を下げてロードし直した。
- ロード後の最小要求は約 1 秒で応答。思考は `message.reasoning_content` に分離され、`content` には本文だけが入る。

### 2. 構造化出力（`02-json-schema-small.json`）

`response_format: { type: "json_schema", json_schema: { strict: true, ... } }` を指定。

| max_tokens | finish_reason | reasoning_tokens | content |
| --- | --- | --- | --- |
| 512 | `length` | 512 | 空文字 |
| 4096 | `stop` | 954 | `{"findings": []}` |

- スキーマどおりの JSON だけが返る。思考が予算を使い切ると `content` は空になる。
- 「駅にに向かった」の助詞重複を拾わなかった。思考の中で「文法の問題であり誤字ではない」と判断していた。
  観点の定義をプロンプトでどう書くかが検出率に直結する。

### 3. seed の再現性（`03-seed.json`）

temperature 0.7、max_tokens 600。seed 42 で 2 回とも同一の出力、seed 7 で別の出力。seed は有効。

### 4. 思考の無効化（`04`〜`06`）

| 方法 | 結果 |
| --- | --- |
| `chat_template_kwargs: { enable_thinking: false }` | 無視される（reasoning_tokens 61、指定なしと同じ） |
| メッセージ先頭に `/no_think` | 出力の順序が変わるだけで思考は続く（reasoning_tokens 78） |
| `reasoning: { effort: "none" }` | 無視される |

このモデルでは思考を止められない。`max_tokens` は思考込みで予算配分する。

### 5. HTTP 切断で生成が止まるか（`07`、`08`、`scripts/disconnect-test.sh`、`scripts/abort-test.mjs`）

2000 までの整数を書かせる長い生成を開始し、数秒後に接続を切って `lms ps` の状態と GPU 使用率を毎秒記録した。

| 方法 | 切断前 | 切断後 1 秒 |
| --- | --- | --- |
| curl、`stream: true`、6 秒後に kill | GENERATING、GPU 83〜87% | IDLE、GPU 3% |
| curl、`stream: false`、6 秒後に kill | GENERATING、GPU 84〜89% | IDLE、GPU 0〜1% |
| Node 24 `fetch` + `AbortController.abort()`、3 秒後 | GENERATING | IDLE。`fetch` は `AbortError` で reject |

3 通りとも切断から 1 秒以内に生成が止まり、その後 10〜25 秒観察しても再開しなかった。
非ストリーミングでも、応答を書き出す前に切断を検知している。

### 6. 実サイズの入力（`09`、`10`）

**`09-repetitive-synthetic-1500.json`**：同じ 8 段落を繰り返して 1,500 字にした合成テキスト（前後に参考文脈 1,000 字ずつ、計 3,784 字、prompt_tokens 2,492）。

| max_tokens | 所要 | finish_reason | reasoning_tokens |
| --- | --- | --- | --- |
| 8,000 | 76 秒 | `length` | 7,918 |
| 40,000 | 363 秒 | `length` | 38,514 |

思考が「段落の反復は誤りか」を延々と検討し、終わらなかった。合成テキストの反復に引きずられた結果で、
実文とは条件が異なる。ただし思考の暴走は起こり得るものとして、`max_tokens` 到達を出力打ち切りとして扱う根拠になる。
出力側の速度は約 105 トークン/秒。

**`10-realistic-906.json`**：反復のない創作文 906 字に、重複（手をかけけた）、助詞抜け（余計なこと考えずに）、
誤変換（屋根の下え）を 1 件ずつ埋め込み、前後に短い参考文脈を付けた。max_tokens 16,000。応答は `10-realistic-906.response.json`。

- 所要 86 秒、prompt_tokens 897、reasoning_tokens 8,384、`finish_reason: stop`。
- 3 件すべてを検出し、誤検出なし。修正案は最小限。
- 引用 3 件はいずれも原文に 1 回だけ完全一致し、位置を確定できた。1 件の `after` は改行を省いていたが、
  引用だけで一意なので仕様書 6.2 節のとおり失敗にしない。
- 思考は英語で、本文の各文を順に検討していた。思考量は本文長にほぼ比例すると見られる。

## 考察

- 切断による停止は仕様書 8.2 節の前提として成立する。「復旧待ち」は切断が効かない環境への備えとして残す。
- 接続確認では `GET /api/v0/models` で `state` を確認し、`not-loaded` なら生成要求を送らない。
  仕様書 7 節のウォームアップ用の小さな生成は、ロード済みの場合だけ送る。
- 思考モデルでは `max_tokens` を思考込みで決める。1,500 字の検査対象なら 16,000 を初期値にし、実測で調整する。
- 906 字で 86 秒なので、1,500 字の検査対象で 1 観点 2〜2.5 分、1 万字（7 分割 × 2 観点）の初回検査で約 30 分の見積もり。
- 上記の思考量・所要時間はこのモデル固有の値。他のモデル（gemma 4 など）は未検証で、`reasoning_content` の有無も含めて再計測が必要。

## 再検証するとき

1. LM Studio でモデルをロードし、コンテキスト長を VRAM に収まる値にする。
2. `LM_STUDIO_URL` と `LMS` を設定する。
3. `scripts/send.sh requests/01-minimal.json` から順に送る。
4. 切断実験は `scripts/disconnect-test.sh requests/08-long-output-nostream.json` と
   `node scripts/abort-test.mjs requests/08-long-output-nostream.json`。
5. 結果をこの README に日付付きで追記するか、新しい日付のディレクトリを作る。

## 追試：`google/gemma-4-31b-qat`（2026-09-07）

同じ要求の `model` を `google/gemma-4-31b-qat`（Q4_0、ロード時コンテキスト長 80,640。VRAM 32 GB に収まる上限）に
差し替えて実施した。qwen はアンロード済み。新規に作った要求は `11`、`12`。

### 応答形式・seed・切断

- 思考は qwen と同様に `reasoning_content` へ分離される。思考は英語。
- `json_schema` strict は有効。seed は有効（seed 42 で 2 回同一）。
- 切断実験（Node `fetch` abort、curl 非ストリーミング）はいずれも切断から 1 秒以内に GENERATING → IDLE、
  GPU 使用率 92% → 3%。生成開始前には `PROCESSINGPROMPT` という状態も観察された。
- 未ロード時の挙動は再検証していない。

### 思考の無効化

| 方法 | 結果 |
| --- | --- |
| `chat_template_kwargs: { enable_thinking: false }` | 無視される |
| `/no_think` | 無視される |
| `reasoning: { effort: "none" }` | 思考が少し減る（134 → 97 トークン）が止まらない |
| **`reasoning_effort: "none"`（トップレベル）** | **思考が完全に止まる（reasoning_tokens 0）** |

qwen では `reasoning: { effort }` の入れ子形式しか試しておらず、トップレベルの `reasoning_effort` は**未検証**。
次に qwen をロードしたときに `11` と同じ形で確認する。

### 実文テスト（906 字、誤り 3 件）

| モデル | 思考 | 所要 | reasoning_tokens | 検出 | 誤検出 | 引用の完全一致 |
| --- | --- | --- | --- | --- | --- | --- |
| qwen/qwen3.8-27b | あり（止められない） | 86 秒 | 8,384 | 3 / 3 | 0 | 3 / 3 |
| google/gemma-4-31b-qat | あり | 24 秒 | 1,230 | 2 / 3 | 0 | 2 / 2 |
| google/gemma-4-31b-qat | なし（`reasoning_effort: none`） | 5 秒 | 0 | 2 / 3 | 0 | 2 / 2 |

- gemma は思考の有無にかかわらず、助詞抜け（「余計なこと考えずに」）を見逃した。重複と誤変換は検出。
- gemma の引用は短い（「かけけた」「下え」）が原文に 1 回だけ一致し、`before` / `after` も正しかった。
- gemma は思考量が qwen の 1/7 で、所要時間は 1/3.5。思考なしなら 1/17。

### 小さな試行（「駅にに向かった」）での項目の取り違え

gemma は qwen が見逃した助詞の重複を検出したが、`before` に引用、`after` に修正後、`suggestion` に理由、
`reason` に分類を入れており、項目の意味を取り違えていた（要求 `02`）。

JSON スキーマの各項目に `description` を付けた要求 `12` を送っても、`prompt_tokens` が 89 で変わらず、
出力も同一だった。**LM Studio の構造化出力はスキーマを文法制約にだけ使い、`description` はモデルに渡らない。**
項目の意味はプロンプト本文に書く必要がある。実文テスト（`10`）ではシステムプロンプトに各項目の説明があり、
取り違えは起きていない。

### 考察の追記

- 切断による停止、`reasoning_content` の分離、`json_schema`、seed はモデルに依存せず LM Studio 側の挙動と見てよい。
- 思考の無効化の可否と、思考量・所要時間はモデル固有。`reasoning_effort` はトップレベルで送る。
- 検出率は 1 原稿 1 回の観察で優劣を決められない。仕様書 10 節の評価原稿で、思考の有無を含めて比較する。
  qwen は遅いが 3/3、gemma は速いが 2/3 という傾向は、評価設計（再確認の有無との組み合わせ）に影響する。

## 追試：qwen でトップレベルの `reasoning_effort`（2026-09-07）

qwen を再ロード（コンテキスト長 201,728）し、要求 `13` で確認した。

- **`reasoning_effort: "none"` は qwen でも効く。** reasoning_tokens 0、小さな要求は 3 秒。
- 実文 906 字（誤り 3 件）：**4.7 秒、3 / 3 検出、誤検出なし**（思考ありは 86 秒で 3 / 3）。
- 引用は文全体（例：「佐和は袖をまくり、〜手をかけけた。」）で、3 件とも原文に 1 回だけ完全一致し位置を確定できた。
  一方 `before` / `after` は 3 件とも引用の内側の文字列を返しており、意味を取り違えている。
  引用だけで一意なので位置特定には影響しないが、項目の意味はプロンプトで明確にする必要がある（gemma の `02` と同じ課題）。
- 修正案は文全体を返している。「最小限の修正案」の粒度もプロンプトで指示する。

更新後の比較（906 字、誤り 3 件、1 回の観察）：

| モデル | 思考 | 所要 | reasoning_tokens | 検出 | 誤検出 |
| --- | --- | --- | --- | --- | --- |
| qwen/qwen3.8-27b | あり | 86 秒 | 8,384 | 3 / 3 | 0 |
| qwen/qwen3.8-27b | なし | 4.7 秒 | 0 | 3 / 3 | 0 |
| google/gemma-4-31b-qat | あり | 24 秒 | 1,230 | 2 / 3 | 0 |
| google/gemma-4-31b-qat | なし | 5.2 秒 | 0 | 2 / 3 | 0 |

思考なしの qwen が最も有望に見えるが、1 原稿 1 回の観察であり、評価原稿で「思考あり／なし」を生成設定の
1 軸として比較する。先に記した「思考は止められない」は、入れ子形式と `chat_template_kwargs` を試した時点の
結論であり、トップレベルの `reasoning_effort` で訂正する。
