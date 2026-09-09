# PR9b 詳細計画：完成したオーケストレーター（server）

作成日：2026-09-09
対象：ロードマップ `docs/plans/2026-09-07-mvp-roadmap.md` の「PR9 server：実行キューとオーケストレーション」の後半
仕様：`docs/spec/mvp-spec.md` v0.8 の 2 節（単一キュー）、6 節（処理順序）、6.4、7 節、8.2 節全体
前提：PR9a（`feat/pr9a-run-foundation`、PR #14）が main にある

**本書は `docs/plans/2026-09-09-pr9-orchestration.md`（以下「PR9 計画書」）の続きである。**
目標・対象外・全体の制約・決定 1〜23・テスト Q/S/O/T/R/P/M/D/E は PR9 計画書のものをそのまま引き継ぐ。
本書はそこに**決定 24 以降**と PR9b の実装タスクを足す。ファイルを分けたのは、SDD の
`scripts/task-brief` が `^#+[ \t]+Task[ \t]+N` で見出しを照合するため、同じファイルに
PR9a の `Task 1〜6` と PR9b の `Task 1〜10` があると両方を拾ってしまうからである。

## 目標（PR9 計画書の再掲）

PR9a で作った部品（`run/units.ts`・`run/queue.ts`・`run/state.ts`・`run/persist.ts`・`run/merge-store.ts`・
リポジトリの条件付き更新・マイグレーション `0001`）を、**DB を正本とした検査実行**に組み上げる。
受け入れ条件 3・4・5・11・14・15・16・18 を本 PR の完了時に満たす。

## 対象外（MUST NOT）

PR9 計画書の「対象外」をそのまま引き継ぐ。特に次を守る。

- HTTP API・SSE エンドポイントは作らない（PR10）。本 PR の成果物は関数として呼べる形にとどめる。
- 画面は作らない（PR11・PR12）。`settings` 表も作らない（PR10）。
- 仕様書 13 節の未決事項（モデル、思考の有無、既定の生成設定、タイムアウトの確定値）をここで確定しない。
- 本文を書き換えない。採否（`judgments`）を実行側から更新しない（仕様 5.4）。
- 位置特定・統合・抑制の**規則**を変えない。PR3・PR4 の関数をそのまま使う。
- `full-text` は CLI（`runPipeline`）専用のまま。オーケストレーターは扱わない（決定 18）。

## 全体の制約（本 PR に効くもの）

- LLM 生成要求はバックエンド全体で単一キュー、同時実行数 1。
- 未ロードのモデルに生成要求を送らない。各要求の直前に `ensureLoaded`。
- `AbortController` は通信の中断であり生成終了の確認ではない。確認できなければ「復旧待ち」。
  時間経過を終了の証拠にしない。
- `finish_reason == "length"`、形式不正、接続失敗を正常な空配列に置き換えない。
- SSE は通知手段で状態の正本は DB。**DB トランザクションに LLM 応答待ちを含めない**。
- API キーと接続先 URL をログ・履歴・出力に含めない。**原稿の断片も同様に扱う**（決定 33）。
- 相対 import は `.ts` 拡張子付き。`enum` を使わない（`erasableSyntaxOnly`）。
- **既存 CLI の非退行**：`packages/server/src/run/pipeline.test.ts` と `packages/cli` のテストを
  1 行も変えずに緑であること（PR9a から引き継ぐ最重要条件。テスト E1）。

## 作るもの

| ファイル | 役割 |
| --- | --- |
| `server/src/run/orchestrator.ts` | 開始・停止・再開・再試行・起動時照合。単位駆動ループの本体 |
| `server/src/run/loop.ts` | 単位駆動ループ本体（`orchestrator.ts` から分ける。決定 24） |
| `server/src/run/save.ts` | 決定 15 の保存トランザクション（1 検査単位ぶん／1 再確認ぶん） |
| `server/src/run/recovery.ts` | 停止ゲート。生成終了の確認と上限付き待機（決定 26） |
| `server/src/run/recovery-gate.ts` | プロセス全体の送信ゲート。復旧待ちの実行がある間は送らない（決定 39） |
| `server/src/run/transitions.ts` | 状態を書く唯一の経路。`canTransition*` を通してからリポジトリを呼ぶ（決定 29） |
| `server/src/run/events.ts`（追記） | `OrchestratorEvent` と `RunEvent`（決定 37） |
| `server/src/run/result.ts`（追記） | `StopReason` に `internal-error`（決定 14） |
| `server/src/run/units.ts`（改修） | 遅延通知の起点（決定 27）、停止経路の `pending_note`（決定 32） |
| `server/src/run/executor.ts`（改修） | `execute` に `hooks.onSend`（決定 27） |
| `server/src/run/persist.ts`（追記） | `mergedFindingFromRecords`（決定 38） |
| `server/src/db/records.ts`（追記） | `RunStopReason` に `internal-error` |
| `server/src/db/schema.ts`（追記） | `RUN_STOP_REASONS` に `internal-error` |
| `server/src/db/repositories/*.ts`（改修） | `setStopRequestedAt`、`claimRun` の停止情報クリア、`updateRunModelInfo`、`listFindingsForTarget`、`listCandidateSourcesForFinding` |
| `server/src/config.ts`（追記） | `SHUTEN_RECOVERY_CONFIRM_MS`（決定 8） |
| `server/src/index.ts`（追記） | 起動時照合の呼び出し |
| `docs/spec/mvp-spec.md` | `checkMs` の意味の改訂。版を上げ 15 節に追記（決定 7） |

## PR9a からの持ち越しの対応表

PR9 計画書の「PR9a からの持ち越し（PR9b で決着させる）」8 件の行き先。

| 持ち越し | 本 PR での扱い |
| --- | --- |
| `onSlow` の遅延通知がキュー待ちを含む | 決定 27（起点を実際の送信時点に改める） |
| （解消済み）`queue` と `tail` の二重直列化 | 対応不要。PR #14 のレビュー対応 2 で解消済み |
| `state.test.ts` の `internal-error` の型アサーション | Task 1 で通常の値に戻す |
| `updateFindingSuppression` に渡す許容語は実行単位で不変 | 決定 31 |
| 増分マージが対象内で決着していない中間状態を見せる | 決定 34（対象の全単位が決着してから起票する順序を守る） |
| `assertUnlocatedFindingBoundary` の呼び出しがまだない | 決定 28（保存トランザクションの中で通す） |
| `run/state.ts` が本番コードから未接続 | 決定 29（`run/transitions.ts` を唯一の書き手にする） |
| `PersistBoundaryError` のメッセージに原稿の断片が入る | 決定 33（`stop_message` へ転記しない） |
| 停止経路の `pending_note` が決定 20 の文言でない | 決定 32 |

## 設計（決定 24 以降）

### 決定 24：オーケストレーターの形と公開 API

プロセス内に 1 つ作る。実行 1 本につき「executor 1 つ・`AbortController` 1 つ・停止ゲート 1 つ」を
レジストリに持つ。キューだけが実行をまたいで共有される（決定 2）。

```ts
// run/orchestrator.ts
export interface OrchestratorDeps {
  readonly db: AppDatabase;
  readonly client: LmStudioClient;
  readonly queue: RequestQueue;
  /** プロセス全体の復旧ゲート（決定 39）。キューと同じく index.ts で 1 個だけ作って渡す。 */
  readonly recoveryGate: RecoveryGate;
  readonly endpointUrl: string;      // runs.endpoint_url に保存する。イベント・結果には出さない
  readonly recoveryConfirmMs: number; // config.ts（決定 8）
  readonly now?: (() => Date) | undefined;
  readonly createId?: (() => string) | undefined;
  readonly onEvent?: ((event: RunEvent) => void) | undefined;
}
export interface Orchestrator {
  startRun(input: StartRunInput): StartRunResult;
  resumeRun(runId: string): StartRunResult;
  retryFailedUnits(runId: string, options?: { readonly unitIds?: readonly string[] }): StartRunResult;
  stopRun(runId: string): { readonly accepted: boolean; readonly run: RunRecord | null };
  reconcileOnStartup(): void;
}
export interface StartRunResult {
  /** 開始（または再開）直後の実行レコード。開始を拒否した場合も終端状態の行を返す。 */
  readonly run: RunRecord;
  /** ループの完了。**決して reject しない**（決定 33）。呼び出し元は待っても捨ててもよい。 */
  readonly done: Promise<RunRecord>;
}
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator;
```

- `startRun` / `resumeRun` / `retryFailedUnits` は**同期に戻り**、ループはバックグラウンドで走る。
  PR10 の `POST /api/runs` が即座に実行 ID を返せる形にするため。テストは `done` を await する。
- `done` は reject しない。想定外の例外もループの内側で終端状態に落として解決する（決定 33）。
  reject する Promise を放置すると `unhandledRejection` でプロセスが落ちうるため。
- 同じ `startOperationId` の 2 回目は既存の実行を返す（決定 12）。**そのときレジストリに走っている
  ループがあれば、その `done` をそのまま返す**（新しい `done` を作らない）。
- レジストリに無い実行への `stopRun` は `{ accepted: false, run }` を返し、DB を変えない
  （このプロセスが走らせていない実行は止めようがない。起動時に残った `running` 行は
  `reconcileOnStartup` が処理する）。
