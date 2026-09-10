# PR11b：接続断で失敗した単位の復旧を 1 段にする（server）

作成日：2026-09-10
仕様：`docs/spec/mvp-spec.md`（v0.9）8.2 節
ロードマップ：`docs/plans/2026-09-07-mvp-roadmap.md`（PR11b）
前提の計画書：`docs/plans/2026-09-09-pr9-orchestration.md`（決定 20・23）、
`docs/plans/2026-09-09-pr9b-orchestrator.md`、`docs/plans/2026-09-09-pr10-http-api.md`（決定 17）

## 何を直すか

生成要求を送った後、**応答を受け取れないまま接続が切れた**とき、実行は「復旧待ち」になるのに、
その検査単位だけが `failed` のまま残る。復旧に「再開」＋「失敗単位の個別再試行」の 2 段が要る。

PR9b からの持ち越しで、PR10 では決定 17 として先送りした（オーケストレーターの実行の意味を
変えないため）。PR12a・PR12b が最終の状態モデルに対して画面を設計できるよう、ここで解消する。

### 現状の根拠（コード）

| 段 | 場所 | いまの挙動 |
| --- | --- | --- |
| 例外 | `lmstudio/client.ts:117-129` | 送信後に切れると `LmStudioError("connection", …)`。`status` は **null**（HTTP 状態行を得ていない） |
| 実行の帰結 | `run/executor.ts:134-147` | `connection` かつ `status === null` → `RunStop{ reason: "connection-lost", generationUnconfirmed: true }` |
| 実行の状態 | `run/state.ts:88-103` | `generationUnconfirmed` が true → 実行は `recovery-waiting` |
| **単位の状態** | `run/units.ts:52-60` | `origin === "chat"` の `connection` は `isPendingFailure` が **false** → 単位は `failed` |

つまり食い違っているのは最後の 1 行だけである。`isPendingFailure` は「生成終了が未確認か」を
判定したいのに、判定材料として `reason === "timeout"` という**個別の理由名**を使っている。
決定 20 が書かれた時点では未確認の経路が停止とタイムアウトの 2 つだけだったためで、
接続断（応答なし）という 3 つ目が漏れている。

## 決定

### 決定 1：判別子を `UnitFailure.generationUnconfirmed` に一本化する

`isPendingFailure` に `reason === "connection" && status === null` の枝を足す形では直さない。
それは同じ判断（生成終了が未確認か）を 2 か所に書き分けることになり、4 つ目の経路が
増えたときに同じ漏れが起きる。

`UnitFailure` に真偽値 1 つを足し、`run/executor.ts` の `toFailure` が**唯一の決定箇所**にする。

```ts
// run/result.ts
export interface UnitFailure {
  readonly reason: FailureReason;
  readonly message: string;
  readonly finishReason: string | null;
  readonly origin: "ensure-loaded" | "chat" | "local";
  /**
   * 生成が LM Studio 側で走り続けている可能性があるか。
   * 生成要求を送った後に、応答を受け取れないまま終わったときだけ true。
   */
  readonly generationUnconfirmed: boolean;
}
```

決め方（`toFailure` が `origin` と `LmStudioError` から導く。`origin !== "chat"` は常に false）：

| `origin` | `kind` | `status` | `generationUnconfirmed` |
| --- | --- | --- | --- |
| `chat` | `timeout` | — | true |
| `chat` | `aborted` | — | true |
| `chat` | `connection` | null | **true（本 PR で変わるのはここ）** |
| `chat` | `connection` | 非 null | false |
| `chat` | `malformed` / `truncated` / `model-not-loaded` / `input-too-long` | — | false |
| `ensure-loaded` / `local` | いずれも | — | false |

`isPendingFailure` は次の 1 本になる。

```ts
function isPendingFailure(failure: UnitFailure, treatUnconfirmedAsPending: boolean): boolean {
  if (failure.origin !== "chat") {
    return true;                                   // 送っていない（決定 5(b)）
  }
  if (failure.reason === "model-not-loaded" || failure.reason === "aborted") {
    return true;                                   // 仕様書 7 節・8.2 節
  }
  return treatUnconfirmedAsPending && failure.generationUnconfirmed;
}
```

