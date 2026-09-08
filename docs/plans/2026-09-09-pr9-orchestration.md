# PR9 詳細計画：実行キューとオーケストレーション（server）

作成日：2026-09-09
対象：ロードマップ `docs/plans/2026-09-07-mvp-roadmap.md` の「PR9 server：実行キューとオーケストレーション」
仕様：`docs/spec/mvp-spec.md` v0.8 の 2 節（単一キュー）、6 節（処理順序）、6.4、7 節、8.2 節全体
前提：PR7（`server/src/run/pipeline.ts`、`run/executor.ts`）、PR8（`server/src/db/`）が main にある

**本書は 2 本の PR（PR9a：基盤／PR9b：完成したオーケストレーター）をまとめて設計する。**
分割の境界と各 PR の中身は末尾の「進め方（タスク分割と PR の分割）」にある。

## 目標

PR7 の検査パイプラインと PR8 の永続化をつなぎ、**DB を正本とした検査実行**を作る。

1. バックエンド全体で LLM 生成要求を 1 本のキューに直列化する（仕様 2 節）。
2. 検査実行の開始・停止・再開・失敗単位の再試行を、状態遷移と条件付き更新で安全に行う（仕様 8.2）。
3. 各単位の結果を、生成要求の完了ごとに DB へ書く。バックエンドが落ちても完了分が残り、再起動後に未完了分から再開できる。
4. 生成終了を確認できない場合に「復旧待ち」とし、自動で後続生成を送らない（仕様 8.2、受け入れ条件 18）。

## 対象外（MUST NOT）

- HTTP API・SSE エンドポイントは作らない（PR10）。本 PR の成果物は関数として呼べる形にとどめる。
- 画面は作らない（PR11・PR12）。
- 一括エクスポート形式は決めない（PR13）。
- `settings` 表（UI からの接続先上書き）は作らない（PR10 の持ち越し）。
- 仕様書 13 節の未決事項（モデル、思考の有無、既定の生成設定）をここで確定しない。
- 本文を書き換えない。採否（`judgments`）を実行側から更新しない（仕様 5.4）。
- 位置特定・統合・抑制の**規則**を変えない。PR3・PR4 の関数をそのまま使う。

## 全体の制約（ロードマップの「全体の制約」から本 PR に効くもの）

- LLM 生成要求はバックエンド全体で単一キュー、同時実行数 1。
- 未ロードのモデルに生成要求を送らない。各要求の直前に `ensureLoaded`。
- `AbortController` は通信の中断であり生成終了の確認ではない。確認できなければ「復旧待ち」。時間経過を終了の証拠にしない。
- `finish_reason == "length"`、形式不正、接続失敗を正常な空配列に置き換えない。
- SSE は通知手段で状態の正本は DB。**DB トランザクションに LLM 応答待ちを含めない**。
- API キーと接続先 URL をログ・履歴・出力に含めない。
- 相対 import は `.ts` 拡張子付き。`enum` を使わない（`erasableSyntaxOnly`）。

## 作るもの

| ファイル | 役割 |
| --- | --- |
| `server/src/run/queue.ts` | プロセス全体で 1 本の FIFO キュー。`createRequestQueue()` |
| `server/src/run/units.ts` | 「1 検査単位」「1 再確認単位」の実行プリミティブ。`runPipeline` とオーケストレーターが共用 |
| `server/src/run/state.ts` | 実行・単位の許容状態遷移表と検査関数 |
| `server/src/run/persist.ts` | パイプラインの値 → DB レコードの変換と境界検証（PR8 必須事項 3） |
| `server/src/run/merge-store.ts` | 保存済み指摘への増分マージ（`mergeKey` 照合、集約の再計算） |
| `server/src/run/recovery.ts` | 生成終了の確認と上限付き待機 |
| `server/src/run/orchestrator.ts` | 開始・停止・再開・再試行・起動時照合。単位駆動ループの本体 |
| `server/src/run/events.ts`（追記） | `target-planned` と実行 ID を持つ `RunEvent` |
| `server/src/db/repositories/*.ts`（改修） | `claim*` の `started_at`、`finish*` の条件付き更新、集約更新、開始操作 ID での検索 |
| `server/src/config.ts`（追記） | 復旧確認の待機上限 |
| `server/src/index.ts`（追記） | 起動時照合の呼び出し |

## 設計

### 決定 1：オーケストレーターが単位駆動ループを持ち、`runPipeline` は CLI 用に残す

PR7 の `runPipeline` を「保存済みの検査対象を渡し、完了済み単位を飛ばせるように拡張する」案は採らない。理由は 3 つ。

1. **マージ戦略が初回と再開で違う。** 初回は `mergeCandidates` で対象内の候補をまとめる。再開・再試行では、
   すでに保存されている指摘に `mergeKey` で照合する必要がある（ロードマップの規則）。指摘 ID は
   `judgments.finding_id` の参照先なので、統合をやり直して ID を振り直すことはできない。
2. **再開には「新しい候補を伴わない仕事」がある。** 前回のセッションで作られ、再確認が `pending` のまま
   残っている指摘は、検査単位を 1 つも実行せずに再確認だけを進める。単位駆動でなければ表現しにくい。
3. **CLI（`packages/cli`）が DB 由来の入力を持つことになる。** `runPipeline` の引数に保存済みの検査対象や
   完了済み単位が入ると、DB を使わない評価経路がその分だけ複雑になる。

代わりに、**「1 単位を実行する」部分を `run/units.ts` に抽出**し、`runPipeline`（CLI・評価用）と
`orchestrator.ts`（DB 経路）の両方がそれを呼ぶ。ロードマップの「PR7 のパイプラインを PR9 が共用する」は
この形で満たす。

```ts
// run/units.ts
export interface CheckUnitArgs {
  readonly text: string;
  readonly paragraphs: readonly Paragraph[];
  readonly input: CheckInput;
  readonly perspective: Perspective;
  readonly allowedWords: readonly string[];
  readonly generation: GenerationSettings;
  readonly timeoutMs: number;
  readonly executor: Executor;
  readonly createCandidateId: () => string;
}
/** 生成要求 → 解析 → 位置確定まで。DB も結果 JSON も知らない。 */
export function executeCheckUnit(args: CheckUnitArgs): Promise<CheckUnitOutcome>;

export interface CheckUnitOutcome {
  readonly unit: CheckUnitResult;          // PR7 の型をそのまま返す
  readonly candidates: readonly Candidate[]; // done のときだけ非空になりうる
  readonly failure: UnitFailure | null;     // unit.status が pending でも非 null になりうる（決定 20）
  readonly halt: RunStop | null;            // 非 null なら実行全体を止める
}

export function executeRecheckUnit(args: RecheckUnitArgs): Promise<RecheckUnitOutcome>;
```

**検証条件**：この抽出は挙動を変えない。`packages/server/src/run/pipeline.test.ts`（1,051 行）と
`packages/cli` のテストを**一切変更せずに**緑のままにすることを、抽出タスクの完了条件にする。

### 決定 2：単一キューはプロセス内 FIFO。1 ジョブ = ensureLoaded + chat + parse + 再試行

```ts
// run/queue.ts
export interface RequestQueue {
  /** 前のジョブが終わってから実行する。例外は呼び出し元に返し、後続は止めない。 */
  enqueue<T>(job: () => Promise<T>): Promise<T>;
  /** 実行中・待機中のジョブ数（表示・テスト用）。 */
  readonly size: number;
}
export function createRequestQueue(): RequestQueue;
```

- `createExecutor` に任意オプション `queue` を足す。渡されたら `runOne`（ensureLoaded → chat → parse →
  再試行 1 回）の**全体を 1 ジョブとして**投入する。`ensureLoaded` と `chat` の間に別の実行の要求が
  割り込むと「未ロードのモデルに送らない」の保証が崩れるため、ジョブの粒度を要求 1 件にはしない。
- `runPipeline`（CLI）はキューを渡さない。実行が 1 本しかないので executor 内の直列化で足りる。
- PR10 の接続確認（小さな生成）も同じキューを通す前提を書き残す。
- 別モデルの実行が交互に来ると `ensureLoaded` が往復するが、初期版は単一モデル（仕様 2 節）なので対象外。

### 決定 3：状態遷移表を `run/state.ts` に置き、遷移はすべて条件付き更新で行う

実行（`RunStatus`）：

| From | To | 契機 |
| --- | --- | --- |
| （新規） | `running` | 開始 |
| `running` | `completed` / `partially-failed` | 全単位が決着 |
| `running` | `stopped` | 停止操作、設定エラー、接続喪失、未ロード |
| `running` | `recovery-waiting` | 生成終了を確認できないまま打ち切った |
| `stopped` | `running` | 再開 |
| `recovery-waiting` | `running` | 手動再開 |
| `partially-failed` | `running` | 失敗単位の個別再試行 |
| `stopped` | `running` | 失敗単位の個別再試行（停止した実行にも失敗単位がありうる） |