- イベントは `deps.onEvent` に流す。実行 ID は `RunEvent` が持つ（決定 37）ので購読口は 1 つでよい。
- **`queue` と `recoveryGate` はオーケストレーターの内側で作らない。** `index.ts` が
  `createRequestQueue()` / `createRecoveryGate()` を 1 個ずつ作り、`createOrchestrator` に渡す。
  内側で作ると、同じキューとゲートを共有すべき PR10 の接続確認が同じインスタンスを使えない。
- `endpointUrl` は `runs.endpoint_url` に保存するだけで、イベント・`stop_message` には入れない。
  **`RunRecord` 自体は `endpointUrl` を持つ**ので、`startRun` などが返すレコードは
  「サーバー内部でだけ扱う値」である。PR10 は HTTP 応答へそのまま流さず、
  接続先 URL を除いた公開 DTO へ必ず射影する（PR10 への持ち越しに記載する）。

**単位駆動ループ本体は `run/loop.ts` に置く**（`orchestrator.ts` は入口の状態管理とレジストリだけ）。
1 ファイルの責務を小さく保ち、ループのテストがレジストリを経由せずに書けるようにするため。

### 決定 25：走査順は DB の索引順に頼らない

`listUnfinishedCheckUnits` は `ORDER BY target_id, perspective` だが、`target_id` は
`randomUUID()`（`db/ids.ts`）なので**検査対象の順序と無関係**であり、`perspective` の昇順も
実行が指定した観点の順序ではない。`listRecheckUnits` の `ORDER BY finding_id` も同様。
そこでループは次の順で走査する。

1. 検査対象：`listRunTargets(db, runId)`（`target_index` 昇順。既存の並びで正しい）。
2. 対象内の観点：`runs.perspectives` の配列順（実行時に指定された順）。
   `listCheckUnits(db, runId)` を 1 度読み、`(targetId, perspective)` で引ける表を作る。
3. 対象内の再確認：`listFindings` と同じ並び（`start` 昇順、位置特定失敗は最後、
   同順位は `created_at` → `id`）に揃える。対象で絞った `listFindingsForTarget` を足す（決定 38）。

`listUnfinishedCheckUnits` / `listUnfinishedRecheckUnits` は「未完了が残っているか」の判定にだけ使う。

### 決定 26：停止ゲート（`run/recovery.ts`）

決定 6 の「新規送信を止め、実行中の 1 要求は上限まで自然な完了を待つ」を 1 か所に閉じ込める。

```ts
// run/recovery.ts
export interface StopGate {
  readonly signal: AbortSignal;
  /** 停止要求を受けたか。ループは各単位の手前でこれを見る。 */
  readonly stopRequested: boolean;
  /** 停止要求。冪等（2 回目以降は何もしない）。 */
  requestStop(): void;
  /**
   * 生成要求の送信直前・完了直後に**executor が**呼ぶ（決定 27 のフック経由）。
   * ループからは呼ばない。キュー待ちと `ensureLoaded` を含めてしまうと、
   * 生成を送っていない停止でも `recoveryConfirmMs` だけ待つことになるため。
   */
  beginRequest(): void;
  endRequest(): void;
  /** タイマーを解除する。ループの終了時に必ず呼ぶ。 */
  dispose(): void;
}
export function createStopGate(recoveryConfirmMs: number): StopGate;
```

- `requestStop()` は `stopRequested` を立て、**実行中の要求があれば** `recoveryConfirmMs` 後に
  `abort()` を予約する。実行中の要求が無ければただちに `abort()` する（送信していないので
  生成終了は未確認にならない）。
- `endRequest()` は予約された `abort()` を解除する。**ただし `stopRequested` が立っていれば、
  解除ではなくその場で `abort()` する。** この要求は応答が届いて終わっているので「生成終了は
  確認できた」（`generationUnconfirmed` は false のまま）が、**executor 内部の自動再試行**
  （`malformed` / `truncated` / HTTP 応答ありの `connection`）はループに制御を戻さずに次の
  `chat` を送ってしまう。停止要求後に新しい要求を送らない（仕様 8.2）を守れるのは、
  ここで signal を落としておく形だけである。
  - 例：1 回目の `chat` 中に停止 → 上限内に `malformed` な応答が届く → `endRequest()` が
    abort → executor は再試行の手前で signal を見て送らない → `stopped`
    （`generationUnconfirmed: false`）。
  - abort 後にループが合成する停止（`aborted` / false）と、executor が返す停止（同じく false）の
    どちらでも実行は `stopped` になる（決定 23）。
- **`beginRequest()` / `endRequest()` を呼ぶのは executor だけ**（`client.chat` の直前と、
  その `finally`。自動再試行では試行ごとに 1 往復）。ループが `executeCheckUnit` の前後で
  呼ぶと、キュー待ちと `ensureLoaded` の時間が「実行中の生成」に含まれてしまい、
  下の 3 経路の区別が崩れる。
- 停止から実行の終了状態への写像は**自前で持たない**。決定 23 の表がそのまま成り立つ。
  - キュー待ち・`ensureLoaded` 中に `abort()` → executor は `origin: local` / `ensure-loaded`、
    `generationUnconfirmed: false` を返す → `stopped`。
  - `chat` 中に `abort()` → `reason: aborted`、`generationUnconfirmed: true` → `recovery-waiting`。
  - 上限内に応答が届いた → 応答を保存し、ループが
    `{ reason: "aborted", message: "停止操作により実行を停止した", failure: null, generationUnconfirmed: false }`
    を合成して `stopped`。ただし**その応答自体が停止を伴う場合は合成しない**。
    ループが採る停止は `stop = outcome.halt ?? 合成した停止` の順で決める（例：上限内に届いたのが
    「応答を受け取れずに切断」なら `generationUnconfirmed: true` の `halt` が勝ち、`recovery-waiting`）。
- タイマーは Node の `setTimeout` を直接使う。テストは `units.test.ts` と同じく vitest の
  fake timers で進める（新しい注入口を作らない）。

### 決定 27：遅延通知の起点を「実際に生成要求を送った時点」に改める（PR9a の持ち越し）

PR9a の `executeWithSlowNotice` は `executor.execute` を呼んだ時点でタイマーを立てるため、
キュー待ちの時間が `checkMs` に食い込む。**起点を実際の送信時点に移す**。

```ts
// run/executor.ts
export interface ExecuteHooks {
  /** client.chat を呼ぶ直前に呼ぶ。再試行のたびに呼ぶ（1 回の execute で最大 2 回）。 */
  readonly onSend?: (() => void) | undefined;
  /** client.chat の finally で呼ぶ。成功・失敗・例外のいずれでも必ず呼ぶ。onSend と同数。 */
  readonly onSettled?: (() => void) | undefined;
}
execute<T>(request: ChatRequest, parse: (result: ChatResult) => T, timeoutMs: number, hooks?: ExecuteHooks): Promise<ExecOutcome<T>>;
```

`units.ts` は `onSend` の中でタイマーを張り直す（前のタイマーは解除してから）。試行ごとに
測り直すのは、`chat` に渡すハード上限（`checkMs + recoveryConfirmMs`）も試行ごとに適用されるため。
`recoveryConfirmMs <= 0` の早期 return（タイマーを作らない）はそのまま残し、E1 を守る。

**executor は自動再試行の手前で signal を再確認する。** 現在の `runOne` は
`isRetryable(error) && !retried` だけで `continue` し、次の周回の `ensureLoaded` まで中断を見ない。
`isAborted(signal)` を再試行の条件に足し、中断されていたら再試行せずに
`halt ??= { reason: "aborted", message: "停止要求により再試行を送らなかった", failure, generationUnconfirmed: false }`
を立てて返す（届いた応答の失敗内容 `failure` は捨てない。`ensureLoaded` の abort まで進めると
`malformed` だった事実が「モデル一覧の取得中に中断された」に置き換わってしまう）。

**このフックは停止ゲートの入口でもある。** `executeCheckUnit` / `executeRecheckUnit` は
任意の `onSend` / `onSettled` を受け取り、自分の遅延通知タイマーと合成して executor に渡す。
ループはそこへ `gate.beginRequest` / `gate.endRequest`（決定 26）を渡す。これで
「実行中の生成」は `client.chat` の実行区間そのものになり、キュー待ちと `ensureLoaded` は含まれない。

**代案（採らない）**：通知の意味を「キュー投入からの経過」と定義し直す。実装は要らないが、
他人の実行で待たされただけで「生成が遅い」と表示され、`checkMs` の設定を疑わせる。

### 決定 28：保存トランザクションを `run/save.ts` に切り出す

決定 15 の「1 検査単位ぶんを 1 トランザクション」の実装場所。オーケストレーターの内側に
書かずに分けるのは、T1〜T7 をループを動かさずに書けるようにするため。

