# PR5 詳細計画：設定と LM Studio クライアント

日付：2026-09-08  
状態：計画（レビュー待ち）  
ブランチ：`feat/pr5-lmstudio-client`  
上位計画：`docs/plans/2026-09-07-mvp-roadmap.md` の PR5 節

## 目標

`packages/server` に LM Studio の OpenAI 互換 API を呼ぶクライアントを作る。責務は 3 つだけ。

1. `GET /api/v0/models` でモデル一覧とロード状態を取り、`ensureLoaded` を提供する。各要求の直前にこれを呼ぶのは
   呼び出し側（PR7・PR9）の責務で、クライアントは `chat` の呼び出し自体を型では縛らない。
2. `POST /v1/chat/completions` で 1 回の生成要求を送り、応答の外枠（envelope）を検証して本文・思考・終了理由・
   使用トークンを返す。
3. 起こり得る失敗を仕様書 7 節の区分（`FailureReason`）に分類し、区別できる例外として投げる。

あわせて `config.ts` に接続先と API キーの設定を足し、実 LM Studio を使う統合テストの枠（`pnpm test:llm`）を作る。

対応する仕様：7（接続、未ロードの扱い、タイムアウト、`finish_reason == "length"`、失敗の区別、API キーを履歴に
含めない）、8.2（HTTP 切断をキャンセル要求として扱う）、9（既定はループバック）、決定記録 0003。
受け入れ条件：11 節 1 項（実 LM Studio で生成要求と結果取得）、19 項（出力打ち切りの検知）のクライアント側。

### この PR の対象外（MUST NOT）

実装者が「気を利かせて」足しがちなものを禁止として並べる。

- 応答本文（`content`）を JSON として解析しない。スキーマ検証も行わない。PR6 の `parseCheckResponse` の仕事。
  本 PR が検証するのは OpenAI 互換応答の外枠だけ。
- `<think>` の分離を実装しない。思考は `message.reasoning_content` に分離される（決定 0003）。
- 再試行しない。再試行回数の方針は呼び出し側（PR7・PR9）が持つ。
- ストリーミングを使わない。要求は常に `stream: false`。
- 生成終了の確認（`lms ps` 相当）や「復旧待ち」の状態遷移を持たない。PR7・PR9 の仕事。
- キュー・同時実行制御を持たない。単一キューは PR7 の実行器と PR9 のキュー。
- `chat` は内部で `ensureLoaded` を呼ばない。呼ぶのは呼び出し側（PR7・PR9）。
- プロンプト本文を持たない（PR6）。モデルのロード・アンロード操作を持たない（仕様書 7 節）。

## 全体の制約（`docs/reference/invariants.md`、ロードマップの全体の制約から）

- 未ロードのモデルに生成要求を送らない。各要求の直前に `state` を確認する経路を提供する。
- 中断・タイムアウト・送信後の接続失敗のいずれも生成終了の確認ではない（仕様書 8.2）。`aborted`・`timeout`・
  `connection` のどれについても、クライアントは「生成が止まった」ことを示唆する値を返さない。
  生成終了の確認と「復旧待ち」は PR7・PR9 の仕事。
- `finish_reason == "length"`、形式不正、接続失敗を正常な空配列に置き換えない。
- API キーをログ・履歴・出力に含めない。`Authorization` ヘッダーにだけ載せる。
- 待ち受けと接続先の既定はループバック（`http://127.0.0.1:1234`）。
- 依存の版は完全固定。相対 import は `.ts` 拡張子付き。`erasableSyntaxOnly`（`enum` を使わない）。
- `package.json` の scripts は Windows で動く書き方（環境変数の inline 代入を使わない）。
- 個人情報・機器固有の値（WSL のゲートウェイ IP など）をコミットしない。接続先は環境変数で与える。

## 作るもの

| ファイル | 責務 | 公開する名前 |
| --- | --- | --- |
| `server/src/lmstudio/types.ts` | 要求・応答のアプリ側の型 | `ChatMessage`、`ChatRequest`、`ChatResult`、`ModelInfo`、`Usage`、`ReasoningEffort`、`LmStudioClient`、`LmStudioClientOptions`、`LOADED_STATE` |
| `shared/src/run/failure-reason.ts` | 失敗理由の列挙（server・web・PR7 が共用） | `FAILURE_REASONS`、`FailureReason` |
| `server/src/lmstudio/errors.ts` | LM Studio 由来の例外 | `LmStudioError` |
| `server/src/lmstudio/wire.ts` | 受信 JSON の外枠の検証（手書きの型ガード）と、送信 JSON への変換 | `parseChatCompletion`、`parseModelList`、`toWireChatBody`（server 内部。`index.ts` からは公開しない） |
| `server/src/lmstudio/client.ts` | HTTP 呼び出しと失敗の分類 | `createLmStudioClient` |
| `server/src/config.ts`（改修） | 接続先と API キーの設定 | `ServerConfig` に `lmStudioUrl`、`lmStudioApiKey` を追加 |
| `server/vitest.integration.config.ts` | 実 LM Studio を使うテストの別プロジェクト（`tsconfig.json` の `include` にも足す） | — |
| `server/src/lmstudio/client.integration.test.ts` | 実機での一覧・状態・小さな生成・実スキーマ疎通 | — |