上記以外は拒否する。特に `stopped` → `completed` の直行（停止後に遅れて届いた完了報告）を許さない。
`completed` → `running` は入れない（失敗単位が 1 つもないから `completed` なので、再試行の対象がない）。

単位（`UnitStatus`）：

| From | To |
| --- | --- |
| `pending` | `running` / `not-applicable` |
| `running` | `done` / `failed` / `pending`（送らずに戻す） |
| `failed` | `pending`（個別再試行） |
| `done` / `not-applicable` | （終端。再試行でも戻さない） |

`state.ts` は `canTransitionRun(from, to): boolean` と `canTransitionUnit(from, to): boolean` を公開し、
遷移を書く経路はすべてこれを通す。**状態を書くのはオーケストレーターだけ**とし、停止要求は
`AbortController` と停止フラグを立てるだけにする（状態の書き手を 1 つにするのが第一の防御で、
決定 5 の条件付き更新はその裏打ち）。

### 決定 4：`claim*` が `started_at` を同じ UPDATE で設定する（PR8 必須事項 1）

```ts
export function claimUnit(
  db: AppDatabase, id: string, from: UnitStatus, to: UnitStatus,
  options?: { readonly startedAt?: Date },
): boolean;
```

`started_at` は状態の変更と**同じ 1 文の UPDATE** に含める（2 文に分けると、その間にプロセスが落ちた場合に
`running` で `started_at` が null の行が残る）。`claimRecheckUnit` も同じ。
`runs.started_at` は `insertRun` で確定するので `claimRun` では触らない（再開で開始日時を上書きしない）。

### 決定 5：`finish*` を条件付き更新にする（PR8 必須事項 2）

```ts
export function finishCheckUnit(
  db: AppDatabase, id: string, input: FinishCheckUnitInput & { readonly expectedStatus: UnitStatus },
): boolean;   // 0 行更新なら false
```

`WHERE id = ? AND status = ?` にし、更新行数を返す。呼び出し側（オーケストレーター）は false を
「停止などで先に決着していた」として扱い、**上書きしない**。`finishRecheckUnit`・`finishRun` も同じ。
PR8 のリポジトリテストは戻り値と引数が変わるので、同じタスクで更新する。

### 決定 6：停止操作は「新規送信を止め、実行中の 1 要求は上限まで自然な完了を待つ」（解釈点）

仕様 8.2 は「停止操作では新しい要求の送信を止める。実行中の要求を即時中断できない場合は、その状況を
表示する」と書いており、即時中断を要求していない。また接続の切断はキャンセル要求として扱えるだけで、
生成終了の証拠にはならない。そこで停止は次の順で行う。

1. 新規の生成要求の送信を止める（キューへの投入をやめ、以降の単位は `pending` のまま残す）。
2. 実行中の 1 要求は abort せず、`recoveryConfirmMs` まで応答を待つ。この間の実行状態は `running` のまま、
   イベントで「停止操作を受け付け、実行中の要求の終了を待っている」ことを通知する。
3. 上限内に応答が届いた → 生成終了を確認できたので実行を `stopped`（`generation_unconfirmed = false`）。
   届いた応答は捨てずに当該単位の結果として保存する（決定 7）。
4. 上限を超えた → abort し、実行を `recovery-waiting`（`generation_unconfirmed = true`）。

**代案（採らない）**：停止で即 abort し、常に `recovery-waiting` にする。仕様には反しないが、通常の停止が
毎回「復旧待ち」になり手動再開を強いる。PR 本文に解釈点として記載する。

### 決定 7：タイムアウトの上限付き待機（`run/recovery.ts`）

現在の PR7 は `checkMs` で abort し、`timeout` を必ず `recovery-needed` の停止にしている。これを変える。

- `chat` に渡すハード上限を `checkMs + recoveryConfirmMs` にする。abort はこの上限でだけ行う。
- `checkMs` を超えた時点でイベント `generation-slow`（実行 ID、単位 ID、経過ミリ秒）を出す。実行は待ち続ける。
- 上限前に応答が届いたら、**通常どおり結果として採用する**（成功なら `done`、`length` や形式不正なら
  従来どおりの失敗分類）。単一キューではこの間ほかに進められる仕事がなく、届いた完全な応答を捨てる理由がない。
  `checkMs` を超えたことは `elapsed_ms` と `runs.timeouts.checkMs` の比較で後から分かる。
- 上限を超えたら abort し、実行を `recovery-waiting`（`generation_unconfirmed = true`）にする。
  自動で後続を送らない。**当該単位の処理状態は `pending`**（決定 20）だが、
  `failure_reason: "timeout"`・`attempts`・`elapsed_ms`・`failure_message` もあわせて保存する。
  処理状態（次に何をするか）と直前の失敗理由（何が起きたか）は別の情報で、`check_units` では
  別々の列なので同時に持てる。

**待つのは「応答が届いたこと」であって時間ではない**ので、「時間経過を終了の証拠とみなさない」に反しない。

**`checkMs` の意味を改める。** オーケストレーター経路では `timeouts.checkMs` は打ち切りの上限ではなく
「これを超えたら遅延として通知する閾値」になり、実際のハード上限は `checkMs + recoveryConfirmMs` になる。
JSON のキー名（`runs.timeouts.checkMs`）は変えない（既存行の検証を壊さないため）が、
`run/result.ts` と `db/records.ts` のコメント、README、仕様の該当箇所での説明を「遅延通知の閾値」に改める。

**仕様書の改訂は挙動が変わる PR9b で行う**（版を上げ、15 節の改訂記録に追記し、同じコミットに含める。
`AGENTS.md` の規約）。PR9a は列を足すだけで、`recovery_confirm_ms = 0`（＝従来どおり `checkMs` が
ハード上限）のままなので、仕様上の意味は変わらない。
`runPipeline`（CLI）では `recoveryConfirmMs = 0` なので従来どおりの打ち切り上限のままで、意味が二重になる。
その区別が保存結果から分かるように、実行ごとの `recoveryConfirmMs` を DB に残す（決定 8）。

**`runPipeline`（CLI）の挙動は変えない。** `recoveryConfirmMs` は `run/units.ts` の引数（任意、既定 0）にする。
0 のときハード上限は `checkMs` そのもので、`timeout` は従来どおり当該単位を `failed` にし
`recovery-needed` の停止を返す。上限付き待機はオーケストレーターが値を渡したときだけ働く。
これでタスク 1 の非退行条件（E1）と両立し、CLI が復旧設定を知る必要もなくなる。

**代案（採らない）**：`checkMs` で失敗を確定させ、超過後の待機は生成終了の確認だけに使い、届いた応答は捨てる。
`checkMs` の意味は明確になるが、正しい応答を捨てる。PR 本文に解釈点として記載する。

**前提の確認**：undici の `headersTimeout` / `bodyTimeout` は PR5 で 0（無効）にしてあるので
（`lmstudio/client.ts` の `createLmStudioClient` の注釈、実測 301,289ms の記録）、300 秒の天井はない。
本 PR で PR5 のクライアントを変える必要はない。

### 決定 8：復旧確認の待機上限はサーバー設定に置く

`SHUTEN_RECOVERY_CONFIRM_MS` を `config.ts` に足す。`runs.timeouts` の JSON には入れない。
検査の設定ではなく実行環境の性質であり、既存行の JSON 検証（`runTimeoutsSchema`）を広げずに済むため。

ただし**実行時の値は `runs.recovery_confirm_ms` 列に保存する**（マイグレーション `0001`。決定 21 と同じ）。
実際のハード上限（`checkMs + recoveryConfirmMs`）を保存結果だけから復元できるようにするため。
既定値 **120000（2 分）は暫定値**とする。仕様書 13 節の未決値（タイムアウト）と同じ性質で、
PR13 の実原稿評価で実測して見直す。ロードマップの「ユーザーに依存する入力」に準じる扱いで、
数値の確定は本 PR では行わない。

### 決定 9：統合は「保存済み指摘への `mergeKey` 照合」に一本化する

オーケストレーターは `mergeCandidates` を呼ばない。初回実行でも再開でも、位置確定済み候補 1 件ごとに
次を行う（同一実行内・同一検査対象内に限る。仕様 6.4）。

