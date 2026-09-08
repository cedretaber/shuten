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

## Node の `fetch`（undici）の既定タイムアウトを無効化する（2026-09-08、PR7 の試運転）

PR7 の試運転（gemma、思考あり）で、`checkTimeoutMs` に 900,000ms を渡した要求が **301,289ms** で
失敗した。原因は Node の `fetch` の実体である undici の **`headersTimeout` の既定 300 秒**である。
我々は `stream: false` で生成を頼むので、応答ヘッダーは生成が終わるまで来ない。つまり既定のままでは
300 秒が生成時間の事実上の上限になり、それより長いタイムアウトを設定しても意味がない。

さらに悪いことに、この打ち切りは我々の `AbortSignal` でもタイマーでもないため、`client.ts` の
`sendRequest` は `timeout` ではなく `connection`（`status` は null）に分類する。PR7 の executor は
`connection` を「応答を受け取れなかった通信失敗」＝生成が走り続けている可能性ありと解釈するので、
実行全体が `connection-lost`・`generationUnconfirmed: true` で止まっていた。仕様書 7 節が求める
「接続失敗とタイムアウトの区別」と「タイムアウトは代表的な入力長・出力長・推論モードで測って余裕を持たせる」
の両方に反する。

**決定**：クライアント 1 つにつき `new Agent({ headersTimeout: 0, bodyTimeout: 0 })` を 1 つ作り、
`listModels` と `chat` の `fetch` に `dispatcher` として渡して undici 側のタイムアウトを無効にする。
打ち切りの責任は `sendRequest` の `AbortSignal` とタイマーだけが持つ。`LmStudioClientOptions` には
任意の `dispatcher` を足し、テストと将来の呼び出し元が差し替えられるようにした。

- `undici` は **7 系（7.29.1 に固定）** を使う。`undici@8` の `Agent` は Node 24 の `fetch` に渡すと
  `UND_ERR_INVALID_ARG` で動かない。
- 効いていることの確認は実 HTTP サーバーを使う回帰テスト（`client.test.ts` の C47〜C49）で行う。
  役割はそれぞれ異なる。**C47** は `headersTimeout` を短くした Agent を渡すと `connection` になることを見る、
  dispatcher が実際に効いていることを判別できる唯一のテスト。**C49** は既定のクライアント（実 `fetch` ＋
  既定の Agent）に短い `timeoutMs` を渡し、undici 7 の Agent を Node 内蔵 `fetch` に渡すという版の境界を
  通っても自前のタイマーが先に効いて `timeout` になることを見る、本番経路の回帰テスト。**C48** は遅延
  2000ms のサーバーに既定のクライアントで要求して成功することを見るが、この遅延は修正前の既定値
  （undici の `headersTimeout` 300 秒）でも打ち切られないため、単体では dispatcher が効いていることの
  証明にはならない。役割は既定のクライアント（実 `fetch`）が壊れていないことのスモークテストで、
  undici の版が非互換になったとき（`UND_ERR_INVALID_ARG` など）に落ちて気づけるようにする。
  なお undici のタイマーは約 500ms 刻みなので、1 秒未満の `headersTimeout` でも発火は 1 秒前後になる。
  テストの遅延はそれを踏まえた値にしてある。

## 当面の通常運用では思考を無効にする（2026-09-09、PR7 の試運転）

PR7 の試運転（`docs/experiments/2026-09-08-pipeline-trial/`）では、思考ありによる校正品質の改善を
確認できなかった。一方で負担は大きい。gemma は思考ありで 1 要求 51.8〜431.1 秒かかり、
qwen は短文（657 字・2 観点）に対し 2 温度とも `max_tokens: 16,000` のほぼ全量を思考に使って
`finish_reason == "length"` で打ち切られ、2 温度・4 単位・8 要求のすべてが `truncated` に終わって
指摘 0 件だった。gemma は同じ切り出し入力（3,317 字）を思考なしなら 1 要求 8〜11 秒で処理している。

**決定**：当面の通常運用では思考を無効にする。`reasoning_effort` を省略してモデル既定に委ねるのではなく、
**`reasoning_effort: "none"` を明示的に送る**（モデル既定は qwen では思考ありのため）。
評価用 CLI の `--reasoning-effort` の既定も `none` にした（`packages/cli/src/args.ts`）。

これは**今回のモデル（`qwen/qwen3.8-27b` Q4_K_M、`google/gemma-4-31b-qat` Q4_0）・量子化・
プロンプト版 `"1"`・生成設定（`max_tokens: 16,000`、`seed: 1`、`temperature` 0 と 0.7）での判断**であり、
思考ありという方式やモデルの校正能力一般についての結論ではない。

- 思考ありは廃止しない。仕様書 10 節の比較実験の条件として残し、13 節の未決事項（モデルと生成設定）は
  未決のままにする。思考ありで動かすときは `--reasoning-effort low|medium|high` を明示的に渡す
- 将来 UI を作るとき（PR11）も、思考の初期設定は無効にする
- 確定は正解データを用いる PR13 の評価で行う。この決定はそれまでの暫定である