`aborted` を `generationUnconfirmed` の枝に統合しない（フラグに関係なく `pending`）。CLI が
`signal` で中断したときの非退行（`units.test.ts` U6、`pipeline.test.ts` E1）がこれに依存している。

`haltForChatError`（`executor.ts:128-175`）が `makeStop(...)` に渡している
`generationUnconfirmed` も、リテラルの `true` / `false` ではなく `failure.generationUnconfirmed`
から取る。同じ判断を 2 か所に持たない。**実行の状態（`recovery-waiting`）と単位の状態
（`pending`）が同じ 1 つの値から決まること**が、この PR で守りたい不変条件である。

### 決定 2：`treatUnconfirmedAsPending` の役割は変えない

決定 45-3（呼び出し元が経路を明示するフラグ。待機時間を判別子にしない）はそのまま。
オーケストレーター（`run/loop.ts:330,405`）だけが true を渡し、CLI（`run/pipeline.ts`）は渡さない。

したがって **CLI の挙動は 1 ビットも変わらない**。接続断で失敗した単位は CLI では従来どおり
`failed` で、結果 JSON に残る。CLI には再開の概念がないので `pending` にする意味がない。

### 決定 3：「応答を受け取った」＝ HTTP 状態行と本文を読み切ったこと

`client.ts` の `sendRequest` は `fetch` と `response.text()` を同じ `try` に入れており、
**本文の読み取り中に切れた場合も `status` は null** になる（`client.ts:117-129`。
`status` を持つのは `return { status: response.status, text }` に到達した経路だけ）。

これを「応答を受け取っていない」側に倒す。生成が終わって本文を送っている途中で切れた場合も
`pending` になり、再開で作り直すことになるが、次の理由でこちらを採る。

- クライアントには「本文の途中まで読めた」ことを知る手段が無く、実際に採用できる結果も無い。
- 実行の側は既にこの場合も `recovery-waiting`（`generationUnconfirmed: true`）にしている
  （`executor.ts:139-147`）。単位だけ別の判断にすると決定 1 の不変条件が崩れる。
- 再実行が起きるだけで、誤った結果は残らない（仕様書 8.2「時間経過を終了の証拠とみなさない」と同じ姿勢）。

`isRetryable`（`executor.ts:115-122`）は既にこの区別を持っており、本 PR で変えない。
`status === null` の `connection` は再試行しない（`attempts` は 1 のまま）。

### 決定 4：DB には持たせない（列もマイグレーションも増やさない）

ロードマップは「`UnitFailure` / `UnitFailureRecord` に持たせる」と書いているが、
`UnitFailureRecord` と `check_units` / `recheck_units` の列は増やさない。

理由：オーケストレーター経路では、本 PR の後は**保存済みの行から一意に読み取れる**。

| 保存された組み合わせ | 意味 |
| --- | --- |
| `status = pending` かつ `failure_reason = connection` | 応答を受け取らずに切れた（再開が拾う） |
| `status = failed` かつ `failure_reason = connection` | HTTP 応答を受け取った拒否（個別再試行の対象） |

さらに `pending_note`（決定 5）に経路が文言として残る。列を足せばマイグレーション、
`db/records.ts`、`api/dto.ts` の射影、`shared/src/api/` の zod スキーマ、`api/leak.test.ts` の
検査面がすべて動く。得られるのは既に読み取れる情報なので、割に合わない。

**代案（採らない）**：`UnitFailureRecord.generationUnconfirmed` と列を足し、画面が
「LM Studio 側で生成が走っているかもしれない」を単位ごとに出せるようにする。実行単位では
`runs.generation_unconfirmed` で既に出せており、単位ごとの表示は合意した機能範囲にない。

`UnitFailure` は CLI の結果 JSON（`CheckUnitResult.failure`）に載るので、出力に真偽値が
1 つ増える。追加であって形の破壊ではないため `RESULT_VERSION` は `"1"` のままにする。

### 決定 5：`pendingNote` に 3 本目の固定文言を足す

`units.ts:77-87` の `pendingNote` に枝を足す。