```ts
// run/save.ts
export interface SaveCheckUnitInput {
  readonly run: RunRecord;
  readonly target: RunTargetRecord;
  readonly unit: CheckUnitRecord;      // 状態は running（claim 済み）
  readonly outcome: CheckUnitOutcome;  // run/units.ts の戻り値
  readonly body: string;
  readonly paragraphs: readonly Paragraph[];
  readonly allowedWords: readonly string[];
  readonly now: Date;
}
export interface SaveCheckUnitResult {
  /** 条件付き更新が 0 行で、トランザクション全体をロールバックした（決定 15）。 */
  readonly rolledBack: boolean;
  readonly findingIds: readonly string[];
}
export function saveCheckUnitOutcome(db: AppDatabase, input: SaveCheckUnitInput): SaveCheckUnitResult;
export interface SaveRecheckInput {
  readonly run: RunRecord;
  readonly unit: RecheckUnitRecord;     // 状態は running（claim 済み）
  readonly outcome: RecheckUnitOutcome; // run/units.ts の戻り値
  readonly now: Date;
}
export function saveRecheckOutcome(db: AppDatabase, input: SaveRecheckInput): { readonly rolledBack: boolean };
```

トランザクションの中身（この順）：

1. `nextCandidateIndex(tx, runId)` を 1 度読み、応答の候補に LLM の返した順で連番を振る（決定 22）。
2. 位置確定済みの候補 → `mergeCandidateIntoRun`（PR9a）。
3. 位置特定失敗の候補 → `assertUnlocatedFindingBoundary`（PR9a の持ち越しの配線）を通してから
   `saveUnlocatedCandidate`。`not-found` / `ambiguous` で指摘ができたら、続けて
   `insertRecheckUnit({ status: "not-applicable", notApplicableReason })`（決定 11）。
   理由の優先順位は `disabled` → `unlocated` → `suppressed`。
4. `runs.model_info` がまだ null で executor が `modelInfo` を持っていれば `updateRunModelInfo`（決定 30）。
5. `finishCheckUnit(tx, id, { expectedStatus: "running", ... })`。**false ならロールバック**。

ロールバックは番兵例外（`class SaveRolledBack extends Error`）を投げて `db.transaction` を抜け、
`save.ts` の内側で捕まえて `{ rolledBack: true }` に変える。呼び出し元に例外を漏らさない。

`saveRecheckOutcome` も同じ形（結果列と状態更新を 1 トランザクション、0 行ならロールバック）。

### 決定 29：状態を書く唯一の経路を `run/transitions.ts` にする（PR9a の持ち越し）

PR9a で作った `canTransitionRun` / `canTransitionUnit` は、まだどこからも呼ばれていない。
本 PR で「状態を書く経路はすべてこれを通す」を**コードとして強制**する。

```ts
// run/transitions.ts
export class InvalidTransitionError extends Error {}   // 表にない遷移。プログラミング誤り
export function claimUnitChecked(db: AppDatabaseLike, id: string, from: UnitStatus, to: UnitStatus, options?: { readonly startedAt?: Date }): boolean;
export function claimRecheckUnitChecked(db: AppDatabaseLike, id: string, from: UnitStatus, to: UnitStatus, options?: { readonly startedAt?: Date }): boolean;
export function finishCheckUnitChecked(db: AppDatabaseLike, id: string, input: FinishCheckUnitInput): boolean;
export function finishRecheckUnitChecked(db: AppDatabaseLike, id: string, input: FinishRecheckUnitInput): boolean;
export function claimRunChecked(db: AppDatabaseLike, id: string, from: RunStatus, to: RunStatus, options?: { readonly clearStopState?: boolean }): boolean;
export function finishRunChecked(db: AppDatabaseLike, id: string, input: FinishRunInput): boolean;
```

`from → to`（`finish*` は `expectedStatus → status`）が表になければ `InvalidTransitionError` を投げ、
表にあればリポジトリへ委譲する。**オーケストレーター・ループ・`save.ts`・起動時照合は、
リポジトリの `claim*` / `finish*` を直接呼ばない**（レビューの検査項目にする）。

**代案（採らない）**：リポジトリ自身に検査を入れる。強制力は強いが、PR8 のテストが「表にない
ペアを渡して false が返ること」を確かめている箇所が 6 つあり（`check-units.test.ts` の
`pending→failed`・`pending→done`、`rechecks.test.ts` の `pending→failed`・`pending→done`、
`runs.test.ts` の `stopped→completed`、`judgments.test.ts` の `pending→done`）、それらを
「表にある遷移だが行の状態が違う」形に書き換える必要がある。PR8 のテストを触る範囲が
本 PR の主題から離れるので採らない（PR12 以降で検討する余地は残る）。

### 決定 30：`runs.model_info` は最初の `ensureLoaded` 成功で 1 度だけ書く

`RunRecord.modelInfo` は「`ensureLoaded` が返した `ModelInfo`」だが、`startRun` の時点では
まだ生成要求を送っていないので null で作るしかない。リポジトリに
`updateRunModelInfo(db, runId, info): void` を足し、**最初の保存トランザクションの中で**
（`runs.model_info` が null かつ `executor.modelInfo` が非 null のときだけ）書く。
別トランザクションにしないのは、書き込み回数を増やさずに済み、落ちても次の単位で書けるため。

### 決定 31：実行の設定は `runs` から 1 度だけ読む（PR9a の持ち越し）

ループの開始時に `findRun` で 1 度だけ読み、`allowedWords`・`generationSettings`・`chunkSettings`・
`timeouts`・`perspectives`・`recheckEnabled`・`recoveryConfirmMs` をローカル変数に固定する。
候補ごと・単位ごとに読み直さない。特に `allowedWords` は、途中で変わると統合済み指摘の抑制判定が
候補の処理順に左右される（PR9a の持ち越し）。原稿本文（`manuscript_versions.body`）と
`splitParagraphs` の結果も同じくループの開始時に 1 度だけ作る。

### 決定 32：停止操作で打ち切った単位の `pending_note`（PR9a の持ち越し）

決定 20 は 2 つの文言を定めている。PR9a は上限超過（`timeout`）側だけを実装した。停止側を足す。

- `recoveryConfirmMs > 0` かつ `failure.origin === "chat"` かつ `failure.reason === "aborted"`
  → 「停止操作により打ち切った。生成終了は未確認」
- それ以外（送信前に止めた `origin: "local"` の `aborted` を含む）は従来どおり `failure.message`。

`recoveryConfirmMs > 0` を条件に含めるのは、`runPipeline`（CLI）が `signal` を渡して中断したときの
文言を変えないため（E1）。`origin === "chat"` で絞るのは、送信していない単位は「生成終了が
未確認」ではないため。

### 決定 33：想定外の例外の扱い（決定 14 の具体化）

ループの最上位で `LmStudioError` でも `InputTooLongError` でもない例外を捕まえ、次を行う。

1. その時点で `running` の検査単位・再確認単位を `pending` に戻す（`pending_note`：
   「想定外のエラーで実行が中断した」）。**戻さないと `resumeRun` が拾えない**
   （`claimUnit("pending" → "running")` が 0 行になり、起動時照合は起動時にしか走らない）。
2. `finishRunChecked(..., { status: "stopped", stopReason: "internal-error", generationUnconfirmed: false })`。
3. `stop_message` は**定型文のみ**（「想定外のエラーで実行を停止しました」）。例外のメッセージを
   転記しない。接続先 URL・API キーに加え、`PersistBoundaryError` が持つ**原稿の断片**
   （`previewQuote` の 20 コード単位）も DB に残さないため（PR9a の持ち越し）。
4. 例外は `done` に載せずに握る（決定 24）。`run-settled` イベントで通知する。
5. **その実行の復旧ゲートが閉じているなら、`stopped` ではなく `recovery-waiting`
   （`generation_unconfirmed = true`）で終端化する**（Task 8 のレビューで判明した隙間への対処）。
   `resumeRun` がゲートを開けるのは `recovery-waiting` の実行の claim に成功したときだけなので、
   ゲートが閉じたまま `stopped(internal-error)` で終わると、**プロセス全体の送信が再起動まで
   止まる**。生成終了を確認できていないことは想定外の例外とは無関係に真なので、
   `recovery-waiting` と記録するのが事実にも合う。判定は `recoveryGate.blockedRunIds.has(runId)`。
   これで「ゲートが閉じている ⟺ その実行は `recovery-waiting`」という不変条件が保たれる。
   `stop_reason` は `internal-error` のまま、`run-settled` の `generationUnconfirmed` も
   同じ値にする。決定 23 の写像表には `internal-error` / true / `recovery-waiting` の行が増える
   （`state.test.ts` の S6 も同じ数になる）。
6. **この後始末自体が失敗することもある**（DB が原因の例外なら 1・2 も失敗しうる）。その場合も
   捕まえて握り、`done` は最後に読めた `RunRecord`（読めなければ開始時のレコード）で解決する。
   レジストリからの削除と `gate.dispose()` は `finally` で必ず行う。「`done` は決して reject
   しない」（決定 24）の実体はここにある。

`internal-error` は `run/result.ts` の `StopReason`、`db/records.ts` の `RunStopReason`、
`db/schema.ts` の `RUN_STOP_REASONS` の 3 か所に足す。drizzle の `text({ enum })` は CHECK 制約を
生成しない（`0000_steep_prodigy.sql` に CHECK は 0 件）ので**マイグレーションは増えない見込み**だが、
`pnpm --filter @shuten/server db:generate` を実行して差分が出ないことを確認し、出たらコミットする。

### 決定 34：再確認単位を起票する契機（決定 19 の実装）

ある検査単位の保存が終わったら、**その対象の検査単位に `pending` / `running` が 1 つも
無いことを確かめてから**、対象ごとに 1 トランザクションで起票する。

