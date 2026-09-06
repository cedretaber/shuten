# MVP 実装ロードマップ（PR 単位）

作成日：2026-09-07  
仕様：`docs/spec/mvp-spec.md`（v0.7）  
前提：`docs/reference/invariants.md`、`docs/decisions/0001`〜`0003`

本書は MVP を PR 単位に分解し、各 PR の範囲、対応する仕様の節、ファイル、インターフェース、テスト、担当を定める。
各 PR の着手時に、この文書の該当節を起点として TDD 手順まで書いた詳細計画を `docs/plans/` に追加する。
本書の粒度は PR とその境界であり、コード手順は詳細計画で書く。

## 目標

仕様書 11 節の受け入れ条件をすべて満たし、10 節の評価を実原稿で実施できる状態にする。

## 全体の制約（すべての PR に適用）

- 本文は BOM 除外以外を加工しない。位置は UTF-16 コード単位、範囲は `[start, end)`、文字数は書記素クラスタ数。
- 分割範囲と確定位置の正本はサーバーが保存した値。ブラウザは再計算結果で上書きしない。
- LLM 生成要求はバックエンド全体で単一キュー、同時実行数 1。
- 未ロードのモデルに生成要求を送らない。接続確認、開始、再開、各要求の直前に `GET /api/v0/models` で `state` を確認する。
- `AbortController` は通信の中断であり生成終了の確認ではない。生成終了を確認できなければ「復旧待ち」。
- 思考モデルの `max_tokens` は思考込みで配分し、`reasoning_effort` を実行記録に保存する。
- `finish_reason == "length"`、形式不正、接続失敗を正常な空配列に置き換えない。
- 引用は完全一致でのみ位置を確定する。診断候補を正式な位置に使わない。
- 採否は本文を書き換えない。本文編集機能を作らない。
- SSE は通知手段で状態の正本は DB。DB トランザクションに LLM 応答待ちを含めない。
- 待ち受けは既定で `127.0.0.1`。API キーをログ・履歴・出力に含めない。
- 依存の版は完全固定。scripts は Windows で動く書き方。相対 import は `.ts` 拡張子付き。
- 個人情報、機器固有の値、実原稿をコミットしない。

## 共通語彙（型と関数の名前を先に固定する）

PR をまたいで同じ名前を使うため、ここで定める。すべて `packages/shared/src/` に置き、`src/index.ts` から再エクスポートする。

