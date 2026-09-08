# PR7 詳細計画：検査パイプライン（DB なし）と評価ハーネス（server + cli）

作成日：2026-09-08
状態：計画（自己レビュー反映済み。ユーザーレビュー待ち）
仕様：`docs/spec/mvp-spec.md`（v0.8）6 全体、7、8.2、10、11 節（3・4・19・21 項）、13
前提：`docs/plans/2026-09-07-mvp-roadmap.md` の PR7 節、`docs/reference/invariants.md`、
`docs/decisions/0003-lm-studio-connection.md`、PR1〜PR4（`shared`）、PR5（`lmstudio/`）、PR6（`prompts/`）

## 目標

PR1〜PR6 で作った部品をつなぎ、本文と設定と `LmStudioClient` を受け取って
「分割 → 観点別検査 → 位置確定 → 確定／失敗の分割 → 統合・許容語抑制 → 再確認（任意）」を
実行する DB 非依存のパイプラインを作る。あわせて、原稿ファイルを与えてこのパイプラインを回し
結果を JSON に落とす評価用 CLI（`packages/cli`）を作る。

これによって、仕様書 13 節が未決として残しているプロンプト・生成設定・分割長・タイムアウトを
実原稿で回して調整できるようになる。PR9 のオーケストレーションは本 PR のパイプラインと実行器を
そのまま共用し、永続化・再開・停止だけを足す。

## 対象外（MUST NOT）

- DB に触れない。永続化・再開・実行 ID の名前空間分離は PR8・PR9。
- HTTP API・SSE を作らない（PR10）。パイプラインの進捗はコールバックで通知するだけ。
- 複数実行・複数タブのキュー（`run/queue.ts`）を作らない（PR9）。本 PR の実行器は
  「1 つのパイプライン実行の中で生成要求を直列にする」ところまで。
- 生成終了の確認と上限付き待機（`run/recovery.ts`）を実装しない（PR9）。本 PR は
  「確認できないので後続を送らずに終了し、その旨を結果に残す」ところで止める。
- 評価指標の集計（検出率、誤検出、位置特定失敗率、診断候補の正誤）を実装しない（PR13）。
  本 PR は集計に必要な生データを JSON に残すところまで。
- `shared` を変更しない。分割・照合・統合・抑制の規則は PR1〜PR4 のまま使う。
- 本文を黙って縮めない。`InputTooLongError` は必ず終了理由か単位の失敗にする。
- 失敗・形式不正を指摘ゼロ（空配列）に置き換えない。
- 実原稿・実行結果 JSON をコミットしない。結果 JSON は引用と本文断片を含む。
  `docs/experiments/` に載せるのは集計値だけにする。
- API キーと接続先 URL を結果 JSON・標準出力・標準エラー・例外に出さない。
- `<think>` の分離を実装しない。実測で必要なモデルが出たときに、決定記録 0003 への追記と
  同時に行う（PR6 からの持ち越し条件）。

## 全体の制約（不変条件から）

- 位置は UTF-16 コード単位、長さは書記素クラスタ数。パイプラインはこの換算を自前で行わず
  `shared` の関数を使う。
- 引用の位置確定は完全一致のみ。診断候補を正式な位置に流用しない。
- 位置特定失敗（`not-found` / `ambiguous`）は統合・抑制・再確認に進めず、そのまま結果に残す。
  `outside-target` は通常一覧に出さず診断記録として残す。
- 統合は同一の検査実行内に限定する（本 PR は 1 実行しか扱わないので自然に満たす。
  永続化層での名前空間分離は PR9）。
- 未ロードのモデルに生成要求を送らない。各生成要求の直前に `ensureLoaded` を呼ぶ。
- `finish_reason == "length"` は成功にしない（PR5 が `truncated` の例外にする）。
- `AbortController` による中断は生成終了の確認ではない。中断・タイムアウトの後は生成終了を
  未確認として扱い、後続を送らない。
- 自動再試行は各処理 1 回まで。

## 作るもの

| ファイル | 内容 |
| --- | --- |
| `server/src/run/result.ts` | 結果の型（`PipelineResult` ほか）と `RESULT_VERSION` |
| `server/src/run/events.ts` | 進捗イベントの型（PR10 の SSE がそのまま流せる形） |
| `server/src/run/allowed-words.ts` | 改行区切りの許容語文字列を配列にする（server 側の責務） |
| `server/src/run/executor.ts` | 生成要求の直列実行、`ensureLoaded`、再試行 1 回、停止判定 |
| `server/src/run/pipeline.ts` | `runPipeline`。分割から再確認までの本体 |
| `packages/cli/` | 新規パッケージ `@shuten/cli`。`src/`、`bin/shuten-eval.ts` |
| `server/package.json` | `exports` を追加（`packages/cli` から server の型と関数を読むため） |
| `server/src/run/*.test.ts` | 単体・結合テスト（モック `LmStudioClient`） |
| `server/src/run/pipeline.integration.test.ts` | 実 LM Studio での試運転（合成長文） |
| `packages/cli/src/*.test.ts` | 引数解釈と JSON 形式の単体テスト |

### 公開する型と関数（案）