1. `mergeKey(candidate)` が null（修正案なし）→ 常に新しい指摘を作る。
2. 非 null → 同じ `run_id` の `findings` を `merge_key` で引く（PR8 の部分一意索引 `(run_id, merge_key)` が索引になる）。
   - 見つかった → `attachCandidateToFinding` し、**集約を再計算**する。
   - 見つからない → `insertFinding`（`judgments` の `undecided` 行も同一トランザクションで作る）。

集約の再計算は `mergeCandidates` と同じ規則にする（`category` は元候補が一致すればその値、
不一致なら `unclear`。`initialVerdict` は全候補が `likely-error` のときだけ `likely-error`）。
PR8 の `attachCandidateToFinding` は `finding_id` しか更新しないので、リポジトリに
`updateFindingAggregate(db, findingId, { category, initialVerdict })` を足す。

**オラクルテスト**：1 検査対象ぶんの候補列を (a) `mergeCandidates` で一括処理、(b) 増分照合で 1 件ずつ処理し、
グルーピング・`category`・`initialVerdict` が一致することを確認する。これが「1 本の実装で初回と再開の
両方をまかなう」ことの担保になる。

### 決定 10：再確認が終わった後に元候補が増えても、再確認はやり直さない

失敗観点の再試行で新しい候補が既存の指摘に付き、集約（`category` / `initialVerdict`）が変わっても、
`done` の再確認単位は再実行しない（仕様 8.2「完了済み処理は通常の再開で繰り返さない」）。
再確認の入力と結果は保存済みのものを保持する。表示でどう見せるか（「再確認後に元候補が増えた」の注記）は PR12。

### 決定 11：位置特定失敗の指摘にも `recheck_units` を作る（PR8 持ち越し）

`saveUnlocatedCandidate` が `not-found` / `ambiguous` で指摘を作ったら、続けて
`insertRecheckUnit({ status: "not-applicable", notApplicableReason, ... })` を書く。
両者は**同じ外側のトランザクション**（決定 15 の検査単位トランザクション）の中で行う。
`saveUnlocatedCandidate` は内部で自分の `db.transaction` を開くが、これは SAVEPOINT として正しく動くことを
PR8 で確認済みなので、外側から包んでよい。理由の優先順位は次のとおり。

1. 実行の `recheck_enabled` が false → `disabled`
2. 位置特定失敗 → `unlocated`
3. 許容語で抑制 → `suppressed`

再確認単位を必ず作ることで、「指摘 1 件に再確認単位 1 件」が実行内で常に成り立ち、一覧・集計が分岐せずに済む。

### 決定 12：二重送信の防止は要求の同一性で行う（仕様 8.2）

- **開始**：`startRun({ startOperationId, ... })`。`runs.start_operation_id` の一意制約で 2 回目は
  UNIQUE 違反になるので、これ（`SQLITE_CONSTRAINT_UNIQUE` かつ `start_operation_id` のもの）だけを捕まえて
  既存の実行を返す（冪等）。ほかの制約違反は握りつぶさずに送出する。リポジトリに
  `findRunByStartOperationId(db, opId)` を足す。原稿版・設定の一致は判定に使わない。
- **再開**：`claimRun(id, from, "running")` が false なら「すでに実行中」または「再開できない状態」。
  例外にせず、現在の実行状態を返す。
- 同じ単位を 2 つの経路が同時に取ることは `claimUnit` の条件付き更新で防ぐ。

### 決定 13：起動時照合（`reconcileOnStartup`）

サーバー起動時、マイグレーション適用後・API 受付前に次を行う。プロセスが落ちた時点で LM Studio 側の生成が
走っていた可能性を否定できないため、**自動では再開しない**。

- `running` の検査単位・再確認単位 → `pending`（条件付き）。`pending_note` に
  「バックエンドが終了したため未完了のまま残った」を記録する。
- `running` の単位を持っていた実行 → `recovery-waiting`、`generation_unconfirmed = true`、
  `stop_message` に「バックエンドが終了しました。LM Studio 側を確認して再開してください」。
- `running` の単位を 1 つも持たない `running` の実行 → `stopped`（`generation_unconfirmed = false`、
  `stop_message` は「バックエンドが終了しました」）。単位と単位の間で落ちており、生成は走っていない。
  復旧待ちにすると、確認する必要のないものをユーザーに確認させることになる。

`index.ts` から `reconcileOnStartup(db)` を呼ぶ。PR8 のテスト D2（再オープン）が「行が残ること」を
確認したのに対し、本 PR は「残った行をどう扱うか」を確認する。

### 決定 14：想定外の例外で実行を `running` のまま残さない

オーケストレーターの最上位で `LmStudioError` でも `InputTooLongError` でもない例外を捕まえ、
実行を終端状態に落としてから再送出（または呼び出し元へ返す）。停止理由には `internal-error` を足す。

- `StopReason`（`run/result.ts`）と `RunStopReason`（`db/records.ts`）の両方に足す。
- SQLite 側に CHECK 制約はない（`drizzle/0000_steep_prodigy.sql` に `CHECK` は 0 件、`stop_reason` は
  ただの `text`）ので、実 DB のマイグレーションは不要な見込み。ただし
  `pnpm --filter @shuten/server db:generate` を実行して差分が出ないことを確認し、出たらそのままコミットする
  （`docs/reference/conventions.md` の規約）。
- `StopReason` を網羅的に分岐している箇所（`_exhaustive: never`）は現時点でない（`executor.ts` の
  網羅分岐は `FailureReason` に対するもの、`packages/cli` は値を表示するだけ）ので、追加でコンパイルが
  壊れる箇所はない見込み。追加後に `pnpm typecheck` で確認する。
- 例外のメッセージをそのまま `stop_message` に入れない（接続先 URL・API キーが混ざる可能性がある）。
  定型文を入れ、詳細はサーバーのログにも出さない方針を PR10 まで維持する。

**代案（採らない）**：既存の `aborted` に寄せる。列挙を増やさずに済むが、「失敗を別の値に置き換えない」に反する。

### 決定 15：永続化は `onEvent` に載せず、1 単位ぶんを 1 トランザクションで書く

PR7 の `onEvent` は例外を握りつぶす（進捗通知の失敗で実行を止めないため）。永続化の失敗は握りつぶしては
ならないので、DB 書き込みをイベント経路に載せない。オーケストレーターは `await`（生成要求）から戻った**後**に
同期的に（better-sqlite3 は同期 API）書く。これで「DB トランザクションに LLM 応答待ちを含めない」が
構造的に守られる。

**1 検査単位の応答から生じる書き込みは、すべて 1 つのトランザクションにまとめる。**

1. `candidates`（この応答が生んだ候補すべて。`candidate_index` の採番を含む。決定 22）
2. `diagnostics`（位置特定失敗の候補ぶん）
3. `findings` と `judgments`（新規指摘）、既存指摘への `attachCandidateToFinding` と集約更新
4. 位置特定失敗の指摘に対する `recheck_units`（`not-applicable`。決定 11）
5. 当該 `check_units` の `running` → `done` / `failed` / `pending`（条件付き更新。決定 5）

分けてはならない理由：先に単位を `done` にしてプロセスが落ちると、再開時にその単位が飛ばされ、
LLM 応答から得た候補が永久に失われる。逆順（候補を先に書いて単位の更新前に落ちる）だと、
再開時に同じ単位を実行して候補が重複する。**両方を同時に避けられるのは 1 トランザクションだけ。**

再確認も同じ。`recheck_units` の結果保存（`verdict`・`reasonKind`・`reason`・`suggestionValid`・`usage`）と
状態の `running` → `done` / `failed` / `pending` を 1 トランザクションで行う。

条件付き更新（決定 5）が 0 行を返した場合（停止などで先に決着していた）、**トランザクション全体を
ロールバックする**。単位が別の状態に決着しているのに候補だけが残る状態を作らない。
ロールバックしたことはイベントとログに残す。

テスト：トランザクションの途中（たとえば `findings` の挿入直後）で例外を起こし、
`candidates`・`diagnostics`・`findings`・`judgments`・`recheck_units` のいずれにも行が残らず、
`check_units` の状態も `running` のままであることを確認する。

### 決定 16：進捗イベント

`run/events.ts` に足す。

```ts
/** 検査対象の分割が確定した（PR8 の持ち越し）。 */
| { readonly type: "target-planned"; readonly targetIndex: number; readonly target: Range; readonly input: Range }
/** checkMs を超えたが応答を待っている（決定 7）。 */
| { readonly type: "generation-slow"; readonly unitId: string; readonly elapsedMs: number }
/** 停止操作を受け付け、実行中の要求の終了を待っている（決定 6）。 */
| { readonly type: "stop-requested" }
/** オーケストレーターの終了。RunStatus なので recovery-waiting もありうる。 */
| { readonly type: "run-settled"; readonly status: RunStatus; readonly stop: RunStop | null }
```