- 対象の指摘（`listFindingsForTarget`）のうち、`recheck_units` を持たないものだけを作る。
  すでに持つものは触らない（`findRecheckUnitByFinding` で判定）。**冪等**なので、起票の直前に
  落ちても再開時に同じ判定でやり直せる。だから起票を保存トランザクションに含めなくてよい。
- `runs.recheck_enabled === false` → 全件 `not-applicable(disabled)`。
- 抑制されている指摘（`findings.suppression !== null`）→ `not-applicable(suppressed)`。
- それ以外 → `pending`。
- 位置特定失敗の指摘の `not-applicable(unlocated)` は保存トランザクションの中で作り済み（決定 28）。

**`not-applicable` の再確認単位を `running` に claim してはならない。** `run/save.ts` の
`saveRecheckOutcome` は `disabled` / `suppressed` の `RecheckResult` を受け取ると例外を投げる
（`running → not-applicable` は決定 3 の許容遷移表に無いため、状態を書けない）。ループが実行するのは
`pending` の再確認単位だけであり、起票の時点で `not-applicable` にしたものはそのまま終端である。

**この順序は必ず守る**（PR9a の持ち越し）。対象内の他の観点がまだ `pending` / `running` のうちに
統合結果を読むと、後から集約・抑制が変わる中間状態を見て起票の可否を誤る。

### 決定 35：終了状態の再計算

ループを抜けるときの `runs.status`（決定 3 の遷移表にある行き先だけ）：

| 条件 | `status` |
| --- | --- |
| `stop !== null` | `runStatusForStop(stop)`（`stopped` / `recovery-waiting`。決定 23） |
| 停止なし、`failed` の検査単位・再確認単位が 1 つ以上 | `partially-failed` |
| 停止なし、`failed` が 0 件 | `completed` |

停止していないのに `pending` の単位が残ったままループを抜けることは無い（残っていれば
ループが続く）。`completed` / `partially-failed` の判定は**DB を読み直して**行う。
ループが持つメモリ上の集計ではなく DB が正本であり、条件付き更新が 0 行だった単位
（他の経路が先に決着させた）を取りこぼさないため。

### 決定 36：再開・再試行が受け付ける状態と、再開で消すもの

| 入口 | 受け付ける `runs.status` | 遷移 |
| --- | --- | --- |
| `resumeRun` | `stopped`、`recovery-waiting` | → `running` |
| `retryFailedUnits` | `partially-failed`、`stopped` | → `running`（その後 `failed` 単位を `pending` に） |
| どちらも | `running`（実行中）、`completed` | 拒否。現在のレコードを返す（例外にしない。決定 12） |

再開・再試行の `claimRunChecked(..., { clearStopState: true })` は、状態と同時に次を**1 文の
UPDATE で**消す（2 文に分けると途中で落ちた行が「実行中なのに停止済みに見える」）。

- `stop_requested_at` → null（決定 21）
- `generation_unconfirmed` → false
- `finished_at` → null
- `stop_reason` / `stop_message` → null（前回の停止の記録。実行中の行に残すと画面が矛盾する。
  単位ごとの失敗（`check_units.failure_*`）は消さないので「何が起きたか」は失われない）

**`retryFailedUnits` は検査単位と再確認単位の両方を戻す。** 仕様 8.2 の「失敗した単位」は
`check_units` と `recheck_units` の両方を指す。`claimUnitChecked(failed → pending)` と
`claimRecheckUnitChecked(failed → pending)` を、`claimRunChecked` と**同じトランザクション**で行う
（実行だけ `running` になって単位が `failed` のまま残ると、ループがやることを見つけられずに
すぐ `partially-failed` に戻る）。`options.unitIds` は**両方の表の ID を混ぜて受け付ける**。`unitIds` を省略したら、その実行の
`failed` の単位をすべて戻す。

**指定 ID は状態を 1 つも変える前に、同じトランザクションの中で全件検証する。** ID だけで
`claimUnitChecked` を呼ぶと、**別の実行に属する失敗単位を書き換えられてしまう**。検証は次の 4 つ。

1. `check_units` と `recheck_units` のちょうど一方に存在すること（両方・どちらにも無いは誤り）
2. その行の `run_id` が引数の `runId` と一致すること
3. その行の現在の状態が `failed` であること（`done` / `pending` / `running` / `not-applicable` は誤り）
4. `unitIds` が空配列なら誤り（省略が「全件」なので、空配列を全件と読むと取り違えが静かに通る）

1 件でも違反したら `RetryTargetError` を投げ、**実行の状態も単位も 1 つも変えずに**拒否する
（トランザクションを開いた中で投げるのでロールバックされる）。PR10 はこれを 400 に写す。

**`input-too-long` で失敗した検査単位は再試行の対象から外す**（Task 6 のレビューで判明した危険への対処）。
理由は 2 つある。(1) 分割設定は実行ごとに固定（`runs.chunk_settings`）なので、同じ実行の中で
再試行しても必ず同じ上限超過になる。(2) より危険なのは、`startRun` が上限超過の対象について
`run_targets.input` に**実際に試みた範囲を保存できない**ことである（`buildCheckInput` は失敗時に
試みた範囲を返さないため、暫定値として `target.range` を入れている）。この行から
`checkInputFromTargetRecord`（`run/persist.ts`）で入力を組み直すと、参考文脈のない**本来より狭い
入力**ができ、上限検査を素通りして検査が「成功」してしまう。仕様 7 節「入力上限超過時に本文を
黙って切り捨てない」に反する。
`unitIds` で明示的に指定された場合も同じ理由で拒否する（`RetryTargetError`）。
対処は「実際に試みた範囲を保存する」ではない（今度は上限を超える入力を送ることになる）。
守りは消費側に置く。

**この除外は検査単位だけで、再確認単位には掛けない**（意図的な非対称）。上の危険な理由 (2) は
再確認には当てはまらない。再確認の入力は `buildRecheckInput` が毎回組み直すので、黙って狭い入力に
なることがない。再試行しても同じ `input-too-long` を繰り返すだけで、安全上の問題は生じない。

停止要求そのものは `setStopRequestedAt(db, runId, at)` で書く（`runs.status` は `running` のまま。決定 21）。

### 決定 37：新しいイベントは `PipelineEvent` を広げずに足す

決定 16 の 4 つ（`target-planned`・`generation-slow`・`stop-requested`・`run-settled`）を
`PipelineEvent` に足すと、`packages/cli` の `formatEvent`（`main.ts:132`）が
**default 無しの網羅 switch** なのでコンパイルが壊れる。CLI はオーケストレーターのイベントを
受け取らないので、分けて定義する。

```ts
// run/events.ts
export type OrchestratorEvent =
  | { readonly type: "target-planned"; readonly targetIndex: number; readonly target: Range; readonly input: Range }
  | { readonly type: "generation-slow"; readonly unitId: string; readonly elapsedMs: number }
  | { readonly type: "stop-requested" }
  | { readonly type: "run-settled"; readonly status: RunStatus; readonly stop: RunStop | null };
/** SSE（PR10）に渡す形。実行 ID を必ず添える。 */
export interface RunEvent {
  readonly runId: string;
  readonly event: PipelineEvent | OrchestratorEvent;
}
```

オーケストレーターは `PipelineEvent` のうち `check-started` / `check-finished` / `target-merged` /
`recheck-started` / `recheck-finished` を出し、`run-started` / `run-finished` は出さない
（開始・終了は `target-planned` と `run-settled` で表す）。イベントは通知手段であり状態の正本は DB。

### 決定 38：DB から `MergedFinding` を組み立てる

再確認要求（`buildRecheckRequest` → `renderFindingBlock`）は `MergedFinding` を要求し、その
`sources` には**候補の観点**（`source.perspective`）が要る。ところが `CandidateRecord` は
`check_unit_id` しか持たない。次を足す。

```ts
// db/repositories/findings.ts
/** 指摘に紐づく候補を candidate_index 昇順で返す。観点は check_units から引く。 */
export function listCandidateSourcesForFinding(
  db: AppDatabaseLike, findingId: string,
): ReadonlyArray<{ readonly candidate: CandidateRecord; readonly perspective: Perspective }>;
/** 検査対象に属する指摘を listFindings と同じ並びで返す（決定 25）。 */
export function listFindingsForTarget(db: AppDatabaseLike, targetId: string): FindingRecord[];

// run/persist.ts
/** 位置確定済みの指摘レコードと候補から MergedFinding を作る。位置未確定の指摘には使えない（例外）。 */
export function mergedFindingFromRecords(
  finding: FindingRecord,
  sources: ReadonlyArray<{ readonly candidate: CandidateRecord; readonly perspective: Perspective }>,
): MergedFinding;
```

`mergedFindingFromRecords` は保存済みの集約値（`category`・`initialVerdict`・`quote`・`suggestion`・
`range`）をそのまま使い、再計算しない。再確認は保存された指摘を見るのであって、統合をやり直さない。

### 決定 39：「復旧待ち」はプロセス全体の送信ゲートにする

