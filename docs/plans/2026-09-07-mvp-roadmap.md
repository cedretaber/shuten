# MVP 実装ロードマップ（PR 単位）

作成日：2026-09-07  
仕様：`docs/spec/mvp-spec.md`（v0.8）  
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

// text/grapheme-index.ts（PR2）
interface GraphemeIndex { readonly boundaries: readonly number[]; readonly count: number }   // boundaries[k] は k 番目の書記素の開始位置、末尾は text.length
function buildGraphemeIndex(text: string): GraphemeIndex
function isGraphemeBoundary(index: GraphemeIndex, offset: number): boolean
function graphemeAt(index: GraphemeIndex, offset: number): number       // 境界でない位置は RangeError
function offsetAt(index: GraphemeIndex, grapheme: number): number         // 範囲外は RangeError

// text/grapheme.ts（scaffold 済み）
function countGraphemes(text: string): number
function segmentGraphemes(text: string): GraphemeSegment[]

// chunk/settings.ts（PR2）
interface ChunkSettings { readonly targetGraphemes: number; readonly contextGraphemes: number; readonly recheckContextGraphemes: number; readonly roundingTolerance: number /* 0.2 */; readonly maxInputGraphemes: number /* 検査対象 + 参考文脈の上限。書記素数 */ }
class InvalidChunkSettingsError extends Error
class InputTooLongError extends Error { readonly required: number; readonly limit: number }
function validateChunkSettings(settings: ChunkSettings): void                 // 不正なら InvalidChunkSettingsError
function roundingDelta(target: number, tolerance: number): number            // floor(target × tolerance)

// chunk/sentence.ts（PR2）
function findSentenceBoundaries(text: string, range: Range, index: GraphemeIndex): number[]   // 終端記号（。！？!?）とそれに続く閉じ括弧の並びの直後。書記素境界に限る

// chunk/plan.ts
interface TargetRange { readonly index: number; readonly range: Range; readonly paragraphIds: readonly number[] }
interface ContextWindow { readonly before: Range | null; readonly after: Range | null }
interface CheckInput { readonly target: TargetRange; readonly context: ContextWindow; readonly inputRange: Range }
function planTargets(text: string, paragraphs: readonly Paragraph[], settings: ChunkSettings): TargetRange[]
function buildCheckInput(text: string, paragraphs: readonly Paragraph[], target: TargetRange, settings: ChunkSettings): CheckInput           // settings.contextGraphemes を使う
function buildRecheckInput(text: string, paragraphs: readonly Paragraph[], initial: CheckInput, settings: ChunkSettings): CheckInput   // settings.recheckContextGraphemes。初回の inputRange を必ず含む

// locate/quote-ref.ts（PR3。LLM 出力の型に依存しない照合用の最小入力）
interface QuoteRef { paragraphId: number; quote: string; before: string; after: string }

// text/grapheme-index.ts（PR3 で追加）
function floorGraphemeBoundary(index: GraphemeIndex, offset: number): number   // offset 以下で最大の書記素境界
function ceilGraphemeBoundary(index: GraphemeIndex, offset: number): number    // offset 以上で最小の書記素境界

// locate/position-map.ts（PR3。比較用文字列と原文の位置対応。DiagnosticTransform と applyTransform だけ公開）
type DiagnosticTransform = "newline" | "nfc" | "newline+nfc"
function applyTransform(text: string, transform: DiagnosticTransform): string

// locate/diagnostic.ts（PR3）
interface DiagnosticCandidate { readonly transform: DiagnosticTransform; readonly text: string /* 一致を覆う書記素境界範囲の原文 */; readonly range: Range | null /* 位置対応が取れなければ null */ }
interface Diagnostic { readonly transformVersion: string; readonly candidates: readonly DiagnosticCandidate[] /* 指定段落に近い順、最大 3 件 */; readonly omitted: number /* 打ち切り件数 */; readonly tied: boolean /* 同順位あり */ }
const DIAGNOSTIC_CANDIDATE_LIMIT: number   // 3

// locate/locate.ts（PR3）
type LocateFailureReason = "not-found" | "ambiguous" | "outside-target"
type LocateResult =
  | { readonly status: "located"; readonly range: Range }
  | { readonly status: "failed"; readonly reason: LocateFailureReason; readonly exactMatches: readonly Range[]; readonly diagnostic: Diagnostic | null }
function locateQuote(text: string, input: CheckInput, paragraphs: readonly Paragraph[], ref: QuoteRef): LocateResult
// target.paragraphIds には文境界・書記素境界で切られて一部だけ重なる段落も入る。照合は inputRange で行い、
// ヒント（段落 ID → before → after）で 1 件に絞ってから「引用の開始位置が target.range 内か」で担当を決める。
// exactMatches は絞り込み後に残った完全一致（ambiguous / outside-target の記録用。採用位置には使わない）。
// diagnostic は not-found のときだけ非 null（空引用は null）。
// not-found / ambiguous は「位置特定失敗」として通常一覧に表示する。
// outside-target は参考文脈内から始まる候補で、通常一覧に出さず診断記録にだけ残す。