`run-finished`（`PipelineRunStatus`）は `runPipeline` のものとして残し、オーケストレーターは
`run-settled` を出す。SSE（PR10）に渡すため、実行 ID を添えた `RunEvent = { runId: string; event: PipelineEvent }`
を公開する。イベントは通知手段であり、状態の正本は DB。

### 決定 17：境界の検証を `run/persist.ts` に集める（PR8 必須事項 3）

パイプライン側の値を DB レコードに変換する関数をここに集め、**保存の前に**次を検査する。
違反は `PersistBoundaryError` を投げ、1 行も書かない。

1. `mergeKey` は `locateStatus === "located"` の指摘にだけ入れてよい。`not-found` / `ambiguous` に
   非 null の `mergeKey` を渡したら例外。
2. 抑制（`suppression`）は `category === "notation"`、`suggestion !== null`、位置確定済みの 3 条件が
   そろったときだけ非 null にできる（`findSuppression` の前提を保存の直前に再検査する）。
3. 位置確定済みの `paragraphId` は、保存本文と段落表から導いた値（`range.start` を含む段落）と一致すること。
   候補の申告値をそのまま使わない（PR8 決定 15）。
4. 本文・引用・修正案に孤立サロゲートを含まないこと（PR8 決定 17 の `assertWellFormedBody` を通す）。

テストは意図的に壊した入力を渡し、**DB に 1 行も入らないこと**まで確認する。

### 決定 18：開始（`startRun`）で書くものと、その範囲

開始時に次をすべて**1 トランザクション**で書く。途中で落ちて「実行はあるが検査単位が 0 件」の行が残ると、
`listUnfinishedCheckUnits` が「やることなし」を返して復旧できなくなる。

1. `runs`（`status: "running"`、`start_operation_id`）
2. `run_targets`（`planTargets` と `buildCheckInput` の結果。分割範囲は開始時に計算して保存する）
3. `check_units`（対象 × 観点の直積を `pending` で）

分割時に `InputTooLongError`（入力が上限を超える）が出た場合は、開始を拒否せず**記録を残す**。
当該対象の単位を `failed`（`input-too-long`）で作り、実行を `stopped`（`settings`）にして返す。
仕様 7 節の「入力上限超過時に本文を黙って切り捨てない。設定変更を案内し、未完了範囲を残す」に沿う。
`InvalidChunkSettingsError`（設定そのものが不正）は対象を 1 件も作れないので、`runs` だけを
`stopped`（`settings`）で作る。

`PipelineMode` の `full-text` はオーケストレーターの対象外とする（`RunRecord` に `mode` の列はなく、
比較実験のための経路なので `packages/cli` の `runPipeline` に残す）。オーケストレーターが扱うのは
`split` と `split-recheck`（`runs.recheck_enabled` で区別）だけ。

再開時は保存済みの `RunTargetRecord` から `CheckInput` を組み立て直す（`paragraphIds`、
`contextBefore` / `contextAfter` → `ContextWindow`）。この変換は `run/persist.ts` に置き、
境界検証と同じ場所で扱う。

### 決定 19：再確認単位を作り、走らせる契機

統合が候補 1 件ごとになった（決定 9）ので、「対象の統合が終わった」という状態を別に持つ必要がある。
規則は次のとおり。

> ある検査単位が決着したあと、**同じ検査対象の検査単位に `pending` / `running` が 1 つもなければ**、
> その対象の指摘のうち再確認単位を持たないものについて `recheck_units` を作り、`pending` のものを実行する。

これで再確認の要求は、PR7 のパイプラインと同じく「その対象の全観点が終わったあとの統合結果」を見る。
候補が 1 件付いた時点で再確認を始めてしまうと、`category` が `unclear` に変わる前の指摘を再確認することになる。
再開でも同じ規則がそのまま働く（前回 `pending` だった単位が決着した時点で発火する）。
再確認単位を持つが `pending` のままの指摘（前回セッションの続き）は、対象の単位を 1 つも実行せずに走らせる（O8）。

### 決定 20：`recovery-waiting` に入るときの単位は `pending` にする

停止からの打ち切り（決定 6 の 4）と、タイムアウトからの打ち切り（決定 7）は、どちらも「生成終了を確認できない」
という同じ理由で `recovery-waiting` に入る。ところが素の挙動では前者は `aborted` → `pending`、後者は
`timeout` → `failed` になり、再開の対象が変わってしまう（`failed` は通常の再開では拾われず、
失敗単位の個別再試行が必要になる）。

**打ち切られた実行中の単位は、どちらの経路でも `pending`** とし、`pending_note` に理由を書く
（「停止操作により打ち切った。生成終了は未確認」「応答が上限内に届かなかった。生成終了は未確認」）。
仕様 8.2 が言う手動「再開」は、この単位から続けられることを意味する。

処理状態を `pending` にしても、**失敗の事実は捨てない**。`failure_reason`（`timeout` / `aborted`）・
`failure_message`・`failure_origin`・`attempts`・`elapsed_ms` を同じ更新で保存する。
`check_units` では処理状態と失敗理由が別の列なので同時に持てる（PR8 のスキーマに制約はない）。
「次に何をするか」（`status`）と「直前に何が起きたか」（`failure_*`）は別の情報で、
後者を落とすと「失敗を指摘ゼロと誤表示しない」（受け入れ条件 14）が保てない。

### 決定 21：停止要求中であることを DB に持つ

決定 6 の待機（最大 `recoveryConfirmMs`）の間、実行の状態は `running` のままになる。状態の正本は DB なので、
このままだと画面の再読み込みや `GET /api/runs/:id`（PR10）から「停止操作を受け付けたが実行中の要求の終了を
待っている」ことが見えない。仕様 8.2 の「実行中の要求を即時中断できない場合は、その状況を表示する」は
これを表示することを求めている。

`runs` に `stop_requested_at`（`integer timestamp`、null 可）を足し、停止要求を受けた時点で書く。
再開時に null に戻す。**本 PR で最初のマイグレーション追加（`0001`）**になり、`applyMigrations` が
複数のマイグレーションを順に適用する経路の実証も兼ねる。
決定 8 の `recovery_confirm_ms` も同じマイグレーションで足す（`0001` の追加列は 2 つ）。

**既存データが入った DB に適用できることを要件にする。** PR8（`0000`）だけを適用して検査実行の行を作った
DB に `0001` を当てられなければならない。

- `stop_requested_at`：nullable。既定値なし。
- `recovery_confirm_ms`：`NOT NULL DEFAULT 0` として足す。既存行は 0 になる。
  **0 は「`checkMs` がそのままハード上限」という従来の意味**に対応するので、既存行の解釈が変わらない。
  nullable で足してから制約を確定させる手も取れるが、SQLite の `ALTER TABLE ADD COLUMN` は
  `NOT NULL DEFAULT` を直接受け付けるので 1 文で足りる。
- テスト：`0000` だけを適用した DB に `runs` の行を作り、そこへ `0001` を適用できること。
  適用後にその行を読み出すと `recoveryConfirmMs: 0` になること。空の DB だけで検証すると、
  既存行がある環境での `NOT NULL` 列追加の失敗を見逃す。

**代案（採らない）**：メモリだけに持ち、PR10 で表示の必要が出たときに列を足す。マイグレーションは
増えないが、その間は「停止操作が効いているのか分からない」状態が残る。

### 決定 22：`candidate_index` の採番規則

PR8 で `candidates.candidate_index` を「実行内の生成順の正本」にし、`(run_id, candidate_index)` に
一意制約を置いた。初回・再開・個別再試行をまたいで番号を配る規則を次のように決める。

> 決定 15 の保存トランザクションの中で、`SELECT COALESCE(MAX(candidate_index), -1) + 1 FROM candidates
> WHERE run_id = ?` を取り、その応答の候補を LLM が返した順に連番で振る。

- 同じトランザクション内で読んで書くので、番号の決定と使用の間に別の書き込みが挟まらない
  （better-sqlite3 は同期 API、書き込みは単一プロセス内で直列）。
- 実行 ID ごとに独立しているので、2 つの実行が並行しても互いの番号に影響しない。
- ロールバックすれば採番ごと消える（外部カウンターを持たない理由）。
- 万一二重に採番されたら `(run_id, candidate_index)` の一意制約が検出する（PR8 決定 19 の安全網）。

リポジトリに `nextCandidateIndex(db, runId): number` を足す。テストは次の 4 つ。