```ts
// text/range.ts
interface Range { readonly start: number; readonly end: number }   // UTF-16、[start, end)
function sliceRange(text: string, range: Range): string

// text/paragraph.ts
interface Paragraph { readonly id: number; readonly range: Range }  // id は原稿版内で 0 始まりの出現順
function splitParagraphs(text: string): Paragraph[]                 // CRLF / LF / CR を 1 区切り、改行列は直前の段落に含める

// text/ingest.ts
function decodeUtf8Strict(bytes: Uint8Array): string                // 不正バイトは例外（黙って置換しない）
function stripBom(text: string): string                             // 先頭 U+FEFF だけを除外
function ingestUtf8Bytes(bytes: Uint8Array): string                // stripBom(decodeUtf8Strict(bytes))。ファイル入力はこれだけを呼ぶ

// text/grapheme.ts（scaffold 済み）
function countGraphemes(text: string): number
function segmentGraphemes(text: string): GraphemeSegment[]

// chunk/plan.ts
interface ChunkSettings { targetGraphemes: number; contextGraphemes: number; recheckContextGraphemes: number; roundingTolerance: number /* 0.2 */ }
interface TargetRange { readonly index: number; readonly range: Range; readonly paragraphIds: readonly number[] }
interface ContextWindow { readonly before: Range | null; readonly after: Range | null }
interface CheckInput { readonly target: TargetRange; readonly context: ContextWindow; readonly inputRange: Range }
function planTargets(text: string, paragraphs: Paragraph[], settings: ChunkSettings): TargetRange[]
function buildCheckInput(text: string, paragraphs: Paragraph[], target: TargetRange, contextGraphemes: number, settings: ChunkSettings): CheckInput
function buildRecheckInput(text: string, paragraphs: Paragraph[], initial: CheckInput, settings: ChunkSettings): CheckInput   // 初回の inputRange を必ず含む

// locate/quote-ref.ts（PR3。LLM 出力の型に依存しない照合用の最小入力）
interface QuoteRef { paragraphId: number; quote: string; before: string; after: string }

// locate/locate.ts（PR3）
type LocateFailureReason = "not-found" | "ambiguous" | "outside-target"
interface Diagnostic { transformVersion: string; candidates: DiagnosticCandidate[]; truncated: boolean; tied: boolean }
interface DiagnosticCandidate { transform: "newline" | "nfc" | "newline+nfc"; text: string; range: Range | null }
type LocateResult =
  | { status: "located"; range: Range }
  | { status: "failed"; reason: LocateFailureReason; diagnostic: Diagnostic }
function locateQuote(text: string, input: CheckInput, paragraphs: Paragraph[], ref: QuoteRef): LocateResult
// not-found / ambiguous は「位置特定失敗」として通常一覧に表示する。
// outside-target は参考文脈内から始まる候補で、通常一覧に出さず診断記録にだけ残す。

// llm/schema.ts（PR4）
type Perspective = "typo" | "naturalness"
type InitialVerdict = "likely-error" | "confirm-with-author"
// 分類。許容語による自動抑制は notation（誤字・表記の訂正）だけを対象にする（仕様書 6.4）
type FindingCategory = "notation" | "omission-or-duplication" | "particle" | "grammar" | "context-misuse" | "unclear"
interface LlmFinding extends QuoteRef { category: FindingCategory; suggestion: string | null; reason: string; verdict: InitialVerdict }
interface LlmCheckOutput { findings: LlmFinding[] }
type RecheckVerdict = "keep" | "withdraw" | "confirm-with-author"
// 再確認の理由区分（仕様書 6.5 の確認内容に対応）。confirm-with-author のうち suggestion-inappropriate は
// 修正案を有効な修正案として表示しない（修正案の改訂はしない）
type RecheckReasonKind = "error-confirmed" | "intentional-expression" | "suggestion-inappropriate" | "unnecessary-polish" | "insufficient-context"
interface LlmRecheckOutput { verdict: RecheckVerdict; reasonKind: RecheckReasonKind; suggestionValid: boolean; reason: string }
const llmCheckOutputSchema: z.ZodType<LlmCheckOutput>; const llmRecheckOutputSchema: z.ZodType<LlmRecheckOutput>
function checkOutputJsonSchema(): object   // response_format 用（description はモデルに渡らない前提で書く）

// merge/merge.ts, merge/allowed-words.ts（PR4）
interface CandidateBase { id: string; perspective: Perspective; llm: LlmFinding }
interface LocatedCandidate extends CandidateBase { locate: { status: "located"; range: Range } }
interface UnlocatedCandidate extends CandidateBase { locate: { status: "failed"; reason: LocateFailureReason; diagnostic: Diagnostic } }
type Candidate = LocatedCandidate | UnlocatedCandidate
function partitionCandidates(candidates: Candidate[]): { located: LocatedCandidate[]; unlocated: UnlocatedCandidate[] }
interface MergedFinding { id: string; range: Range; quote: string; category: FindingCategory; suggestion: string | null; sources: LocatedCandidate[]; verdict: InitialVerdict }
function mergeCandidates(candidates: LocatedCandidate[]): MergedFinding[]   // 位置確定済みだけを受け取る。同一実行内は呼び出し元が保証
function findSuppression(finding: MergedFinding, allowedWords: string[]): { word: string; ruleVersion: string } | null
// UnlocatedCandidate は統合・抑制・再確認に進まず、そのまま保存して一覧に表示する（not-found / ambiguous）か
// 診断記録にだけ残す（outside-target）

// versions.ts
const PROMPT_VERSION, ALLOWED_WORD_RULE_VERSION, DIAGNOSTIC_TRANSFORM_VERSION: string
```

実行の状態名（server 側、DB に保存）：

- 検査実行 `RunStatus`: `running` | `stopped` | `recovery-waiting` | `completed` | `partially-failed`
- 検査単位・再確認単位 `UnitStatus`: `pending` | `running` | `done` | `failed` | `not-applicable`（許容語により対象外など）
- 失敗理由 `FailureReason`: `connection` | `model-not-loaded` | `input-too-long` | `timeout` | `truncated` | `malformed` | `aborted`

## 実装上の決定（提案。各 PR の着手時に確認する）