単体テストは同じディレクトリに `*.test.ts`（`client.test.ts`、`wire.test.ts`、`config.test.ts` の追記）。

## 設計上の決定

### 1. 接続先は「LM Studio のルート」。`/v1` を含めない（判断 5）

`GET /api/v0/models` は `/v1` の下にないため、設定値は `http://127.0.0.1:1234` のようなルートにする。
クライアントは末尾のスラッシュを取り除き、`${base}/v1/chat/completions` と `${base}/api/v0/models` を組み立てる。
（仕様書 7 節は v0.8 でこの形に改訂した。）

`/v1/models` は呼ばない。`/api/v0/models` が同じ一覧に `state`・種別などを加えて返すため、2 回呼ぶ意味がない。
仕様書 7 節は当初 `GET /v1/models` との併用を求めていたので、逸脱のまま実装せず **仕様書を v0.8 に改訂した**
（一覧の正本を `/api/v0/models` に一本化、接続先の設定値をルート URL に、種別で生成対象を絞る）。
決定記録 0003 の「接続先の既定値」も同時に直した。

設定は `config.ts` で読む。

```ts
readonly lmStudioUrl: string;          // SHUTEN_LM_STUDIO_URL、既定 http://127.0.0.1:1234。末尾の / を除去
readonly lmStudioApiKey: string | null; // SHUTEN_LM_STUDIO_API_KEY、未設定・空文字なら null
```

`lmStudioUrl` の作り方（`new URL().href` は `http://h:1234/` を返し、末尾スラッシュの扱いが混ざるので使わない）：

1. `raw.trim()` を `new URL()` に渡し、解析失敗は例外。
2. `protocol` が `http:` / `https:` 以外なら例外。
3. `pathname` が `/^\/+$/`（スラッシュだけ）に一致しなければ例外。`http://h:1234/v1` のような誤設定を
   起動時に落とす（`http://h:1234//` の `pathname` は `//` なので、この条件なら受理される）。
   `search` と `hash` がある場合も例外。
4. 値は `raw.trim().replace(/\/+$/, "")`（末尾のスラッシュを何個でも除去した元の文字列）。

API キーの値は例外メッセージに入れない。空白のみの API キーは未設定と同じ扱い（`null`）。

### 2. クライアントは環境変数を読まない

`createLmStudioClient(options: LmStudioClientOptions)` が接続先・API キー・`fetch` を引数で受け取る。
UI から接続先を上書きする経路（PR10・PR11）と、モックでの単体テストが同じ入口を使えるようにする。

`exactOptionalPropertyTypes` が有効なので、省略可能プロパティには `| undefined` を明示する
（`{ apiKey: maybeUndefined }` が TS2375 になるのを避ける）。本 PR で定義する省略可能プロパティはすべてこの書き方にする。

```ts
interface LmStudioClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | null | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;   // 未指定なら globalThis.fetch
}

interface RequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}
interface ChatOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;            // 生成は既定値を置かない（決定 8）
}

interface LmStudioClient {
  listModels(options?: RequestOptions): Promise<ModelInfo[]>;
  ensureLoaded(modelId: string, options?: RequestOptions): Promise<ModelInfo>;
  chat(request: ChatRequest, options: ChatOptions): Promise<ChatResult>;
}
```

`server/src/lmstudio/index.ts` は作らない。利用側は `lmstudio/client.ts` などから直接 import する。
`DEFAULT_MODEL_LIST_TIMEOUT_MS` は `client.ts` で定義して export する（テストから参照する）。
`wire.ts` の関数は server 内部で使うだけで、パッケージ外には出さない。

### 3. 要求はアプリ側の型で受け取り、クライアントがワイヤ形式に直す

PR6 が snake_case の JSON を組み立てるのではなく、camelCase の `ChatRequest` を作る。ワイヤ形式（`response_format` の
入れ子、`stream: false`、`reasoning_effort` がトップレベルであること）はクライアントの中に閉じ込め、テストで固定する。

```ts
type ReasoningEffort = "none" | "low" | "medium" | "high";
interface ChatMessage { readonly role: "system" | "user" | "assistant"; readonly content: string }
interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;       // 思考込みの予算（決定 0003）
  readonly temperature: number;
  readonly seed?: number | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly responseFormat?: { readonly name: string; readonly schema: Record<string, unknown> } | undefined;
}
```

`toWireChatBody` の出力（キーの名前と入れ子は実験の要求に合わせる）：