- 再開後に保存された候補が、既存候補より後の番号になること
- 1 応答に複数候補があるとき、LLM の応答順に連番になること
- 保存がロールバックされたとき、中途半端な番号の候補が残らないこと
- 2 つの実行を交互に保存しても、それぞれの番号が 0 から連続すること

### 決定 23：`RunStop` から実行の終了状態への写像

規則は 1 行で書ける。**`stop.generationUnconfirmed` が true なら `recovery-waiting`、false なら `stopped`。**
既存の `RunStop` をすべて当てはめると次のとおり（`executor.ts` の `haltForChatError` /
`haltForEnsureLoadedError` が作る値の全件）。

| `stop.reason` | 発生源 | `generationUnconfirmed` | 実行の終了状態 |
| --- | --- | --- | --- |
| `settings` | 分割設定・入力上限・モデル種別 | false | `stopped` |
| `model-not-loaded` | `ensureLoaded` / 生成中のアンロード | false | `stopped` |
| `connection-lost` | HTTP 応答あり（4xx・5xx） | false | `stopped` |
| `connection-lost` | 応答を受け取れずに切断（`status` が null） | **true** | **`recovery-waiting`** |
| `connection-lost` | `ensureLoaded` の失敗（生成は送っていない） | false | `stopped` |
| `recovery-needed` | 生成のハード上限超過（決定 7） | **true** | **`recovery-waiting`** |
| `aborted` | 停止操作で上限内に応答が届いた（決定 6 の 3） | false | `stopped` |
| `aborted` | 停止操作で上限を超えた（決定 6 の 4） | **true** | **`recovery-waiting`** |
| `internal-error` | 想定外の例外（決定 14） | false | `stopped` |

テストは表の 9 行すべてを網羅する（S6）。「生成中に応答を受け取れず接続が切れた」を `stopped` にしないこと
（生成が LM Studio 側で走り続けている可能性がある）を、変異させて落ちることまで確認する。

## PR8 からの持ち越しの対応表

| 持ち越し | 本 PR での扱い |
| --- | --- |
| **必須** `claim` 時に `started_at` を設定 | 決定 4 |
| **必須** `finish*` の無条件 UPDATE | 決定 5 |
| **必須** 境界での `mergeKey`・抑制・段落 ID の検証 | 決定 17 |
| 保存済み `TargetPlan[]` を渡す口と `target-planned` イベント | 決定 1（オーケストレーターが対象を DB から読む）、決定 16 |
| 生成終了の確認と上限付き待機 | 決定 6・7・8 |
| 位置特定失敗の指摘に `recheck_units` を作る | 決定 11 |
| `listFindings` の N+1 | 本 PR では直さない（PR12 の表示要件が固まってから） |
| 入れ子トランザクションが SAVEPOINT として動く | 確認済み。外側のトランザクションから呼んでよい |
| （新規）停止要求中の可視化 | 決定 21。`runs.stop_requested_at` を足すマイグレーション `0001` |

## テスト

すべて通常テスト（`pnpm test`）で走る。LM Studio は使わず、モック `LmStudioClient` とメモリ DB
（PR8 のリポジトリテストと同じ形）を使う。

### キュー（Q）

- Q1 2 つの実行を同時に走らせ、要求が交互に並ばず投入順に直列化されること
- Q2 1 ジョブの中で `ensureLoaded` と `chat` の間に別ジョブが割り込まないこと
- Q3 ジョブが例外を投げても後続のジョブが実行されること
- Q4 `runPipeline`（キューなし）が従来どおり動くこと

### 状態遷移（S）

- S1 許容表にある遷移がすべて通ること
- S2 許容表にない遷移がすべて拒否されること（`stopped` → `completed` を含む）
- S3 `claimUnit` が `started_at` を同じ更新で設定し、条件に合わない行を変えないこと
- S4 `finishCheckUnit` / `finishRecheckUnit` / `finishRun` が `expectedStatus` に合わない行を更新せず false を返すこと
- S5 停止後に遅れて届いた完了報告が `stopped` を上書きしないこと（S4 の結合）
- S6 `RunStop` から終了状態への写像（決定 23 の表の 9 行すべて）。特に「生成中に応答を受け取れず切断」が
  `recovery-waiting` になること

### オーケストレーター（O）

- O1 初回実行：`runs`・`run_targets`・`check_units`・`candidates`・`findings`・`judgments`・`recheck_units`・
  `diagnostics` の全表に期待どおりの行が残ること
- O2 観点の一部失敗 → 成功分で統合に進み、実行は `partially-failed`
- O3 未ロード → 当該単位は `pending` のまま、実行は `stopped`（`model-not-loaded`）
- O4 停止操作 → 新規送信が止まり、実行中の要求の応答が上限内に届いて `stopped`（決定 6）
- O5 再開：完了済みの単位に生成要求を送らないこと（モックの呼び出し回数で確認）
- O6 再開後の統合：先に成功していた観点の候補が保存済み指摘に `mergeKey` で照合され、指摘 ID が変わらないこと
- O7 再開で `mergeKey` が一致しない候補は新しい指摘になること
- O8 前回セッションで `pending` のまま残った再確認だけを進める再開
- O9 失敗単位の個別再試行（`failed` → `pending` → `running` → `done`）と、実行状態の再計算
- O10 同じ `startOperationId` の 2 回目の開始が新しい実行を作らず、既存の実行を返すこと
- O11 実行中の実行への再開要求が二重に走らないこと（`claimRun` が false）
- O12 想定外の例外で実行が `running` のまま残らないこと（決定 14）。`stop_message` に接続先 URL・API キーが
  含まれないこと
- O13 完了済み実行に対する新規開始が別の実行 ID になり、結果が混ざらないこと（受け入れ条件 15）
- O14 位置特定失敗の指摘に `recheck_units`（`not-applicable`）が作られること。理由の優先順位（決定 11）
- O15 開始が 1 トランザクションで、`runs` と `run_targets` と `check_units` がそろって残ること（決定 18）
- O16 分割で `InputTooLongError` が出たとき、実行が `stopped`（`settings`）で残り、当該対象の単位が
  `failed`（`input-too-long`）で保存されること（決定 18）
- O17 再確認単位が「対象の全検査単位が決着したあと」に作られること。1 観点が `pending` の間は作られないこと（決定 19）
- O18 停止要求で `stop_requested_at` が書かれ、再開で null に戻ること（決定 21）

### トランザクションと採番（T）

- T1 1 検査単位の保存（候補・診断・指摘・判断・再確認単位・単位の状態）が 1 トランザクションであること。
  途中で例外を起こすと**どの表にも行が残らず**、`check_units` の状態も `running` のままであること（決定 15）
- T2 再確認の結果保存と `recheck_units` の状態更新が 1 トランザクションであること
- T3 条件付き更新が 0 行（停止で先に決着していた）ならトランザクション全体がロールバックされ、
  候補だけが残らないこと（決定 15）
- T4 `candidate_index`：再開後の候補が既存候補より後の番号になること（決定 22）
- T5 `candidate_index`：1 応答の複数候補が LLM の応答順に連番になること
- T6 `candidate_index`：ロールバック後に中途半端な番号の候補が残らないこと
- T7 `candidate_index`：2 つの実行を交互に保存しても、それぞれ 0 から連続すること

### 復旧（R）

- R1 `checkMs` 超過後、上限内に応答が届けば結果として採用され、実行が続くこと
- R2 上限を超えたら abort し、実行が `recovery-waiting`・`generation_unconfirmed = true` になること
- R3 `recovery-waiting` の実行に対して自動で後続の生成要求が送られないこと
- R4 `recovery-waiting` からの手動再開が、打ち切られた単位（`pending`）から続けられること（決定 20）
- R4b 停止経路・タイムアウト経路のどちらでも、打ち切られた単位が `pending` になること（決定 20）
- R5 起動時照合：`running` の実行が `recovery-waiting` に、`running` の単位が `pending` になること（決定 13）
- R6 起動時照合が `done` / `failed` / `not-applicable` の行を触らないこと

### 境界の検証（P）

- P1 `not-found` の指摘に `mergeKey` を渡すと例外。DB に 1 行も入らないこと
- P2 `category !== "notation"` の指摘に抑制を渡すと例外
- P3 修正案 null の指摘に抑制を渡すと例外
- P4 位置確定済みの `paragraphId` が本文から導いた値と食い違うと例外
- P5 孤立サロゲートを含む引用・修正案で例外

### 統合の同値（M）

- M1 オラクル：1 対象ぶんの候補列に対し、`mergeCandidates` の結果と増分照合の結果が
  グルーピング・`category`・`initialVerdict` で一致すること（決定 9）
- M2 修正案なし（`mergeKey` が null）の候補は常に別の指摘になること
- M3 異なる実行 ID の同じ `mergeKey` が混ざらないこと（仕様 6.4）