当初この計画は「復旧待ちは実行単位の性質」と読み、解釈点としてユーザーの判断を仰ぐ形にしていた。
**レビューの結論に従い、プロセス全体のゲートにする。** 仕様 8.2 の「前の生成が継続している
可能性がある場合は後続生成を送信しない」は LM Studio への送信全体に効く要件であり、実行 A の
生成が続いている可能性がある状態で実行 B を送ると、「バックエンド全体で同時実行数 1」
（仕様 2 節）も保証できない。複数タブ・複数原稿は受け入れ条件に含まれている。
これは機能追加ではなく、仕様の安全条件を満たすための実装である。

```ts
// run/recovery-gate.ts
export interface RecoveryGate {
  /** 復旧待ちの実行 ID。1 件でもあれば送信を止める（単一 boolean にしない）。 */
  readonly blockedRunIds: ReadonlySet<string>;
  readonly blocked: boolean;
  block(runId: string): void;
  unblock(runId: string): void;
}
export function createRecoveryGate(): RecoveryGate;
```

- `createExecutor` に任意オプション `recoveryGate` を足す。**`runOne` の先頭**（キューの順番が
  回ってきた時点。既存の `halt` 検査と同じ場所）で `gate.blocked` を見て、真なら `ensureLoaded` も
  `chat` も呼ばずに返す。キューへの投入時ではなく**順番が回ってきた時点**で見るので、
  「A が未確認になった時点で B がすでにキュー待ち」でも B は送信前に止まる。
- **ゲートを閉じるのは executor（キューのジョブの内側）**。ループ側で
  「実行が `recovery-waiting` に決着したら `block`」だけにすると閉じるのが遅れる。現在のキューは
  A のジョブが解決した直後に B のジョブを始めるので、A の結果が executor からループへ戻り、
  保存・実行状態の更新を経て `block(A)` に届く前に、B の `runOne` がゲートを見てしまう
  （V1 が不安定になる）。`createExecutor` に `onRecoveryRequired?: () => void` を足し、
  **`generationUnconfirmed: true` の `halt` を返す直前に同期的に**呼ぶ。オーケストレーターは
  そこで `recoveryGate.block(runId)` する。ループ終了時の `block` は**冪等な安全網**として残す。
- ゲートに止められた実行 B は `stopped`、停止理由は新しい値 **`recovery-blocked`**、
  `generationUnconfirmed: false`（B は 1 度も送っていない）。B の単位は `pending` のままなので、
  A の復旧を確認して A を再開すればゲートが開き、B も再開できる。
- 決定 23 の写像表に 10 行目を足す：`recovery-blocked` ／ 別の実行が復旧待ち ／ false ／ `stopped`。
- `recovery-blocked` は `StopReason`・`RunStopReason`・`RUN_STOP_REASONS` の 3 か所に足す
  （`internal-error` と同じく Task 1 で）。
- ブロックの出入りは 3 か所だけ：
  - 実行が `recovery-waiting` になったとき → `gate.block(runId)`
  - `resumeRun` が `recovery-waiting` の実行の `claimRunChecked` に成功したとき → `gate.unblock(runId)`
  - `reconcileOnStartup` が起動時に `status = "recovery-waiting"` の実行を読み、全件 `block` する
    （**ゲートの復元**。これが無いと、再起動しただけで未確認の生成に後続を送ってしまう）
- PR10 の接続確認（軽い生成要求）も同じキューを通すので、同じゲートに従う。

**代案（採らない）**：ゲートに当たった実行を停止させず、ブロックが解けるまでキューで待たせる。
待たせると B は何も表示せずに止まり続け、利用者から見て原因が分からない。停止させて理由を
`recovery-blocked` で残すほうが、仕様 8.2 の「その状況を表示する」に沿う。

### 決定 40：起動時照合は実行ごとに 1 トランザクション

決定 13 の 3 規則は「`running` の単位を持っていたか」で行き先が変わる。単位を先に `pending` へ
戻してから落ちると、次の起動では「`running` の単位なし」と判定され、**生成中だった可能性のある
実行を `stopped` に誤分類する**（復旧待ちにすべきものを、確認不要として片づけてしまう）。

実行ごとに次の 3 つを 1 トランザクションで行う。

1. 更新前に `running` の検査単位・再確認単位の有無を確定する
2. `running` の単位を `pending` に戻す（`pending_note`：「バックエンドが終了したため未完了のまま残った」）
3. 1 の判定に基づいて実行の状態を更新する（`recovery-waiting` または `stopped`）

複数の実行をまたいで 1 つのトランザクションにはしない（1 実行の失敗で全実行の照合が巻き戻る）。
`recovery-waiting` にした実行は、同じ照合の中で `gate.block(runId)`（決定 39）する。

### 決定 41：`attempts` は実行をまたいで累積する

仕様 8.1 の「試行回数」と `Executor.requestCount` のコメント（「送信した生成要求の総数（再試行を含む）」）
から、`check_units.attempts` / `recheck_units.attempts` は **1 回の `execute` の中だけでなく、
停止後の再開や個別再試行も含む累計**と読む。

`saveCheckUnitOutcome` / `saveRecheckOutcome` は `finishCheckUnit` に
**`unit.attempts + outcome.unit.attempts`** を渡す（`finishCheckUnit` は絶対値で上書きするため）。
例：最初に 2 要求で失敗し、個別再試行の 1 要求で成功したら 3。`pending` からの再開も同じ。

### 決定 42：イベント発火は 1 か所にまとめ、開始の通知はコミット後に出す

`onEvent` の例外で実行を壊さない（PR7 の `runPipeline` と同じ方針）ため、`emit(runId, event)` を
オーケストレーターに 1 つ作り、`try { onEvent(...) } catch { /* 通知の失敗で実行を止めない */ }` を
そこだけに書く。ループ・`startRun`・`stopRun` は必ず `emit` を通す。

`target-planned` は**開始トランザクションがコミットしてから**出す。トランザクションの中で出すと、
そのあとロールバックした場合に「存在しない検査対象」を通知したことになる。

### 決定 43：`SHUTEN_RECOVERY_CONFIRM_MS` は専用のパーサーで読む

`parsePort` は 1〜65535 の範囲検査なので流用できない。次を検査する専用の
`parseRecoveryConfirmMs(raw: string | undefined): number` を `config.ts` に足す。

- 未設定 → 既定 120000（暫定値。決定 8）
- **0 を許可する**（「`checkMs` がそのままハード上限」という従来の意味。決定 8）
- 10 進の整数表記であること。負値は不可
- `Number.isSafeInteger` を満たすこと
- `setTimeout` の実用上限（2,147,483,647 = 2^31 − 1）以下であること。超えると Node は
  タイマーを即時発火させるため、上限待ちが機能しなくなる
- 満たさなければ起動時に例外（既存の設定エラーと同じ扱い）

### 決定 44：ハード上限は加算後の値も検証する

`LmStudioClient` は `chat` の先頭で `validateTimeoutMs`（1 以上 2^31−1 以下の整数。
`lmstudio/client.ts`）を通す。オーケストレーター経路が渡すのは
**`checkMs + recoveryConfirmMs`** と **`recheckMs + recoveryConfirmMs`**（決定 7）なので、
各値が単体で範囲内でも**加算結果が上限を超えると `TypeError`** になる。これは
`LmStudioError` ではないので決定 33 の網に落ち、設定の誤りが `internal-error` として
記録されてしまう。`runs.timeouts` の JSON 検証（`runTimeoutsSchema`）は `z.number()` だけで
正負も整数性も見ていない。

`startRun` の設定検証（決定 18 の `validateChunkSettings` と同じ位置）で次を確かめる。

- `checkMs`・`recheckMs` が 1 以上の安全な整数であること
- `checkMs + recoveryConfirmMs <= 2^31 - 1` かつ `recheckMs + recoveryConfirmMs <= 2^31 - 1`

違反したら**生成要求を 1 件も送る前に**設定エラーとして扱う。`InvalidChunkSettingsError` と
同じく `runs` だけを `stopped`（`settings`）で作り、検査対象も検査単位も作らない
（`stop_message` は定型文。数値は入れてよいが接続先 URL・API キーは入れない）。

## テスト

PR9 計画書のテスト一覧（Q・S・O・T・R・P・M・D・E）をそのまま引き継ぎ、次を足す。
すべて通常テスト（`pnpm test`）。LM Studio は使わず、モック `LmStudioClient` とメモリ DB を使う。

### 遅延通知の起点（G）

- G1 キュー待ちが `checkMs` を超えても `generation-slow` が出ないこと（決定 27）
- G2 送信後に `checkMs` を超えたら出ること
- G3 再試行が起きたとき、2 回目の送信で測り直すこと（1 回目の経過時間を持ち越さない）

### 復旧ゲート（V。決定 39）

- V1 実行 A が `chat` 中の打ち切りで `recovery-waiting` に入った時点で**すでにキュー待ちだった**
  実行 B の要求が送られず、B が `stopped`（`recovery-blocked`）になること。
  B の検査単位は `pending` のまま残ること。**モックのキューではなく実物の `createRequestQueue()`
  を使い**、「A のジョブの解決 → B の `runOne` 開始」という実際の順序で検査する
  （ゲートを閉じるのが executor の `onRecoveryRequired` でなくループ側だと落ちること。決定 39）