```ts
// server/src/run/result.ts
export const RESULT_VERSION: string = "1";

/** 検査方式。仕様書 10 節の 3 方式に 1 対 1 で対応する。 */
export type PipelineMode = "split" | "split-recheck" | "full-text";

/** 失敗の記録。reason は shared の FailureReason をそのまま使う（列挙は増やさない）。 */
export interface UnitFailure {
  readonly reason: FailureReason;
  readonly message: string;
  /** LM Studio が返した finish_reason（取れたときだけ）。 */
  readonly finishReason: string | null;
  /** ensureLoaded 由来なら "ensure-loaded"、生成要求由来なら "chat"、送信前の例外なら "local"。 */
  readonly origin: "ensure-loaded" | "chat" | "local";
}

/** 1 検査単位（1 検査対象 × 1 観点）。状態で持ち物が変わるので判別可能ユニオンにする。 */
export type CheckUnitResult =
  | {
      readonly status: "pending";
      readonly targetIndex: number;
      readonly perspective: Perspective;
      /** 未送信の理由（モデル未ロード、先行する停止など）。 */
      readonly note: string;
    }
  | {
      readonly status: "done";
      readonly targetIndex: number;
      readonly perspective: Perspective;
      readonly attempts: number;
      readonly usage: Usage | null;
      /** 要求に載せた本文の書記素数（検査対象 + 参考文脈）。換算係数の実測に使う。 */
      readonly inputGraphemes: number;
      readonly elapsedMs: number;
      readonly findingCount: number;
    }
  | {
      readonly status: "failed";
      readonly targetIndex: number;
      readonly perspective: Perspective;
      readonly attempts: number;
      readonly failure: UnitFailure;
      readonly usage: Usage | null;
      readonly inputGraphemes: number;
      readonly elapsedMs: number;
    };

export type RecheckResult =
  | { readonly status: "disabled" }
  | { readonly status: "suppressed" }
  | { readonly status: "pending"; readonly note: string }
  | {
      readonly status: "failed";
      readonly attempts: number;
      readonly failure: UnitFailure;
      readonly usage: Usage | null;
      /** 送信前の例外（InputTooLongError）では null。 */
      readonly inputRange: Range | null;
      readonly elapsedMs: number | null;
    }
  | {
      readonly status: "done";
      readonly attempts: number;
      readonly output: LlmRecheckOutput;
      readonly usage: Usage | null;
      readonly inputRange: Range;
      readonly inputGraphemes: number;
      readonly elapsedMs: number;
    };

export interface FindingResult {
  readonly targetIndex: number;
  /** 統合後の指摘。sources に元の LlmFinding と LocateResult が入っている。 */
  readonly finding: MergedFinding;
  readonly suppression: Suppression | null;
  readonly recheck: RecheckResult;
}

export interface UnlocatedResult {
  readonly targetIndex: number;
  readonly candidate: UnlocatedCandidate;
}

/** 検査対象と、その対象に実際に送った入力範囲。位置の正本として結果に残す。 */
export interface TargetPlan {
  readonly target: TargetRange;
  readonly input: CheckInput;
}

export type RunStatus = "completed" | "partially-failed" | "stopped";

export type StopReason =
  | "model-not-loaded"
  | "recovery-needed"
  | "connection-lost"
  | "settings"
  | "aborted";

export interface RunStop {
  readonly reason: StopReason;
  readonly message: string;
  /** 停止の原因になった失敗。設定値の検証エラーや停止要求では null。 */
  readonly failure: UnitFailure | null;
  /**
   * 生成が LM Studio 側で走り続けている可能性があるか。
   * 要求の送信中にタイムアウト・中断したときだけ true（PR9 の「復旧待ち」の入口）。
   */
  readonly generationUnconfirmed: boolean;
}

/** 集計。指摘ゼロと失敗を取り違えないための材料。 */
export interface RunTotals {
  readonly targets: number;
  readonly checkUnits: { readonly done: number; readonly failed: number; readonly pending: number };
  /** 送信した生成要求の総数（再試行を含む）。 */
  readonly requests: number;
  readonly candidates: number;
  readonly located: number;
  readonly unlocated: {
    readonly notFound: number;
    readonly ambiguous: number;
    readonly outsideTarget: number;
  };
  readonly findings: number;
  readonly suppressed: number;
  readonly rechecks: {
    readonly done: number;
    readonly failed: number;
    readonly pending: number;
    readonly suppressed: number;
    readonly disabled: number;
  };
  readonly elapsedMs: number;
}

/** 実行条件（仕様書 10 節）。接続先 URL と API キーは含めない。 */
export interface RunConditions {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly mode: PipelineMode;
  readonly perspectives: readonly Perspective[];
  readonly generation: GenerationSettings;
  /** 最初の ensureLoaded が返した ModelInfo。取れなければ null。 */
  readonly model: ModelInfo | null;
  readonly chunkSettings: ChunkSettings;
  readonly timeouts: { readonly checkMs: number; readonly recheckMs: number };
  readonly allowedWords: readonly string[];
  readonly versions: {
    readonly result: string;
    readonly prompt: string;
    readonly allowedWordRule: string;
    readonly diagnosticTransform: string;
  };
  readonly manuscript: {
    readonly utf16Length: number;
    readonly graphemeCount: number;
    readonly paragraphCount: number;
    readonly targetCount: number;
  };
}

export interface PipelineResult {
  readonly status: RunStatus;
  readonly stop: RunStop | null;
  readonly conditions: RunConditions;
  readonly targets: readonly TargetPlan[];
  readonly checkUnits: readonly CheckUnitResult[];
  readonly findings: readonly FindingResult[];
  readonly unlocated: readonly UnlocatedResult[];
  readonly totals: RunTotals;
}
```

