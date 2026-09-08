# PR9 詳細計画：実行キューとオーケストレーション（server）

作成日：2026-09-09
対象：ロードマップ `docs/plans/2026-09-07-mvp-roadmap.md` の「PR9 server：実行キューとオーケストレーション」
仕様：`docs/spec/mvp-spec.md` v0.8 の 2 節（単一キュー）、6 節（処理順序）、6.4、7 節、8.2 節全体
前提：PR7（`server/src/run/pipeline.ts`、`run/executor.ts`）、PR8（`server/src/db/`）が main にある

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
- 上限を超えたら abort し、当該単位を `failed`（`timeout`）、実行を `recovery-waiting`
  （`generation_unconfirmed = true`）にする。自動で後続を送らない。

**待つのは「応答が届いたこと」であって時間ではない**ので、「時間経過を終了の証拠とみなさない」に反しない。

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

`SHUTEN_RECOVERY_CONFIRM_MS`（既定 120000）を `config.ts` に足す。`runs.timeouts` の JSON には入れない。
検査の設定ではなく実行環境の性質であり、既存行の JSON 検証（`runTimeoutsSchema`）を広げずに済むため。

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

`saveUnlocatedCandidate` が `not-found` / `ambiguous` で指摘を作ったら、続けて同じトランザクションの外側で
`insertRecheckUnit({ status: "not-applicable", notApplicableReason, ... })` を書く。理由の優先順位は次のとおり。

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

### 決定 15：永続化は `onEvent` に載せず、オーケストレーターが直接書く

PR7 の `onEvent` は例外を握りつぶす（進捗通知の失敗で実行を止めないため）。永続化の失敗は握りつぶしては
ならないので、DB 書き込みをイベント経路に載せない。オーケストレーターは `await`（生成要求）から戻った**後**に
同期的に（better-sqlite3 は同期 API）書く。これで「DB トランザクションに LLM 応答待ちを含めない」が
構造的に守られる。

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

### 決定 21：停止要求中であることを DB に持つ

決定 6 の待機（最大 `recoveryConfirmMs`）の間、実行の状態は `running` のままになる。状態の正本は DB なので、
このままだと画面の再読み込みや `GET /api/runs/:id`（PR10）から「停止操作を受け付けたが実行中の要求の終了を
待っている」ことが見えない。仕様 8.2 の「実行中の要求を即時中断できない場合は、その状況を表示する」は
これを表示することを求めている。

`runs` に `stop_requested_at`（`integer timestamp`、null 可）を足し、停止要求を受けた時点で書く。
再開時に null に戻す。**本 PR で最初のマイグレーション追加（`0001`）**になり、`applyMigrations` が
複数のマイグレーションを順に適用する経路の実証も兼ねる。

**代案（採らない）**：メモリだけに持ち、PR10 で表示の必要が出たときに列を足す。マイグレーションは
増えないが、その間は「停止操作が効いているのか分からない」状態が残る。

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

## 進め方（タスク分割）

Subagent Driven で実行する。各タスクの終わりに `pnpm check` を通す。

1. **プリミティブの抽出**：`run/units.ts` を作り、`pipeline.ts` をそれを使う形に書き換える。
   テストは 1 行も変えない（E1）。
2. **キュー**：`run/queue.ts` と `createExecutor` のオプション（Q1〜Q4）。
3. **スキーマとリポジトリの改修**：`runs.stop_requested_at` の追加とマイグレーション `0001` の生成（決定 21）、
   `claim*` の `started_at`、`finish*` の条件付き更新、`updateFindingAggregate`、
   `findRunByStartOperationId`（S3・S4 と PR8 テストの更新）。
4. **状態遷移と境界検証**：`run/state.ts`、`run/persist.ts`（S1・S2、P1〜P5）。
5. **増分マージ**：`run/merge-store.ts`（M1〜M3）。
6. **オーケストレーター（初回実行）**：開始・完了・部分失敗・未ロード、位置特定失敗の再確認単位、
   想定外例外（O1〜O3、O10、O12〜O14）。
7. **停止・再開・再試行**：`recovery.ts` と合わせて（O4〜O9、O11、R1〜R4）。
8. **起動時照合と再起動テスト**：`index.ts` への組み込み（R5・R6、D1）。
9. **ドキュメント**：README の現在の状態、`docs/reference/conventions.md`（必要なら）、
   ロードマップの PR9 節と PR10 への持ち越し。

タスク 1〜6 とタスク 7〜8 の間が自然な切れ目になっている（下の「PR の分割案」）。

## PR の分割案（ユーザーの判断を仰ぐ）

ロードマップの大きさは「大」。1 本の PR で出すこともできるが、次の 2 本に割ることもできる。

- **PR9a**：キュー、プリミティブ抽出、状態遷移、境界検証、増分マージ、オーケストレーター（初回実行）、
  起動時照合、PR8 の必須事項 3 件（タスク 1〜6、8 の一部）
- **PR9b**：停止・再開・失敗単位の再試行・復旧待ち（タスク 7、8 の残り）

分割すると PR9a だけでは受け入れ条件 14・18 を満たせない（再開と復旧待ちが 9b にあるため）。

## PR10 以降への持ち越し（本 PR では作らない）

- HTTP API・SSE の口（PR10）。本 PR のオーケストレーターは関数として呼べる形にとどめる。
- `settings` 表と接続先の UI 上書き（PR10）。
- `LmStudioClient` の `close()` / `dispose()` と graceful shutdown（PR10）。
- `listFindings` の N+1（PR12）。
- 一括エクスポート（PR13）。