| 項目 | 提案 |
| --- | --- |
| ID | `crypto.randomUUID()` の文字列 |
| マイグレーション | `drizzle-kit generate` で SQL を生成しコミット。サーバー起動時、API の受付前に `migrate()` で適用し、失敗したら起動を止める |
| API | JSON の REST を `/api/` 配下に。進捗は `/api/runs/:id/events` の SSE |
| LLM を呼ぶテスト | `packages/server/vitest.integration.config.ts` の別プロジェクト。`LM_STUDIO_URL` 未設定なら skip、設定時も `state` が `not-loaded` なら skip。`pnpm test:llm` で実行 |
| エクスポート形式 | 実行 1 件を JSON 1 ファイルに（原稿版、設定、指摘、診断、採否を含む）。先頭に形式の版 `formatVersion` を持つ。仕様書 8.2 節の「実装設計時に決める」に対応 |
| 接続先の設定 | 環境変数 `SHUTEN_LM_STUDIO_URL`（既定 `http://127.0.0.1:1234`）と UI からの上書き。UI 側の値は DB に保存 |

## PR 一覧

```
PR1  shared  原稿の取り込みと段落モデル
PR2  shared  検査範囲と参考文脈の分割
PR3  shared  引用照合・位置確定・診断候補
PR4  shared  LLM 出力スキーマ、重複統合、許容語抑制
PR5  server  設定と LM Studio クライアント
PR6  server  プロンプトと要求の組み立て（観点別検査・再確認）
PR7  server+cli  検査パイプライン（DB なし）と評価ハーネス
PR8  server  DB スキーマと永続化
PR9  server  実行キューとオーケストレーション
PR10 server  HTTP API と SSE
PR11 web     接続・入力・設定画面
PR12 web     結果画面
PR13 all     評価ツール、エクスポート、実原稿での評価
```

依存関係：

```
PR1 → PR2 → PR3 → PR4 ──┬→ PR6 ──┐
PR5 ────────────────────┘        ├→ PR7（PR1〜PR6）→ PR9（PR7、PR8）→ PR10 → PR11, PR12 → PR13
PR1 → PR8 ───────────────────────┘
```

- PR3 の `locateQuote` は PR4 の `LlmFinding` に依存しないよう、PR3 で `QuoteRef` を定義し `LlmFinding` はそれを拡張する。
- PR6 は PR4 のスキーマで応答を検証するため、PR4 と PR5 の両方の後。
- 並行できる組：`PR2〜PR4` と `PR5`、`PR8` と `PR6`、`PR11` と `PR12`（API を先に固定した場合）。

PR7 を PR8 より前に置くのは、UI 完成を待たずにプロンプトと生成設定（仕様書 13 節の未決）を実原稿で回し始めるため。
PR7 は 10 節の「全文チャット方式」との比較にも使い、PR13 の評価ツールの土台になる。
PR7 で作る検査パイプライン（`server/src/run/pipeline.ts`）は PR9 のオーケストレーションが共用し、
PR9 はその上に永続化・再開・キュー管理を加える。

## ユーザーに依存する入力

| 入力 | 必要になる PR |
| --- | --- |
| Windows での scaffold 確認（`docs/guides/windows-verification.md`） | PR5 以降の Windows 実行 |
| 評価用原稿（作者が利用を認めたもの。リポジトリには入れない） | PR7 の試運転、PR13 |
| モデルの選択と思考の有無（仕様書 13 節。1 原稿の観察では qwen 思考なしが有望） | PR7 で比較して決める |
| 許容語の実例、意図的な口語・造語を含む原稿 | PR13 |

## 各 PR

### PR1 shared：原稿の取り込みと段落モデル

- 仕様：5.1、6.1、9（位置対応の保持）
- 作る：`text/range.ts`、`text/paragraph.ts`、`text/ingest.ts`、`versions.ts`、上記の型
- 提供：`Range`、`sliceRange`、`Paragraph`、`splitParagraphs`、`decodeUtf8Strict`、`stripBom`、`ingestUtf8Bytes`（decode → stripBom を一度だけ適用する取り込み経路）、`Utf8DecodeError`、版定数
- テスト（境界条件、fixture は `packages/shared/test/fixtures/`）：
  - CRLF・LF・CR の混在、末尾改行の有無、空行の保持、改行列が直前の段落に含まれること、全体が隙間なく覆われること
  - BOM あり・なし、本文中の U+FEFF は残すこと、不正 UTF-8 で例外
  - 段落 ID が出現順で固定されること
  - 空本文は段落ゼロ。末尾改行の後に空の最終段落を作らない（改行列は直前の段落に含める）。改行のみの本文は 1 段落
  - `decodeUtf8Strict` は BOM を保持する（バイト列を文字列にするだけ）。取り込み経路でその結果に `stripBom` を
    一度だけ適用し、先頭の U+FEFF を最大 1 文字除外する。保存本文や後続処理では再適用しない。
    先頭に U+FEFF が 2 文字続く入力では、取り込み完了後に 1 文字残ることをテストする