```ts
// server/src/run/pipeline.ts
export interface PipelineArgs {
  /** 保存本文（BOM 除外済み）。段落はここから splitParagraphs で導く。 */
  readonly text: string;
  readonly mode: PipelineMode;
  readonly perspectives: readonly Perspective[];
  /** 改行区切りの生の文字列。分割・trim・重複除去はパイプラインが行う（決定 7）。 */
  readonly allowedWordsRaw: string;
  readonly generation: GenerationSettings;
  readonly chunkSettings: ChunkSettings;
  readonly timeouts: { readonly checkMs: number; readonly recheckMs: number };
  readonly client: LmStudioClient;
  /** 候補の ID 生成。既定は実行全体で 1 本の連番 c1, c2, …（決定 9）。 */
  readonly createCandidateId?: (() => string) | undefined;
  /** 統合後の指摘の ID 生成。既定は実行全体で 1 本の連番 f1, f2, …。 */
  readonly createFindingId?: (() => string) | undefined;
  /** 時刻。既定は Date.now。 */
  readonly now?: (() => number) | undefined;
  readonly onEvent?: ((event: PipelineEvent) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export function runPipeline(args: PipelineArgs): Promise<PipelineResult>;
```

```ts
// server/src/run/executor.ts
export type ExecOutcome<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly attempts: number;
      readonly usage: Usage | null;
      readonly elapsedMs: number;
    }
  | {
      readonly ok: false;
      readonly attempts: number;
      readonly failure: UnitFailure;
      /** 取れたときだけ（truncated では非 null になりうる）。 */
      readonly usage: Usage | null;
      readonly elapsedMs: number;
      /** 非 null なら実行全体を止める。 */
      readonly halt: RunStop | null;
    };

export interface Executor {
  /** request.model で ensureLoaded を呼んでから chat を送り、parse に通す。同時実行は 1。 */
  execute<T>(
    request: ChatRequest,
    parse: (result: ChatResult) => T,
    timeoutMs: number,
  ): Promise<ExecOutcome<T>>;
  /** 送信した生成要求の総数（再試行を含む）。 */
  readonly requestCount: number;
  /** 最初に成功した ensureLoaded の結果。成功前は null（getter で実装する）。 */
  readonly modelInfo: ModelInfo | null;
}

export function createExecutor(
  client: LmStudioClient,
  options: { readonly signal?: AbortSignal | undefined; readonly now?: (() => number) | undefined },
): Executor;
```

## 設計上の決定

### 決定 1：段落はパイプラインが本文から導く

`PipelineArgs` は `text` だけを取り、`splitParagraphs(text)` を内部で 1 回だけ呼ぶ。
呼び出し元が段落配列を渡せると、本文と段落がずれた組み合わせを渡せてしまう。
PR9 は保存本文から同じ関数で同じ段落を得るので、共用の妨げにならない。

### 決定 2：処理順序は検査対象ごとに閉じる

検査対象 1 つにつき、選択した観点をすべて送り終えてから位置確定・統合・抑制・再確認へ進む
（仕様 6.4「同じ対象範囲の選択済み観点の検査がすべて終了してから統合」）。
検査対象をまたいだ統合は行わない。処理は検査対象の `index` 昇順、対象内では `perspectives` の指定順。

各検査対象での順序：

1. `buildCheckInput`（`full-text` では決定 8 の全文入力）
2. 観点ごとに `buildCheckRequest` → `execute` → `parseCheckResponse`
3. 各 `LlmFinding` を `locateQuote` に通して `Candidate` を作る
4. `partitionCandidates` で確定／失敗に分ける
5. 確定分を `mergeCandidates` で統合
6. 各 `MergedFinding` に `findSuppression`
7. 再確認（`mode === "split-recheck"` かつ抑制なしのときだけ）：
   `buildRecheckInput` → `buildRecheckRequest` → `execute` → `parseRecheckResponse`

### 決定 3：`Candidate` の位置確定には要求と同じ `CheckInput` を使う

`locateQuote(text, input, paragraphs, ref)` に渡す `input` は、その指摘を生んだ要求と
同じ `CheckInput` にする。参考文脈を含む入力全体で照合するという仕様 6.3 の規定と、
「開始位置が検査対象内の候補だけを採用する」という規定は、この対応が保たれて初めて成立する。
使った `CheckInput` は `TargetPlan` として結果に残す（仕様 6.3 の「検索対象範囲」の保存、
仕様 8.1 の入力範囲。PR9 の「分割範囲は開始時に計算して保存する」もこの値を使う）。

### 決定 4：単位の状態は `pending` / `done` / `failed` の 3 つ

- `pending`：生成要求を 1 度も送っていない。モデル未ロードや実行の途中終了で残った単位。
  仕様 7 節の「当該処理を失敗にせず未完了のまま残す」に対応する。`note` に理由を書く。