```json
{
  "model": "...", "messages": [...], "max_tokens": 16000, "temperature": 0,
  "stream": false,
  "seed": 42,
  "reasoning_effort": "none",
  "response_format": { "type": "json_schema", "json_schema": { "name": "findings", "strict": true, "schema": { } } }
}
```

`seed`・`reasoning_effort`・`response_format` は **`undefined` のときだけ** キーごと出さない。
判定は `!== undefined` で行う（`seed: 0`、`temperature: 0` は falsy なので、真偽値で判定するとキーが消える）。
`stream: false` は常に入れる。`messages` の空配列や `maxTokens <= 0` は検証せずそのまま送る（LM Studio 側の
応答で分類する）。
`reasoning: { effort }` の入れ子形式や `chat_template_kwargs`、`/no_think` は使わない（決定 0003 で効かないことを確認済み）。

各キーの根拠：`model`・`messages`・`max_tokens`・`temperature`・`response_format`・`reasoning_effort` は要求 `13`、
`stream: false` は要求 `08`、`seed` は要求 `03`・`06` で個別に確認したもの。**これらを同時に送った構成は未確認**で、
統合テストの小さな生成が最初の実測になる。

`ChatRequest` は生成パラメーターの集合を固定する（`top_p`・`top_k`・`min_p` などは表現できない）。
PR7 の実測調整で必要になれば `ChatRequest` を広げる。

### 4. `ModelInfo` の `state` は文字列。`"loaded"` だけが生成を許す

`/api/v0/models` の応答本文は実験で記録していない（README と決定 0003 に項目名の記述があるだけ）。
そのため受信スキーマは緩く作る：`data` は配列、各要素の `id` は文字列（必須）、それ以外は欠けていれば `null`。
未知のキーは無視する。`state` は列挙にせず `string` のまま持ち、**厳密に `"loaded"` のときだけ生成を許す**。
未知の状態名が増えたとき、一覧の取得ごと失敗させるより「未ロード扱い」に倒すほうが安全側。

ワイヤ側のキー名は `data[].id`、`data[].type`、`data[].state`、`data[].quantization`、
`data[].max_context_length`、`data[].loaded_context_length`。`data` が配列でなければ `malformed`。要素のうち `id` が文字列でないものは
**その要素だけ捨てる**（一覧全体を失敗にしない）。

```ts
const LOADED_STATE = "loaded";
interface ModelInfo {
  readonly id: string;
  readonly type: string | null;                 // "llm" / "vlm" / "embeddings" など。欠けていれば null
  readonly state: string | null;                // "loaded" / "not-loaded" / 未知の値 / 欠けていれば null
  readonly quantization: string | null;
  readonly maxContextLength: number | null;
  readonly loadedContextLength: number | null;  // ロード中のみ
}
```

`quantization` と `loadedContextLength` は実行記録に保存する（決定 0003）。保存自体は PR8。

`type` は生成に使えないモデル（`embeddings` など）を除くために持つ（仕様書 7 節 v0.8）。
`ensureLoaded` は種別で弾かない（未知の種別名でロード済みのモデルを拒否しないため）。使う側の責務とし、
本 PR では統合テストのモデル選択と、PR11 の選択肢の絞り込みに使う。

`ensureLoaded(modelId)` は一覧から `id` が完全一致する要素を探し、見つからない場合と `state !== "loaded"` の場合に
`LmStudioError`（`model-not-loaded`）を投げる。見つかれば `ModelInfo` を返す。

### 5. `ChatResult` と使用トークン

```ts
interface Usage {
  readonly promptTokens: number; readonly completionTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens: number | null;   // completion_tokens_details がなければ null
}
interface ChatResult {
  readonly content: string;
  readonly reasoningContent: string | null;   // message.reasoning_content。項目がなければ null、空文字はそのまま空文字
  readonly finishReason: string;              // "length" はここに来ない（決定 6）
  readonly usage: Usage | null;               // 応答に usage がなければ null
  readonly raw: unknown;                      // 応答 JSON 全体（実行記録・診断用）
}
```

- `reasoningTokens` は `usage.completion_tokens_details.reasoning_tokens`。項目がなければ `null`。
  思考なし設定の実測 0 と「取得できなかった」を区別する（仕様書 10 節の比較で使う値のため）。
  ロードマップの共通語彙では `ChatResult.reasoningTokens` が独立していたが、`usage` の一部として持つ。
  ロードマップの当該行を本 PR で直す。
- `usage` が欠けている応答は形式不正にせず、`usage: null` として成功を返す。生成そのものは成功しているのに、
  記録用の項目が欠けただけで結果を捨てるのは損が大きい。
- `prompt_tokens`・`completion_tokens`・`total_tokens` のいずれかが欠けている、または数値でない場合も
  `usage: null` にする。一部だけ 0 で埋めると「実測 0」と「取得できなかった」の区別がつかない。