- 受け入れ条件：CRLF を含む原稿で位置がずれない（11 節 7 項の一部）
- 担当：Claude がスペック、qwen が実装とテスト、Claude が検証
- 大きさ：小

### PR2 shared：検査範囲と参考文脈の分割

- 仕様：5.2、6.1（手順 2〜5）、6.5（再確認の入力範囲）
- 作る：`chunk/plan.ts`、`chunk/sentence.ts`（文境界の検出。句点・感嘆符・疑問符・閉じ括弧の後）
- 提供：`ChunkSettings`、`TargetRange`、`ContextWindow`、`CheckInput`、`planTargets`、`buildCheckInput`、`buildRecheckInput`
- 規則：
  - 段落境界を優先し、目標の ±20% 内で最も近い境界、同距離なら外側
  - 適切な境界がなければ文境界、それでも長ければ書記素クラスタ境界。CRLF や結合文字の途中で切らない
  - 参考文脈は検査対象の外側から書記素クラスタ数で数え、短い会話段落でも目標文字数まで複数段落を含める
  - 本文端では存在する文脈だけ。再確認の入力は初回の `inputRange` を必ず含む
  - すべての位置がちょうど 1 つの検査対象に属する
  - 入力上限（設定値）を超えたら例外 `InputTooLongError` を投げ、黙って縮めない
- テスト：短い会話段落の連続、1 段落が目標の 3 倍、絵文字 ZWJ・異体字セレクタをまたぐ境界、本文の先頭と末尾、±20% の同距離
- 受け入れ条件：11 節 3・4・7・8 項の shared 側
- 担当：Claude がスペック（丸め規則の数値例を含める）、qwen が実装、Claude が検証
- 大きさ：中

### PR3 shared：引用照合・位置確定・診断候補

- 仕様：6.2（引用だけで一意なら失敗にしない）、6.3 全体
- 作る：`locate/quote-ref.ts`、`locate/locate.ts`、`locate/diagnostic.ts`、`locate/position-map.ts`（正規化後の文字列から原文への位置対応）
- 提供：`QuoteRef`、`LocateResult`、`LocateFailureReason`、`Diagnostic`、`locateQuote`
- 規則：
  - 完全一致を `inputRange` 内で探す。1 件なら確定。複数なら段落 ID と `before` / `after` で絞る。絞れなければ `ambiguous`
  - 開始位置が `target.range` 外なら `outside-target`（診断記録に残す。付け替えない。通常一覧に出さない）
  - `not-found` と `ambiguous` は位置特定失敗として保存し、通常一覧に表示する（強調はしない）
  - 完全一致ゼロのときだけ診断：改行統一、NFC、両方の 3 変換で比較し、指定段落に近い順に最大 3 件。同順位と打ち切りを記録。位置対応が取れない候補は `range: null`
  - 原文は変更しない。変換規則の版を記録
- テスト：同一引用の反復、検査対象から参考文脈へ続く引用、参考文脈から始まる引用、本文端、`before` / `after` が改行を省く応答、NFC で一致する濁点の分解、CRLF と LF の違いでのみ一致、候補 4 件以上での打ち切り
- 受け入れ条件：11 節 6・7・9・17 項の shared 側
- 担当：Claude がスペック、位置対応の設計、Unicode を含む期待結果の作成。qwen が実装、Claude が検証
- 大きさ：中〜大

### PR4 shared：LLM 出力スキーマ、重複統合、許容語抑制