- `failed`：送ったが失敗した。`attempts` と `UnitFailure` を持つ。
- `done`：応答をスキーマまで通した。

判別可能ユニオンにして、`done` なのに `failure` がある、`pending` なのに `attempts` が 1、
といった状態を型で作れないようにする。`findingCount` は `done` にしかないので、
指摘ゼロ（`findingCount: 0`）と失敗（そもそも項目がない）を取り違えられない。

### 決定 5：再試行と停止の分岐

失敗は 3 つの出どころに分ける（`UnitFailure.origin`）。

**(a) 生成要求（`chat`）由来**

| 失敗 | 再試行 | その後 |
| --- | --- | --- |
| `malformed` | 1 回 | 2 回目も失敗なら単位を `failed`。実行は続ける |
| `truncated` | 1 回 | 同上 |
| `connection` | 1 回 | 2 回目も `connection` なら実行を `stopped`（`connection-lost`、`generationUnconfirmed: false`） |
| `timeout` | しない | 実行を `stopped`（`recovery-needed`、`generationUnconfirmed: true`）。当該単位は `failed` |
| `aborted` | しない | 実行を `stopped`（`aborted`、`generationUnconfirmed: true`）。当該単位は `failed` |
| `input-too-long` | しない | 実行を `stopped`（`settings`）。当該単位は `failed` |
| `model-not-loaded` | しない | 実行を `stopped`（`model-not-loaded`）。当該単位は `failed`（送信済みのため） |

**(b) `ensureLoaded` 由来**

再試行しない。当該単位は `pending`（生成要求を送っていない）のまま、実行を `stopped` にする。
`model-not-loaded` なら `model-not-loaded`、それ以外（`connection` / `timeout` / `malformed`）は
`connection-lost`。いずれも `generationUnconfirmed: false`（生成を送っていない）。

理由：一覧が取れない＝ロード状態を確認できない状態で生成要求を送らない（仕様 7 節）。
`GET /api/v0/models` のタイムアウトは生成が走り続けていることを意味しないので、
`recovery-needed` ではない。

**(c) 送信前の例外（`origin: "local"`）**

| 例外 | 扱い |
| --- | --- |
| `InvalidChunkSettingsError` | `runPipeline` の冒頭で `stopped`（`settings`）。`targets` は空、`checkUnits` も空 |
| 初回検査の `InputTooLongError` | 実行を `stopped`（`settings`）。当該対象以降の単位は `pending` |
| 再確認の `InputTooLongError` | その再確認だけ `failed`（`input-too-long`）。実行は続け、`partially-failed` |

再確認だけ扱いを変えるのは、再確認が指摘 1 件ごとに独立していて、他の指摘の再確認は成功しうるため。
初回検査は本文の被覆に関わるので、1 件でも入力上限を超えたら設定を直してもらう。
いずれの場合も本文は縮めない（仕様 7 節）。

`RunStop` には停止の原因になった `UnitFailure` を残す。`settings` に潰れても
`input-too-long` か設定値の誤りかが結果 JSON から辿れるようにする。

補足：`connection` は HTTP の非 2xx をすべて含む（PR5 のクライアントの分類）。
API キーの誤りや `response_format` の拒否のような恒久的な 4xx でも
「1 回再試行 → `connection-lost` で停止」になる。ここは実行を止めるのが安全側なのでそのままにする。

### 決定 6：`stop` / `length` 以外の `finish_reason`（PR6 からの持ち越し）

PR5 のクライアントは `length` を `truncated` の例外にし、それ以外の値は `ChatResult.finishReason`
に載せて返す。判定は executor が行う（`parseCheckResponse` は `finishReason` を見ない）。
`finishReason !== "stop"` の応答は成功にせず、`truncated`（`UnitFailure.finishReason` に実際の値）
として扱う。

理由：仕様 7 節は「終了理由だけでなく、通信の完了とデータの完全性も確認する」と定めている。
未知の終了理由は「生成が通常どおり終わらなかった」ことを示すので、形式（`malformed`）ではなく
完全性（`truncated`）の側に寄せる。`FailureReason` の列挙は増やさない（UI と共有しているため）。

### 決定 7：許容語の分割は server 側

`splitAllowedWords(raw: string): string[]` を `server/src/run/allowed-words.ts` に置き、
`runPipeline` が呼ぶ。`/\r\n|\r|\n/` で分割し、各行を `String.prototype.trim` にかけ、
空文字を除き、完全一致の重複を除いて出現順に返す（`shared` の `findSuppression` は登録語を
加工しない、という PR4 の分担を守る）。重複除去は仕様に明記がないが、`findSuppression` の
結果を変えず、実行条件の記録が読みやすくなるので行う。

CLI は許容語ファイルの中身をそのまま `allowedWordsRaw` に渡す。分割は 1 箇所だけで行う。

### 決定 8：`full-text` 方式は同じ下流を通す

`mode === "full-text"` では `planTargets` を使わず、本文全体を 1 つの `TargetRange`
（`index: 0`、`range` は本文全体、`paragraphIds` は全段落）にし、`context` は前後とも `null`、
`inputRange` は本文全体にした `CheckInput` を 1 つ作る。観点ごとに 1 要求だけ送る。