- `reasoningContent` はロードマップになかった追加。評価（PR7・PR13）で思考量を見るために残す。
  項目がない場合の `null` と、思考なし設定での `""` を区別する。

### 6. `finish_reason == "length"` は例外にする（判断 1）

`chat` は `truncated` の `LmStudioError` を投げる。例外は `usage`・`finishReason`・`raw` を持つので、
呼び出し側は実行記録に必要な値（`reasoning_tokens` など）を失わない。

理由：仕様書 7 節と不変条件の「出力打ち切りを成功扱いしない」「正常な空配列に置き換えない」を最下層で守れる。
戻り値の `finishReason` を呼び出し側が見る設計だと、PR6・PR7 のどちらかが確認を忘れたときに、
打ち切られた JSON が「指摘なし」として通ってしまう。実験でも `max_tokens: 512` のとき `finish_reason: "length"`、
`content` は空文字で、そのまま解析すれば「指摘 0 件」に見える。

`"length"` 以外の終了理由（`stop` など）はそのまま `finishReason` に入れて返す。

**判定の順序**：本文を JSON として解析 → `error` キーの照合（決定 7。HTTP 状態に依存しない）→ HTTP 200 以外の分類 →
`choices[0].finish_reason` を見る →
`"length"` なら `truncated`（このとき `content` の型は問わない。モデルによっては `null` で返る）→
そうでなければ `message.content` が文字列であることを含む外枠の検証（失敗なら `malformed`）。
外枠の検証を先に厳密に行うと、打ち切りが `malformed` になって `usage` を失う。
`finish_reason` が欠けている・`null` の応答は `malformed`。`choices` が複数あるときは `[0]` を使う。
`noUncheckedIndexedAccess` が有効なので `choices[0]` は `undefined` になり得る。`!` で潰さず明示的に分岐する。

### 7. 失敗の分類（判断 2・判断 3 を含む）

`FailureReason` は仕様書 7 節の区分そのもので、ロードマップの `FailureReason` と同じ 7 値。
置き場所は `packages/shared/src/run/failure-reason.ts` にし、`FAILURE_REASONS` と `FailureReason` を
`shared` の `index.ts` から再エクスポートする（判断 2）。LM Studio を経由しない失敗（PR7 の
`InputTooLongError` からの `input-too-long`）や web での表示（PR12）も同じ列挙を使うため。
`LmStudioError` は HTTP と応答本文に依存するので `server/src/lmstudio/errors.ts` に置く。
ロードマップは `FailureReason` を「実行の状態名（server 側）」に分類しているので、その行を本 PR で直す。

```ts
// shared/src/run/failure-reason.ts
export const FAILURE_REASONS = ["connection", "model-not-loaded", "input-too-long", "timeout", "truncated", "malformed", "aborted"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

// server/src/lmstudio/errors.ts（パラメータプロパティは erasableSyntaxOnly で使えない）
import type { FailureReason } from "@shuten/shared";
import type { Usage } from "./types.ts";              // verbatimModuleSyntax。型は型 import で

export class LmStudioError extends Error {
  readonly kind: FailureReason;
  readonly status: number | null;         // HTTP 応答があったときだけ
  readonly usage: Usage | null;           // truncated のとき非 null
  readonly finishReason: string | null;
  readonly raw: unknown;                  // 応答本文。要求本文とヘッダーは入れない

  constructor(kind: FailureReason, message: string, options?: {
    status?: number | null | undefined; usage?: Usage | null | undefined;
    finishReason?: string | null | undefined; raw?: unknown; cause?: unknown;
  }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LmStudioError";
    this.kind = kind;
    this.status = options?.status ?? null;
    this.usage = options?.usage ?? null;
    this.finishReason = options?.finishReason ?? null;
    this.raw = options?.raw ?? null;
  }
}
```

クラスフィールドは列挙可能なので `JSON.stringify(error)` に `kind`・`status`・`raw` などが出る。
`message` と `stack` は非列挙で出ない。テスト C30 はこの前提で書く。

| 観測 | `kind` |
| --- | --- |
| `fetch` が中断以外で reject（接続拒否、DNS、切断） | `connection` |
| 応答本文の読み取り（`response.text()`）が reject（途中で切れた） | `connection` |
| 呼び出し元の `signal` が中断された | `aborted` |
| タイムアウトで中断した（呼び出し元の signal は未中断） | `timeout` |
| 本文に `error` があり、モデル未ロードの印（`no models loaded`、`model_not_found`、`not loaded`、`unloaded`）がある | `model-not-loaded` |
| 本文に `error` があり、文脈長超過の印（`context length`、`context_length`、`too long`、`maximum context`）がある | `input-too-long` |
| 上記以外の HTTP 200 以外 | `connection`（`status` に HTTP 状態、`raw` に本文） |
| HTTP 200 だが本文が JSON でない／外枠の検証に失敗（`choices` 空、`message.content` が文字列でない など） | `malformed` |
| HTTP 200 で `finish_reason == "length"` | `truncated` |