// llm/schema.ts（PR4）
type Perspective = "typo" | "naturalness"
type InitialVerdict = "likely-error" | "confirm-with-author"
// 分類。許容語による自動抑制は notation（誤字・表記の訂正）だけを対象にする（仕様書 6.4）
type FindingCategory = "notation" | "omission-or-duplication" | "particle" | "grammar" | "context-misuse" | "unclear"
// 列挙値は FINDING_CATEGORIES などの as const タプルとしても公開する（z.enum とテストの共用）
interface LlmFinding extends QuoteRef { category: FindingCategory; reason: string; suggestion: string | null; verdict: InitialVerdict }
// paragraphId は 0 以上の整数、quote は 1 文字以上（空引用を含む応答は形式不正）。suggestion の空文字・空白のみは解析時に null に正規化
interface LlmCheckOutput { findings: LlmFinding[] }
type RecheckVerdict = "keep" | "withdraw" | "confirm-with-author"
// 再確認の理由区分（仕様書 6.5 の確認内容に対応）。suggestion-inappropriate は修正案を有効な修正案として表示しない
// （修正案の改訂はしない）。suggestion-inappropriate と insufficient-context の verdict は confirm-with-author に限る（仕様書 6.5）
type RecheckReasonKind = "error-confirmed" | "intentional-expression" | "suggestion-inappropriate" | "unnecessary-polish" | "insufficient-context"
interface LlmRecheckOutput { reason: string; reasonKind: RecheckReasonKind; verdict: RecheckVerdict; suggestionValid: boolean }
const llmCheckOutputSchema: z.ZodType<LlmCheckOutput>; const llmRecheckOutputSchema: z.ZodType<LlmRecheckOutput>
// response_format の json_schema.schema 本体。変換を含まないワイヤ層から生成し、$schema と整数の maximum を除く。
// キー順（reason を suggestion・verdict の前）はプロンプト設計の一部で、PR6 が実測で並べ替えてよい（PROMPT_VERSION を上げる）
function checkOutputJsonSchema(): Record<string, unknown>; function recheckOutputJsonSchema(): Record<string, unknown>

// merge/candidate.ts, merge/merge.ts, merge/allowed-words.ts（PR4）
interface CandidateBase { id: string; perspective: Perspective; llm: LlmFinding }
interface LocatedCandidate extends CandidateBase { locate: Extract<LocateResult, { status: "located" }> }
interface UnlocatedCandidate extends CandidateBase { locate: Extract<LocateResult, { status: "failed" }> }
type Candidate = LocatedCandidate | UnlocatedCandidate
function partitionCandidates(candidates: readonly Candidate[]): { located: readonly LocatedCandidate[]; unlocated: readonly UnlocatedCandidate[] }
interface MergedFinding { id: string; range: Range; quote: string; category: FindingCategory; suggestion: string | null; verdict: InitialVerdict; sources: LocatedCandidate[] }
function mergeKey(candidate: LocatedCandidate): string | null   // 範囲・引用・修正案の完全一致。修正案なしは null（統合しない）。PR9 の再試行時の照合にも使う
function mergeCandidates(candidates: readonly LocatedCandidate[], createId: () => string): MergedFinding[]   // 位置確定済みだけを受け取る。同一実行内は呼び出し元が保証
// category は元候補が一致すればその値、不一致なら unclear。verdict は全候補が likely-error のときだけ likely-error
type SuppressionInput = Pick<MergedFinding, "category" | "quote" | "suggestion">
function findSuppression(finding: SuppressionInput, allowedWords: readonly string[]): Suppression | null   // Suppression = { word; ruleVersion }。SuppressionInput は構造的型なので、位置確定済みかどうかは呼び出し元が MergedFinding を渡すことで保証する
// 判定：引用内の登録語の出現 1 箇所（書記素境界）の外側が修正案と完全一致し、置換文字列が空でなく登録語を含まない。
// 登録語の前後・両側への挿入だけ（吉野家→吉野家だ、リュシア→リュシアー）は抑制しない。登録語は加工しない（空文字は飛ばす）
// UnlocatedCandidate は統合・抑制・再確認に進まず、そのまま保存して一覧に表示する（not-found / ambiguous）か
// 診断記録にだけ残す（outside-target）

