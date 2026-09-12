# MVP 実装ロードマップ（PR 単位）

作成日：2026-09-07  
仕様：`docs/spec/mvp-spec.md`（v0.9）  
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
| エクスポート形式 | 実行 1 件を JSON 1 ファイルに（原稿版、設定、指摘、診断、採否を含む）。先頭に形式の版 `formatVersion` を持つ。接続先 URL は含めない。仕様書 8.2 節の「実装設計時に決める」に対応（PR13a-2） |
| 接続先の設定 | 環境変数 `SHUTEN_LM_STUDIO_URL`（既定 `http://127.0.0.1:1234`。ルート URL。`/v1` 付きは起動時エラー）と UI からの上書き。URL は `settings` 表に保存し、API キーはプロセスのメモリだけ（PR10 計画の決定 5） |

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
PR11 web     接続・入力・設定画面（アプリの骨格と API クライアントを含む）
PR11c web    設定画面の統合とナビゲーション（PR11 の後続。配置換えのみで機能は増やさない）
PR11b server 接続断で失敗した単位の復旧を 1 段にする（決定 20 の改訂）
PR12a web    結果閲覧（完了済み実行の本文・強調・指摘一覧・詳細・採否・絞り込み）
PR12b web    実行制御（開始・進捗・停止・再開・再試行・復旧確認、SSE、再読み込み復元）
PR12c server 指摘一覧の 3N+1 解消（PR12a の計測で決着した持ち越し）
PR13a-1 server+cli  評価ツール（正解ファイルの形式、突き合わせと集計、複数回実行の集計、CLI のサブコマンド化）（完了）
PR13a-2 server+cli  エクスポートの口と形式（`GET /api/runs/:id/export`）、評価入力アダプター（完了）
PR13a-3 server+cli  全文チャット方式（自由形式プロンプト）の CLI モード（未着手）
PR13b   all         実原稿での評価の実施と、仕様書 13 節の確定
```

チェックポイント（PR ではない作業）：

- **Windows でのローカル確認**：PR11 の実装後・マージ前（`docs/guides/windows-verification.md`）。
  2026-09-10 に前倒しをやめた。ガイドの 5 手順のうち 4 つは CI の `windows-latest` が同じ内容を毎回確認しており、
  残るのは「`pnpm start` してブラウザから使う」経路だけである。それはまさに PR11 が作る画面なので、
  PR11 より前に確認しても対象が置き換わる。PR11 のマージ条件として実施する。
- **強調表示のスパイク**：PR11 の後・PR12a の設計前。UTF-16 範囲 → DOM の方式を確かめる。コードは残さない。
  → **2026-09-11 に実施済み**（`docs/experiments/2026-09-11-highlight-spike/README.md`）。方式は成立し、
  ブラウザ側に書記素境界の計算は要らないことを実ブラウザで確認した。1 万字・指摘 800 件で構築 5〜7 ms、
  DOM 反映 21 ms、選択中の指摘の塗り替え 0.1 ms 未満。仮想スクロールは不要。PR12a への申し送り 8 件を
  同記録に残した。
- **評価原稿と正解データの準備**：今から。**形式は PR13a-1 で確定した**（`docs/reference/truth-format.md`）。
  13b までに揃える（ユーザー）。

依存関係：

```
PR1 → PR2 → PR3 → PR4 ──┬→ PR6 ──┐
PR5 ────────────────────┘        ├→ PR7（PR1〜PR6）→ PR9a（PR7、PR8）→ PR9b → PR10 → PR11 → [Windows] → PR11c → PR11b → [スパイク] → PR12a → PR12b → PR12c → PR13b
PR1 → PR8 ───────────────────────┘                                                    └→ PR13a-1（PR10 の後いつでも。PR13b の前）─┬→ PR13a-2 ─┐
                                                                                                                                 └→ PR13a-3 ─┴→ PR13b