- 仕様：6.2（構造化データ）、6.4 全体、7（スキーマ検証）
- 作る：`llm/schema.ts`（zod と JSON Schema）、`merge/merge.ts`、`merge/allowed-words.ts`、`merge/diff.ts`（共通接頭辞・接尾辞の除去）
- 提供：`FindingCategory`、`LlmFinding`、`LlmCheckOutput`、`RecheckReasonKind`、`LlmRecheckOutput`、`llmCheckOutputSchema`、`llmRecheckOutputSchema`、`checkOutputJsonSchema`、`Candidate`、`LocatedCandidate`、`UnlocatedCandidate`、`partitionCandidates`、`MergedFinding`、`mergeCandidates`、`findSuppression`
- 規則：
  - `partitionCandidates` で位置確定済みと失敗を分ける。統合・抑制・再確認は `LocatedCandidate` だけを扱い、`UnlocatedCandidate` は保存・表示の経路へ渡す
  - 統合は同じ範囲・原文・修正案。修正案なしや別の問題は統合しない。観点と元候補への参照を保持。統合後の `category` は元候補が一致すればその値、不一致なら `unclear`
  - 抑制の前提：`category` が `notation`（誤字・表記の訂正）で、位置確定済みで、修正案があること。`context-misuse`、`particle`、`grammar`、`unclear`、`omission-or-duplication` は抑制しない
  - 抑制の判定：「引用内の登録語の出現 1 箇所を空でない別の文字列に置き換えるだけで修正案を再現できる」。外側は完全一致。削除、複数出現にまたがる変更、範囲外に及ぶ変更は抑制しない
  - 「引用が登録語だけ」「変更の一部に登録語を含む」はそれ自体では抑制の理由にならない。上の判定を満たすかどうかだけで決める
  - 抑制結果に登録語と規則版を含める
  - 再確認の `reasonKind` が `suggestion-inappropriate` のとき、`suggestionValid` は false。表示側は修正案を有効な修正案として出さず、履歴には残す
- テスト：
  - 同じ引用「リュシア」・修正案「ルシア」で、`notation`（抑制）、`context-misuse`（抑制しない）、`unclear`（抑制しない）を分けて検証
  - 引用が登録語だけで表記訂正（抑制）、登録語を含む文で登録語の外側も変わる（抑制しない）、複数出現のうち 1 箇所（抑制）、削除（抑制しない）、修正案 null（抑制しない）
  - `partitionCandidates` の分割、`mergeCandidates` が `UnlocatedCandidate` を型で受け付けないこと
  - スキーマが不正 JSON、未知の `category`、`reasonKind` と `suggestionValid` の矛盾（`suggestion-inappropriate` かつ true）を拒否
- 受け入れ条件：11 節 10・11 項の shared 側、19 項の一部
- 担当：Claude がスペックと許容語判定の期待結果の作成、qwen が実装、Claude が検証
- 大きさ：中

### PR5 server：設定と LM Studio クライアント

- 仕様：7、8.2（切断をキャンセル要求として扱う）、決定記録 0003
- 作る：`server/src/lmstudio/client.ts`、`lmstudio/errors.ts`、`lmstudio/types.ts`、`config.ts` の拡張、`vitest.integration.config.ts`
- 提供：
  ```ts
  interface LmStudioClient {
    listModels(): Promise<ModelInfo[]>                         // /api/v0/models。state, quantization, loaded_context_length
    ensureLoaded(modelId: string): Promise<ModelInfo>           // not-loaded なら ModelNotLoadedError
    chat(req: ChatRequest, opts: { signal: AbortSignal; timeoutMs: number }): Promise<ChatResult>
  }
  interface ChatResult { content: string; reasoningTokens: number; finishReason: string; usage: Usage; raw: unknown }
  class LmStudioError { kind: FailureReason }                   // connection / model-not-loaded / input-too-long / timeout / truncated / malformed / aborted
  ```
- 規則：`finish_reason == "length"` は `truncated`。応答本文は素の JSON 解析のみ（`<think>` 分離は実装しない）。再試行はここでは行わず呼び出し側の方針に任せる。API キーは `Authorization` にだけ載せ、ログに出さない
- テスト：モック HTTP でのエラー分類、abort で `aborted`、タイムアウト、`length` の扱い。統合テスト（`pnpm test:llm`）で実 LM Studio の一覧・状態・小さな生成
- 受け入れ条件：11 節 1・19 項
- 担当：Claude がインターフェース設計、qwen が実装とモックテスト、Claude が検証と統合テスト
- 大きさ：中

### PR6 server：プロンプトと要求の組み立て

- 仕様：3.1、5.2（許容語のヒント）、5.4、6.2、6.5、13（プロンプトは未決。ここで初版を作り版を付ける）
- 作る：`server/src/prompts/typo.ts`、`prompts/naturalness.ts`、`prompts/recheck.ts`、`prompts/build.ts`（`<context>` / `<target>` の区切りと非追従の指示）、`test/fixtures/injection/`（命令文を含む原稿）
- 提供：`buildCheckRequest(input: CheckInput, text, perspective, allowedWords, settings): ChatRequest`、`buildRecheckRequest(...)`、`parseCheckResponse(result: ChatResult): LlmCheckOutput`、`parseRecheckResponse(result): LlmRecheckOutput`（PR4 のスキーマで検証）
- 規則の追加：プロンプトは `category` と `reasonKind` の各値の意味を本文に書き、モデルが分類を選べるようにする
- 規則：項目の意味（引用、前後の引用、修正案は引用全体に対応し変更を最小限、理由）をプロンプト本文に書く。体言止め・倒置・口語・造語を誤りにしない指示。件数のノルマなし。思考の有無は設定
- テスト：プロンプトのスナップショット（版が変わったら更新）、命令文を含む原稿の統合テストで逸脱の有無を記録
- 受け入れ条件：11 節 20 項
- 担当：Claude（プロンプト設計は委譲しない）
- 大きさ：中