// versions.ts
const PROMPT_VERSION, ALLOWED_WORD_RULE_VERSION, DIAGNOSTIC_TRANSFORM_VERSION: string
```

実行の状態名（DB に保存）：

- 検査実行 `RunStatus`（server）: `running` | `stopped` | `recovery-waiting` | `completed` | `partially-failed`
- 検査単位・再確認単位 `UnitStatus`（server）: `pending` | `running` | `done` | `failed` | `not-applicable`（許容語により対象外など）
- 失敗理由 `FailureReason`: `connection` | `model-not-loaded` | `input-too-long` | `timeout` | `truncated` | `malformed` | `aborted`
  （PR5 で `shared/src/run/failure-reason.ts` に置く。LM Studio を経由しない失敗と web の表示も同じ列挙を使う）

## 実装上の決定（提案。各 PR の着手時に確認する）

| 項目 | 提案 |
| --- | --- |
| ID | `crypto.randomUUID()` の文字列 |
| マイグレーション | `drizzle-kit generate` で SQL を生成しコミット。サーバー起動時、API の受付前に `migrate()` で適用し、失敗したら起動を止める |
| API | JSON の REST を `/api/` 配下に。進捗は `/api/runs/:id/events` の SSE |
| LLM を呼ぶテスト | `packages/server/vitest.integration.config.ts` の別プロジェクト。`SHUTEN_LM_STUDIO_URL` 未設定なら skip、設定時も生成に使えるロード済みモデルがなければ生成テストだけ skip。`pnpm test:llm` で実行 |
| エクスポート形式 | 実行 1 件を JSON 1 ファイルに（原稿版、設定、指摘、診断、採否を含む）。先頭に形式の版 `formatVersion` を持つ。仕様書 8.2 節の「実装設計時に決める」に対応 |
| 接続先の設定 | 環境変数 `SHUTEN_LM_STUDIO_URL`（既定 `http://127.0.0.1:1234`。ルート URL。`/v1` 付きは起動時エラー）と UI からの上書き。UI 側の値は DB に保存 |

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
PR9a server  実行キューとオーケストレーションの基盤
PR9b server  実行キューとオーケストレーション（本体）
PR10 server  HTTP API と SSE
PR11 web     接続・入力・設定画面
PR12 web     結果画面
PR13 all     評価ツール、エクスポート、実原稿での評価
```

依存関係：

```
PR1 → PR2 → PR3 → PR4 ──┬→ PR6 ──┐
PR5 ────────────────────┘        ├→ PR7（PR1〜PR6）→ PR9a（PR7、PR8）→ PR9b → PR10 → PR11, PR12 → PR13
PR1 → PR8 ───────────────────────┘
```

PR9a は PR7 の実行プリミティブの抽出と PR8 のスキーマ改修が中心で、オーケストレーターはまだ持たない。
PR9b は PR9a の部品の上に実行の開始・停止・再開・再試行をつなぐ。両方が終わって初めて PR9 の受け入れ条件を満たす。

- PR3 の `locateQuote` は PR4 の `LlmFinding` に依存しないよう、PR3 で `QuoteRef` を定義し `LlmFinding` はそれを拡張する。
- PR6 は PR4 のスキーマで応答を検証するため、PR4 と PR5 の両方の後。
- 並行できる組：`PR2〜PR4` と `PR5`、`PR8` と `PR6`、`PR11` と `PR12`（API を先に固定した場合）。

PR7 を PR8 より前に置くのは、UI 完成を待たずにプロンプトと生成設定（仕様書 13 節の未決）を実原稿で回し始めるため。
PR7 は 10 節の「全文チャット方式」との比較にも使い、PR13 の評価ツールの土台になる。
PR7 で作る検査パイプライン（`server/src/run/pipeline.ts`）から「1 検査単位・1 再確認単位を実行する」
プリミティブを PR9a が `run/units.ts` に抽出し、PR9b のオーケストレーションがそれを共用する。
PR9b はその上に永続化・再開・キュー管理を加える。

## ユーザーに依存する入力

| 入力 | 必要になる PR |
| --- | --- |
| Windows での scaffold 確認（`docs/guides/windows-verification.md`） | PR5 以降の Windows 実行 |
| 評価用原稿（作者が利用を認めたもの。リポジトリには入れない） | PR7 の試運転、PR13 |
| モデルの選択（仕様書 13 節） | PR7 の試運転では正解データがなく決められなかった。PR13 の評価で決める |
| 思考の有無（仕様書 13 節） | PR7 の試運転を踏まえ、当面の通常運用は思考なし（決定記録 0003 の 2026-09-09 の節）。思考ありは比較条件として残し、採否は PR13 |
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
- 作る：`text/grapheme-index.ts`、`chunk/settings.ts`、`chunk/sentence.ts`（文境界の検出。終端記号 `。！？!?` とそれに続く閉じ括弧の並びの直後。閉じ括弧単独は境界にしない）、`chunk/plan.ts`
- 提供：`GraphemeIndex` と変換関数、`ChunkSettings`（`maxInputGraphemes` を含む）、`validateChunkSettings`、`roundingDelta`、`InvalidChunkSettingsError`、`InputTooLongError`、`findSentenceBoundaries`、`TargetRange`、`ContextWindow`、`CheckInput`、`planTargets`、`buildCheckInput`、`buildRecheckInput`
- 詳細計画：`docs/plans/2026-09-07-pr2-chunk-plan.md`（丸めの規則、数値例、解釈で迷った点）
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
- 詳細計画：`docs/plans/2026-09-07-pr3-locate-quote.md`（実装済み）
- 作る：`locate/quote-ref.ts`、`locate/locate.ts`、`locate/diagnostic.ts`、`locate/position-map.ts`（正規化後の文字列から原文への位置対応）、`text/grapheme-index.ts` に境界の丸めを追加
- 提供：`QuoteRef`、`LocateResult`、`LocateFailureReason`、`Diagnostic`、`DiagnosticCandidate`、`DiagnosticTransform`、`DIAGNOSTIC_CANDIDATE_LIMIT`、`locateQuote`、`applyTransform`、`floorGraphemeBoundary`、`ceilGraphemeBoundary`
- 規則：
  - 完全一致を `inputRange` 内で探す（書記素境界で始まり終わる一致だけ。重なる出現も数える）。1 件なら確定。複数なら段落 ID → `before` → `after` の順に 1 件になるまで絞る。入力範囲内に存在しない段落 ID と空のヒントは飛ばし、有効なヒントが全候補と矛盾したらそこで打ち切る。`before` / `after` は CR/LF を除いて比べる（引用本体は完全一致）
  - 絞った結果の開始位置が `target.range` 外なら `outside-target`（診断記録に残す。付け替えない。通常一覧に出さない）。2 件以上残り、すべて対象外なら `outside-target`、1 件でも対象内なら `ambiguous`
  - `not-found` と `ambiguous` は位置特定失敗として保存し、通常一覧に表示する（強調はしない）
  - 完全一致ゼロのときだけ診断：改行統一、NFC、両方の 3 変換で比較し、指定段落に近い順（段落 ID の差）に最大 3 件。同順位（`tied`）と打ち切り件数（`omitted`）を記録。位置対応は書記素クラスタ単位で、取れない候補は `range: null`
  - 原文は変更しない。変換規則の版を記録
- テスト：同一引用の反復、検査対象から参考文脈へ続く引用、参考文脈から始まる引用、本文端、`before` / `after` が改行を省く応答、矛盾したヒント、NFC で一致する濁点の分解、CRLF と LF の違いでのみ一致、引用側だけが変換で変わる一致、候補 4 件以上での打ち切りと同順位、位置対応不能、異体字セレクタ・ZWJ・サロゲートの途中で切れる引用、ランダム検査
- 受け入れ条件：11 節 6・7・9・17 項の shared 側
- 担当：Claude がスペック、位置対応の設計、Unicode を含む期待結果の作成。qwen が実装、Claude が検証
- 大きさ：中〜大

### PR4 shared：LLM 出力スキーマ、重複統合、許容語抑制

- 仕様：6.2（構造化データ）、6.4 全体、7（スキーマ検証）
- 詳細計画：`docs/plans/2026-09-07-pr4-llm-schema-merge.md`
- 作る：`llm/schema.ts`（zod と JSON Schema）、`merge/candidate.ts`、`merge/merge.ts`、`merge/allowed-words.ts`。
  共通接頭辞・接尾辞の差分（`merge/diff.ts`）は作らない。出現ごとに「外側が一致し置換文字列が空でない」を直接判定すれば仕様 6.4 の条件をそのまま検査できる
- 提供：`Perspective`、`InitialVerdict`、`FindingCategory`、`LlmFinding`、`LlmCheckOutput`、`RecheckVerdict`、`RecheckReasonKind`、`LlmRecheckOutput`、列挙値のタプル、`llmCheckOutputSchema`、`llmRecheckOutputSchema`、`checkOutputJsonSchema`、`recheckOutputJsonSchema`、`CandidateBase`、`Candidate`、`LocatedCandidate`、`UnlocatedCandidate`、`partitionCandidates`、`MergedFinding`、`mergeKey`、`mergeCandidates`、`Suppression`、`SuppressionInput`、`findSuppression`
- 依存：shared に `zod` `4.5.4`（server と同じ版）
- 規則：
  - `partitionCandidates` で位置確定済みと失敗を分ける。統合・抑制・再確認は `LocatedCandidate` だけを扱い、`UnlocatedCandidate` は保存・表示の経路へ渡す
  - 統合は同じ範囲・原文・修正案。修正案なしや別の問題は統合しない。観点と元候補への参照を保持。統合後の `category` は元候補が一致すればその値、不一致なら `unclear`
  - 抑制の前提：`category` が `notation`（誤字・表記の訂正）で、位置確定済みで、修正案があること。`context-misuse`、`particle`、`grammar`、`unclear`、`omission-or-duplication` は抑制しない
  - 抑制の判定：「引用内の登録語の出現 1 箇所を空でない別の文字列に置き換えるだけで修正案を再現できる」。外側は完全一致。削除、複数出現にまたがる変更、範囲外に及ぶ変更は抑制しない
  - 「引用が登録語だけ」「変更の一部に登録語を含む」はそれ自体では抑制の理由にならない。上の判定を満たすかどうかだけで決める
  - 抑制結果に登録語と規則版を含める
  - 再確認の `reasonKind` が `suggestion-inappropriate` のとき、`suggestionValid` は false。表示側は修正案を有効な修正案として出さず、履歴には残す。`suggestion-inappropriate` と `insufficient-context` の `verdict` は `confirm-with-author`（仕様 6.5）。他の対応は検査しない
  - スキーマは未知のキーを捨てて受理する。必須キーの欠落、型違い、未知の列挙値、空の引用、整数でない段落 ID は応答全体を形式不正にする
  - 接続検証（決定記録 0003）で試したスキーマは文字列項目だけ。本 PR が加える `minimum`、`minLength`、`type: ["string", "null"]`、`enum` は未確認なので、生成した実スキーマでの疎通試験を PR5 の統合テストで実施し、`strict: true` で通ることを確認した（2026-09-08、決定記録 0003 の追試）
- テスト：
  - 同じ引用「リュシア」・修正案「ルシア」で、`notation`（抑制）、`context-misuse`（抑制しない）、`unclear`（抑制しない）を分けて検証
  - 引用が登録語だけで表記訂正（抑制）、登録語を含む文で登録語の外側も変わる（抑制しない）、複数出現のうち 1 箇所（抑制）、削除（抑制しない）、修正案 null（抑制しない）
  - `partitionCandidates` の分割、`mergeCandidates` が `UnlocatedCandidate` を型で受け付けないこと
  - 前後・両側への挿入だけの修正案（抑制しない）、修正案側にだけ登録語がある（抑制しない）、書記素境界の途中の出現（数えない）、重なる出現
  - スキーマが不正 JSON、未知の `category`、`reasonKind` と `suggestionValid` の矛盾（`suggestion-inappropriate` かつ true）を拒否
- 受け入れ条件：11 節 10・11 項の shared 側、19 項の一部
- 担当：Claude がスペックと許容語判定の期待結果の作成、qwen が実装、Claude が検証
- 大きさ：中

### PR5 server：設定と LM Studio クライアント

- 詳細計画：`docs/plans/2026-09-08-pr5-lmstudio-client.md`
- 仕様：7（v0.8 で一覧を `/api/v0/models` に一本化、接続先をルート URL に改訂）、8.2（切断をキャンセル要求として扱う）、決定記録 0003
- 作る：`shared/src/run/failure-reason.ts`、`server/src/lmstudio/client.ts`、`lmstudio/errors.ts`、`lmstudio/types.ts`、`lmstudio/wire.ts`、`config.ts` の拡張、`vitest.integration.config.ts`
- 提供：
  ```ts
  interface LmStudioClient {
    listModels(options?: RequestOptions): Promise<ModelInfo[]>            // /api/v0/models。type, state, quantization, loaded_context_length
    ensureLoaded(modelId: string, options?: RequestOptions): Promise<ModelInfo>   // not-loaded なら LmStudioError（model-not-loaded）
    chat(request: ChatRequest, options: ChatOptions): Promise<ChatResult>         // ChatOptions は timeoutMs 必須、signal 任意
  }
  interface ChatResult { content: string; reasoningContent: string | null; finishReason: string; usage: Usage | null; raw: unknown }
  interface Usage { promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens: number | null }
  class LmStudioError extends Error { kind: FailureReason; status: number | null; usage: Usage | null; finishReason: string | null; raw: unknown }
  ```
  `RequestOptions` は `{ signal?, timeoutMs? }`。一覧取得の既定タイムアウトは 10 秒（初期値。仕様書 13 節の未決とは別）。
  生成のタイムアウトに既定値は置かない。`ChatRequest` は camelCase で受け取り、クライアントがワイヤ形式（`stream: false`、
  トップレベルの `reasoning_effort`、`response_format.json_schema.strict`）に直す
- 規則：`finish_reason == "length"` は `truncated` の例外にする（`usage` と `raw` を例外に載せる）。応答本文の JSON 解析とスキーマ検証は PR6（`<think>` 分離も再試行もここでは実装しない）。API キーは `Authorization` にだけ載せ、例外にも入れない
- テスト：モック `fetch` でのエラー分類、abort で `aborted`、タイムアウト（フェイクタイマー）、`length` の扱い、API キーが例外に漏れないこと。統合テスト（`pnpm test:llm`）で実 LM Studio の一覧・状態・小さな生成と、PR4 のスキーマでの疎通確認
- 受け入れ条件：11 節 1・19 項
- 担当：Claude が設計、実装はサブエージェント（Claude）、Claude が検証と統合テスト
- 大きさ：中

### PR6 server：プロンプトと要求の組み立て

- 詳細計画：`docs/plans/2026-09-08-pr6-prompts.md`
- 仕様：3.1、5.2（許容語のヒント）、5.4、6.2、6.5、13（プロンプトは未決。ここで初版を作り版を付ける）
- 作る：`server/src/prompts/types.ts`（`GenerationSettings`、`CheckRequestInput`、`RecheckRequestInput`）、`prompts/render.ts`（`<context_before>` / `<target>` / `<context_after>` の描画）、`prompts/common.ts`（system プロンプト共通部。原稿・許容語中の命令に従わない非追従の指示を含む）、`prompts/typo.ts`、`prompts/naturalness.ts`、`prompts/recheck.ts`、`prompts/build.ts`、`prompts/parse.ts`、`lmstudio/integration-support.ts`（統合テスト共通ヘルパー）、`test/fixtures/injection/`（命令文を含む原稿）
- 提供：`buildCheckRequest(args: CheckRequestInput): ChatRequest`、`buildRecheckRequest(args: RecheckRequestInput): ChatRequest`、`parseCheckResponse(result: ChatResult): LlmCheckOutput`、`parseRecheckResponse(result: ChatResult): LlmRecheckOutput`（PR4 のスキーマで検証）。`CheckRequestInput` / `RecheckRequestInput` はオブジェクト 1 引数で、保存本文・`paragraphs`（原稿版全体の段落）・`CheckInput`・許容語に加え、生成パラメーターを `GenerationSettings`（`model`、`maxTokens`、`temperature`、`seed?`、`reasoningEffort?`。既定値は持たない）として受け取る
- 規則の追加：プロンプトは `category` と `reasonKind` の各値の意味を本文に書き、モデルが分類を選べるようにする。原稿は段落マーカー `[P12]` を付けて描画し、`quote`・`before`・`after` のいずれにも段落マーカーやタグを含めない指示を明示する。再確認では `reasonKind` が `suggestion-inappropriate` のとき `suggestionValid` は false、`suggestion-inappropriate` または `insufficient-context` のとき `verdict` は `confirm-with-author` という矛盾する組み合わせをプロンプト本文で明示する
- 規則：項目の意味（引用、前後の引用、修正案は引用全体に対応し変更を最小限、理由）をプロンプト本文に書く。体言止め・倒置・口語・造語を誤りにしない指示。件数のノルマなし。思考の有無は設定
- テスト：プロンプトのスナップショット（版が変わったら更新）、命令文を含む原稿の統合テストで逸脱の有無を記録
- 受け入れ条件：11 節 20 項
- 担当：Claude（プロンプト設計は委譲しない）
- 大きさ：中

### PR7 server + cli：検査パイプライン（DB なし）と評価ハーネス

- 詳細計画：`docs/plans/2026-09-08-pr7-pipeline.md`
- 試運転の記録：`docs/experiments/2026-09-08-pipeline-trial/`（実 LM Studio・実原稿。タイムアウトの実測、思考ありの挙動、生成パラメーターの追加可否）
- PR5 からの持ち越し：`chat` を実際に使うときに、既定タイムアウトの適用・本文読み取り中のタイムアウト・`truncateRaw` の各テストを足す → **本 PR で対応済み**（テスト L1〜L4）
- PR6 からの持ち越し：
  - **本 PR で対応済み**：`finish_reason` が `stop` / `length` 以外のときの扱い（実行器が `truncated` として失敗にし、実際の値を `failure.finishReason` に残す。テスト E5）、段落マーカーの引用への混入の観測（合成長文・実原稿とも混入ゼロ。`docs/experiments/2026-09-08-pipeline-trial/`）
  - **未対応（持ち越し）**：`<think>` 分離（実測で必要になったモデルが出たら、決定記録 0003 の追記と同時に実装する）、`before` / `after` の長さの調整
  - 統合テスト I5・I6（命令文・区切り偽装を含む原稿と許容語での逸脱の観察。仕様書 6.2 が求める「代表的な命令文を含む原稿での逸脱の評価」）は実機（qwen/qwen3.8-27b）で実行済みで、記録は `docs/experiments/2026-09-08-prompt-injection/` にある（2026-09-08）。ただし 1 モデル・1 生成設定・実質 1 回分の観測にとどまるため、PR13 の評価で改めて取り直す。

- 仕様：6（処理順序）、7（未ロード、再試行 1 回、生成終了未確認時の扱い）、10（比較実験）、13（プロンプトと生成設定の実測）
- 作る：
  - `server/src/run/pipeline.ts`：本文と設定と `LmStudioClient` を受け取り、分割 → 観点別検査 → 位置確定 → 分割（確定／失敗）→ 統合・抑制 → 再確認（任意）を実行する純粋な処理。DB に依存せず、進捗と各単位の結果をコールバックで通知する。PR9 のオーケストレーションはこれを共用する
  - `server/src/run/executor.ts`：生成要求を直列に実行する小さな実行器（同時実行 1）。PR9 のキューはこれを包む
  - `packages/cli/`（新規パッケージ。`bin/shuten-eval.ts`）：原稿ファイルと設定を読み、パイプラインを呼び、結果を JSON に出す。`--mode full-text` で全文を 1 要求で送る比較用の経路
- 規則：
  - 許容語は改行区切りの文字列で受け取り、server が CRLF を含む改行で分割して各語を trim し、空行を除いた配列にしてからプロンプトと `findSuppression` に渡す（shared は登録語を加工しない）
  - 分割前に `validateChunkSettings` を呼ぶ。`maxInputGraphemes` はモデルのコンテキスト長から換算する（係数は実測で決める）。`InputTooLongError` と `InvalidChunkSettingsError` はどちらも「設定変更を案内」の終了理由にし、本文を縮めない
  - 要求は直列。各要求の直前に `ensureLoaded`
  - タイムアウトや abort の後に生成終了を確認できなければ、後続の要求を送らずにパイプラインを終了し、その旨を結果に残す（PR9 の「復旧待ち」に相当する終了理由）
  - 失敗した単位を含む途中結果をそのまま JSON に残す。失敗を指摘ゼロにしない
  - 実行条件（モデル、量子化、コンテキスト長、seed、思考の有無、プロンプト版、許容語規則版、診断変換版）を JSON に含める
- テスト：モック `LmStudioClient` でパイプライン全体の結合テスト（通常テストで実行）。不正 JSON、`length`、未ロード、タイムアウト後の停止、部分失敗の各経路。実機を使う結合テストは統合テストとして分離。CLI は引数解釈と JSON 形式の単体
- 評価指標の集計（検出率、誤検出、位置特定失敗率）は正解ファイルとの突き合わせで PR13 に回す
- 受け入れ条件：11 節 21 項の土台。3・4・19 項のパイプライン側
- 担当：Claude がパイプラインの設計と実装、CLI と結合テストも Claude（サブエージェント）が実装、Claude が実原稿での試運転
- 大きさ：中〜大
- 補足：この PR 以降、プロンプトと生成設定の調整を実原稿で回せる

### PR8 server：DB スキーマと永続化

- 詳細計画：`docs/plans/2026-09-09-pr8-db-persistence.md`
- 仕様：8.1 全体、8.2（永続化する対象）
- 作る：`server/src/db/schema.ts`（置き換え）、`db/migrate.ts`、`db/repositories/*.ts`（原稿版、実行、検査単位、再確認単位、診断、指摘、採否）、`drizzle/` の SQL
- 規則：8.1 の表の項目をすべて持つ。原稿版は本文と本文ハッシュ。指摘は元候補への参照、位置特定状態、未確定位置を許す。位置特定失敗（`not-found` / `ambiguous`）は一覧表示用に指摘として保存し、`outside-target` は診断記録にだけ保存する。再確認結果は `verdict`、`reasonKind`、`suggestionValid` を持つ。採否は指摘 ID ごとに 1 件で更新日時を持つ。API キーは保存しない。マイグレーションは API 受付前に適用し、失敗したら起動を止める
- テスト：メモリ DB でのマイグレーション適用、各リポジトリの往復、CRLF を含む本文がそのまま戻ること、再起動を模した再オープン
- 受け入れ条件：11 節 12・13 項の永続化側
- 担当：Claude がスキーマ設計、qwen が実装、Claude が検証
- 大きさ：中

### PR9 server：実行キューとオーケストレーション（PR9a / PR9b）

**詳細計画は 1 本にまとめてある**：`docs/plans/2026-09-09-pr9-orchestration.md`。設計判断（決定 1〜23）、
テスト一覧、PR8 からの持ち越しの対応表もそこにある。以下はロードマップの粒度での要約。

分割の理由：状態遷移・クラッシュ整合性・時間依存テストが 1 つの diff に重なるとレビューが難しくなるため、
「挙動を変えない基盤」と「実行を開始・停止・再開する本体」に分けた。**PR9a だけでは受け入れ条件を
1 つも満たさない**（利用者から見える動きは増えない）。9a と 9b がそろって初めて PR9 の受け入れ条件を満たす。

#### PR9a：基盤（完了）

- 仕様：2（単一キュー）、8.2（状態・境界検証の前提）
- 作った：
  - `server/src/run/units.ts`：「1 検査単位」「1 再確認単位」を実行するプリミティブ。`pipeline.ts`（PR7）は
    これを呼ぶ形に変わったが、CLI の挙動は変えていない。`recoveryConfirmMs`（既定 0）を受け取り、
    0 なら従来どおり `checkMs` がハード上限
  - `server/src/run/queue.ts`：プロセス全体で 1 本の FIFO キュー。`createExecutor` の任意オプション
    `queue` に渡すと、`ensureLoaded` + `chat` + 解析 + 再試行 1 回の全体が 1 ジョブになる。`runPipeline`（CLI）
    は渡さない
  - マイグレーション `0001`（`runs.stop_requested_at`、`runs.recovery_confirm_ms`）と、`claim*` の
    `started_at` 同時設定、`finish*` の条件付き更新（戻り値 `boolean`）、`updateFindingAggregate` /
    `nextCandidateIndex` / `findRunByStartOperationId` / `findFindingByMergeKey` などの追加。
    `AppDatabaseLike` でトランザクションハンドルも受けられるようにした（PR8 必須事項 1・2 に対応）
  - `server/src/run/state.ts`：実行・単位の許容状態遷移表と `runStatusForStop`
  - `server/src/run/persist.ts`：境界検証（`mergeKey`・抑制・段落 ID・孤立サロゲート）と
    `RunTargetRecord` → `CheckInput` の変換（PR8 必須事項 3 に対応）
  - `server/src/run/merge-store.ts`：保存済み指摘への増分マージ（`mergeKey` 照合と集約の再計算）
- PR9a の実施で分かったことは PR9b への持ち越しとして詳細計画の該当節に記録した（キュー待ち時間を含む
  遅延通知の意味、`tail` とキューの二重直列化、状態遷移テストの型アサーション、抑制の許容語の受け渡し、
  再確認単位を作る順序）
- 受け入れ条件：本 PR だけでは満たすものなし（PR9b の完了時にまとめて満たす）
- 担当：Claude が状態機械と実装（委譲しない）、qwen がテストの雛形
- 大きさ：中

#### PR9b：完成したオーケストレーター（未着手）

- PR8 からの持ち越し（**先頭 3 件は PR9a で対応済み**。レビューで確認済み）：
  - **対応済み（PR9a）**：`claim` 時に `started_at` を設定する
  - **対応済み（PR9a）**：`finishCheckUnit` / `finishRecheckUnit` / `finishRun` の無条件 UPDATE を、
    安全な状態遷移か条件付き更新に置き換える
  - **対応済み（PR9a）**：パイプライン結果から DB レコードへ変換する境界で、`mergeKey`・許容語抑制・段落 ID を検証する
  - 保存済み `TargetPlan[]` を渡す口の設計と、`target-planned` イベント。PR8 は `run_targets` を作るところまでで、パイプライン側の入口は触っていない
  - 生成終了の確認と上限付き待機（`recovery-waiting` への遷移）の制御。PR8 は列（`status`、`generation_unconfirmed`）だけ用意した
  - 位置特定失敗の指摘に `recheck_units`（`not-applicable` / `unlocated`）を作ること。`saveUnlocatedCandidate` では行っていない
  - `listFindings` が N+1（指摘 1 件につき `reasons` を 1 クエリ）。PR12 の表示要件が固まってから直す
  - 入れ子トランザクションが SAVEPOINT として正しく動くことは確認済み。PR9b が外側のトランザクションから呼ぶ設計にしてよい

- 仕様：6（処理順序）、6.4（観点の一部失敗）、7（未ロード、再試行 1 回）、8.2 全体
- 作る：`server/src/run/orchestrator.ts`（実行の開始・停止・再開・失敗単位の個別再試行、単位駆動ループ）、
  `run/recovery.ts`（生成終了の確認と上限付き待機）、`index.ts` への起動時照合（`reconcileOnStartup`）の組み込み
- 規則：
  - 開始は常に新しい実行 ID。再開は既存 ID。二重送信は要求の同一性（実行 ID、開始操作の識別子）で判定
  - 各生成要求の直前に `ensureLoaded`。未ロードなら当該単位を `pending` のまま実行を `stopped` にし、案内を記録
  - 観点の一部失敗は成功分で統合に進み、実行を `partially-failed`
  - 失敗観点の再試行で同じ候補が出たときの照合は `mergeKey` で行うが、鍵は実行 ID を含まないので、保存済みの統合結果は実行 ID で名前空間を切って照合する（仕様 6.4「統合は同一の検査実行内に限定」を永続化層で破らない）
  - 停止は新規送信を止める。実行中の要求は上限内なら自然な完了を待ち、上限を超えたら abort して `recovery-waiting`
  - 自動再試行は各処理 1 回。完了済みは再開で繰り返さない。失敗単位の個別再試行
  - 分割範囲は開始時に計算して保存し、再開時は保存済みを使う
  - `checkMs` の意味の改訂（遅延通知の閾値になる。ハード上限は `checkMs + recoveryConfirmMs`）を仕様書に反映し、
    版を上げて 15 節の改訂記録に追記する（同じコミットに含める）
- テスト：モッククライアントでの状態遷移（開始、停止、再開、復旧待ち、部分失敗、再起動後の再開）、同じ開始要求の重複、起動時照合、再起動後の再開
- 受け入れ条件：11 節 3・4・5・11・14・15・16・18 項（すべて PR9b の完了時に満たす）
- 担当：Claude が状態機械と実装（委譲しない）、qwen がテストの雛形
- 大きさ：大

### PR10 server：HTTP API と SSE

- PR8 からの持ち越し：
  - UI からの接続先上書きを保存する `settings` 表
  - `LmStudioClient` の `close()` / `dispose()`（PR7 からの持ち越し）
  - 貼り付け経路の孤立サロゲートを API 側でも弾くか。PR8 は決定 17 で永続化層が拒否するようにしたので保存は守られるが、ユーザーに何を返すかは PR10 で決める
  - `index.ts` が DB ハンドルを閉じない（graceful shutdown なし）

- 仕様：4、5.1（ファイル読み込み）、8.2（ブラウザを閉じても継続）、9（ループバック、テキストとして扱う）
- 作る：`server/src/api/*.ts`（接続設定と確認、原稿、実行、指摘、採否、エクスポート）、`api/events.ts`（SSE）、zod による入出力検証
- エンドポイント（提案）：
  - `GET/PUT /api/settings/connection`、`POST /api/settings/connection/check`（一覧・状態・小さな生成を区別して返す）
  - `POST /api/manuscripts`（貼り付け）、`POST /api/manuscripts/upload`（ファイル。`ingestUtf8Bytes`）
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

- PR8 からの持ち越し：一括エクスポート形式と、そこでの接続先 URL の扱い

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
| 3 | 全本文が検査対象に割り当てられ、観点ごとの処理状態を確認できる | PR2、PR7、PR9b、PR12 |
| 4 | 参考文脈付きの分割検査と、文脈を広げた再確認が動作する | PR2、PR6、PR7、PR9b |
| 5 | 再確認の有無を切り替えて比較でき、撤回候補も確認できる | PR9b、PR11、PR12 |
| 6 | 指摘から原文の該当箇所に移動し、正しい範囲が強調される | PR3、PR12 |
| 7 | 同一引用の反復、段落境界、CRLF、異体字セレクタ、結合文字、絵文字で位置がずれず、書記素の途中で分割されない | PR1、PR2、PR3、PR12 |
| 8 | 短い会話段落が連続しても文字数基準の参考文脈が渡される | PR2 |
| 9 | 位置特定失敗が一覧に表示され、引用と診断候補が保存される。診断候補は正式な位置に割り当てられない | PR3、PR8、PR12 |
| 10 | 許容語の抑制が機能し、文法・文脈上の問題は抑制されず、抑制候補を再閲覧できる | PR4、PR12 |
| 11 | 重複統合後に再確認され、初回判定を保持したまま最終判定が表示される。採否は上書きされない | PR4、PR9b、PR12 |
| 12 | 採用予定・却下・保留を変更して保存でき、本文は変化しない | PR8、PR10、PR12 |
| 13 | ブラウザの再読み込み後も結果と判断が保持される | PR8、PR10、PR12 |
| 14 | 中断後に未完了分を同じ実行 ID で再開でき、失敗を指摘ゼロと誤表示しない | PR9b、PR12 |
| 15 | 同じ原稿版・設定で新規検査を開始すると別の実行 ID になり、結果が混ざらない | PR9b |
| 16 | 複数タブ・複数原稿でも LLM 要求が単一キューで処理される | PR7（直列実行器）、PR9b（PR9a の単一キューをオーケストレーターが使う） |
| 17 | 参考文脈内から始まる候補は採用されず診断記録に残り、検査対象内から始まり参考文脈へ続く引用は採用される | PR3 |
| 18 | 生成終了を確認できない場合に「復旧待ち」となり、自動で後続生成を送信しない | PR9b |
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