```

（2026-09-09 の見直し後、2026-09-12 に PR13a を 13a-1/13a-2/13a-3 へ分割。分割の理由は
`docs/plans/2026-09-12-pr13a-evaluation-export.md` 決定 1。見直しの内容は「2026-09-09 の見直し」節）

PR9a は PR7 の実行プリミティブの抽出と PR8 のスキーマ改修が中心で、オーケストレーターはまだ持たない。
PR9b は PR9a の部品の上に実行の開始・停止・再開・再試行をつなぐ。両方が終わって初めて PR9 の受け入れ条件を満たす。

PR13a-2（エクスポート）と PR13a-3（全文チャット方式）は、どちらも PR13a-1 が作る突き合わせ器・
サブコマンドの器の上に乗るため PR13a-1 の後だが、互いには依存せず順序を入れ替えてよい
（決定 1：エクスポートは「結果を出す側」で漏えいと問い合わせ本数が論点、全文チャット方式は
生成の失敗・打ち切りが論点で、中身が無関係）。どちらも PR13b の前に終える。

- PR3 の `locateQuote` は PR4 の `LlmFinding` に依存しないよう、PR3 で `QuoteRef` を定義し `LlmFinding` はそれを拡張する。
- PR6 は PR4 のスキーマで応答を検証するため、PR4 と PR5 の両方の後。
- 並行できる組：`PR2〜PR4` と `PR5`、`PR8` と `PR6`、`PR13a-1` と `PR11`〜`PR12c`（2026-09-09 の見直しで `PR11` と `PR12` の並行は取り下げ。`PR11 → PR11c → PR11b → PR12a → PR12b → PR12c` の順。
  `PR11c` は web、`PR11b` は server なので互いに独立で、順序は入れ替えてよい。`PR12c` も server の小さな改善で
  `PR13a-1` とは独立に進められるため、`PR13a-1` との並行に含めている）。

PR7 を PR8 より前に置くのは、UI 完成を待たずにプロンプトと生成設定（仕様書 13 節の未決）を実原稿で回し始めるため。
PR7 は 10 節の「全文チャット方式」との比較にも使い、PR13 の評価ツールの土台になる。
PR7 で作る検査パイプライン（`server/src/run/pipeline.ts`）から「1 検査単位・1 再確認単位を実行する」
プリミティブを PR9a が `run/units.ts` に抽出し、PR9b のオーケストレーションがそれを共用する。
PR9b はその上に永続化・再開・キュー管理を加える。

## 2026-09-09 の見直し

PR9b の完了時点（PR10 は計画済み）で残りの工程を見直した。当初の予定からの差と、今から見える設計修正を
次のとおり反映した。

**予定との差**

- PR1〜PR9b は 3 日で完了した。PR9 は 9a / 9b に分けた。
- **PR13 が実質のクリティカルパスで、着手していなかった。** 仕様書 13 節の未決（モデル、思考、生成設定、
  分割長、タイムアウト、許容する誤検出）をすべて PR13 に先送りしており、PR13 は評価原稿と正解データに依存する。
  PR7 の試運転は「正解なしでは件数は品質の指標にならない」と結論した。CLI は既に動くので、PR13 を
  13a（集計ツール）と 13b（実施）に分け、13a と正解データの準備を今から並行する。
- 担当欄の「qwen が実装」は PR9b 以降の実態（Claude のサブエージェント駆動）と違っていた。以降の PR の担当欄を改めた。
- Windows でのローカル確認を PR5 以降一度もしていない（CI のみ）。チェックポイントを置く。
  当初は PR10 のマージ後・PR11 の前としたが、2026-09-10 に PR11 の実装後・マージ前へ移した（上記チェックポイント欄）。
- PR10 の接続確認から試験生成を外した（生成終了未確認を表現できないため。PR10 計画の決定 8）。受け入れ条件 1 項は
  PR11 の最初の検査実行で満たす。エクスポートは PR10 から PR13a（2026-09-12 の分割後は PR13a-2）へ移した
  （PR10 計画の決定 16）。どちらも PR10 の実施で確定した。

**設計修正**

- **復旧確認の永続化**（PR10 に含める）：版が変わった `recovery-waiting` の実行が起動のたびに復旧ゲートを閉じ直す
  問題を、`runs.recovery_confirmed_at` を足して確認済みの実行ではゲートを閉じないことで解消する。
- **接続断で失敗した単位の 1 段復旧**（PR11b）：応答を受け取らずに切れた単位を復旧待ちと同時に `pending` に戻す。
  PR9 決定 20 の改訂を伴うので、HTTP 層とは別の小さなサーバー PR にし、PR12 が最終の状態モデルに対して設計できる
  ように PR12a の前に置く。
  → **2026-09-10 に PR11b で実施済み**（`docs/plans/2026-09-10-pr11b-one-step-recovery.md`）。
- **設定画面の統合とナビゲーション**（PR11c。2026-09-10 に追加）：PR11 の画面を実際に触って、接続設定画面から
  戻る導線が無いこと、めったに触らない設定が「詳細設定（メイン画面）」と「接続設定（別画面）」の 2 か所に
  分かれていることが分かった。`/settings` へ 3 節にまとめ、ヘッダーの「朱点」をホームへのリンクにする。
  仕様の改訂は伴わない配置換えなので小さい PR にする（`docs/plans/2026-09-10-pr11c-settings-consolidation.md`）。
- **PR12 の分割**：12a（結果閲覧。PR10 の GET だけで作れる）と 12b（実行制御・SSE）。レビュー単位を PR9b 級に抑える。
- **強調表示のスパイク**：UTF-16 範囲 → DOM の変換は PR12a の構造を決める最難部なので、設計の前に実現可能性を確かめる。
  → **2026-09-11 に実施済み**（`docs/experiments/2026-09-11-highlight-spike/README.md`）。
- **評価の経路**：CLI（`runPipeline`。`recoveryConfirmMs: 0`）とオーケストレーターは LLM とのやり取りを `run/units.ts` で
  共有するが、タイムアウトと復旧の体制が違う。品質指標は CLI で取り、モデルごとに 1 回はサーバー経由の通し実行を行う。
- 仕様 10 節の「全文チャット方式との比較」は残す。自由形式プロンプトと CLI モードを PR13a
  （2026-09-12 の分割後は PR13a-3）で足す（現在の `full-text` モードは分割の対照にすぎない）。
- `listFindings` の N+1 は PR12a で計測して決着（持ち越し解消）。`GET /api/runs/:id/findings` は
  `listFindings` の理由（`listReasons`）に加え、ハンドラー側の再確認・採否の問い合わせも指摘 1 件
  ごとに出ており、実質 **3N+1** だった。指摘 800 件（理由・再確認・採否つき）で計測したところ
  中央値 110〜130 ms 台（WSL2/Linux。`packages/server/src/api/findings.perf.test.ts`）で 100 ms を
  上回ったため、**据え置きではなくサーバー側の後続 PR（PR12c）に回す**（詳細・実測値は
  `docs/plans/2026-09-11-pr12a-result-view.md` 決定 14）。
  → **2026-09-12 に PR12c で解消**。実行 1 件あたりの問い合わせを `findRun` 1 ＋一覧側 4 本
  （`findings`・理由・再確認・採否）の計 5 本にまとめ、指摘の件数によらないことをクエリ本数の
  テストで検査した。同条件での再計測は中央値 12 ms 前後（詳細は
  `docs/plans/2026-09-11-pr12c-findings-batch.md` 決定 5）。索引・マイグレーションは追加していない。

## ユーザーに依存する入力

| 入力 | 必要になる PR |
| --- | --- |
| Windows での scaffold 確認（`docs/guides/windows-verification.md`） | PR5 以降の Windows 実行 |
| 評価用原稿（作者が利用を認めたもの。リポジトリには入れない） | PR7 の試運転、PR13 |
| モデルの選択（仕様書 13 節） | PR7 の試運転では正解データがなく決められなかった。PR13 の評価で決める |
| 思考の有無（仕様書 13 節） | PR7 の試運転を踏まえ、当面の通常運用は思考なし（決定記録 0003 の 2026-09-09 の節）。思考ありは比較条件として残し、採否は PR13 |
| 許容語の実例、意図的な口語・造語を含む原稿 | PR13b |
| **評価原稿と正解データ**（仕様書 10 節。作者が利用を認めた原稿に実在した誤りの一覧と、誤検出してほしくない正常な文章） | **今から準備を始める。形式は PR13a-1 で確定した**（`docs/reference/truth-format.md`）。**PR13b の実施までに揃える** |
| Windows でのローカル確認 | PR11 のマージ条件（2026-09-10 に PR11 の前から移した） |

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

#### PR9b：完成したオーケストレーター（完了）

- 詳細計画：`docs/plans/2026-09-09-pr9b-orchestrator.md`（決定 24 以降。決定 1〜23 は PR9a と共通の `docs/plans/2026-09-09-pr9-orchestration.md`）
- PR8 からの持ち越し（**すべて対応済み**。レビューで確認済み）：
  - **対応済み（PR9a）**：`claim` 時に `started_at` を設定する
  - **対応済み（PR9a）**：`finishCheckUnit` / `finishRecheckUnit` / `finishRun` の無条件 UPDATE を、
    安全な状態遷移か条件付き更新に置き換える
  - **対応済み（PR9a）**：パイプライン結果から DB レコードへ変換する境界で、`mergeKey`・許容語抑制・段落 ID を検証する
  - **対応済み（PR9b）**：保存済み `TargetPlan[]` を渡す口の設計と、`target-planned` イベント
  - **対応済み（PR9b）**：生成終了の確認と上限付き待機（`recovery-waiting` への遷移）の制御
  - **対応済み（PR9b）**：位置特定失敗の指摘に `recheck_units`（`not-applicable` / `unlocated`）を作ること
  - `listFindings` が N+1（指摘 1 件につき `reasons` を 1 クエリ）。PR12 の表示要件が固まってから直す
    → **2026-09-11 に PR12a で計測して決着**（実質 3N+1。実測値は「## 2026-09-09 の見直し」節の
    `listFindings` の行、詳細は `docs/plans/2026-09-11-pr12a-result-view.md` 決定 14）
    → **2026-09-12 に PR12c で解消**（実行 1 件あたり 5 本に固定。詳細は
    `docs/plans/2026-09-11-pr12c-findings-batch.md` 決定 5）
  - 入れ子トランザクションが SAVEPOINT として正しく動くことは確認済み。PR9b は外側のトランザクションから呼ぶ設計にした

- 仕様：6（処理順序）、6.4（観点の一部失敗）、7（未ロード、再試行 1 回）、8.2 全体
- 作った：`server/src/run/orchestrator.ts`（実行の開始・停止・再開・失敗単位の個別再試行、単位駆動ループ）、
  `run/recovery.ts`（生成終了の確認と上限付き待機）、`index.ts` への起動時照合（`reconcileOnStartup`）の組み込み
- 規則：
  - 開始は常に新しい実行 ID。再開は既存 ID。二重送信は要求の同一性（実行 ID、開始操作の識別子）で判定
  - 各生成要求の直前に `ensureLoaded`。未ロードなら当該単位を `pending` のまま実行を `stopped` にし、案内を記録
  - 観点の一部失敗は成功分で統合に進み、実行を `partially-failed`
  - 失敗観点の再試行で同じ候補が出たときの照合は `mergeKey` で行うが、鍵は実行 ID を含まないので、保存済みの統合結果は実行 ID で名前空間を切って照合する（仕様 6.4「統合は同一の検査実行内に限定」を永続化層で破らない）
  - 停止は新規送信を止める。実行中の要求は上限内なら自然な完了を待ち、上限を超えたら abort して `recovery-waiting`
  - 自動再試行は各処理 1 回。完了済みは再開で繰り返さない。失敗単位の個別再試行
  - 分割範囲は開始時に計算して保存し、再開時は保存済みを使う
  - `checkMs` の意味の改訂（オーケストレーター経路では遅延通知の閾値になり、ハード上限は
    `checkMs + recoveryConfirmMs`。`runPipeline`（CLI）は従来どおり `checkMs` がハード上限）を
    仕様書に反映し、版を v0.9 に上げて 15 節の改訂記録に追記した（同じコミットに含める）
- テスト：モッククライアントでの状態遷移（開始、停止、再開、復旧待ち、部分失敗、再起動後の再開）、同じ開始要求の重複、起動時照合
- 受け入れ条件：11 節 3・4・5・11・14・15・16・18 項（PR9b の完了で達成。表示は PR11・PR12 待ち）
- 担当：Claude が状態機械と実装（委譲しない）、qwen がテストの雛形
- 大きさ：大
- PR9b の実施で分かったことは PR10 への持ち越しとして記録した（`RunRecord` が接続先 URL を持つ内部
  API であること、応答未受信のまま接続が切れた検査単位が `failed` のまま残り復旧に 2 段の操作が要る
  ことなど）。詳細は次項「PR10 server：HTTP API と SSE」の「PR9b からの持ち越し」を参照

### PR10 server：HTTP API と SSE

- PR9b からの持ち越し：
  - **`RunRecord` は接続先 URL（`endpointUrl`）を持つ内部 API である。** `startRun` などが返す
    `RunRecord` を HTTP 応答にそのまま流してはならず、接続先を除いた公開 DTO へ射影する（決定 24）
    → **PR10 で解消。** 射影は `server/src/api/dto.ts` の 1 か所に集め（PR10 決定 3）、
    全エンドポイントの応答・エラー本文・SSE に番兵の接続先 URL と API キーが出ないことを
    `api/leak.test.ts`（A0）が検査する
  - **生成中に応答を受け取れずに接続が切れた検査単位は `failed` のまま残る。** その実行は
    `recovery-waiting`（生成終了が未確認）になるが、単位の側は `pending` にならないため、復旧には
    「再開」に加えて「失敗単位の個別再試行」の 2 段の操作が要る。単位も `pending` にするには
    `UnitFailure` に「応答を受け取ったか否か」を持たせる必要があり、決定 20（打ち切りの経路を
    停止とタイムアウトの 2 つだけとしている）の文言の改訂も要るため、PR9b では広げなかった
    → **PR10 でも解消せず、PR11b に切り出した**（PR10 決定 17。オーケストレーターの実行の意味を
    変えないため）→ **2026-09-10 に PR11b で解消**（`UnitFailure` に列は足さず、既存の
    `RunStop.generationUnconfirmed` を単位の判定にも使う形で 1 段にした。PR9 決定 20 の改訂を伴う）
- PR8 からの持ち越し：
  - UI からの接続先上書きを保存する `settings` 表 → **PR10 で解消**（`settings` 表と
    `ConnectionManager`。接続先 URL は表に保存し、API キーはプロセスのメモリだけ。PR10 決定 5）
  - `LmStudioClient` の `close()` / `dispose()`（PR7 からの持ち越し）→ **PR10 で解消**
    （`close()` を追加し、接続設定の更新時と graceful shutdown で呼ぶ。PR10 決定 19）
  - 貼り付け経路の孤立サロゲートを API 側でも弾くか。PR8 は決定 17 で永続化層が拒否するようにしたので保存は守られるが、ユーザーに何を返すかは PR10 で決める
    → **PR10 で解消。** 永続化層の `MalformedBodyError` を 400 `malformed-body` に写す（PR10 決定 4）。
    API 側で本文を先読みして弾く経路は作らない
  - `index.ts` が DB ハンドルを閉じない（graceful shutdown なし）→ **PR10 で解消**（PR10 決定 18。
    走っている検査は待たず、5 秒の上限を置く）
- 実施で変えたこと：
  - **接続確認から試験生成を外した**（PR10 決定 8）。`POST /api/settings/connection/check` は
    モデル一覧とロード状態までで、生成要求を送らない。生成終了の未確認を接続確認で表現できず、
    「HTTP 層は生成要求を送る経路を新設しない」ためである。受け入れ条件 1 項は PR11 の最初の
    検査実行で満たす
  - **エクスポート（`GET /api/runs/:id/export`）を PR13a へ移した**（PR10 決定 16）。形式は評価ツールと
    揃えて決めるほうが二度手間にならない。仕様 8.2 の「保存済み結果の再閲覧」は `GET /api/runs/:id` と
    `GET /api/runs/:id/findings` で満たす

- 詳細計画：`docs/plans/2026-09-09-pr10-http-api.md`（決定 1〜20、Task 1〜10）
- 仕様：4、5.1（ファイル読み込み）、8.2（ブラウザを閉じても継続）、9（ループバック、テキストとして扱う）
- 作る：`server/src/api/*.ts`（接続設定と確認、原稿、実行、指摘、採否、復旧確認）、`api/events.ts`（SSE）、
  `shared/src/api/`（要求・応答・イベントの zod スキーマと型。web が import する）、`settings` 表と `ConnectionManager`、
  `LmStudioClient.close()` と graceful shutdown、**復旧確認の永続化**（`runs.recovery_confirmed_at`。2026-09-09 の見直し）
- エンドポイント：詳細計画の「エンドポイント」節が正本。
  - `GET/PUT /api/settings/connection`、`POST /api/settings/connection/check`（モデル一覧とロード状態まで。**試験生成は送らない**）
  - `POST /api/manuscripts`（貼り付け）、`POST /api/manuscripts/upload`（ファイル。`ingestUtf8Bytes`）
  - `GET /api/runs`、`POST /api/runs`、`GET /api/runs/:id`、`GET /api/runs/:id/units`、`POST /api/runs/:id/stop|resume|retry-failed`
  - `GET /api/recovery`、`POST /api/recovery/confirm`
  - `GET /api/runs/:id/findings`（絞り込みはクライアント側）、`GET /api/findings/:id`、`PUT /api/findings/:id/judgment`
  - `GET /api/runs/:id/events`（SSE。購読の終了で検査を止めない）
  - エクスポートは PR13a へ移した
- テスト：`app.request` でのハンドラーテスト、SSE 切断後に実行が継続すること、接続先 URL・API キーの漏えい検査
- 受け入れ条件：11 節 2・12・13 項（16 項はどの口から始めた実行も 1 キューを通る）
- 担当：Claude が API 設計、実装はサブエージェント（Claude）、Claude がレビューと検証
- 大きさ：中〜大

### PR11 web：接続・入力・設定画面

- マージ条件：CI が Ubuntu・Windows とも緑になった後、ネイティブ Windows で起動確認を行う
  （`docs/guides/windows-verification.md` の 2 節。着手の前提ではない）
- 仕様：4（手順 1〜4）、5.1、5.2
- 作る：アプリの骨格（画面遷移、共通レイアウト）、API クライアント（fetch の薄い包み。型とスキーマは `shared/src/api/` から）、
  `web/src/features/connection/`、`features/manuscript/`、`features/settings/`
- 規則：検査開始前に `POST /api/settings/connection/check` でロード状態を確認。空の本文では開始不可。ファイル入力は CRLF を保持
  （`File` を bytes のまま multipart で送る）。許容語は改行区切り。設定の初期値は `RUN_SETTINGS_DEFAULTS`。思考は既定で無効
- テスト：コンポーネントの単体（Vitest + Testing Library。導入はこの PR）
- 受け入れ条件：11 節 1・2 項の UI 側（1 項は最初の検査実行で満たす）
- 担当：Claude が画面設計、実装はサブエージェント（Claude）、Claude がレビューと検証
- 大きさ：中

### PR11b server：接続断で失敗した単位の復旧を 1 段にする（完了）

- 2026-09-09 の見直しで追加。PR9b からの持ち越し「生成中に応答を受け取れずに接続が切れた検査単位は `failed` のまま残る」の解消
- 仕様：8.2（失敗した処理の個別再試行、復旧待ち）
- 作る（実施：計画時の想定と異なる）：`UnitFailure` / `UnitFailureRecord` に列は足さず、すでにある
  `RunStop.generationUnconfirmed`（PR9 決定 23）を単位の判定（`run/units.ts` の `isPendingFailure` /
  `pendingNote`）にも使う。判別子を `treatUnconfirmedAsPending && failure.reason === "timeout"` から
  `treatUnconfirmedAsPending && halt?.generationUnconfirmed === true` に改め、応答を受け取らずに切れた
  単位（接続断）も同じ条件で `pending` に戻す。DB の列は増えない。PR9 決定 20（打ち切りの経路）の
  改訂を同じ PR で行う
- 規則：応答を受け取ってから失敗した単位（形式不正、出力打ち切り）は `failed` のまま。1 段にするのは「送ったが応答が無い」だけ
- テスト：接続断 → 復旧待ち → 再開で、当該単位が再試行なしに再実行されること。応答を受け取った失敗は `pending` にならないこと
- 受け入れ条件：11 節 14・18 項の運用性
- 詳細計画：`docs/plans/2026-09-10-pr11b-one-step-recovery.md`（決定 1〜8）
- 担当：Claude（状態機械は委譲しない）
- 大きさ：小

### PR12a web：結果閲覧（完了）

- 前提：強調表示のスパイク（チェックポイント）で UTF-16 範囲 → DOM の方式を確かめてから設計する
  → 2026-09-11 に実施済み。方式・提案インタフェース（`buildBodyView`）・申し送り 8 件は
  `docs/experiments/2026-09-11-highlight-spike/README.md`。設計はこの記録を入力にする
- 仕様：4（手順 5〜7）、5.3（上部の状態表示を除く）、5.4、9（本文をテキストとして表示、位置対応の保持）
- 作った：`features/results/`（本文表示、強調、指摘一覧、詳細、採否、絞り込み）。完了済み・停止中の実行を
  `GET /api/runs/:id`・`findings`・`findings/:id` から読んで表示する。実行一覧（`GET /api/runs`）からの再閲覧
- 作らなかった（PR12b の範囲）：開始・進捗・停止・再開・再試行・復旧確認の操作と SSE の購読。
  本 PR の更新は手動の再取得だけで、実行中の画面には別のポーリングも持たない
- 規則：本文は保存済み範囲で強調し、ブラウザで再計算しない。同じ範囲の複数指摘を参照可能。抑制候補・撤回候補は既定で非表示、切り替え可。「採用予定」は本文を書き換えない旨を表示。位置特定失敗（`not-found` / `ambiguous`）は一覧に出し、強調せず元の検査対象範囲への移動だけを提供。`outside-target` は通常一覧に出さず診断表示だけ。再確認が `suggestion-inappropriate` の指摘は修正案を有効なものとして表示しない。絞り込みはクライアント側
- テスト：UTF-16 範囲から DOM の強調への変換（絵文字・結合文字・CRLF を含む本文で位置がずれない）、絞り込み、採否の更新、
  実行一覧・結果画面双方での漏えい検査（決定 16。`web/src/leak.test.tsx`）
- 受け入れ条件：11 節 6・7・9・10・11・12・13 項の UI 側
- 持ち越し：`GET /api/runs/:id/findings` の 3N+1（実質。理由・再確認・採否の問い合わせが指摘 1 件ごとに
  出る）を計測し、中央値 110〜130 ms 台（WSL2/Linux、指摘 800 件）で 100 ms を上回ったため据え置きを
  やめ、**PR12c** に回した → **PR12c で解消済み**（実行 1 件あたり 5 本に固定、再計測で中央値 12 ms 前後）
- 担当：Claude が画面設計、位置→DOM 変換の設計、Unicode を含む期待結果の作成。実装はサブエージェント（Claude）、Claude がレビューと検証
- 大きさ：中〜大
- 詳細計画：`docs/plans/2026-09-11-pr12a-result-view.md`（決定 1〜16、Task 1〜12）

### PR12b web：実行制御と進捗（完了）

- 仕様：4（手順 4〜5）、5.3（上部：原稿名、検査状態、観点別の処理進捗、停止・再開操作）、8.2、9（根拠のない残り時間を示さない）
- 作った：開始 → 進捗 → 完了の流れ、停止・再開・失敗単位の再試行・復旧確認の操作、SSE の購読
  （`subscribeRunEvents`）と `run-settled` 後の再購読、再読み込み・再接続時の `GET /api/runs/:id` による復元、
  `recovery-waiting` / `recovery-blocked` / `backend-restarted` / 再開拒否（`run-rejected-*`）の案内、
  観点別の処理進捗（`GET /api/runs/:id/units` を数えて作る。決定 5）
- 作らなかった：残り時間・完了予定時刻・進捗率の推定（仕様 9 のとおり出さない）、失敗単位の一覧からその単位が
  出した指摘への移動経路（持ち越し）、実行一覧（`/runs`）の自動更新（本 PR の範囲外のまま）
- 規則：進捗は完了した検査単位数と再確認件数（`progress`）で示す。「完了」「一部失敗」「停止中」「実行中」「復旧待ち」を区別し、
  未処理範囲がある状態を「問題なし」と表示しない。再開・新規開始を区別する。イベントの差分では数えず、
  表示する値は必ず DB（REST）から取り直す
- PR12a からの持ち越しを解消：本文と右側（一覧・絞り込み・詳細）が独立してスクロールしない CSS を、
  `results-page.module.css` の 2 カラムに `height` と `overflow-y: auto` を与えて解消した（決定 15。
  `docs/plans/2026-09-11-pr12a-result-view.md` 持ち越し節にも解消済みと追記）
- テスト：`subscribeRunEvents` の単体（B1〜B4）、自動更新の合流・出し分け（B5〜B7、B13〜B16）、観点別の
  進捗・中間状態と遅延通知（B8・B12）、操作の出し分けと 409 の取り直し（B9・B10）、`/units` の漏えい
  検査拡張（B11）、実ブラウザでの終端状態の非購読と左右独立スクロールの確認（S1）
- 受け入れ条件：11 節 3・5・14 項の UI 側
- 持ち越し：実 LLM を動かした「実行中」の表示（進捗の更新、遅延の通知、停止の効き方、`run-settled` 後に
  `/events` が増え続けないこと）は未確認。Windows 未確認。指摘一覧が入った状態での右側の独立スクロールと
  「指摘へ移動」したときの `scrollIntoView` の挙動は、この環境に LM Studio が無く指摘を生成できないため
  未確認（`.bodyColumn` 側の内部スクロールは実測済み）。`GET /api/runs/:id/findings` の 3N+1 は
  本 PR では据え置きも解消もしていないが、**PR12c で解消した**
- 担当：Claude が画面設計、実装はサブエージェント（Claude）、Claude がレビューと検証
- 大きさ：中
- 詳細計画：`docs/plans/2026-09-11-pr12b-run-control.md`（決定 1〜17、Task 1〜11）

### PR12c server：指摘一覧の 3N+1 解消（完了）

- PR12a（Task 11）の計測で「据え置きではなくサーバー側の後続 PR に回す」と決まった持ち越しの引き受け先
  （`docs/plans/2026-09-11-pr12a-result-view.md` 決定 14。100 ms の判断基準もここで決めた）
- 仕様：新しい振る舞いを足さないので改訂なし
- 作った：`GET /api/runs/:id/findings` が指摘 1 件ごとに出していた理由（`listReasons`）・再確認・採否の
  問い合わせを、実行 1 件ぶんのバッチ取得にまとめた。`listFindings` は候補列挙 1 本で理由をまとめて読み
  `Map` に畳み（決定 2・3）、一覧ハンドラーは `listRecheckUnits` / `listJudgments` を実行につき 1 回ずつ
  呼んで `Map` から引く（決定 4）。実行 1 件あたりの問い合わせは `findRun` 1 ＋一覧側 4 本
  （`findings`・理由・再確認・採否）の計 5 本になり、指摘の件数によらないことをクエリ本数のテストで
  検査している（決定 7）
- 作らなかった：索引・マイグレーション `0003` の追加（決定 5。実測が示すまでは走査で足りる）、
  詳細（`GET /api/findings/:id`）への手入れ（決定 9）、クエリパラメーターによる絞り込み・ページング、
  web 側の変更（本 PR は `packages/server` だけ）
- 規則：応答の形・並び・値は 1 バイトも変えない（決定 6）。`judgments` の行が無い指摘は今までどおり
  500 `internal` で、未判断への丸めはしない（決定 4・不変条件）
- テスト：候補列挙のグルーピングを見分けるテスト（決定 10。C1〜C3）、一覧応答の characterization
  test（C4）、`judgments` 欠落 500 の既存テスト（C5）、クエリ本数の回帰テスト（決定 7。C6。
  `api/findings.query-count.test.ts`）、性能テスト（C7。`api/findings.perf.test.ts`。役割を
  計測専用から改善後の回帰の歯止めに書き換えた。決定 8）。C1〜C4 は意図的な変異で落ちることを実測済み
- 根拠：`listFindings` の理由に加えハンドラー側の再確認・採否の問い合わせも指摘 1 件ごとに出ており
  実質 **3N+1**。指摘 800 件（理由・再確認・採否つき）での計測で中央値 110〜130 ms 台（WSL2/Linux）
  だった。改善後に同条件で再計測した中央値は 3 回とも 12 ms 前後で、改善前の約 1/10 に縮んだ
  （詳細は `docs/plans/2026-09-11-pr12c-findings-batch.md` 決定 5）
- 受け入れ条件：本 PR だけでは満たすものなし（応答を 1 バイトも変えない性能改善で、11 節の項目は
  PR12a・PR12b で満たしている）
- 持ち越し：Windows 未確認（CI の Windows ジョブで代える）。実 LLM を動かした本物のデータでの確認は
  していない（合成データでの計測のみ）。索引の追加による更なる高速化は行わない（決定 5。実測が
  妥当だったと確認できたため見直しは不要と判断）。`findings.query-count.test.ts` と
  `findings.perf.test.ts` の `seedRun` / `seedManyFindings` の重複は、性能テストの計測条件が
  静かに変わる危険の方が大きいため共通化していない
- 担当：Claude が設計、実装はサブエージェント（Claude）、Claude がレビューと検証
- 大きさ：小
- 詳細計画：`docs/plans/2026-09-11-pr12c-findings-batch.md`（決定 1〜10、Task 1〜4）

### PR13a-1 server+cli：評価ツール（完了）

- 2026-09-12 に `docs/plans/2026-09-12-pr13a-evaluation-export.md` 決定 1 で、PR13a を
  13a-1（評価ツール）／13a-2（エクスポート）／13a-3（全文チャット方式）の 3 本に分けた
  （1 本のままだとタスク 12 個・変更 2 パッケージ・新形式 3 つになり最終レビューが成立しないため）。
  13a-1 を先にする（品質指標は CLI で取るため、`PipelineResult` だけを入力にすれば単独で完結し、
  ユーザーの正解データが揃った時点ですぐ回せる）。
- 詳細計画：`docs/plans/2026-09-12-pr13a-evaluation-export.md`（決定 1〜22、Task 1〜8）
- 仕様：10 全体
- 作った：正解ファイルの形式（`docs/reference/truth-format.md`。合成の例のみ。段落 ID が 0 起点で
  空行も 1 段落であること、`bodyHash` の取り方を含む）、`RunConditions.manuscript` への本文ハッシュの
  追加（`packages/server/src/hash.ts`）、CLI のサブコマンド化（`run`（既定・既存の起動と完全互換）／
  `evaluate`／`aggregate`／`hash`）、正解ファイル・結果 JSON を読む前の zod 検証（未知キーは許容しつつ
  必須項目・値域・`versions.result` の一致を検査し、指摘の範囲を本文と突き合わせる意味の検証も行う。決定 18）、
  突き合わせと指標算出（検出率・誤検出・位置特定失敗率・許容語の抑制・実行性能。仕様書 10 節の自動集計分を
  すべて出し、人手の指標は空欄で示す。率は `{ numerator, denominator, rate }` で分母 0 は `rate: null`）、
  複数回実行の集計（error 項目ごとの k/N、最小・中央値・最大、条件不一致・量子化不一致の拒否）
- 作らなかった：エクスポート（`GET /api/runs/:id/export`。PR13a-2）、全文チャット方式（PR13a-3）
- 規則：閾値判定はしない（決定 14）。近似一致で位置を自動確定しない（決定 4）。原稿本文・パスを CLI の
  標準出力・標準エラーに出さない（決定 9。既存の `run` にあった同種の漏えいも本 PR で直した）
- テスト：T1〜T11、T16・T16b〜T19、T22（詳細計画のテスト節）。指定した変異でそれぞれ落ちることを確認済み
- 受け入れ条件：本 PR だけでは満たすものなし（評価ツールを作っただけで、仕様書 11 節の受け入れ条件そのものは
  PR13b の実施で満たす）
- 持ち越し：エクスポート（PR13a-2）、全文チャット方式（PR13a-3）、決定 22（対応表を重なり長最大化にする、
  人が付けた判定の読み戻し、段落をまたぐ正解項目、全文チャット方式の自動採点、エクスポートを画面から落とす導線）
- 担当：Claude が評価設計、実装はサブエージェント（Claude）、Claude がレビューと検証
- 大きさ：中

### PR13a-2 server+cli：エクスポート（完了）

- PR8・PR10 からの持ち越し：一括エクスポート形式（実行 1 件 → JSON 1 ファイル、`formatVersion` 付き、接続先 URL を含めない）と
  `GET /api/runs/:id/export`（PR10 決定 16 で PR10 から移した。**この PR で足した唯一の新しい口**で、
  応答は既存の DTO と同じく `api/dto.ts` の射影を通し、接続先 URL・API キーを含めない。
  `api/leak.test.ts`（A0）のエンドポイント一覧にも追加した）
- 仕様：8.1、8.2（エクスポート）
- 詳細計画：`docs/plans/2026-09-12-pr13a-evaluation-export.md`（決定 16〜32、Task 9〜12）
- 作った：`GET /api/runs/:id/export`（実行スコープの一括取得で組み、問い合わせ本数を指摘の件数に依存させない。
  `formatVersion: "1"` と `exportedAt` を持ち、`run` / `manuscript` / `targets` / `checkUnits` /
  `recheckUnits`（全項目。決定 32） / `findings`（元候補・位置診断つき） / `unlocatedCandidates` /
  `unlocatedDiagnostics` を返す）、エクスポート JSON を `evaluate` / `aggregate` の入力に加える
  アダプター（`--export`。決定 29）。CLI 経由の実行とサーバー経由の実行は実行条件が異なるため、
  `--export` 由来の評価入力は `versions.result` を `"export/1"` として区別する（決定 28）
- 作らなかった：全文チャット方式（PR13a-3。着手前）
- 前提：PR13a-1 の後（突き合わせ器が無いと接ぎ先がない）。PR13b の前に終える
- 担当：Claude が API 設計、実装はサブエージェント（Claude）、Claude がレビューと検証
- 大きさ：小〜中

### PR13a-3 server+cli：全文チャット方式

- 仕様：10 全体（「現在の全文チャット方式」との比較）
- 作る：`full-chat` サブコマンド、ユーザーのプロンプトファイルによる自由形式の 1 回生成、出力打ち切りを
  失敗として残す `FullChatResult`、生成できない種別のモデルへの送信拒否
- 前提：PR13a-1 の後（CLI のサブコマンド化が要る）。PR13a-2 とは独立で順序を入れ替えてよい。PR13b の前に終える
- 担当：Claude が設計、実装はサブエージェント（Claude）、Claude がレビューと検証
- 大きさ：小

### PR13b all：実原稿での評価の実施

- 仕様：10 全体、11（最後の 2 項）、13（未決事項の確定）
- 実施：分割方式・分割＋再確認方式・全文チャット方式の比較、再確認が正しい指摘を撤回していないかの確認、命令文を含む原稿での
  逸脱の記録、`docs/experiments/` への評価記録。品質指標は CLI で取り、モデルごとに 1 回はサーバー経由（画面）の通し実行を行う
- 確定：モデル、思考の有無、生成パラメーター、分割長・文脈長、タイムアウト、`recoveryConfirmMs`、入力上限（仕様書 13 節。
  ユーザーが決め、仕様書と決定記録に記す）
- 受け入れ条件：11 節 20・21 項
- 担当：Claude が集計と記録、評価原稿と正解と最終判断はユーザー
- 大きさ：中（実施の時間は別）

## 受け入れ条件（11 節）と PR の対応

| # | 受け入れ条件 | PR |
| --- | --- | --- |
| 1 | LM Studio でモデルを選択し、生成要求と結果取得ができる | PR5、PR10（モデル一覧・状態）、PR11（最初の検査実行） |
| 2 | 貼り付けと UTF-8 テキスト読み込みの両方から検査できる | PR1、PR10、PR11 |
| 3 | 全本文が検査対象に割り当てられ、観点ごとの処理状態を確認できる | PR2、PR7、PR9b、PR12b |
| 4 | 参考文脈付きの分割検査と、文脈を広げた再確認が動作する | PR2、PR6、PR7、PR9b |
| 5 | 再確認の有無を切り替えて比較でき、撤回候補も確認できる | PR9b、PR11、PR12a |
| 6 | 指摘から原文の該当箇所に移動し、正しい範囲が強調される | PR3、PR12a |
| 7 | 同一引用の反復、段落境界、CRLF、異体字セレクタ、結合文字、絵文字で位置がずれず、書記素の途中で分割されない | PR1、PR2、PR3、PR12a |
| 8 | 短い会話段落が連続しても文字数基準の参考文脈が渡される | PR2 |
| 9 | 位置特定失敗が一覧に表示され、引用と診断候補が保存される。診断候補は正式な位置に割り当てられない | PR3、PR8、PR12a |
| 10 | 許容語の抑制が機能し、文法・文脈上の問題は抑制されず、抑制候補を再閲覧できる | PR4、PR12a |
| 11 | 重複統合後に再確認され、初回判定を保持したまま最終判定が表示される。採否は上書きされない | PR4、PR9b、PR12a |
| 12 | 採用予定・却下・保留を変更して保存でき、本文は変化しない | PR8、PR10、PR12a |
| 13 | ブラウザの再読み込み後も結果と判断が保持される | PR8、PR10、PR12a（結果）、PR12b（実行状態） |
| 14 | 中断後に未完了分を同じ実行 ID で再開でき、失敗を指摘ゼロと誤表示しない | PR9b、PR11b、PR12b |
| 15 | 同じ原稿版・設定で新規検査を開始すると別の実行 ID になり、結果が混ざらない | PR9b |
| 16 | 複数タブ・複数原稿でも LLM 要求が単一キューで処理される | PR7（直列実行器）、PR9b（PR9a の単一キューをオーケストレーターが使う） |
| 17 | 参考文脈内から始まる候補は採用されず診断記録に残り、検査対象内から始まり参考文脈へ続く引用は採用される | PR3 |
| 18 | 生成終了を確認できない場合に「復旧待ち」となり、自動で後続生成を送信しない | PR9b |
| 19 | 不正 JSON、存在しない引用、出力打ち切りを検知でき、引用文字列を破壊しない | PR3、PR4、PR5、PR7 |
| 20 | 本文と指示の区切り、非追従の指示、出力検証を実装し、命令文を含む原稿での逸脱を評価・記録する | PR6、PR13b |
| 21 | 実原稿で評価指標を記録し、品質上の制約を確認できる | PR7、PR13a、PR13b |

（仕様書 11 節は 21 項目。上表の番号は仕様書の並び順）

## 各 PR の進め方

1. ブランチを切る（`feat/pr<N>-<name>`）。
2. 本書の該当節から詳細計画 `docs/plans/<日付>-pr<N>-<name>.md` を書く（TDD の手順、テストコード、コミット単位まで）。
3. 実装は担当欄のとおり。qwen に委譲する場合は英語のスペックに不変条件を MUST / MUST NOT として明記する。
4. `pnpm check` を通し、Windows で未確認ならその旨を PR 本文に書く。
5. PR を作成しレビューを受ける。仕様の解釈で迷った点は PR 本文に列挙する。
6. 仕様や決定に変更が生じたら、同じ PR で `docs/spec/`、`docs/decisions/`、`docs/reference/` を更新する。