- V2 A を手動再開するとゲートが開き、B を再開すると生成要求が送られること
- V3 起動時照合が `recovery-waiting` の実行を読んでゲートを復元すること（再起動しただけでは開かない）
- V4 復旧待ちが 2 件あるとき、1 件を再開してもゲートは開かないこと（集合で持つことの確認）
- V5 **停止要求の後に executor の自動再試行が送られないこと**（決定 26）。1 回目の `chat` 中に
  停止し、上限内に `malformed` な応答が届いたとき、2 回目の `chat` を送らずに `stopped`
  （`generationUnconfirmed: false`）になること。`client.chat` の呼び出し回数で確認する

### 状態遷移の強制（W）

- W1 `transitions.ts` が表にない遷移で `InvalidTransitionError` を投げ、DB を変えないこと
- W2 表にある遷移はリポジトリに委譲され、条件付き更新の戻り値がそのまま返ること
- W3 オーケストレーター・ループ・`save.ts`・起動時照合が、リポジトリの `claim*` / `finish*` を
  直接 import していないこと（import の静的検査）

### 個別再試行の対象検証（Y。決定 36）

- Y1 別の実行に属する単位 ID を渡すと `RetryTargetError` になり、その単位も実行も変わらないこと
- Y2 `done` / `pending` の単位 ID を渡すと拒否されること
- Y3 `check_units` と `recheck_units` の ID を混ぜて渡せること（正常系）
- Y4 複数 ID のうち 1 件が不正なら、正しい ID の単位も含めて 1 つも変わらないこと
- Y5 `unitIds: []`（空配列）が拒否されること。省略時は `failed` の単位が全件戻ること

### トランザクションと採番（T の追加分）

- T8 `attempts` が実行をまたいで累積すること（決定 41）。2 要求で失敗した単位を個別再試行し、
  1 要求で成功したら 3 になること
- T9 起動時照合が実行ごとに 1 トランザクションであること（決定 40）。実行状態の更新で例外を
  起こすと、`pending` に戻したはずの単位も `running` のまま残ること

### 想定外の例外（X）

- X1 保存中に `PersistBoundaryError` が出たとき、実行が `stopped`（`internal-error`）になり、
  `stop_message` に例外のメッセージ（原稿の断片を含む）が入らないこと（決定 33）
- X2 想定外の例外の後、`running` だった単位が `pending` に戻り、`resumeRun` で拾えること（決定 33）
- X3 `done` が reject しないこと（決定 24）

### 実行レコードの補完（N）

- N1 最初の `ensureLoaded` 成功で `runs.model_info` が 1 度だけ書かれること（決定 30）
- N2 再開が `stop_requested_at`・`generation_unconfirmed`・`finished_at`・`stop_reason`・
  `stop_message` を同じ更新で消すこと（決定 36）
- N3 走査順が `target_index` 昇順・`runs.perspectives` の順であること。`target_id` の
  UUID 順に依存していないこと（対象 ID を昇順・降順に作り分けて同じ順序になることを確認。決定 25）

### 通知と設定（C）

- C1 `onEvent` が例外を投げても実行が止まらず、以降のイベントも通知されること（決定 42）
- C2 `target-planned` が開始トランザクションのコミット後に出ること
  （開始が失敗した場合は 1 件も出ないこと）
- C3 `parseRecoveryConfirmMs`：未設定で 120000、`"0"` を許可、負値・非整数・
  `Number.isSafeInteger` 超過・2,147,483,647 超過を拒否すること（決定 43）
- C4 `checkMs + recoveryConfirmMs` が 2^31−1 を超える設定で `startRun` すると、生成要求を
  1 件も送らずに `stopped`（`settings`）になること。`recheckMs` 側も同じ。`checkMs` が 0・負値・
  非整数でも同じこと（決定 44）

### 非退行（E、再掲）

- E1 `pipeline.test.ts` と `packages/cli` のテストを変更せずに緑であること

## 実装タスク

いずれも Subagent Driven で実行し、各タスクの終わりに `pnpm check` を通す。
PR9 計画書の決定番号は本書と共通（決定 1〜23 は PR9 計画書、24〜44 は本書）。

### Task 1：停止理由の追加とイベント型

**Files**
- Modify: `packages/server/src/run/result.ts`（`StopReason` に `internal-error`・`recovery-blocked`）
- Modify: `packages/server/src/db/records.ts`（`RunStopReason` に同じ 2 つ）
- Modify: `packages/server/src/db/schema.ts`（`RUN_STOP_REASONS` に同じ 2 つ）
- Modify: `packages/server/src/run/events.ts`（`OrchestratorEvent`・`RunEvent`。決定 37）
- Modify: `packages/server/src/run/state.test.ts`（決定 23 の表 9 行目の型アサーションを外す）
- Test: `packages/server/src/run/events.test.ts`（新規）、`packages/server/src/db/schema.test.ts`

**Interfaces（後続タスクが使う）**：決定 37 の `OrchestratorEvent` / `RunEvent`。

**手順**
1. 3 か所に `internal-error`（決定 14）と `recovery-blocked`（決定 39）を足す。
   `state.test.ts` の `"internal-error" as StopReason` を `"internal-error"` に戻す
   （PR9a の持ち越し）。決定 23 の写像表に `recovery-blocked` → `stopped` の行を足し、
   `state.test.ts` の S6 を 10 行にする。
2. `pnpm --filter @shuten/server db:generate` を実行し、**差分が出ないこと**を確認する
   （drizzle の `text({ enum })` は CHECK を生成しないため。決定 33）。差分が出たらコミットに含める。
3. `OrchestratorEvent` と `RunEvent` を足す。`PipelineEvent` は**変えない**。
4. `packages/cli` を変更せずに `pnpm check` が通ることを確認する（E1）。

**完了条件**：`pnpm check` が緑。`packages/cli` と `pipeline.test.ts` に差分が無い。

### Task 2：遅延通知の起点を送信時点にする（決定 27）

**Files**
- Modify: `packages/server/src/run/executor.ts`（`execute` に `hooks?: ExecuteHooks`）
- Modify: `packages/server/src/run/units.ts`（`executeWithSlowNotice` の起点）
- Test: `packages/server/src/run/executor.test.ts`、`packages/server/src/run/units.test.ts`（G1〜G3）

**Interfaces**：決定 27 の `ExecuteHooks`（`onSend` / `onSettled`）。`Executor.execute` の
第 4 引数は任意。`CheckUnitArgs` / `RecheckUnitArgs` に任意の `onSend` / `onSettled` を足し、
`executeWithSlowNotice` が自分のタイマーと合成して executor に渡す。

**手順**
1. `executor.ts`：自動再試行の条件に `!isAborted(signal)` を足し、中断されていたら再試行せずに
   `halt ??= { reason: "aborted", ..., generationUnconfirmed: false }` を立てて返す（決定 27）。
   届いた応答の `failure`（`malformed` など）は捨てない。
2. `executor.ts`：`runOne` の `client.chat` 呼び出しの直前で `hooks?.onSend?.()`、その
   `finally` で `hooks?.onSettled?.()` を呼ぶ。成功・失敗・例外のいずれでも `onSettled` を
   必ず呼び、`onSend` と同数にする。再試行のたびに 1 往復（1 回の `execute` で最大 2 往復）。
   `ensureLoaded` の周りでは呼ばない。
3. `units.ts`：`executeWithSlowNotice` は `onSend` の中でタイマーを張り直し
   （前のタイマーを `clearTimeout` してから `setTimeout(onSlow, budgetMs)`）、`onSettled` で解除する。
   引数で受け取った `onSend` / `onSettled`（ループが渡す停止ゲート）も同じ場所で呼ぶ。
   `recoveryConfirmMs <= 0` の早期 return はそのまま残す。
4. G1：キューに先行ジョブを積み、`checkMs` を超えるまで待たせてから送信させ、`onSlow` が
   呼ばれないことを fake timers で確認する。
5. G2・G3 と、「`onSend` と `onSettled` が同数で、例外時にも `onSettled` が呼ばれること」、
   「signal が中断されていたら再試行を送らないこと」を書く。
6. `pipeline.test.ts` と `packages/cli` を**変更せず**に `pnpm check`（E1）。

**完了条件**：G1〜G3 が緑。E1 が緑。

### Task 3：停止ゲートと復旧ゲート（決定 26・39）

**Files**
- Create: `packages/server/src/run/recovery.ts`（停止ゲート）
- Create: `packages/server/src/run/recovery-gate.ts`（プロセス全体の送信ゲート）
- Modify: `packages/server/src/run/executor.ts`（`options.recoveryGate`）
- Test: `packages/server/src/run/recovery.test.ts`、`packages/server/src/run/recovery-gate.test.ts`、
  `packages/server/src/run/executor.test.ts`

**Interfaces（後続タスクが使う）**：決定 26 の `StopGate` / `createStopGate`、
決定 39 の `RecoveryGate` / `createRecoveryGate`。

**手順**
1. `createStopGate(recoveryConfirmMs)` を書く。内部に `AbortController` を 1 つ持つ。
2. テスト（fake timers）：
   - 実行中の要求が無いときの `requestStop()` が**ただちに** abort すること
   - `beginRequest()` 中の `requestStop()` が abort を予約し、`recoveryConfirmMs` 未満では
     abort しないこと
   - `endRequest()` が予約を解除し、その後 `recoveryConfirmMs` を過ぎても abort しないこと
   - **`stopRequested` が立っているときの `endRequest()` はその場で abort すること**（決定 26）
   - `recoveryConfirmMs` 経過で abort すること
   - `requestStop()` が冪等であること（2 回呼んでもタイマーが 2 本にならない）
   - `dispose()` がタイマーを解除すること