本文の読み方と照合の規則：

- 応答本文は `await response.text()` を **1 回だけ** 呼んで文字列にする（`res.json()` と使い分けない）。
  その文字列を `JSON.parse` にかけ、失敗しても例外を漏らさずテキストのままにする。
- 照合対象は「JSON として解析できたら `error` の値を `JSON.stringify` した文字列、できなければ本文テキスト全体」。
  `{"error":"..."}`（文字列）と `{"error":{"message":"...","code":"..."}}`（オブジェクト）の両方に効く。
  照合は小文字化した部分一致。
- 印の照合は **HTTP 状態にかかわらず**、`error` キーを持つ応答すべてに適用する（実験で観測した
  `{"error": "Model unloaded by user or API request."}` の HTTP 状態は記録されておらず、200 で返る可能性を
  否定できないため）。`error` を持つ応答が `choices` も持つことは想定しないが、その場合は `error` を優先する。
- 両方の印が一致した場合は `model-not-loaded` を優先する（生成を送ってはいけない状態のほうが重い）。
- `raw` には、JSON として解析できたらそのオブジェクト、できなければ本文テキストの先頭 2,000 文字を入れる。
- `listModels` にも同じ分類を使う。HTTP 200 以外は `connection`、本文が JSON でない・`data` が配列でないは
  `malformed`。`ensureLoaded` は `listModels` の失敗をそのまま伝播する（`connection` を `model-not-loaded` に
  読み替えない）。

分類できない HTTP エラーを `connection` に倒すのは、7 値に「サーバー内部エラー」がなく、
「接続先が期待どおりに応答しない」に最も近いため（判断 3）。PR7・PR9 が `connection` を再試行対象とするなら、
決定的な 4xx も 1 回再試行することになる。`status` を公開しているので、必要なら呼び出し側で分けられる。

`input-too-long` の判定文字列は **実測していない**。仕様書 7 節の「入力上限超過」を区別する要求に対する防御的な実装で、
本来の防波堤は PR7 の `validateChunkSettings` と `maxInputGraphemes`。統合テストで確認できたら文字列を実測値に直す。
`model-not-loaded` の印のうち実測に基づくのは `no models loaded`（モデル名なしの要求への 400。README 手順 1）と
`unloaded`（モデル名を指定した未ロード要求が JIT ロードに失敗したときの `Model unloaded by user or API request.`。同）。
`model_not_found`・`not loaded` は防御的な追加で未実測。実行中のアンロード（仕様書 7 節「実行中にアンロードされた
場合も同様に扱う」）は `unloaded` の印で `model-not-loaded` に落ちることを狙うが、その経路自体は未実測。

### 8. タイムアウトと中断の見分け（判断 4）

`chat(req, { signal, timeoutMs })` は必須引数。`listModels`・`ensureLoaded` にも省略可能の
`{ signal?, timeoutMs? }` を足す（ロードマップからの拡張）。接続先を誤ったときの挙動は未実測で、
WSL の NAT 構成（決定 0003 の接続先の注記）では接続拒否ではなく無応答になり得る。待ち続けないための備えとして
一覧取得にだけ既定値を置く。

```ts
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 10_000;   // 初期値。仕様書 13 節のタイムアウト決定ではない
```

生成のタイムアウトに既定値を置かない。仕様書 13 節で未決の値であり、思考の有無で 10 秒前後と 2〜3 分に分かれる。

`timeoutMs` は有限で 1 以上 `2**31 - 1` 以下の整数であることを検証し、外れていれば `TypeError` を投げる
（`setTimeout(fn, Infinity)` は 1ms で発火する）。

実装は `AbortSignal.timeout` も `AbortSignal.any` も使わず、自前の `AbortController` + グローバルの `setTimeout` にする。

```ts
const controller = new AbortController();          // abort() は必ず理由なしで呼ぶ
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
const onCallerAbort = () => controller.abort();
callerSignal?.addEventListener("abort", onCallerAbort);
try { /* fetch → text() → 解析 */ }
catch (err) {
  if (callerSignal?.aborted) throw new LmStudioError("aborted", ...);
  if (timedOut) throw new LmStudioError("timeout", ...);
  throw new LmStudioError("connection", ..., { cause: err });
}
finally { clearTimeout(timer); callerSignal?.removeEventListener("abort", onCallerAbort); }
```

決めておくこと（実装者の裁量にしない）：

- **例外の形で判定しない。** Node 24 の `fetch` は `signal.reason` をそのまま reject 値にするため、
  呼び出し元が `AbortSignal.timeout()` を渡せば `name === "TimeoutError"`、独自の理由で abort すれば
  その値がそのまま来る。`err.name === "AbortError"` の判定は成立しない。分類は上のフラグと
  `callerSignal.aborted` だけで行う。