上限検査は `shared` の非公開関数を使えないのでパイプラインで行う：
`countGraphemes(sliceRange(text, inputRange)) > chunkSettings.maxInputGraphemes` なら
`InputTooLongError` を投げ、決定 5(c) の初回検査と同じ扱いにする（縮めない）。
再確認は行わない（`mode` の組み合わせとして持たない）。

これは仕様 10 節の「現在の全文チャット方式」との比較用だが、プロンプトは PR6 の構造化プロンプトの
ままなので、自由形式のチャットとの比較ではない。この差は結果の記録に明記する。

### 決定 9：ID は注入可能な連番を 2 本

`createCandidateId`（既定 `c1`, `c2`, …）と `createFindingId`（既定 `f1`, `f2`, …）を分けて受け取る。
どちらも実行全体で 1 本の採番器にする（検査対象ごとに作り直すと ID が衝突する）。
同じ入力・同じモック応答で 2 回実行したら同じ ID になること。PR8・PR9 は DB 側の ID を注入する。

ロードマップの実装上の決定は `crypto.randomUUID()` だったが、評価用 JSON の差分を取れることを
優先して連番にする。PR8 で DB の ID を注入する時点で切り替わるので、PR 本文にその旨を書く。

再確認の固有 ID（仕様 6.5）は、本 PR では対象の `MergedFinding.id` で代用する
（1 指摘につき再確認は 1 回で、再確認ループは行わないため）。独立した ID は PR8 で持たせる。

### 決定 10：進捗は 1 つのコールバックに union で流す

```ts
export type PipelineEvent =
  | { readonly type: "run-started"; readonly targetCount: number; readonly unitCount: number }
  | { readonly type: "check-started"; readonly targetIndex: number; readonly perspective: Perspective }
  | { readonly type: "check-finished"; readonly result: CheckUnitResult }
  | { readonly type: "target-merged"; readonly targetIndex: number; readonly findingCount: number }
  | { readonly type: "recheck-started"; readonly findingId: string }
  | { readonly type: "recheck-finished"; readonly findingId: string; readonly result: RecheckResult }
  | { readonly type: "run-finished"; readonly status: RunStatus; readonly stop: RunStop | null };
```

`run-started` は必ず最初、`run-finished` は必ず最後（`stopped` でも出す）。
PR10 の SSE がそのまま流せる形にしておく。コールバックの例外はパイプラインを壊さない
（`try` / `catch` で握り潰し、実行を続ける）。

### 決定 11：`RunStatus` の決め方

- `stop` が非 null なら `stopped`。
- そうでなく、`failed` の単位（検査・再確認のどちらでも）が 1 つでもあれば `partially-failed`（仕様 6.4）。
- どちらでもなければ `completed`。

抑制・`disabled` は失敗ではない。

### 決定 12：CLI の形

`packages/cli`（`@shuten/cli`）。実行は `node packages/cli/bin/shuten-eval.ts`。

```
shuten-eval --manuscript <path> --model <id>
            [--allowed-words <path>] [--out <path>]
            [--mode split|split-recheck|full-text]      既定 split
            [--perspectives typo,naturalness]           既定 typo,naturalness
            [--max-tokens N] [--temperature T] [--seed N] [--reasoning-effort none|low|medium|high]
            [--target-graphemes N] [--context-graphemes N] [--recheck-context-graphemes N]
            [--rounding-tolerance F] [--max-input-graphemes N]
            [--check-timeout-ms N] [--recheck-timeout-ms N]
```

- 原稿はバイト列で読み、`ingestUtf8Bytes` を通す（BOM を 1 文字だけ外し、CRLF は変換しない）。
- 許容語ファイルも同じ経路で読み、中身をそのまま `allowedWordsRaw` に渡す。
- 接続先と API キーは server と同じ環境変数（`SHUTEN_LM_STUDIO_URL`、`SHUTEN_LM_STUDIO_API_KEY`）
  から読む。CLI の引数では受け取らない（シェル履歴に API キーを残さないため）。
- 結果 JSON は `--out` のファイルへ。省略時は標準出力。進捗は標準エラーへ 1 行ずつ。
- 終了コード：0 = `completed`、2 = `partially-failed`、3 = `stopped`、1 = 引数・入出力の誤り。

### 決定 13：`server` パッケージに `exports` を足す

`packages/server/package.json` は現在 `exports` を持たないので、`packages/cli` から
`@shuten/server/run/pipeline.ts` を解決できない。`shared` と同じ形（`"." : "./src/index.ts"`、
`"./*": "./src/*"`）を足す。この形で解決できることは実測で確認済み（自己レビュー）。

`packages/cli` に置くもの：`package.json`（`@shuten/server` と `@shuten/shared` を
`workspace:*` で依存、`typecheck` と `test` スクリプト）、`tsconfig.json`
（`include` に `src`・`bin`・`vitest.config.ts`。`bin` を入れないと型検査から漏れる）、
`vitest.config.ts`（`name: "cli"`）。ルートの `vitest.config.ts` は `packages/*` を拾い、
`pnpm typecheck` は `pnpm -r --sequential` なので、`pnpm install` を一度走らせれば
`pnpm check` に自動で乗る。

## 状態モデル（一覧）