3. `createRecoveryGate()`（決定 39）：`block` / `unblock` / `blockedRunIds` / `blocked`。
   同じ ID の二重 `block` と、`block` していない ID の `unblock` が無害であること。
4. `createExecutor` に `options.recoveryGate` を足す。`runOne` の先頭（`halt` 検査と同じ場所）で
   `gate.blocked` が真なら、`ensureLoaded` も `chat` も呼ばずに
   `halt: { reason: "recovery-blocked", generationUnconfirmed: false }` を返す。
   executor のテストで「ゲートが閉じているとき `client` が 1 度も呼ばれないこと」を確認する。
   `recoveryGate` を渡さない経路（`runPipeline` / CLI）の挙動は変えない（E1）。
5. `createExecutor` に `options.onRecoveryRequired` を足し、**`generationUnconfirmed: true` の
   `halt` を返す直前に同期的に**呼ぶ（決定 39）。executor のテストで
   「`ExecOutcome` を返す Promise が解決する前に呼ばれていること」を確認する
   （`onRecoveryRequired` の中で記録した順序と、`execute` の `await` 後の順序を比べる）。

**完了条件**：停止ゲートの 7 件と復旧ゲートのテストが緑。`pnpm check` が緑。E1 が緑。

### Task 4：リポジトリの追加と遷移ラッパー（決定 29・30・36・38）

**Files**
- Create: `packages/server/src/run/transitions.ts`
- Modify: `packages/server/src/db/repositories/runs.ts`（`setStopRequestedAt`、`claimRun` の
  `options.clearStopState`、`updateRunModelInfo`）
- Modify: `packages/server/src/db/repositories/findings.ts`（`listFindingsForTarget`、
  `listCandidateSourcesForFinding`）
- Modify: `packages/server/src/run/persist.ts`（`mergedFindingFromRecords`）
- Test: `packages/server/src/run/transitions.test.ts`（W1・W2）、既存のリポジトリテストに追記（N1・N2）

**Interfaces（後続タスクが使う）**：決定 29 の `*Checked` 6 関数、決定 36 の `setStopRequestedAt`、
決定 30 の `updateRunModelInfo`、決定 38 の 3 関数。

**手順**
1. `claimRun` に `options?: { readonly clearStopState?: boolean }` を足す。true のとき、決定 36 の
   5 列を**同じ 1 文の UPDATE** で null / false にする。既存の呼び出し（オプション無し）の
   挙動は変えない。
2. `setStopRequestedAt(db, id, at)`（`runs.status` は触らない）、`updateRunModelInfo(db, id, info)`
   （`model_info` が null の行だけ更新する条件付き UPDATE）、
   `listRunsByStatus(db, statuses: readonly RunStatus[]): RunRecord[]`
   （起動時照合が `running` を、ゲートの復元が `recovery-waiting` を読む。決定 39・40）を足す。
3. `listFindingsForTarget`（`listFindings` と同じ ORDER BY を `target_id` で絞ったもの）、
   `listCandidateSourcesForFinding`（`candidates` × `check_units` の join、`candidate_index` 昇順）。
4. `mergedFindingFromRecords`：`finding.locateStatus !== "located"` または `range === null` なら例外。
5. `transitions.ts`：6 関数。表にない遷移で `InvalidTransitionError`、DB を触らないこと（W1）。
6. N1・N2 のリポジトリ側テスト（`updateRunModelInfo` が 2 度目に上書きしない、
   `clearStopState` が 5 列を消す）。

**完了条件**：W1・W2 と追記したリポジトリテストが緑。`pnpm check` が緑。

### Task 5：保存トランザクション `run/save.ts`（決定 15・22・28）

**Files**
- Create: `packages/server/src/run/save.ts`
- Test: `packages/server/src/run/save.test.ts`（T1〜T8、P1〜P5 の DB 側、決定 11 の優先順位）

**Interfaces（後続タスクが使う）**：決定 28 の `saveCheckUnitOutcome` / `saveRecheckOutcome`。

**手順**
1. 決定 28 の 5 段階を 1 つの `db.transaction` に書く。状態更新は `finishCheckUnitChecked`
   （Task 4）を使い、リポジトリを直接呼ばない（W3）。
2. 位置特定失敗の候補は `assertUnlocatedFindingBoundary` を通してから `saveUnlocatedCandidate`
   （PR9a の持ち越しの配線）。続けて `not-applicable` の再確認単位を作る（決定 11）。
3. T1：`findings` の挿入直後に例外を起こす注入口をテストから与え（保存対象の候補を意図的に
   壊す）、`candidates`・`diagnostics`・`findings`・`judgments`・`recheck_units` のどれにも行が
   残らず、`check_units` が `running` のままであることを確認する。
4. T3：`finishCheckUnit` が 0 行を返す状況（先に別経路で `done` にしておく）を作り、
   `rolledBack: true` が返り、候補が 1 行も残らないことを確認する。
5. `attempts` は `unit.attempts + outcome.unit.attempts` を渡す（決定 41）。T8 を書く。
6. T4〜T7（`candidate_index` の 4 件）を書く。
7. P1〜P5 は PR9a の `persist.test.ts` が関数単体で持っている。ここでは
   「境界違反の候補を渡すと `PersistBoundaryError` が出て DB に 1 行も残らない」ことを 1 件足す。

**完了条件**：T1〜T8 が緑。`pnpm check` が緑。

### Task 6：`startRun`（決定 12・18・24）

**Files**
- Create: `packages/server/src/run/orchestrator.ts`（`createOrchestrator` と `startRun` まで）
- Test: `packages/server/src/run/orchestrator.start.test.ts`（O10・O13・O15・O16）

**Interfaces（後続タスクが使う）**：決定 24 の `OrchestratorDeps` / `Orchestrator` / `StartRunResult`、
`StartRunInput`（`startOperationId`・`manuscriptVersionId`・`modelId`・`generation`・`chunkSettings`・
`timeouts`・`perspectives`・`recheckEnabled`・`allowedWordsRaw`）。

**手順**
1. `startRun` は 1 トランザクションで `runs` → `run_targets` → `check_units` を書く（決定 18）。
   `planTargets` と `buildCheckInput` は開始時に計算する。
2. `emit(runId, event)`（決定 42）を作り、`onEvent` の例外をここだけで握る。
   `target-planned` は**開始トランザクションのコミット後**に対象ごとに出す（C1・C2）。
3. `startOperationId` の UNIQUE 違反（`SQLITE_CONSTRAINT_UNIQUE` かつ `start_operation_id`）
   だけを捕まえ、`findRunByStartOperationId` で既存の実行を返す。ほかの制約違反は再送出（O10）。
   レジストリに走っているループがあれば、その `done` を返す（決定 24）。
4. 決定 44 のタイムアウト検証を `validateChunkSettings` と同じ位置で行い、違反したら
   `runs` だけを `stopped`（`settings`）で作って返す（C4）。
5. `InputTooLongError` → 当該対象の単位を `failed`（`input-too-long`）で作り、実行を
   `stopped`（`settings`）にして返す（O16）。`InvalidChunkSettingsError` → `runs` だけを
   `stopped`（`settings`）で作る。どちらもループを始めない。
6. `manuscriptVersionId` が存在しない → 実行を作らずに例外（呼び出し側の誤り。PR10 が 404 にする）。
7. O13：完了済み実行があっても新しい `startOperationId` で別の実行 ID になり、
   `findings` / `candidates` が混ざらないこと。
8. O15：開始の途中で落ちても「実行はあるが検査単位が 0 件」の行が残らないこと
   （`insertCheckUnit` を失敗させ、`runs` も `run_targets` も残らないことを確認）。
9. **本タスクの `done` は仮実装**：ループは Task 7 で作るので、ここでは開始直後の `RunRecord` を
   そのまま解決する Promise を返す。ループを本タスクで書き始めない。

**完了条件**：O10・O13・O15・O16・C1・C2・C4 が緑。`pnpm check` が緑。

### Task 7：単位駆動ループと再確認の起票（決定 19・25・31・34・35）

**Files**
- Create: `packages/server/src/run/loop.ts`
- Modify: `packages/server/src/run/orchestrator.ts`（ループの起動）
- Test: `packages/server/src/run/loop.test.ts`（O1〜O3、O14、O17、R1、M1〜M3、N3）

**Interfaces（後続タスクが使う）**：`runLoop(context): Promise<RunRecord>`（`context` は DB・executor・
停止ゲート・実行の設定・イベント発火を持つ）。

**手順**
1. 決定 31 のとおり設定と本文を 1 度だけ読む。`createExecutor(client, { signal: gate.signal, queue })`。
2. 決定 25 の順で走査する。各単位：`claimUnitChecked(pending → running, { startedAt })` →
   `executeCheckUnit`（`recoveryConfirmMs`・`onSlow` と、**停止ゲートの
   `onSend: gate.beginRequest` / `onSettled: gate.endRequest`** を渡す）→ `saveCheckUnitOutcome`。
   `claim` が false なら飛ばす。**ループは `beginRequest` / `endRequest` を直接呼ばない**
   （決定 26。キュー待ちと `ensureLoaded` を「実行中の生成」に含めないため）。