| 経路 | 文言 |
| --- | --- |
| ハード上限超過（`timeout`） | 応答が上限内に届かなかった。生成終了は未確認（既存） |
| 停止操作（`aborted`） | 停止操作により打ち切った。生成終了は未確認（既存） |
| **接続断（`connection` かつ `generationUnconfirmed`）** | **応答を受け取らずに接続が切れた。生成終了は未確認** |

固定文言にするのは、`failure.message` を素通しすると将来 `message` に接続先の情報が入ったときに
`pending_note` 経由で漏れるため（`test-support.ts` の裁定 R12 と同じ考え方）。既存の 2 本と同じく
`treatUnconfirmedAsPending && origin === "chat"` の下でだけ差し替える。

### 決定 6：仕様書は改訂しない

仕様書 8.2 節は次の 2 文で本 PR の前後どちらの挙動も許している。

- 「前の生成が継続している可能性がある場合は、終了を確認できるまで後続生成を送信せず、再試行の重複を防ぐ。」
- 「完了済み処理は通常の再開で繰り返さない。失敗した処理を個別に再試行できる。」

本 PR が変えるのは「未完了の単位をどちらの操作が拾うか」という実装内部の割り当てであり、
仕様が定める外形（復旧待ちの表示、手動再開、個別再試行の存在）は変わらない。
したがって版は上げず、15 節の改訂記録にも追記しない。

**改訂するのは計画書の側**である（決定 7）。

### 決定 7：改訂する計画書と、その文言

| 文書 | いまの記述 | 改める内容 |
| --- | --- | --- |
| `2026-09-09-pr9-orchestration.md` の決定 20 | 「停止からの打ち切り…と、タイムアウトからの打ち切り…はどちらも」と 2 経路で書いている | 3 経路（停止・タイムアウト・接続断）に改め、**規則は「生成終了が未確認なら `pending`」の 1 本**で、判別子は `UnitFailure.generationUnconfirmed` であると書く。2026-09-10 に PR11b で改訂した旨と経緯を残す |
| `2026-09-09-pr10-http-api.md` の決定 17 | 「接続断で `failed` になった単位の復旧は 2 段のまま」 | 見出しはそのままに、末尾へ「→ PR11b（`docs/plans/2026-09-10-pr11b-one-step-recovery.md`）で 1 段にした」を追記する（PR10 時点の判断の記録は消さない） |
| `2026-09-07-mvp-roadmap.md` | PR11b の項、PR10 の持ち越し表 | 実施済みにし、本計画書へのリンクを足す |
| `README.md` | 現在の状態 | PR11b まで完了に更新する |

`run/units.ts` の JSDoc（33-59 行、62-76 行）と `run/result.ts` の `UnitFailure` の
コメントも同じコミットで実態に合わせる。

### 決定 8：起動時照合（`reconcileOnStartup`）は変えない

プロセスが落ちた場合、`running` の単位は既に `pending` に戻る（決定 13、テスト R5）。
本 PR が扱うのは「プロセスは生きていて接続だけが切れた」経路なので、照合の側に変更はない。

## 変更するファイル

| ファイル | 変更 |
| --- | --- |
| `packages/server/src/run/result.ts` | `UnitFailure` に `generationUnconfirmed: boolean` を足す（JSDoc も） |
| `packages/server/src/run/executor.ts` | `toFailure`（96 行）が同フィールドを決める。`haltForChatError` はそれを使う。送信前の中断（216 行）と `ensureLoaded` 由来（310 行）は `false` |
| `packages/server/src/run/orchestrator.ts` | 1210 行の `input-too-long` の `UnitFailure` に `false` を足す（送信前なので常に確認済み） |
| `packages/server/src/run/units.ts` | `localFailure` に `generationUnconfirmed: false`。`isPendingFailure` を決定 1 の形に。`pendingNote` に 3 本目。JSDoc |
| `packages/server/src/run/*.test.ts` | 新規テスト（下記）。既存の `UnitFailure` リテラルにフィールドを足す |
| `packages/server/src/run/test-support.ts` | 台本の失敗に `status` を渡せるようにする（下記 U9・R4d 用） |
| 計画書 4 本と `README.md` | 決定 7 のとおり |

`db/`、`api/`、`shared/`、`packages/web/`、`packages/cli/` の実装には触らない。

## テスト

