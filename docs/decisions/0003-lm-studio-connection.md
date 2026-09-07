# 0003. LM Studio 接続検証の結論

日付：2026-09-07  
状態：決定（初回検証に基づく。数値は評価時に再計測する）  
検証したモデル：`qwen/qwen3.8-27b`、`google/gemma-4-31b-qat`  
根拠：`docs/experiments/2026-09-07-lm-studio-connection/`

## 決定

- **HTTP 切断をキャンセル要求として扱う（仕様書 8.2 節）は成立する。** curl のストリーミング・非ストリーミング、
  Node の `fetch` + `AbortController` のいずれでも、切断後の最初の観測（1〜3 秒後）で IDLE になり、以後も維持した。
  観測は `lms ps` の応答時間を含むため、停止時刻そのものは確定できない。
  「復旧待ち」の経路は、切断が効かない環境への備えとして残す。
- **接続確認では生成要求の前に `GET /api/v0/models` で `state` を確認する。** `not-loaded` なら生成要求を送らず、
  LM Studio 側でのロードをユーザーに案内する。未ロードのモデルへの生成要求は JIT ロードを起こし、
  LM Studio 既定のコンテキスト長で VRAM が溢れることがある。ウォームアップ用の小さな生成はロード済みのときだけ送る。
- **実行記録には `GET /api/v0/models` の `quantization` と `loaded_context_length`、応答の
  `usage.completion_tokens_details.reasoning_tokens` を保存する**（仕様書 10 節の実行条件の記録）。
- **構造化出力は `response_format: json_schema` の `strict: true` を使う。** スキーマどおりの JSON だけが返る。
- **思考は `message.reasoning_content` に分離される。** `content` 内の `<think>` を分離する処理は、
  必要になったモデルに限定して実装する（仕様書 7 節）。
- **思考モデルの `max_tokens` は思考込みで予算配分する。** 1,500 字の検査対象に対する初期値は 16,000 とし、
  実測で調整する。`finish_reason: "length"` は出力打ち切りとして扱い、`content` が空でも正常な空配列と混同しない。
- **思考の無効化はトップレベルの `reasoning_effort: "none"` で行う。** qwen、gemma とも思考が完全に止まった
  （`reasoning: { effort }` の入れ子形式、`chat_template_kwargs`、`/no_think` は効かない）。
  思考の有無は生成設定として実行記録に残し、評価で比較する。思考なしの qwen は 906 字を 4.7 秒で処理し、
  埋め込んだ誤り 3 件を検出した。
- **JSON スキーマの `description` は、今回のモデル・ランタイムではモデルに渡らなかった。** スキーマは文法制約にだけ
  使われていた。仕様としては、各項目の意味（引用、前後の引用、修正案、理由）をプロンプト本文にも明記する。
- **比較実験では `seed` を固定する。** temperature 0.7 でも同じ seed で同一出力になった。
- 切断による停止、`reasoning_content` の分離、`json_schema`、seed は、今回の構成（LM Studio 0.4.23、
  llama.cpp CUDA 12 ランタイム 2.33.0、上記 2 モデル）で確認済み。他のランタイム・モデル・通信障害時の挙動は
  保証しないため、スキーマ検証、構造化出力に未対応の場合の経路、生成終了未確認時の「復旧待ち」は維持する。
- **WSL2（NAT 構成）から Windows 側の LM Studio へ接続する場合は、`localhost` ではなくデフォルトゲートウェイの IP を使う。**
  IP は環境や再起動で変わるため設定に固定値を書かず、接続先 URL は環境変数で与える。
  WSL の `networkingMode=mirrored` では Windows 側へ `127.0.0.1` で届くため、この扱いは不要。

## 追試：生成した実スキーマでの疎通（2026-09-08、PR5）

`packages/shared` の `checkOutputJsonSchema()`（zod から生成した検査出力のスキーマ）をそのまま
`response_format` に渡し、応答を `llmCheckOutputSchema` で検証できることを確認した。qwen（ロード時
コンテキスト長 160,000、`reasoning_effort: "none"`、`max_tokens` 2,000）で 2.2 秒。

- **`minimum`・`minLength`・`type: ["string", "null"]`・`enum` を含むスキーマが `strict: true` で通る。**
  接続検証（2026-09-07）で試したのは文字列項目だけだったので、この 4 つは未確認のまま残っていた。
- `GET /api/v0/models` は `id`・`type`・`state`・`quantization`・`max_context_length`・
  `loaded_context_length` を返す。**`type` は qwen・gemma とも `vlm`**（`llm` ではない）。
  生成に使えるモデルを種別で絞るときは `llm` だけにしない。
- 未確認のまま残るもの：`input-too-long` の判定文字列（ロード時コンテキスト長を超える要求が要る）、
  実行中アンロード時の応答（`unloaded` の印）。

## 接続先の既定値

Windows 上で動かす標準構成では仕様書 7 節どおり `http://127.0.0.1:1234`（LM Studio のルート。
生成は `/v1/chat/completions`、一覧と状態は `/api/v0/models`。仕様書 v0.8 で設定値をルートに統一した）。
WSL2 の NAT 構成で動かす場合はゲートウェイ IP を環境変数で指定する（手順は experiments の README）。

## 未決のまま残す項目（仕様書 13 節）

| 項目 | 状態 |
| --- | --- |
| モデル ID | 未決。1 原稿の観察では qwen 思考なし（4.7 秒、3/3）が最も有望。gemma は思考の有無によらず 2/3。評価原稿で比較する |
| プロンプト、生成パラメーター | 未決。`max_tokens` の初期値だけ 16,000 |
| タイムアウト | 未決。思考ありの qwen で 1 要求 2〜3 分、思考なしなら 10 秒前後。思考の有無で別の値にする |
| 分割長と文脈長の実測調整、評価原稿 | 未決 |

## 品質の初期観察（評価ではない）

反復のない 906 字の創作文に埋め込んだ誤り 3 件（重複、助詞抜け、誤変換）に対し、qwen は思考の有無によらず 3 件すべてを検出、
gemma は思考の有無にかかわらず助詞抜けを見逃して 2 件。どちらも誤検出はなく、引用は完全一致で位置を確定できた。
一方、小さな試行では qwen が助詞の重複を「文法の問題」と判断して見逃し、gemma は検出した。
観点の定義をプロンプトでどう書くかが検出率を左右する。また、`before` / `after` / `suggestion` の意味を
取り違える応答が両モデルで出ており、各項目の意味をプロンプト本文に明示する。修正案は「引用全体に対応し、
変更内容を最小限にする」と指示する。文全体を引用して必要な文字だけを直した応答はこの条件を満たしており、
引用を短くする改善とは分けて扱う。
所要時間と思考量はモデル固有の値で、モデルを変えれば再計測が必要。