### 再起動（D）

- D1 ファイル DB で実行を途中まで進め、ハンドルを閉じて開き直し、起動時照合 → 再開で最後まで進むこと
  （PR8 の D2 の延長。Windows 経路は CI で確認する）

### 抽出の非退行（E）

- E1 `run/units.ts` の抽出後、`pipeline.test.ts` と `packages/cli` のテストを変更せずに緑であること

## 進め方（タスク分割と PR の分割）

レビューの推奨に従い、**2 本の PR に分ける**。境界は「基盤」と「完成したオーケストレーター」に置く。
当初案（初回実行までを 9a に入れる）は、再開手段のない中間状態が main に入るので採らない。

いずれも Subagent Driven で実行し、各タスクの終わりに `pnpm check` を通す。

### PR9a：挙動を支える基盤（`feat/pr9a-run-foundation`）

DB とモックだけで完結する部品を作る。オーケストレーターはまだ無いので、実行を開始する経路は増えない。
**この PR だけでは受け入れ条件を 1 つも満たさない**（満たすのは 9b）。それが分割の意図でもある。
タスクの詳細は「PR9a の実装タスク」（下）にある。**最重要の非退行条件は、既存の CLI の挙動が
変わらないこと**（`pipeline.test.ts` と `packages/cli` のテストを 1 行も変えずに緑）。

9a の関数はすべて**トランザクションハンドルを引数で受け取る**形にする。決定 15 のトランザクションを
組み立てるのは 9b のオーケストレーターなので、9a の部品が自分でトランザクションを開いて閉じてしまうと
合成できない。

### PR9b：完成したオーケストレーター（`feat/pr9b-orchestrator`）

1. **オーケストレーター（開始と実行）**：`startRun`（決定 18）、単位駆動ループ、決定 15 の保存
   トランザクション、位置特定失敗の再確認単位、再確認の発火条件（決定 19）、想定外例外
   （O1〜O3、O10、O12〜O17、T1〜T3）。
2. **停止・再開・再試行**：`recovery.ts` と合わせて（O4〜O9、O11、O18、R1〜R4b）。
3. **起動時照合と再起動テスト**：`index.ts` への組み込み（R5・R6、D1）。
4. **仕様書の改訂**：`checkMs` の意味（決定 7）。版を上げ、15 節の改訂記録に追記し、同じコミットに含める。
5. **ドキュメント**：README、ロードマップの PR9 節と PR10 への持ち越し。

受け入れ条件 3・4・5・11・14・15・16・18 は 9b の完了時に満たす。

### 1 本にまとめる場合

技術的には可能だが、変更量・状態遷移・クラッシュ整合性・時間依存テストが 1 つの diff に重なる。
その場合は実装モデルと独立レビューをそれぞれ 1 段引き上げる。ただし分割のほうがレビュー可能性への
効果は大きい、というのがレビューの評価であり、本計画もそれに従う。


## PR9a の実装タスク

各タスクは 1 つの実装単位。完了前に `pnpm check` を通す。**すべてのタスクに共通する禁止事項**：
`docs/spec/mvp-spec.md` を変えない（PR9b で行う）、`packages/web` を触らない、
オーケストレーター（実行の開始・停止・再開）を作らない、接続先 URL と API キーを出力・例外・DB に残さない。

### Task 1：検査単位・再確認単位のプリミティブを `run/units.ts` に抽出する

**目的**：「1 検査単位を実行する」「1 再確認単位を実行する」を `pipeline.ts` から取り出し、
PR9b のオーケストレーターが同じコードを使えるようにする（決定 1）。

**作る**：`packages/server/src/run/units.ts`、`run/units.test.ts`
**変える**：`packages/server/src/run/pipeline.ts`（抽出した関数を呼ぶ形に）

**インターフェース**（`CheckUnitResult` / `RecheckResult` / `RunStop` / `UnitFailure` は `run/result.ts` の既存型）：

```ts
export interface CheckUnitArgs {
  readonly text: string;
  readonly paragraphs: readonly Paragraph[];
  readonly input: CheckInput;
  readonly targetIndex: number;
  readonly perspective: Perspective;
  readonly allowedWords: readonly string[];
  readonly generation: GenerationSettings;
  /** 遅延通知の閾値。ハード上限は checkMs + recoveryConfirmMs。 */
  readonly checkMs: number;
  /** 既定 0。0 ならハード上限は checkMs そのもの（従来の挙動）。 */
  readonly recoveryConfirmMs?: number | undefined;
  readonly executor: Executor;
  readonly createCandidateId: () => string;
  /** checkMs を超えたときに 1 回だけ呼ぶ。省略可。 */
  readonly onSlow?: ((elapsedMs: number) => void) | undefined;
}

export interface CheckUnitOutcome {
  readonly unit: CheckUnitResult;
  readonly candidates: readonly Candidate[];
  /** unit.status が pending でも非 null になりうる（PR9b の決定 20 が使う）。 */
  readonly failure: UnitFailure | null;
  readonly halt: RunStop | null;
}

export function executeCheckUnit(args: CheckUnitArgs): Promise<CheckUnitOutcome>;
export function executeRecheckUnit(args: RecheckUnitArgs): Promise<RecheckUnitOutcome>;
```

**規則**：

- 抽出であって挙動の変更ではない。`pipeline.ts` の分岐（`isPendingFailure` による pending / failed の
  振り分け、`input-too-long` の停止判断、`locateQuote` を要求と同じ `CheckInput` で呼ぶこと）を
  そのまま持ち込む。
- `recoveryConfirmMs` が 0（既定）のとき、`executor.execute` に渡すタイムアウトは `checkMs` そのもの。
  従来と 1 ビットも変わらない。
- `recoveryConfirmMs > 0` のとき、`executor.execute` に渡すタイムアウトは `checkMs + recoveryConfirmMs`
  とし、`checkMs` 経過時に `onSlow` を 1 回だけ呼ぶ。タイマーは応答が返ったら必ず解除する
  （テストが未解決のタイマーを残さないこと）。
- 位置確定（`locateQuote`）とその結果の候補化までを `executeCheckUnit` が行う。DB も結果 JSON も知らない。
- `executeRecheckUnit` は `buildRecheckInput` の `InputTooLongError` を当該単位の失敗にとどめる
  （実行は止めない）。

**テスト**：

- E1（**このタスクの完了条件**）：`packages/server/src/run/pipeline.test.ts` と `packages/cli` のテストを
  **1 行も変更せずに**緑であること。テストを直したくなったら、それは抽出が挙動を変えた印なので実装を直す
- U1 `recoveryConfirmMs` 省略時、`executor.execute` に渡るタイムアウトが `checkMs` と等しいこと
- U2 `recoveryConfirmMs > 0` のとき、渡るタイムアウトが `checkMs + recoveryConfirmMs` であること
- U3 `checkMs` 経過で `onSlow` がちょうど 1 回呼ばれること（フェイクタイマー）
- U4 `checkMs` 超過後、ハード上限前に応答が届いたら `unit.status` が `done` になること
- U5 応答が上限前に返ったとき `onSlow` が呼ばれず、タイマーが残らないこと

### Task 2：単一キュー `run/queue.ts`

**目的**：バックエンド全体で LLM 生成要求の同時実行数を 1 にする（仕様 2 節、決定 2）。

**作る**：`packages/server/src/run/queue.ts`、`run/queue.test.ts`
**変える**：`packages/server/src/run/executor.ts`（`ExecutorOptions` に `queue` を足す）

```ts
export interface RequestQueue {
  enqueue<T>(job: () => Promise<T>): Promise<T>;
  readonly size: number;
}
export function createRequestQueue(): RequestQueue;
```

**規則**：

- FIFO。前のジョブが解決するまで次のジョブを始めない。ジョブが例外で終わっても後続を止めない
  （例外は `enqueue` の呼び出し元に返す）。
- `createExecutor` の `options.queue` が渡されたら、`runOne`（`ensureLoaded` → `chat` → `parse` →
  再試行 1 回）の**全体を 1 ジョブ**として投入する。`ensureLoaded` と `chat` の間に別の実行の要求が
  割り込むと「未ロードのモデルに生成要求を送らない」が破れるため、粒度を細かくしない。
- `queue` を渡さないときは現在の `tail` による直列化のまま（`runPipeline` は渡さない）。

**テスト**：

- Q1 2 つの executor に同じキューを渡し、要求が交互に並ばず投入順に直列化されること
- Q2 1 ジョブの中で `ensureLoaded` と `chat` の間に別ジョブが割り込まないこと
  （モックが呼び出し順を記録して確認する）