### PR7 server + cli：検査パイプライン（DB なし）と評価ハーネス

- 仕様：6（処理順序）、7（未ロード、再試行 1 回、生成終了未確認時の扱い）、10（比較実験）、13（プロンプトと生成設定の実測）
- 作る：
  - `server/src/run/pipeline.ts`：本文と設定と `LmStudioClient` を受け取り、分割 → 観点別検査 → 位置確定 → 分割（確定／失敗）→ 統合・抑制 → 再確認（任意）を実行する純粋な処理。DB に依存せず、進捗と各単位の結果をコールバックで通知する。PR9 のオーケストレーションはこれを共用する
  - `server/src/run/executor.ts`：生成要求を直列に実行する小さな実行器（同時実行 1）。PR9 のキューはこれを包む
  - `packages/cli/`（新規パッケージ。`bin/shuten-eval.ts`）：原稿ファイルと設定を読み、パイプラインを呼び、結果を JSON に出す。`--mode full-text` で全文を 1 要求で送る比較用の経路
- 規則：
  - 要求は直列。各要求の直前に `ensureLoaded`
  - タイムアウトや abort の後に生成終了を確認できなければ、後続の要求を送らずにパイプラインを終了し、その旨を結果に残す（PR9 の「復旧待ち」に相当する終了理由）
  - 失敗した単位を含む途中結果をそのまま JSON に残す。失敗を指摘ゼロにしない
  - 実行条件（モデル、量子化、コンテキスト長、seed、思考の有無、プロンプト版、許容語規則版、診断変換版）を JSON に含める
- テスト：モック `LmStudioClient` でパイプライン全体の結合テスト（通常テストで実行）。不正 JSON、`length`、未ロード、タイムアウト後の停止、部分失敗の各経路。実機を使う結合テストは統合テストとして分離。CLI は引数解釈と JSON 形式の単体
- 評価指標の集計（検出率、誤検出、位置特定失敗率）は正解ファイルとの突き合わせで PR13 に回す
- 受け入れ条件：11 節 21 項の土台。3・4・19 項のパイプライン側
- 担当：Claude がパイプラインの設計と実装、qwen が CLI と結合テストの雛形、Claude が実原稿での試運転
- 大きさ：中〜大
- 補足：この PR 以降、プロンプトと生成設定の調整を実原稿で回せる

### PR8 server：DB スキーマと永続化

- 仕様：8.1 全体、8.2（永続化する対象）
- 作る：`server/src/db/schema.ts`（置き換え）、`db/migrate.ts`、`db/repositories/*.ts`（原稿版、実行、検査単位、再確認単位、診断、指摘、採否）、`drizzle/` の SQL
- 規則：8.1 の表の項目をすべて持つ。原稿版は本文と本文ハッシュ。指摘は元候補への参照、位置特定状態、未確定位置を許す。位置特定失敗（`not-found` / `ambiguous`）は一覧表示用に指摘として保存し、`outside-target` は診断記録にだけ保存する。再確認結果は `verdict`、`reasonKind`、`suggestionValid` を持つ。採否は指摘 ID ごとに 1 件で更新日時を持つ。API キーは保存しない。マイグレーションは API 受付前に適用し、失敗したら起動を止める
- テスト：メモリ DB でのマイグレーション適用、各リポジトリの往復、CRLF を含む本文がそのまま戻ること、再起動を模した再オープン
- 受け入れ条件：11 節 12・13 項の永続化側
- 担当：Claude がスキーマ設計、qwen が実装、Claude が検証
- 大きさ：中

### PR9 server：実行キューとオーケストレーション