**すべて、直しを戻すと落ちることを確認する（変異検査）。** 特に U9・R4d は
「`connection` を全部 `pending` にする」実装を弾くためのもので、これが落ちなければ意味がない。

### 単位の層（`run/units.test.ts`。既存は U1〜U7）

- **U8**：`chat` 由来の `connection`（`status: null`）に `treatUnconfirmedAsPending: true` を渡すと、
  単位が `pending` になり、`note` が「応答を受け取らずに接続が切れた。生成終了は未確認」で、
  失敗の事実（`failure.reason === "connection"`、`attempts === 1`）が残ること。
- **U9（判別子）**：同じ `connection` でも `status: 503`（HTTP 応答あり）なら、
  再試行 1 回のあと単位は `failed` のままであること。
- **U10**：`treatUnconfirmedAsPending` を渡さない（CLI 経路）と、`status: null` の `connection` は
  `failed` のままであること（U6 と同じ趣旨の非退行）。
- **U11**：再確認単位でも U8 と同じになること（`executeRecheckUnit` の側の配線）。

### オーケストレーターの層（`run/orchestrator.stop.test.ts`。R4b・45-3 の隣に置く）

- **R4c**：生成中に接続が切れる（`status: null`）と、実行が `recovery-waiting`・
  `generationUnconfirmed: true` になり、**その単位が `pending`** で `pending_note` が決定 5 の文言に
  なること。続けて `resumeRun` を呼ぶと、`retryFailedUnits` を**一度も呼ばずに**その単位が
  再実行され、実行が `completed` になること（これが「1 段」の意味。既存の 45-3 のテストが手本）。
- **R4d（判別子）**：`status: 503` の `connection` では、実行が `stopped`（`generationUnconfirmed`
  は false）で単位は `failed` のままであること。`resumeRun` ではその単位が再実行されないこと。

### 既存テストの非退行

- `pipeline.test.ts`（E1、P18c）と `packages/cli` のテストを**変更せずに**緑に保つ。
  `UnitFailure` を組み立てているテストヘルパーだけは、フィールド追加に伴う型エラーの分を直す
  （期待値の変更ではない）。
- `api/leak.test.ts` は変更しない。`pending_note` は固定文言のみになる。

## タスク

小さい PR なので 3 つに分ける。**状態機械（決定 1・3・5）は委譲しない**（ロードマップの担当欄）。

1. **判別子の導入と単位の層**（Claude）：`result.ts`・`executor.ts`・`units.ts` の変更と
   U8〜U11、`test-support.ts` の `status` 対応。既存テストのフィールド追加も含める。
   完了条件：`pnpm check` が通り、U9・U10 が変異検査で落ちること。
2. **オーケストレーターの結合テスト**（サブエージェント可）：R4c・R4d。実装は変えない。
   既存の 45-3 のテストを手本にする。
3. **文書**（Claude）：決定 7 の 4 本と `README.md`。

## やらないこと（MUST NOT）

- 仕様書を改訂しない（決定 6）。
- DB の列・マイグレーション・`api/dto.ts`・`shared/src/api/` を触らない（決定 4）。
- `isRetryable` の判断（HTTP 応答ありの `connection` だけ再試行）を変えない。
- `treatUnconfirmedAsPending` の意味を変えない。待機時間（`recoveryConfirmMs`）を経路の判別子にしない（決定 45-3）。
- CLI（`runPipeline`）の挙動と結果 JSON の既存フィールドを変えない。
- `packages/web/` を触らない。画面での案内は PR12b の範囲。
- 失敗の事実（`failure_reason` 等）を捨てない（決定 20 の後半）。

## 完了条件

- `pnpm check` が通る（typecheck + lint + test）。テスト総数が減っていないこと。
- 新規テストがすべて変異検査を通る（直しを戻すと落ちる）。
- 決定 7 の文書 4 本と `README.md` が更新されている。
- Windows での実機確認は行わない。本 PR は server の内部状態の話で、Windows 固有の経路
  （ネイティブモジュール、パス、静的配信、Ctrl+C）に触れず、`windows-latest` の CI が
  型検査・lint・テスト・ビルドを毎回通す（`docs/guides/windows-verification.md` 1 節）。