- Q3 ジョブが例外を投げても後続のジョブが実行され、例外は投入元に返ること
- Q4 `queue` を渡さない `createExecutor` の挙動が従来どおりであること（`executor.test.ts` を変更しない）

### Task 3：スキーマとリポジトリの改修

**目的**：PR9b が安全に状態を書けるようにする（PR8 必須事項 1・2、決定 4・5・8・21・22）。

**作る／変える**：
`packages/server/src/db/schema.ts`、`drizzle/0001_*.sql`（生成）、`db/client.ts`、`db/records.ts`、
`db/repositories/runs.ts`、`repositories/check-units.ts`、`repositories/rechecks.ts`、
`repositories/findings.ts` と、対応する既存テスト。

**1. マイグレーション `0001`（決定 8・21）**

- `runs.stop_requested_at`：`integer` timestamp、nullable。
- `runs.recovery_confirm_ms`：`integer NOT NULL DEFAULT 0`。
- `pnpm --filter @shuten/server db:generate` で生成し、`drizzle/` を同じコミットに含める
  （`docs/reference/conventions.md`）。
- `RunRecord` に `stopRequestedAt: Date | null` と `recoveryConfirmMs: number` を足し、
  `insertRun` / `rowToRunRecord` を対応させる。JSON 列にはしない（普通の列）。
- **既存データがある DB で適用できること**：`0000` だけを適用した DB に `runs` の行を作り、
  そこへ `0001` を適用できる。適用後にその行を読むと `recoveryConfirmMs` が 0 になる。
  0 は「`checkMs` がそのままハード上限」という従来の意味に対応する。

**2. トランザクションハンドルを受け取れるようにする**

PR8 のリポジトリは第 1 引数が `AppDatabase`（`BetterSQLite3Database<typeof schema>`）だが、
`db.transaction((tx) => ...)` の `tx` はこの型に代入できない。決定 15 のトランザクションを
9b が組み立てられるよう、共通の上位型を `db/client.ts` に足し、リポジトリの引数をそれに広げる。

```ts
// drizzle の BetterSQLite3Database と SQLiteTransaction の共通の親
export type AppDatabaseLike = BaseSQLiteDatabase<"sync", Database.RunResult, typeof schema>;
```

型の正確な形は実装時にコンパイルで確かめる（drizzle 0.45.2 の定義に合わせる）。
`AppDatabase` は残し、`AppDatabaseLike` を受ける形に各リポジトリを広げる。

**3. `claim*` が `started_at` を同じ UPDATE で設定する（必須事項 1）**

```ts
export function claimUnit(
  db: AppDatabaseLike, id: string, from: UnitStatus, to: UnitStatus,
  options?: { readonly startedAt?: Date | undefined },
): boolean;
```

`claimRecheckUnit` も同じ。`started_at` は状態の変更と**同じ 1 文**に含める。
`claimRun` は変えない（`runs.started_at` は `insertRun` で確定し、再開で上書きしない）。

**4. `finish*` を条件付き更新にする（必須事項 2）**

`finishCheckUnit` / `finishRecheckUnit` / `finishRun` の入力に `expectedStatus` を足し、
`WHERE id = ? AND status = ?` にして**更新できたかを `boolean` で返す**。既存テストを更新する。

**5. 追加するリポジトリ関数**

- `updateFindingAggregate(db, findingId, { category, initialVerdict })`（決定 9）
- `nextCandidateIndex(db, runId): number`（決定 22。`COALESCE(MAX(candidate_index), -1) + 1`）
- `findRunByStartOperationId(db, startOperationId): RunRecord | null`（決定 12）

**テスト**：

- S3 `claimUnit` / `claimRecheckUnit` が `started_at` を同じ更新で設定し、`from` に合わない行を変えないこと
- S4 `finish*` が `expectedStatus` に合わない行を更新せず false を返すこと（3 関数すべて）
- T4b `nextCandidateIndex` が 0 から始まり、保存のたびに増えること
- T6 ロールバックすると `nextCandidateIndex` が元の値に戻ること
- T7 実行が 2 つあるとき、それぞれの `nextCandidateIndex` が互いに影響しないこと
- Mig1 `0000` だけを適用して行を作った DB に `0001` を適用でき、既存行が `recoveryConfirmMs: 0` になること
- Mig2 空の DB に `0000` → `0001` を順に適用できること（`applyMigrations` の複数適用）

### Task 4：状態遷移 `run/state.ts` と境界検証 `run/persist.ts`

**目的**：状態を書く経路と、パイプラインの値を DB レコードにする経路を 1 箇所に集める
（決定 3・17・18・23、PR8 必須事項 3）。

**作る**：`packages/server/src/run/state.ts`、`run/state.test.ts`、`run/persist.ts`、`run/persist.test.ts`

**`state.ts`**：

```ts
export function canTransitionRun(from: RunStatus, to: RunStatus): boolean;
export function canTransitionUnit(from: UnitStatus, to: UnitStatus): boolean;
/** 決定 23。stop.generationUnconfirmed が true なら recovery-waiting、false なら stopped。 */
export function runStatusForStop(stop: RunStop): Extract<RunStatus, "stopped" | "recovery-waiting">;
```

許容遷移は本書「決定 3」の 2 つの表がそのまま仕様。表にない遷移は false。

**`persist.ts`**：保存の直前に検査し、違反は `PersistBoundaryError` を投げる（決定 17）。

1. `mergeKey` は `locateStatus === "located"` の指摘にだけ入れてよい
2. 抑制は `category === "notation"` かつ `suggestion !== null` かつ位置確定済みのときだけ非 null
3. 位置確定済みの `paragraphId` は、保存本文と段落表から `range.start` を含む段落として導いた値と一致すること
4. 引用・修正案・本文に孤立サロゲートを含まないこと（`db/errors.ts` の `assertWellFormedBody` を使う）

あわせて `RunTargetRecord` → `CheckInput` の変換（`paragraphIds`、`contextBefore` / `contextAfter` →
`ContextWindow`、`input` → `inputRange`）をここに置く（決定 18）。

**テスト**：

- S1 決定 3 の表にある遷移がすべて true
- S2 表にない遷移がすべて false（`stopped` → `completed` を含む）
- S6 決定 23 の表 9 行すべてで `runStatusForStop` の結果が一致すること。特に「生成中に応答を受け取れず
  切断」（`connection-lost`、`generationUnconfirmed: true`）が `recovery-waiting` になること
- P1 `not-found` の指摘に非 null の `mergeKey` を渡すと `PersistBoundaryError`
- P2 `category !== "notation"` の指摘に抑制を渡すと例外
- P3 修正案 null の指摘に抑制を渡すと例外
- P4 位置確定済みの `paragraphId` が本文から導いた値と食い違うと例外
- P5 孤立サロゲートを含む引用・修正案で例外
- P6 `RunTargetRecord` → `CheckInput` の往復（参考文脈の有無の 4 通り）

### Task 5：増分マージ `run/merge-store.ts`

**目的**：初回でも再開でも同じ経路で統合する（決定 9）。

**作る**：`packages/server/src/run/merge-store.ts`、`run/merge-store.test.ts`

```ts
export interface MergeCandidateInput {
  readonly runId: string;
  readonly manuscriptVersionId: string;
  readonly targetId: string;
  readonly checkUnitId: string;
  readonly candidateIndex: number;
  readonly candidate: LocatedCandidate;
  readonly paragraphId: number;   // persist.ts が本文から導いた値
  readonly allowedWords: readonly string[];
  readonly now: Date;
}
/** 候補 1 件を保存し、統合先の指摘を返す。トランザクションハンドルを受け取る。 */
export function mergeCandidateIntoRun(
  db: AppDatabaseLike, input: MergeCandidateInput,
): { readonly finding: FindingRecord; readonly created: boolean };
```

**規則**：

- `mergeKey(candidate)` が null（修正案なし）→ 常に新しい指摘を作る。
- 非 null → 同じ `run_id` の `findings` を `merge_key` で引き、あれば `attachCandidateToFinding` して
  集約（`category`・`initialVerdict`）を再計算、なければ `insertFinding`。
- 集約の規則は `mergeCandidates`（`@shuten/shared`）と同じ：`category` は元候補が一致すればその値、
  不一致なら `unclear`。`initialVerdict` は全候補が `likely-error` のときだけ `likely-error`。
- 照合は**同じ実行 ID の中だけ**（仕様 6.4）。
- 新規指摘を作るときは `judgments` の `undecided` 行も同じ呼び出しで作る（`insertFinding` の既存の挙動）。
- 抑制（`findSuppression`）の適用もここで行い、`persist.ts` の検査を通してから保存する。
- 自分でトランザクションを開かない（呼び出し元が包む）。