| 対象 | 状態 | 意味 |
| --- | --- | --- |
| 検査単位（対象 × 観点） | `pending` | 未送信。未ロード・`ensureLoaded` 失敗・先行する停止で残った |
| | `done` | 応答をスキーマまで通した（`findingCount` を持つ） |
| | `failed` | 送ったが失敗（`attempts` と `UnitFailure` を持つ） |
| 再確認 | `disabled` | `mode` が再確認なし |
| | `suppressed` | 許容語により対象外（仕様 6.4） |
| | `pending` | 送る前に実行が終わった |
| | `failed` | 送ったが失敗、または送信前に `InputTooLongError` |
| | `done` | `LlmRecheckOutput` を得た |
| 実行 | `completed` / `partially-failed` / `stopped` | 決定 11 |

位置特定失敗の候補は `FindingResult` にならず `unlocated` に入る。したがって再確認の状態に
「位置未確定」は要らない。

PR9 の永続化では、ロードマップの実行状態（`running`、`recovery-waiting` を含む）に対応させる：
`stopped` かつ `generationUnconfirmed: true` が `recovery-waiting` の入口、`running` は
パイプライン実行中に相当する（本 PR の結果型は終了後の姿だけを表す）。

## 実測で決める初期値（仕様書 13 節）

本 PR では暫定値を CLI の既定として置くだけにし、計画・PR 本文・結果 JSON に「暫定」と明記する。
確定はこの PR の試運転と PR13 の評価で行う。

| 値 | 暫定 | 根拠と決め方 |
| --- | --- | --- |
| `targetGraphemes` | 1500 | 仕様 5.2 の初期案 |
| `contextGraphemes` | 1000 | 同上 |
| `recheckContextGraphemes` | 3000 | 同上 |
| `roundingTolerance` | 0.2 | 同上 |
| `maxInputGraphemes` | 12000 | 再確認の最大入力（1500 + 3000 × 2 = 7500）に余裕を見た値。コンテキスト長からの換算係数は下記の実測で決める |
| `maxTokens` | 16000 | 決定記録 0003（1,500 字の検査対象に対する思考込みの初期値） |
| `temperature` | 0 | 決定記録 0003 の比較実験の設定。仕様 10 節は全モデル必須にはしていない |
| `checkTimeoutMs` | 300000 | 決定記録 0003「思考ありの qwen で 1 要求 2〜3 分、思考なしなら 10 秒前後」。決定 5 では 1 件のタイムアウトが実行全体を止めるので、既定は思考ありに合わせて長めに取り、思考なしでは CLI で下げる |
| `recheckTimeoutMs` | 300000 | 同上 |

決定記録 0003 は「思考の有無で別の値にする」としている。本 PR では既定を 1 つに置き、
試運転で思考なしの所要時間を測ってから、思考の有無で分けるかを PR13 の評価設計で決める。

換算係数の実測：各要求について `inputGraphemes` と `usage.promptTokens` を結果 JSON に残す。
試運転の後、両者の比（書記素あたりのトークン数）を集計し、`loaded_context_length` から
`maxInputGraphemes` を導く係数を提案する。本 PR では数値を決め打ちしない。

`RunConditions` に載らない実行条件（LM Studio 本体とランタイムの版、`seed` の対応可否）は
`GET /api/v0/models` から取れないので、試運転の記録に手で書く。仕様 10 節は「取得可能な実行条件」
と限定しているので、この扱いで足りる。

## 解釈で迷った点（レビューで確認したい）

1. 未知の `finish_reason` を `truncated` に寄せた（決定 6）。`malformed` に寄せる案もある。
   `FailureReason` を増やさない前提での選択。
2. `timeout` で実行全体を止める（決定 5(a)）。仕様 7 節の「生成終了を確認できるまで後続を送らない」を
   PR7 の範囲で守る最も安全な解釈だが、1 単位のタイムアウトで全体が止まる。既定値を 5 分に取って
   緩和した。
3. `truncated` の再試行を 1 回行う（決定 5(a)）。`temperature: 0` では同じ結果になる可能性が高く、
   時間の無駄になりうる。仕様 7 節の「自動再試行は各処理 1 回」を素直に適用した。
4. `connection` の 2 回連続で実行を止める（決定 5(a)）。仕様に明記はない。恒久的な 4xx も
   ここに含まれる。
5. 再確認の `InputTooLongError` だけ実行を止めず単位の失敗にする（決定 5(c)）。仕様に明記はない。
6. 許容語の重複除去（決定 7）。仕様は分割規則しか定めていない。
7. `full-text` 方式が構造化プロンプトのままである点（決定 8）。仕様 10 節の「現在の全文チャット方式」
   との厳密な比較にはならない。自由形式のプロンプトを別に用意すべきかは PR13 の設計で決めたい。
8. ID を `crypto.randomUUID()` ではなく連番にした（決定 9）。評価用 JSON の差分を取るため。
9. 実原稿での試運転には作者が利用を認めた原稿が要る（仕様 10 節）。本 PR では合成の長文で
   パイプラインを通し、実原稿での試運転はユーザーの原稿が用意できた時点で行う。
   合成原稿での試運転だけで PR を締めてよいかを確認したい。