- **判定の順序**は「呼び出し元の中断 → タイムアウト → それ以外は `connection`」。タイムアウト待ちの最中に
  呼び出し元が中断した場合も `aborted` になる。
- **事前中断**：`fetch` を呼ぶ前に `callerSignal?.aborted` を見て、真なら要求を送らずに `aborted` を投げる。
- **リスナ解除**：`finally` で `removeEventListener` する。呼び出し元の signal は長寿命になり得る（PR10 の
  HTTP 切断 signal）。
- **タイマーはグローバルの `setTimeout`**。`import { setTimeout } from "node:timers"` は `vi.useFakeTimers()` が
  差し替えないため、タイムアウトのテストが黙って実時間テストに退化する。
- **締切は本文の読み終わりまで**。`fetch` はヘッダー受信で resolve するので、タイマーの解除は
  `text()` を読み切った後の `finally` で行う。本文読み取り中の abort もこの分類に乗る。

### 9. API キーの扱い

`apiKey` が非 null かつ `trim()` が空でないときだけ `Authorization: Bearer <key>` を付ける（空白のみは未設定扱い）。
`LmStudioError` は要求ヘッダーも要求本文も持たない。`raw` は応答本文だけ。
テストで `error.message`、`JSON.stringify(error)`、`String(error.stack)`、`error.raw` にキー文字列が
含まれないことを確認する。

### 10. 統合テストの枠

- 置き場所：`server/src/lmstudio/client.integration.test.ts`。命名規則は `*.integration.test.ts`。
- `server/vitest.config.ts` は `include` を持たないので、`exclude` で外す。`exclude` を素で書くと
  `node_modules` などの既定が外れるため `configDefaults.exclude` を展開する。

  ```ts
  // packages/server/vitest.config.ts
  import { configDefaults, defineConfig } from "vitest/config";
  export default defineConfig({
    test: { name: "server", environment: "node",
      exclude: [...configDefaults.exclude, "**/*.integration.test.ts"] },
  });

  // packages/server/vitest.integration.config.ts
  import { defineConfig } from "vitest/config";
  export default defineConfig({
    test: { name: "server-integration", environment: "node",
      include: ["src/**/*.integration.test.ts"],
      testTimeout: 180_000, hookTimeout: 60_000 },   // 生成は分単位になり得る（既定 5 秒では落ちる）
  });
  ```

- ルートの `vitest.config.ts` は `projects: ["packages/*"]` で各パッケージの `vitest.config.ts` だけを拾うため、
  統合テストが `pnpm test` に混ざることはない。
- `packages/server/tsconfig.json` の `include` に `vitest.integration.config.ts` を足す（`pnpm typecheck` の対象にする）。
- スクリプト：`packages/server/package.json` に `"test:llm": "vitest run -c vitest.integration.config.ts"`、
  ルートに `"test:llm": "pnpm --filter @shuten/server test:llm"`。Windows で動く書き方（inline 代入を使わない）。
- 環境変数は **アプリと同じ `SHUTEN_LM_STUDIO_URL`**（判断 5）。未設定ならファイルごと skip。
  モデルは `SHUTEN_LM_STUDIO_MODEL` で指定、未指定なら `state === "loaded"` かつ `type` が `llm` または `vlm` の
  最初のもの（ロード済みの埋め込みモデルを選ばないため）。
  ロード済みモデルがなければ生成を伴うテストだけ skip する。判定は非同期なので `describe.skipIf` では書けない。
  URL の有無だけ `describe.skipIf(!url)` で判定し、モデルの有無は `beforeAll` で一覧を取ってから
  各テスト本体の先頭で `ctx.skip()` を呼ぶ。LM Studio が起動していない状態で `SHUTEN_LM_STUDIO_URL` だけが
  設定されている場合は `beforeAll` が失敗して赤くなる。これは許容する（設定したなら繋がるはず、という扱い）。
- 確認する内容：
  1. `/api/v0/models` の応答に `type`・`state`・`quantization`・`loaded_context_length` があること
     （決定 4 の未記録項目の確認）。
  2. `ensureLoaded` が未ロードのモデル ID で `model-not-loaded` を投げること（存在しない ID で代用）。
  3. 小さな生成（`reasoning_effort: "none"`、`max_tokens` 2,000）が `stop` で返り、`usage` が埋まること。
  4. **PR4 の未確認事項の解消**：`checkOutputJsonSchema()` をそのまま `responseFormat.schema` に渡し、
     応答本文を `llmCheckOutputSchema` で検証できること。PR4 で追加した `minimum`・`minLength`・
     `type: ["string","null"]`・`enum` を含むスキーマが LM Studio の `strict: true` で通ることを確認する。
     ロードマップの「PR6 までに実スキーマで疎通を確認する」はここで閉じる。
     使うメッセージは疎通確認専用の最小のもの（誤字を 1 つ含む短い文）で、PR6 のプロンプトではない。
     ここでの検出結果を品質の評価（仕様書 10 節）に使わない。