**テスト**：

- M1 **オラクル**：1 検査対象ぶんの候補列を (a) `mergeCandidates` で一括処理、(b) `mergeCandidateIntoRun` で
  1 件ずつ処理し、グルーピング・`category`・`initialVerdict` が一致すること。
  候補列には「同じ `mergeKey` が 3 件」「`category` が食い違う 2 件」「`verdict` が食い違う 2 件」
  「修正案なし 2 件」を含める
- M2 修正案なし（`mergeKey` が null）の候補が常に別の指摘になること
- M3 実行 ID が違う同じ `mergeKey` の候補が統合されないこと
- M4 既存指摘に候補を足したとき `judgments` の行が増えず、内容も変わらないこと（仕様 5.4）
- M5 呼び出し元が `db.transaction` で包んでロールバックすると、指摘・候補・判断のいずれも残らないこと

### Task 6：ドキュメント

**変える**：`README.md`（現在の状態を「PR9a 完了、次は PR9b」に）、
`docs/plans/2026-09-07-mvp-roadmap.md`（PR9 節を PR9a / PR9b に分け、本詳細計画へのリンクを張る）。

**変えない**：`docs/spec/mvp-spec.md`（`checkMs` の意味の改訂は PR9b）。

## PR9a からの持ち越し（PR9b で決着させる）

PR9a の実装で、設計段階では見えていなかった点がいくつか分かった。挙動を変える判断は PR9b の範囲なので、
ここに記録して先送りする。

- **`onSlow` の遅延通知はキュー待ちの時間を含む。** `run/units.ts` の `executeWithSlowNotice` は
  `executor.execute` を呼んだ時点でタイマーを立てる。決定 2 のキュー（`run/queue.ts`）を経由する経路では、
  `executor.execute` の呼び出し自体がキューへの投入であり、実際に生成要求が送られるまでの待ち時間も
  タイマーに含まれる。PR9b で複数の検査単位・再確認単位を同じキューに積むと、他の実行の要求で
  キューが詰まっているだけで `checkMs` を超え、「遅い」と通知されうる。PR9a の既定経路
  （`recoveryConfirmMs = 0`）ではタイマー自体が作られないため影響はないが、PR9b は次のどちらかを決める必要がある。
  - 遅延通知をキュー投入時ではなく、実際に要求を送り始めた時点から計る
  - 通知の意味を「`checkMs` の経過」ではなく「キュー投入からの経過」と定義し直し、表示側の文言もそれに合わせる

  なお、ハード上限（`checkMs + recoveryConfirmMs` での abort）は executor が生成要求 1 回ごとに適用するため、
  この点は上限の正しさには関わらない。ずれるのは「遅い」という通知のタイミングの解釈だけである。

- **`queue` を渡した経路では、executor 内部の `tail` とキューの二重の直列化が残る。** `run/executor.ts` は
  従来どおり自前の `tail` で要求を直列化したうえで、`queue` が渡されればジョブ全体をさらにキューへ投入する。
  正しさには影響しない（`tail` はキュー経由でも 1 実行内の順序を保つだけで、キューが全体の直列化を担う）が、
  無駄な二段構えである。PR9b でオーケストレーターがキューを使う形が固まった時点で、`tail` を外すか、
  `queue` が渡されたときは `tail` を使わない経路に整理できる。

- **`state.test.ts` は決定 23 の写像表 9 行目（`internal-error`）を型アサーションで検証している。**
  `internal-error` は決定 14（想定外の例外による停止理由）で `StopReason` / `RunStopReason` に足す値だが、
  PR9a はオーケストレーターを作らないため、この値自体はまだ存在しない。`state.test.ts` は
  `reason: "internal-error" as StopReason` という型アサーションで表の 9 行目を仮に検証している。
  PR9b で決定 14 を実装し `internal-error` を両方の型に正式に足すときは、このアサーションを
  通常の値（型アサーションなし）に戻すこと。

- **`merge-store.ts` の `updateFindingSuppression` に渡す許容語リストは、実行単位で不変であるべき。**
  `mergeCandidateIntoRun` は呼び出し元が渡す `MergeCandidateInput.allowedWords` をそのまま
  `findSuppression` と `updateFindingSuppression` に使う。PR9a はこの値の出所を決めていないが、
  PR9b のオーケストレーターは検査対象・検査単位ごとに違う値を渡してはならない。ある実行の途中で
  許容語が変わる仕組みは無いはずだが、呼び出し側が候補ごとに読み直す実装をすると、統合済み指摘の
  抑制判定が候補の処理順に左右されうる。PR9b は `runs` のレコードから許容語を 1 度だけ取り出し、
  同じ実行の全呼び出しにその値を渡すこと。

- **増分マージ（決定 9）は、対象内で決着していない中間状態を DB 上に見せる。** ある検査単位の保存直後、
  その候補によって指摘に抑制（`suppression`）が付くことがある。同じ検査対象の別の検査単位（他の観点）が
  まだ `pending` / `running` で、その単位が保存されると同じ指摘の集約が変わり、抑制が外れることがある
  （逆に、後から抑制が付くこともある）。最終状態は正しいが、この中間状態を読んで再確認を起票すると、
  「許容語により対象外」という誤った判定で再確認単位が作られる・作られないが決まってしまう。
  **決定 19（対象の全検査単位が決着してから再確認単位を作る）はこの中間状態を読まないための規則であり、
  PR9b はこの順序を必ず守ること。** 対象の統合結果を読むのは、その対象の全検査単位が `pending` /
  `running` を持たなくなった時点に限る。

- **位置特定失敗の指摘に境界検証が掛からない。** `assertFindingBoundary`（`run/persist.ts`）を呼ぶのは
  `run/merge-store.ts` の 2 箇所（`createFinding` / `attachToFinding`）だけで、どちらも位置確定済み
  （`locateStatus: "located"`）の経路である。`db/repositories/findings.ts` の `saveUnlocatedCandidate`
  は境界検証を通らずに書き込む。決定 17 が定める 4 項目のうち「`mergeKey` は位置確定済みの指摘にだけ
  付く」「孤立サロゲートを含まない」は、位置特定に失敗した指摘（`not-found` / `ambiguous` /
  `outside-target`）にも意味がある不変条件のはずである。PR9b が `saveUnlocatedCandidate` を呼ぶ実装を
  追加するときに、呼び出し側で該当する検査を通すか、`run/persist.ts` に位置特定失敗用の検証入口を
  新設するかを決めること。PR9a には `saveUnlocatedCandidate` を呼ぶ経路が無いため、現時点での実害はない。

- **`run/state.ts` は本番コードから 1 箇所も呼ばれていない。** `canTransitionRun` / `canTransitionUnit`
  は `db/repositories` の `claimUnit` / `finishCheckUnit` / `finishRun` のどこからも参照されておらず、
  「状態を書く経路はすべてこれを通す」という `state.ts` 冒頭のコメントの前提は、まだコードとして
  強制されていない。PR9a は状態機械の判定ロジックだけを用意する基盤 PR であり、実装をまだ持たない
  PR9b のオーケストレーターに接続できないのは分割の意図どおりである（`createRequestQueue`
  （`run/queue.ts`）と `merge-store.ts` の `mergeCandidateIntoRun` も同様に、PR9a の時点では
  本番コードから未接続）。PR9b でオーケストレーターを実装するときに、状態を書く箇所が必ず
  `canTransitionRun` / `canTransitionUnit` を経由するように接続すること。

- **`PersistBoundaryError` のメッセージには原稿の断片（最大 20 コード単位）が入る。** `run/persist.ts`
  の `previewQuote` は、境界検証に違反した引用の先頭 20 コード単位（書記素ではない）をエラー
  メッセージに含める。プロセス内で検査対象を絞り込むための例外としては妥当だが、決定 14 が
  「想定外の例外のメッセージをそのまま `stop_message` に入れない」と定めているとおり、PR9b が
  `PersistBoundaryError` を捕捉して停止理由（`stop_message` 等）に転記する経路を作るときは、
  接続先 URL・API キーだけでなく原稿の断片も DB に残さないこと（メッセージ全体を捨てるか、
  原稿由来の部分を除いた要約に置き換える）。

## PR10 以降への持ち越し（本 PR では作らない）

- HTTP API・SSE の口（PR10）。本 PR のオーケストレーターは関数として呼べる形にとどめる。
- `settings` 表と接続先の UI 上書き（PR10）。
- `LmStudioClient` の `close()` / `dispose()` と graceful shutdown（PR10）。
- `listFindings` の N+1（PR12）。
- 一括エクスポート（PR13）。