3. 対象の全単位が決着したら決定 34 の起票を行い、その対象の `pending` の再確認単位を
   決定 25 の順で走らせる（`executeRecheckUnit` → `saveRecheckOutcome`）。
   再確認の入力は `checkInputFromTargetRecord`（PR9a）と `mergedFindingFromRecords`（決定 38）で組む。
4. `outcome.halt` が非 null ならループを抜け、決定 35 で終了状態を決める。
5. O17：1 観点が `pending` の間は `recheck_units` が 0 件で、決着した瞬間に作られること。
6. M1（オラクル）：1 対象ぶんの候補列に対し、`mergeCandidates` の結果とループの保存結果が
   グルーピング・`category`・`initialVerdict` で一致すること。M2・M3 も書く。
7. N3：対象 ID の UUID 順に依存していないこと（ID を昇順・降順に作り分けて同じ順序になること）。

**完了条件**：O1〜O3・O14・O17・R1・M1〜M3・N3 が緑。`pnpm check` が緑。

### Task 8：停止・再開・再試行（決定 6・21・26・32・33・36・39）

**Files**
- Modify: `packages/server/src/run/orchestrator.ts`（`stopRun` / `resumeRun` / `retryFailedUnits`）
- Modify: `packages/server/src/run/units.ts`（決定 32 の `pendingNote`）
- Test: `packages/server/src/run/orchestrator.stop.test.ts`
  （O4〜O9、O11、O18、R2〜R4b、X1〜X3、Y1〜Y5、V1・V2・V4・V5）

**手順**
1. `stopRun`：`setStopRequestedAt` → `gate.requestStop()` → `stop-requested` イベント。
   `runs.status` は `running` のまま（決定 21）。レジストリに無ければ `{ accepted: false }`。
2. `units.ts` の `pendingNote` に決定 32 の分岐を足す（`recoveryConfirmMs > 0` かつ
   `origin === "chat"` かつ `aborted`）。E1 を壊していないことを確認する。
3. `resumeRun` / `retryFailedUnits`：決定 36 の表どおりに受け付け、
   `claimRunChecked(..., { clearStopState: true })` で `running` にしてからループを起動する。
   `resumeRun` が `recovery-waiting` の実行の claim に成功したら `gate.unblock(runId)`（決定 39）。
4. `retryFailedUnits` は検査単位と再確認単位の両方を `claimUnitChecked` /
   `claimRecheckUnitChecked`（`failed → pending`）で戻す。**状態を 1 つも変える前に**、
   同じトランザクションの中で決定 36 の 4 つの検証を全 ID に対して行い、1 件でも違反したら
   `RetryTargetError` を投げて何も変えずに拒否する（Y1〜Y5）。
5. `createExecutor` に `onRecoveryRequired: () => gate.block(runId)` を渡す（決定 39）。
   ループ終了時の `gate.block` は冪等な安全網として残す。V1・V2・V4・V5 を書く。
6. 決定 33 の例外処理（`running` の単位を `pending` に戻す・定型文・`done` を reject しない）。
7. O4：停止 → 上限内に応答 → その応答が保存され、実行が `stopped`。
   R2：上限超過 → `recovery-waiting` かつ `generation_unconfirmed = true`。
   R4b：どちらの経路でも打ち切られた単位が `pending`（決定 20）で、`failure_reason` が残ること。
8. 決定 26 が「写像を自前で持たない」と言えることを固定する 3 本（R4b は単位が `pending` に
   なることしか見ていない）。停止要求が
   **キュー待ち中に届いたら、上限を待たずにただちに止まり `stopped`**
   （別の実行を先行させてキューを詰まらせる）、
   **`ensureLoaded` 中に届いても同じく `stopped`**（モックの `ensureLoaded` を遅らせる）、
   **`chat` 中に届いたときだけ上限まで待ち、超過したら `recovery-waiting`** になること。
   3 本目と 1・2 本目の違いが、`beginRequest` を executor のフックに置いた理由そのものである。
9. R3：`recovery-waiting` の実行に対して自動で後続の生成要求が送られないこと
   （モックの `chat` 呼び出し回数で確認）。
10. O5：再開で完了済み単位に生成要求を送らないこと。O6・O7：`mergeKey` の照合で指摘 ID が
   変わらない／変わること。O8：再確認だけの再開。O9：個別再試行と状態の再計算。
   O11：実行中への再開要求が二重に走らないこと。O18：`stop_requested_at` の書き込みと消去。

**完了条件**：O4〜O9・O11・O18・R2〜R4b・X1〜X3・Y1〜Y5・V1・V2・V4・V5 が緑。E1 が緑。
`pnpm check` が緑。

### Task 9：起動時照合と再起動（決定 13・39・40・43）

**Files**
- Modify: `packages/server/src/run/orchestrator.ts`（`reconcileOnStartup`）
- Modify: `packages/server/src/index.ts`（マイグレーション適用後・API 受付前に呼ぶ）
- Modify: `packages/server/src/config.ts`（`SHUTEN_RECOVERY_CONFIRM_MS`。既定 120000）
- Test: `packages/server/src/run/orchestrator.reconcile.test.ts`（R5・R6・T9・V3）、
  `packages/server/src/config.test.ts`（C3）、`packages/server/src/db/persistence.test.ts` に D1 を追記

**手順**
1. `reconcileOnStartup`：`listRunsByStatus(["running"])` を列挙し、**実行ごとに 1 トランザクション**で
   決定 40 の 3 段階（判定 → 単位を `pending` → 実行の状態）を行う。状態の書き込みは
   `transitions.ts` 経由（W3）。T9（途中で例外を起こすと両方ロールバックされること）を書く。
2. 同じ照合の中で、`recovery-waiting` にした実行と `listRunsByStatus(["recovery-waiting"])` で
   読んだ既存の実行を `gate.block(runId)` する（決定 39 のゲート復元）。V3 を書く。
3. `index.ts`：`createRequestQueue()` と `createRecoveryGate()` を 1 個ずつ作り、
   `createOrchestrator` に渡す（決定 24）。オーケストレーターの内側では作らない。
4. `config.ts`：`parseRecoveryConfirmMs`（決定 43）。`parsePort` は流用しない
   （0 を許可し、`Number.isSafeInteger` と `setTimeout` の実用上限 2,147,483,647 を検査する）。C3 を書く。
5. R5・R6 を書く。
6. D1：ファイル DB で実行を途中まで進め、ハンドルを閉じて開き直し、`reconcileOnStartup` →
   `resumeRun` で最後まで進むこと。Windows 経路は CI で確認する。

**完了条件**：R5・R6・T9・V3・C3・D1 が緑。`pnpm check` が緑。

### Task 10：仕様書の改訂とドキュメント（決定 7）

**Files**
- Modify: `docs/spec/mvp-spec.md`（`checkMs` の意味。版を上げ、15 節の改訂記録に追記）
- Modify: `packages/server/src/run/result.ts` / `packages/server/src/db/records.ts` のコメント
- Modify: `README.md`、`docs/plans/2026-09-07-mvp-roadmap.md`（PR9 の節、PR10 への持ち越し）

**手順**
1. 仕様書：オーケストレーター経路の `checkMs` は「打ち切りの上限」ではなく
   **「これを超えたら遅延として通知する閾値」**であり、実際のハード上限は
   `checkMs + recoveryConfirmMs` であることを書く。`runPipeline`（CLI）では従来どおり
   `checkMs` がハード上限であることも書く。版を v0.9 に上げ、**15 節の改訂記録に追記し、
   同じコミットに含める**（`AGENTS.md` の規約）。
2. `result.ts` / `records.ts` のコメントを同じ言い方に直す。
3. README とロードマップを更新し、受け入れ条件 3・4・5・11・14・15・16・18 の達成を記録する。

**完了条件**：`pnpm check` が緑。仕様書の版と 15 節が同じコミットに入っている。

## PR10 以降への持ち越し

- HTTP API・SSE の口（PR10）。本 PR の成果物は関数として呼べる形にとどめる。
- **`RunRecord` から接続先 URL を除いた公開 DTO への射影（PR10）。** 本 PR の `startRun` などは
  `endpointUrl` を持つ `RunRecord` をそのまま返す内部 API である（決定 24）。PR10 は HTTP 応答に
  そのまま流してはならない。
- **生成中に応答を受け取れずに接続が切れた検査単位は `failed` のまま残る。** その実行は
  `recovery-waiting`（生成終了が未確認）になるが、単位の側は `pending` にならないため、復旧には
  「再開」に加えて「失敗単位の個別再試行」の 2 段の操作が要る。単位も `pending` にするには
  `UnitFailure` に「応答を受け取ったか否か」を持たせる必要があり、決定 20（打ち切りの経路を
  停止とタイムアウトの 2 つだけとしている）の文言の改訂も要るため、本 PR では広げなかった。
- `settings` 表と接続先の UI 上書き（PR10）。
- `LmStudioClient` の `close()` / `dispose()` と graceful shutdown（PR10）。
- `listFindings` の N+1（PR12）。
- 一括エクスポート（PR13）。
- `recoveryConfirmMs = 120000` は暫定値。PR13 の実原稿評価で実測して見直す（決定 8）。