## PR8・PR9・PR13 への持ち越し

- 永続化、実行 ID による `mergeKey` の名前空間分離、失敗観点の再試行での参照追加、
  再確認の固有 ID（PR8・PR9）。
- 生成終了の確認と上限付き待機（`recovery-waiting`）、複数実行の単一キュー（PR9）。
  本 PR の `RunStop.generationUnconfirmed` がその入口になる。
- 評価指標の集計（検出率、誤検出、位置特定失敗率、診断候補の正誤、抑制の適否）と、
  段落マーカーの引用への混入率の集計（PR13）。本 PR は結果 JSON に生の `LlmFinding` と
  `LocateResult` を残すところまでとし、集計ロジックをパイプラインに入れない。
- `<think>` の分離（実測で必要になったモデルが出たときに、決定記録 0003 への追記と同時に）。
- `before` / `after` の長さの調整、思考の有無で分けたタイムアウト値（試運転の観測を材料にする）。

PR6 からの持ち越しのうち、**段落マーカー・タグの引用への混入と、検査対象の終端をまたぐ引用の観測**は
本 PR で行う。集計コードは書かず、試運転（I3）で数え、`docs/experiments/` の記録に残す。

## テスト

### U：`allowed-words.ts`（単体）

| # | 内容 |
| --- | --- |
| U1 | CRLF・CR・LF の混在で分割できる |
| U2 | 各行が trim され、空行と空白のみの行が除かれる |
| U3 | 完全一致の重複が 1 つになり、出現順が保たれる |
| U4 | 空文字を渡すと空配列 |

### E：`executor.ts`（モック `LmStudioClient`）

| # | 内容 |
| --- | --- |
| E1 | `chat` の直前に必ず `ensureLoaded` が呼ばれる（呼び出し順を記録して検証） |
| E2 | 同時に 2 つ `execute` しても `chat` が重ならない（直列） |
| E3 | `malformed` は 1 回だけ再試行し、2 回目も失敗なら `ok: false`、`attempts: 2`、`halt: null` |
| E4 | `truncated`（`length`）も 1 回再試行し、`maxTokens` を変えずに送る |
| E5 | `finishReason` が `"tool_calls"` など `"stop"` 以外なら `truncated` にし、`failure.finishReason` に実際の値を入れる（決定 6） |
| E6 | `connection` が 2 回続くと `halt.reason` が `connection-lost`、`generationUnconfirmed: false` |
| E7 | `chat` の `model-not-loaded` は再試行せず `halt.reason` が `model-not-loaded` |
| E8 | `ensureLoaded` の `model-not-loaded` は `chat` を呼ばず、`attempts: 0`、`origin: "ensure-loaded"` |
| E9 | `ensureLoaded` の `timeout` は `connection-lost`（`recovery-needed` にしない）、`generationUnconfirmed: false` |
| E10 | `chat` の `timeout` は `recovery-needed`、`generationUnconfirmed: true` |
| E11 | 呼び出し元の `signal` の中断で `halt.reason` が `aborted` |
| E12 | 最初の `ensureLoaded` の `ModelInfo` が `modelInfo` に残る |
| E13 | 失敗しても `usage` と `elapsedMs` が結果に載る（`truncated` で `usage` が非 null） |
| E14 | `requestCount` が再試行を含む送信回数と一致する |

### P：`pipeline.ts`（モック `LmStudioClient` での結合）

| # | 内容 |
| --- | --- |
| P1 | 誤字を含む合成本文で、分割 → 検査 → 位置確定 → 統合 → 再確認まで通り `completed` |
| P2 | 検査対象が複数のとき、対象の昇順・対象内では観点の指定順に要求が送られる |
| P3 | 1 対象の全観点が終わってから統合が走る（要求順とイベント順で検証） |
| P4 | 同じ引用・修正案を 2 観点が返すと 1 件に統合され、`sources` が 2 件 |
| P5 | 修正案が `null` の候補は統合されず別々に残る（P4 の裏） |
| P6 | 存在しない引用は `unlocated`（`not-found`）に入り、再確認要求が送られない |
| P7 | 参考文脈内から始まる引用は `outside-target` として `unlocated` に入る |
| P8 | 許容語に一致する表記訂正は `suppression` が付き、再確認要求が送られない（呼び出し回数で検証） |
| P9 | `mode: "split"` では再確認要求が 0 件、各 `recheck.status` が `disabled` |
| P10 | 指摘なしの応答で `status: "done"`、`findingCount: 0`、`findings` が空、実行は `completed` |
| P11 | 1 観点だけ `malformed` が続くと、もう一方の観点の指摘で統合が進み `partially-failed` |
| P12 | 全観点が失敗した対象があっても他の対象の結果は残り、`checkUnits` から「指摘ゼロ」と区別できる |
| P13 | `finish_reason: "length"` の応答で当該単位が `failed`（`truncated`）になり、`findings` が空にならない |
| P14 | `timeout` の後に `chat` が 1 度も呼ばれず、残りの単位が `pending`、`stop.reason` が `recovery-needed`、`generationUnconfirmed: true` |
| P15 | k 番目の `ensureLoaded` が `model-not-loaded` のとき、それ以前は `done`、k 番目以降は `pending`、`stopped` |
| P16 | `signal` を途中で中断すると `stopped`（`aborted`）で、以後の要求が送られない |
| P17 | 初回検査の `InputTooLongError`（`maxInputGraphemes` を小さくする）で `stopped`（`settings`）、`stop.failure.reason` が `input-too-long`、本文は縮まない |
| P18 | 再確認の `InputTooLongError` はその再確認だけ `failed` にし、実行は続いて `partially-failed` |
| P19 | `InvalidChunkSettingsError` で `stopped`（`settings`）、`targets` と `checkUnits` が空、`findings` が空 |
| P20 | 再確認が `malformed` を 2 回返すと `recheck.status: "failed"`、実行は `partially-failed` |
| P21 | `mode: "full-text"` で観点ごとに要求が 1 件だけ、`targets` が 1 件、再確認なし |
| P22 | `mode: "full-text"` で本文が `maxInputGraphemes` を超えると `stopped`（`settings`） |
| P23 | 同じ入力・同じモック応答で 2 回実行すると ID と結果 JSON が一致する |
| P24 | 結果 JSON に接続先 URL と API キーが現れない（`JSON.stringify` を文字列検索） |
| P25 | `conditions.versions` が `PROMPT_VERSION` などの実際の値を持ち、`targets[i].input` が要求に使った `CheckInput` と一致する |
| P26 | `onEvent` が例外を投げても実行が続き、結果が変わらない |
| P27 | イベント順が `run-started` で始まり `run-finished` で終わる（`stopped` の場合も） |
| P28 | `inputGraphemes` が要求に載せた本文の書記素数と一致する（CRLF・絵文字を含む本文で） |
| P29 | `totals` の各件数が `checkUnits`・`findings`・`unlocated` の実際の内訳と一致する |