- 実行にはユーザーのローカル LM Studio が要る。CI では実行しない（`pnpm check` に含めない）。

## 解釈で迷った点（PR 本文にも列挙する）

1. **`finish_reason == "length"` を例外にするか戻り値にするか。** 決定 6 で例外にした。ロードマップの
   `ChatResult.finishReason: string` は戻り値で扱う読み方もできる。例外にすると呼び出し側が `try` を書く必要があるが、
   打ち切りを「指摘 0 件」と取り違える経路を型で塞げる。
2. **分類できない HTTP エラー（500 など）の `kind`。** 決定 7 で `connection` にした。7 値に該当がなく、
   `malformed`（応答の形が違う）よりは「接続先が期待どおりに応答しない」に近いと判断した。
3. **`input-too-long` の判定は未実測。** 決定 7 に書いたとおり、文字列一致は防御的な実装で、統合テストで
   確認できるまで「確認済み」とは書かない。
4. **`listModels` のタイムアウト既定値 10 秒。** 仕様書 13 節で未決のタイムアウトとは別の、一覧取得だけの初期値。
   生成側には既定値を置かない。
5. **統合テストの環境変数名。** 実験スクリプトは `LM_STUDIO_URL`、アプリ設定は `SHUTEN_LM_STUDIO_URL`。
   テストはアプリ側に合わせ、実験ディレクトリの記録は当時のまま残す。ロードマップの該当行を直す。
6. **`/api/v0/models` の応答形が未記録。** 決定 4 のとおり緩いスキーマにし、統合テストで実物を確認する。
7. **`FailureReason` を `shared` に置くか `server` に置くか。** 決定 7 で `shared` にした（判断 2）。
   ロードマップは server 側に分類しているが、PR7 の設定エラーと PR12 の表示が同じ列挙を要る。
8. **`error` を含む応答の HTTP 状態が未記録。** 実験は `{"error": "Model unloaded by user or API request."}` の
   本文だけを記録していて状態を残していない。そのため印の照合を状態に依存させない。
9. **`/v1/models` を呼ばない。** 決定 1 のとおり。逸脱にせず仕様書を v0.8 に改訂した。
10. **`usage` 欠落を `null` にする。** 0 埋めだと「思考なしで 0 トークン」と区別できないため（決定 5）。

## テスト（単体。モック `fetch`）

共通の書き方（実装者の裁量にしない）：

- モック `fetch` は `((input, init) => Promise<Response>) as unknown as typeof globalThis.fetch` で作る。
  ヘッダーの検証は `new Headers(init.headers)` に正規化してから `.get("authorization")` / `.get("content-type")` を見る。
- タイムアウト系（C19・C20・C21・C29）は `vi.useFakeTimers()` を使い、`afterEach(() => vi.useRealTimers())`。
  実時間に頼らない。`expect(...).rejects` のアサーションは `vi.advanceTimersByTimeAsync` を呼ぶ **前** に作る
  （未処理 rejection を避ける）。同期版の `advanceTimersByTime` は使わない。

  ```ts
  const hangingFetch = ((_url, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as unknown as typeof globalThis.fetch;

  it("C19 タイムアウトで timeout になる", async () => {
    vi.useFakeTimers();
    const promise = client.chat(request, { timeoutMs: 1000 });
    const assertion = expect(promise).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
  ```

`client.test.ts`：