- 仕様：2（単一キュー）、6（処理順序）、6.4（観点の一部失敗）、7（未ロード、再試行 1 回）、8.2 全体
- 作る：`server/src/run/queue.ts`（PR7 の実行器を包み、複数の実行・タブからの要求を単一キューに直列化）、`run/orchestrator.ts`（PR7 のパイプラインに永続化・再開・停止を加える）、`run/state.ts`（状態遷移）、`run/recovery.ts`（生成終了の確認と上限付き待機）
- 規則：
  - 開始は常に新しい実行 ID。再開は既存 ID。二重送信は要求の同一性（実行 ID、開始操作の識別子）で判定
  - 各生成要求の直前に `ensureLoaded`。未ロードなら当該単位を `pending` のまま実行を `stopped` にし、案内を記録
  - 観点の一部失敗は成功分で統合に進み、実行を `partially-failed`
  - 停止は新規送信を止める。実行中の要求は abort し、生成終了を確認できるまで後続を送らない。上限を超えたら `recovery-waiting`
  - 自動再試行は各処理 1 回。完了済みは再開で繰り返さない。失敗単位の個別再試行
  - 分割範囲は開始時に計算して保存し、再開時は保存済みを使う
- テスト：モッククライアントでの状態遷移（開始、停止、再開、復旧待ち、部分失敗、再起動後の再開）、同じ開始要求の重複、単一キューの直列性
- 受け入れ条件：11 節 3・4・5・11・14・15・16・18 項
- 担当：Claude が状態機械と実装（委譲しない）、qwen がテストの雛形
- 大きさ：大

### PR10 server：HTTP API と SSE

- 仕様：4、5.1（ファイル読み込み）、8.2（ブラウザを閉じても継続）、9（ループバック、テキストとして扱う）
- 作る：`server/src/api/*.ts`（接続設定と確認、原稿、実行、指摘、採否、エクスポート）、`api/events.ts`（SSE）、zod による入出力検証
- エンドポイント（提案）：
  - `GET/PUT /api/settings/connection`、`POST /api/settings/connection/check`（一覧・状態・小さな生成を区別して返す）
  - `POST /api/manuscripts`（貼り付け）、`POST /api/manuscripts/upload`（ファイル。`decodeUtf8Strict` + `stripBom`）
  - `POST /api/runs`（開始）、`POST /api/runs/:id/stop|resume|retry-failed`、`GET /api/runs/:id`
  - `GET /api/runs/:id/findings`（絞り込み）、`PUT /api/findings/:id/judgment`
  - `GET /api/runs/:id/events`（SSE。購読の終了で検査を止めない）
  - `GET /api/runs/:id/export`
- テスト：`app.request` でのハンドラーテスト、SSE 切断後に実行が継続すること
- 受け入れ条件：11 節 2・12・13 項
- 担当：Claude が API 設計、qwen が実装、Claude が検証
- 大きさ：中

### PR11 web：接続・入力・設定画面

- 仕様：4（手順 1〜4）、5.1、5.2
- 作る：`web/src/features/connection/`、`features/manuscript/`、`features/settings/`、API クライアント（fetch の薄い包み。型は `shared` から）
- 規則：検査開始前に状態確認。空の本文では開始不可。ファイル入力は CRLF を保持（`File` を bytes のまま送る）。許容語は改行区切り
- テスト：コンポーネントの単体（Vitest + Testing Library。導入はこの PR）
- 受け入れ条件：11 節 1・2 項の UI 側
- 担当：Claude が画面設計、qwen が実装、Claude が検証
- 大きさ：中

### PR12 web：結果画面

- 仕様：4（手順 5〜7）、5.3、5.4、9（本文をテキストとして表示、位置対応の保持）
- 作る：`features/results/`（本文表示、強調、指摘一覧、詳細、採否、絞り込み）、SSE の購読と再接続時の状態取得
- 規則：本文は保存済み範囲で強調し、ブラウザで再計算しない。同じ範囲の複数指摘を参照可能。抑制候補・撤回候補は既定で非表示、切り替え可。「採用予定」は本文を書き換えない旨を表示。位置特定失敗（`not-found` / `ambiguous`）は一覧に出し、強調せず元の検査対象範囲への移動だけを提供。`outside-target` は通常一覧に出さず診断表示だけ。再確認が `suggestion-inappropriate` の指摘は修正案を有効なものとして表示しない
- テスト：UTF-16 範囲から DOM の強調への変換（絵文字・結合文字を含む本文で位置がずれない）、絞り込み、採否の更新
- 受け入れ条件：11 節 3・5・6・7・9・10・11・12・13・14 項の UI 側
- 担当：Claude が画面設計、位置→DOM 変換の設計、Unicode を含む期待結果の作成。qwen が実装、Claude が検証
- 大きさ：大

### PR13 all：評価ツール、エクスポート、実原稿での評価