### C：`packages/cli`（単体）

| # | 内容 |
| --- | --- |
| C1 | 必須引数（`--manuscript`、`--model`）の欠落でエラー終了（終了コード 1） |
| C2 | 未知のオプション、数値でない値、範囲外の `--temperature` を拒否する |
| C3 | `--perspectives` の分割と未知の観点の拒否 |
| C4 | `--mode full-text` でも `--recheck-context-graphemes` は検証され、`conditions` に記録される（使われないだけ） |
| C5 | BOM 付き CRLF の原稿ファイルを読んだ結果が `ingestUtf8Bytes` の出力と一致する |
| C6 | 許容語ファイルの中身を加工せず `allowedWordsRaw` に渡す |
| C7 | 結果 JSON が `JSON.parse` で構造的に往復する（`PipelineResult` の形を保つ） |
| C8 | 終了コードが `RunStatus` に対応する |
| C9 | 標準出力・標準エラーに API キーと接続先 URL が現れない |

### L：PR5 からの持ち越し（`lmstudio/client.test.ts`）

| # | 内容 |
| --- | --- |
| L1 | `listModels` の既定タイムアウト（10 秒）が適用される |
| L2 | 応答本文の読み取り中にタイムアウトすると `timeout` |
| L3 | `truncateRaw` が長い応答本文を切り詰め、例外の `raw` に全文を載せない |

### I：実 LM Studio（`pnpm test:llm`）

| # | 内容 |
| --- | --- |
| I1 | 合成の長文（複数の検査対象に分かれる長さ）で `mode: "split-recheck"` が通り、`status !== "stopped"` |
| I2 | `mode: "full-text"` が通り、`status !== "stopped"` |
| I3 | 各要求の `inputGraphemes` と `usage.promptTokens`（非 null であること）、`locateQuote` の内訳、段落マーカー・タグの引用への混入件数、検査対象の終端をまたぐ引用の件数を記録する（assert は `usage` の非 null だけ。数値は結果 JSON と `console.log` に残す） |

I1〜I3 は LM Studio に到達できないときは skip する（PR6 の `integration-support.ts` を使う）。
実 LLM の応答は毎回変わるので、`completed` は assert しない（1 単位でも失敗すれば
`partially-failed` になるため）。

## 進め方

1. ブランチ `feat/pr7-pipeline`（作成済み）。
2. 本計画をエージェント 2 体で自己レビューし（実施済み）、指摘を反映してユーザーへ提出する。
3. 実装は SDD（`superpowers:subagent-driven-development`）で行う。ロードマップの担当欄は
   「qwen が CLI と結合テストの雛形」だが、PR5 以降は SDD のサブエージェントに統一しているので
   本 PR もそれに合わせる（ロードマップの担当欄は実装時に実態へ直す）。タスクの区切り：
   1. `result.ts`、`events.ts`、`allowed-words.ts`（型と純粋関数、U）
   2. `executor.ts`（E）
   3. `pipeline.ts`（P）
   4. `packages/cli` と `server` の `exports`（C）。`pnpm install` を走らせて `pnpm check` に乗せる
   5. PR5 持ち越しテスト（L）
   6. 実機での試運転（I）、実測記録、`docs/` の更新
4. `pnpm check` を通す。Windows は CI で確認する。
5. PR を作り、解釈で迷った点を本文に列挙する。
6. 試運転の記録は `docs/experiments/<日付>-pipeline-trial/` に置く。集計値だけを載せ、
   原稿本文・引用・結果 JSON は載せない。