| 番号 | 内容 | 期待 |
| --- | --- | --- |
| C1 | `chat` の送信先 URL とヘッダー | `${base}/v1/chat/completions`、`content-type: application/json`、API キーなしなら `authorization` なし |
| C2 | API キーありのヘッダー | `authorization: Bearer k` が 1 つだけ付く |
| C3 | `baseUrl` の末尾スラッシュ（`http://h:1234/`、`http://h:1234//`） | 送信先が `http://h:1234/v1/chat/completions` |
| C4 | `toWireChatBody` の最小要求 | `stream: false` があり、`seed`・`reasoning_effort`・`response_format` のキーがない |
| C5 | 全項目を指定した要求 | `reasoning_effort` がトップレベル、`response_format.json_schema.strict === true`、`name` と `schema` がそのまま |
| C6 | 正常応答 | `content`・`reasoningContent`・`finishReason`・`usage`（`reasoningTokens` 含む）・`raw` |
| C7 | `usage` が欠けた正常応答 | `usage === null`、成功として返る |
| C8 | `completion_tokens_details` が欠けた応答 | `usage` は非 null、`reasoningTokens === null` |
| C9 | `finish_reason: "length"` | `truncated`。`error.usage` と `error.raw` が非 null |
| C10 | 本文が JSON でない（`"not json"`） | `malformed` |
| C11 | `choices` が空配列 | `malformed` |
| C12 | `message.content` が `null` | `malformed` |
| C13 | HTTP 500 | `connection`、`status === 500` |
| C14 | HTTP 400 `{"error":"No models loaded"}` | `model-not-loaded` |
| C15 | HTTP 400 `{"error":"...maximum context length..."}` | `input-too-long` |
| C16 | HTTP 404、本文に印なし | `connection`、`status === 404` |
| C16b | HTTP 400 `{"error":"Model unloaded by user or API request."}` | `model-not-loaded` |
| C16c | HTTP 200 で本文が `{"error":"Model unloaded by user or API request."}` | `model-not-loaded`（状態に依存しない） |
| C16d | `response.text()` が reject | `connection` |
| C17 | `fetch` が `TypeError("fetch failed")` で reject | `connection` |
| C18 | 呼び出し元の `signal` を中断 | `aborted` |
| C19 | `timeoutMs` を過ぎる（`fetch` が返らない） | `timeout` |
| C20 | タイムアウト待ちの最中に呼び出し元が中断 | `aborted`（`timeout` にしない） |
| C21 | 正常終了後にタイマーが残らない | `vi.useFakeTimers()` の下で `vi.getTimerCount() === 0` |
| C22 | `listModels` の送信先 | `${base}/api/v0/models`、GET |
| C23 | 一覧の解析 | `state`・`quantization`・`maxContextLength`・`loadedContextLength` が入る |
| C24 | 欠けた項目のある一覧 | `null` が入り、例外にならない |
| C25 | 未知の `state`（`"loading"`） | 一覧は成功。`ensureLoaded` は `model-not-loaded` |
| C26 | `ensureLoaded` でロード済み | `ModelInfo` を返す |
| C27 | `ensureLoaded` で `not-loaded` | `model-not-loaded` |
| C28 | `ensureLoaded` で ID が一覧にない | `model-not-loaded` |
| C29 | `listModels` のタイムアウト（既定 10 秒を明示指定で短縮） | `timeout` |
| C30 | API キーが例外に漏れない（C9・C13・C17 の各経路） | `message`・`JSON.stringify`・`stack`・`raw` にキー文字列を含まない |
| C31 | `seed: 0` と `temperature: 0` | どちらもキーが出る（falsy 判定にしない） |
| C32 | 既に中断済みの signal を渡す | `aborted`。`fetch` が呼ばれない |
| C33 | `reasoning_content` がない応答 | `reasoningContent === null`（空文字と区別する） |
| C34 | `finish_reason` がない／`null` の 200 応答 | `malformed` |
| C35 | `usage` の一部が欠けた応答（`total_tokens` なし・数値でない） | `usage === null` |
| C36 | `choices[0].message` がない | `malformed` |
| C37 | `choices` が 2 件 | `[0]` を使う |
| C38 | `finish_reason: "length"` かつ `content` が `null` | `truncated`（`malformed` にしない） |
| C39 | 本文に `error`（未ロードの印）と文脈長超過の印が両方ある | `model-not-loaded` |
| C40 | `listModels` が HTTP 500 | `connection` |
| C41 | `listModels` の本文が JSON でない／`data` が配列でない | `malformed` |
| C42 | `listModels` の要素の `id` が数値 | その要素だけ捨てる。他は返る |
| C46 | `listModels` の要素に `type` がある／ない | `type` に値／`null` |
| C43 | `ensureLoaded` が `listModels` の失敗を伝播 | `connection` のまま（`model-not-loaded` にしない） |
| C44 | `timeoutMs` が 0・負・`Infinity`・非整数 | `TypeError` |
| C45 | API キーが空白のみ | `authorization` を付けない |

`config.test.ts` の追記：既定値、末尾スラッシュの除去（`/` と `//`）、`http:` / `https:` 以外で例外、
解析できない URL で例外、パス付き（`http://h:1234/v1`）で例外、末尾 `//` は受理、`search` / `hash` 付きで例外、
API キー未設定・空文字・空白のみで `null`、例外メッセージに API キーを含めない。

## 進め方（コミット単位）

1. 計画（本文書）とロードマップの改訂（`listModels` の options、`ChatResult` の `usage`・`reasoningContent`、
   統合テストの環境変数名）。
2. `shared` の `run/failure-reason.ts`（再エクスポート込み）と、`server` の `errors.ts`、`types.ts`、`wire.ts`、`wire.test.ts`。
3. `client.ts` と `client.test.ts`（表 C）。
4. `config.ts` の改修と `config.test.ts` の追記。
5. `vitest.config.ts` の `exclude`、`vitest.integration.config.ts`、`tsconfig.json` の `include`、
   `client.integration.test.ts`、ルートと server の `package.json` に `test:llm`。
6. README・決定記録 0002 の状態更新。

実装は PR4 と同じくサブエージェント方式（`superpowers:subagent-driven-development`）で進める。
`pnpm check` を通してから PR を作る。統合テストはユーザーのローカル LM Studio で別途実行する。