- 仕様：10 全体、11（最後の 2 項）、8.2（エクスポート）
- 作る：`packages/cli/` に正解ファイルとの突き合わせと集計（検出率、誤検出、位置特定失敗率、診断候補の正誤、抑制の適否、所要時間）、複数回実行の集計、`docs/experiments/` への評価記録
- 実施：分割方式・分割＋再確認方式・全文チャット方式の比較、再確認が正しい指摘を撤回していないかの確認、命令文を含む原稿での逸脱の記録
- 受け入れ条件：11 節 20・21 項
- 担当：Claude が評価設計と集計、qwen が集計コード、評価原稿と正解はユーザー
- 大きさ：中（実施の時間は別）

## 受け入れ条件（11 節）と PR の対応

| # | 受け入れ条件 | PR |
| --- | --- | --- |
| 1 | LM Studio でモデルを選択し、生成要求と結果取得ができる | PR5、PR10、PR11 |
| 2 | 貼り付けと UTF-8 テキスト読み込みの両方から検査できる | PR1、PR10、PR11 |
| 3 | 全本文が検査対象に割り当てられ、観点ごとの処理状態を確認できる | PR2、PR7、PR9、PR12 |
| 4 | 参考文脈付きの分割検査と、文脈を広げた再確認が動作する | PR2、PR6、PR7、PR9 |
| 5 | 再確認の有無を切り替えて比較でき、撤回候補も確認できる | PR9、PR11、PR12 |
| 6 | 指摘から原文の該当箇所に移動し、正しい範囲が強調される | PR3、PR12 |
| 7 | 同一引用の反復、段落境界、CRLF、異体字セレクタ、結合文字、絵文字で位置がずれず、書記素の途中で分割されない | PR1、PR2、PR3、PR12 |
| 8 | 短い会話段落が連続しても文字数基準の参考文脈が渡される | PR2 |
| 9 | 位置特定失敗が一覧に表示され、引用と診断候補が保存される。診断候補は正式な位置に割り当てられない | PR3、PR8、PR12 |
| 10 | 許容語の抑制が機能し、文法・文脈上の問題は抑制されず、抑制候補を再閲覧できる | PR4、PR12 |
| 11 | 重複統合後に再確認され、初回判定を保持したまま最終判定が表示される。採否は上書きされない | PR4、PR9、PR12 |
| 12 | 採用予定・却下・保留を変更して保存でき、本文は変化しない | PR8、PR10、PR12 |
| 13 | ブラウザの再読み込み後も結果と判断が保持される | PR8、PR10、PR12 |
| 14 | 中断後に未完了分を同じ実行 ID で再開でき、失敗を指摘ゼロと誤表示しない | PR9、PR12 |
| 15 | 同じ原稿版・設定で新規検査を開始すると別の実行 ID になり、結果が混ざらない | PR9 |
| 16 | 複数タブ・複数原稿でも LLM 要求が単一キューで処理される | PR7（直列実行器）、PR9 |
| 17 | 参考文脈内から始まる候補は採用されず診断記録に残り、検査対象内から始まり参考文脈へ続く引用は採用される | PR3 |
| 18 | 生成終了を確認できない場合に「復旧待ち」となり、自動で後続生成を送信しない | PR9 |
| 19 | 不正 JSON、存在しない引用、出力打ち切りを検知でき、引用文字列を破壊しない | PR3、PR4、PR5、PR7 |
| 20 | 本文と指示の区切り、非追従の指示、出力検証を実装し、命令文を含む原稿での逸脱を評価・記録する | PR6、PR13 |
| 21 | 実原稿で評価指標を記録し、品質上の制約を確認できる | PR7、PR13 |

（仕様書 11 節は 21 項目。上表の番号は仕様書の並び順）

## 各 PR の進め方

1. ブランチを切る（`feat/pr<N>-<name>`）。
2. 本書の該当節から詳細計画 `docs/plans/<日付>-pr<N>-<name>.md` を書く（TDD の手順、テストコード、コミット単位まで）。
3. 実装は担当欄のとおり。qwen に委譲する場合は英語のスペックに不変条件を MUST / MUST NOT として明記する。
4. `pnpm check` を通し、Windows で未確認ならその旨を PR 本文に書く。
5. PR を作成しレビューを受ける。仕様の解釈で迷った点は PR 本文に列挙する。
6. 仕様や決定に変更が生じたら、同じ PR で `docs/spec/`、`docs/decisions/`、`docs/reference/` を更新する。
