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

### 決定 1：判別子は既にある `RunStop.generationUnconfirmed` を使う（新しい値を作らない）

**改訂（2026-09-10、レビュー指摘 1 を受けて）**：当初案は `UnitFailure` に
`generationUnconfirmed` を足して `toFailure` を唯一の決定箇所にする形だった。しかし同じ判断は
既に `RunStop.generationUnconfirmed` として存在し（`executor.ts:105` の `makeStop`、
128-175 行の `haltForChatError`）、復旧ゲート（`executor.ts:236` の `finish`）も実行の終端化
（`state.ts:88-103`）もその値を見ている。単位の側だけが別の値を持つ理由はない。

**単位の判定にも同じ `halt` を渡す。** `isPendingFailure` と `pendingNote`（`run/units.ts`）の
引数に `halt: RunStop | null` を足す。

```ts
function isPendingFailure(
  failure: UnitFailure,
  halt: RunStop | null,
  treatUnconfirmedAsPending: boolean,
): boolean {
  if (failure.origin !== "chat") {
    return true;                                   // 送っていない（決定 5(b)）
  }
  if (failure.reason === "model-not-loaded" || failure.reason === "aborted") {
    return true;                                   // 仕様書 7 節・8.2 節
  }
  return treatUnconfirmedAsPending && halt?.generationUnconfirmed === true;
}
```

`reason === "timeout"` という**個別の理由名**が消え、「生成終了が未確認なら `pending`」という
決定 20 の趣旨がそのまま条件になる。**実行の状態（`recovery-waiting`）と単位の状態（`pending`）が
文字どおり同じ 1 つの値から決まる**。接続断（`connection` かつ `status === null`）は
`haltForChatError` が既に `generationUnconfirmed: true` にしているので、**production の
判定ロジックの変更はこの 1 行だけ**になる。

`aborted` を `generationUnconfirmed` の枝に統合しない（フラグに関係なく `pending`）。CLI が
`signal` で中断したときの非退行（`units.test.ts` U6、`pipeline.test.ts` E1）がこれに依存している。

#### この判定が前提にする不変条件

`halt` は executor 内で共有される 1 つの変数で、単位ごとの値ではない（`executor.ts` の
`runOne` が `halt ??= stop` で書く）。したがってこの判定が正しいのは、次が成り立つ限りである。

> **`origin === "chat"` の失敗と一緒に返る `halt` は、その失敗自身から導いたものである。**

根拠は既存の 2 つの決定である。

- `halt` を**書く**のは `runOne` の中だけで、`runOne` はキュー（または `tail`）で直列化される
  （決定 45-2。`execute` の `QueueCancelledError` の catch が共有 `halt` を書かないのは
  まさにこのためで、`executor.ts:441-470` に理由が書いてある）。
- 保持済みの `halt` があるときは `runOne` の冒頭で `blocked()` を返し、**生成要求を送らない**。
  その失敗は `origin: "local"` なので上の 1 本目の枝で `pending` になり、`halt` の値を見ない。
- 決定 45-3 が同じ性質を明記している：「直列化の下では `halt` が立った後に `chat` を送らないので
  到達せず、『最初の halt が勝つ』という規則を崩すだけ」。

この不変条件は**テスト U12 で固定する**（下記）。将来 `halt` を `runOne` の外から書く経路を
作るときは、この判定も一緒に見直すこと。その旨を `units.ts` のコメントに残す。

**代案（採らない）**：`UnitFailure` に `generationUnconfirmed` を足す。単位ごとの値になるので
上の不変条件に依存しないが、同じ判断の表現が 2 つになり、`RunStop` 側との整合を別途保つ必要が
生じる。CLI の結果 JSON（`CheckUnitResult.failure`）にもフィールドが増え、`RESULT_VERSION` の
判断と多数のテストリテラルの修正を招く。不変条件は既に 2 つの決定で守られており、
テストで固定できるので、表現を増やさないほうを採る。

### 決定 2：`treatUnconfirmedAsPending` の役割は変えない

決定 45-3（呼び出し元が経路を明示するフラグ。待機時間を判別子にしない）はそのまま。
オーケストレーター（`run/loop.ts:330,405`）だけが true を渡し、CLI（`run/pipeline.ts`）は渡さない。

したがって **CLI の挙動は 1 ビットも変わらない**。接続断で失敗した単位は CLI では従来どおり
`failed` で、結果 JSON に残る。CLI には再開の概念がないので `pending` にする意味がない。

### 決定 3：「応答を受け取った」＝ HTTP 状態行と本文を読み切ったこと

この定義は既に `haltForChatError` が実装している（`connection` かつ `status === null` →
`generationUnconfirmed: true`）。本 PR で書き換えるのではなく、**単位の側がその判断に従うようにする**
（決定 1）。以下はその定義が妥当であることの確認である。

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

ただしこの読み分けが成り立つのは**本 PR 以降に書かれた行**だけである。それ以前の
`failed` + `connection` の行は両方の意味を含む。復旧手段（失敗単位の個別再試行）は残るので
実害はない。

**HTTP・SSE には波及しない**ことを確認済みである。`UnitFailure` は `run/save.ts` の
`toFailureRecord`（46-57 行）で 4 項目を明示的に選んで `UnitFailureRecord` になり、
`api/dto.ts` の `toUnitFailureDto` がそこから DTO を作る。`shared/src/api/dto.ts` の
`unitFailureDtoSchema`（204-211 行）は `.strict()` だが、新しいフィールドは記録の境界で
落ちるため到達しない。`run/events.ts` も `UnitFailure` をそのまま載せていない。

さらに `pending_note`（決定 5）に経路が文言として残る。列を足せばマイグレーション、
`db/records.ts`、`api/dto.ts` の射影、`shared/src/api/` の zod スキーマ、`api/leak.test.ts` の
検査面がすべて動く。得られるのは既に読み取れる情報なので、割に合わない。

**代案（採らない）**：`UnitFailureRecord.generationUnconfirmed` と列を足し、画面が
「LM Studio 側で生成が走っているかもしれない」を単位ごとに出せるようにする。実行単位では
`runs.generation_unconfirmed` で既に出せており、単位ごとの表示は合意した機能範囲にない。

### 決定 5：`pendingNote` に 3 本目の固定文言を足す

`units.ts:77-87` の `pendingNote` に枝を足す。

| 経路 | 文言 |
| --- | --- |
| ハード上限超過（`timeout`） | 応答が上限内に届かなかった。生成終了は未確認（既存） |
| 停止操作（`aborted`） | 停止操作により打ち切った。生成終了は未確認（既存） |
| **接続断（`connection` かつ `generationUnconfirmed`）** | **応答を受け取らずに接続が切れた。生成終了は未確認** |

`pendingNote` にも `halt` を渡し、3 本目の条件は
`treatUnconfirmedAsPending && failure.origin === "chat" && failure.reason === "connection" &&
halt?.generationUnconfirmed === true` とする（既存 2 本の条件は変えない）。

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
| `2026-09-09-pr9b-orchestrator.md` の決定 32 | `pending_note` をタイムアウトと停止操作の 2 経路として説明している | 接続断の 3 本目を足す。判別を `recoveryConfirmMs > 0` ではなく `treatUnconfirmedAsPending` と `halt.generationUnconfirmed` で書く（45-3 の改訂後の姿に合わせる） |
| `2026-09-09-pr9b-orchestrator.md` の 45-3 | `isPendingFailure` / `pendingNote` が「フラグだけを見る」と書いている | フラグに加えて `halt.generationUnconfirmed` を見る形に改める。`reason === "timeout"` を条件から外したことと、その前提になる不変条件（決定 1）を書く |
| `2026-09-09-pr10-http-api.md` の決定 17 | 「接続断で `failed` になった単位の復旧は 2 段のまま」 | 見出しはそのままに、末尾へ「→ PR11b（`docs/plans/2026-09-10-pr11b-one-step-recovery.md`）で 1 段にした」を追記する（PR10 時点の判断の記録は消さない） |
| `2026-09-07-mvp-roadmap.md` | PR11b の項、PR10 の持ち越し表 | 実施済みにし、本計画書へのリンクを足す |
| `README.md` | 現在の状態 | PR11b まで完了に更新する |

`run/units.ts` の JSDoc（33-59 行、62-76 行）も同じコミットで実態に合わせる。

### 決定 8：起動時照合（`reconcileOnStartup`）は変えない

プロセスが落ちた場合、`running` の単位は既に `pending` に戻る（決定 13、テスト R5）。
本 PR が扱うのは「プロセスは生きていて接続だけが切れた」経路なので、照合の側に変更はない。

## 変更するファイル

| ファイル | 変更 |
| --- | --- |
| `packages/server/src/run/units.ts` | `isPendingFailure` / `pendingNote` に `halt` を渡し、判定を決定 1 の形にする。`pendingNote` に 3 本目の文言。呼び出し 2 か所（`executeCheckUnit` 276-282 行、`executeRecheckUnit` 447-453 行）に `outcome.halt` を渡す。JSDoc と不変条件のコメント |
| `packages/server/src/run/*.test.ts` | 新規テスト（下記） |
| `packages/server/src/run/test-support.ts` | 台本の失敗に `status` を渡せるようにする（下記 U9・R4d 用） |
| 計画書 6 本と `README.md` | 決定 7 のとおり |

**`result.ts`・`executor.ts`・`orchestrator.ts` は変更しない**（決定 1 の改訂により、
`UnitFailure` に足すフィールドが無くなったため）。`db/`、`api/`、`shared/`、`packages/web/`、
`packages/cli/` にも触らない。

`isPendingFailure` に渡すのは **executor が返した `outcome.halt`** である。`units.ts` が
`input-too-long` のために合成する `halt`（266-275 行）ではない。合成する側も
`generationUnconfirmed: false` なので結果は同じだが、判定の根拠を「executor がその失敗から
導いた停止理由」に固定しておく。

## テスト

**すべて、直しを戻すと落ちることを確認する（変異検査）。** 特に U9・R4d は
「`connection` を全部 `pending` にする」実装を弾くためのもので、これが落ちなければ意味がない。

**U8・U9 は `halt.generationUnconfirmed` を反転させても落ちること**を確かめる。偽の executor が
返す `failure.reason` だけで通ってしまうと、決定 1 が意図した「halt が判別子である」という
性質を検査できていない（レビュー指摘 1）。

### 単位の層（`run/units.test.ts`。既存は U1〜U7）

- **U8**：`chat` 由来の `connection`（`status: null`）に `treatUnconfirmedAsPending: true` を渡すと、
  単位が `pending` になり、`note` が「応答を受け取らずに接続が切れた。生成終了は未確認」で、
  失敗の事実（`failure.reason === "connection"`、`attempts === 1`）が残ること。
- **U9（判別子）**：同じ `connection` でも `status: 503`（HTTP 応答あり）なら、
  再試行 1 回のあと単位は `failed` のままであること。
- **U10**：`treatUnconfirmedAsPending` を渡さない（CLI 経路）と、`status: null` の `connection` は
  `failed` のままであること（U6 と同じ趣旨の非退行）。
- **U11**：再確認単位でも U8 と同じになること（`executeRecheckUnit` の側の配線）。
- **U12（決定 1 の不変条件）**：保持済みの `halt`（`generationUnconfirmed: true`）がある状態で
  次の単位を実行すると、生成要求を送らずに `origin: "local"` の失敗で返ること。
  ＝**他の単位の `halt` が `chat` 由来の失敗と組になることはない**。決定 1 の判定が
  `halt` を見てよい根拠を固定する。実装は変えないので、既存の挙動の性質を書き留めるテストである。

### オーケストレーターの層（`run/orchestrator.stop.test.ts`。R4b・45-3 の隣に置く）

- **R4c**：生成中に接続が切れる（`connection`・`status: null`）と、
  実行が `recovery-waiting`・`generationUnconfirmed: true`・`stopReason: "connection-lost"` になり、
  **その単位が `pending`**、`pending_note` が決定 5 の文言、`failure.reason` が `connection`、
  `scripted.requests` が 1 件（再試行なし）であること。続けて `resumeRun` を呼ぶと、
  `retryFailedUnits` を**一度も呼ばずに**要求が 2 件目として送られ、単位が `done`、
  実行が `completed` になること（これが「1 段」の意味。既存の 45-3 のテストが手本）。
- **R4d（判別子）**：`connection`・`status: 503` では、再試行 1 回のあと（`scripted.requests`
  は 2 件）実行が `stopped`・`generationUnconfirmed: false` で、単位は `failed` のまま。
  続けて `resumeRun` を呼ぶと `accepted: true` だが、`pending` の単位が無いので新しい要求は
  送られず（`scripted.requests` は 2 件のまま）、実行は `partially-failed` に決着し、
  単位は `failed` のままであること（`loop.ts` の `finalizeRun`）。復旧には
  `retryFailedUnits` が要る＝**この経路は 2 段のままでよい**ことの記録でもある。

### 既存テストの非退行

- `pipeline.test.ts`（E1、P18c）と `packages/cli` のテストを**変更せずに**緑に保つ。
  型の変更が `UnitFailure` に及ばなくなったので、既存のテストリテラルの修正も発生しない。
- `api/leak.test.ts` は変更しない。`pending_note` は固定文言のみになる。

## タスク

小さい PR なので 3 つに分ける。**状態機械（決定 1・3・5）は委譲しない**（ロードマップの担当欄）。

1. **判別の付け替えと単位の層**（Claude）：`units.ts` の変更と U8〜U12、
   `test-support.ts` の `status` 対応。
   完了条件：`pnpm check` が通り、U9・U10 と、`halt` の反転で U8・U9 が落ちること。
2. **オーケストレーターの結合テスト**（サブエージェント可）：R4c・R4d。実装は変えない。
   既存の 45-3 のテストを手本にする。
3. **文書**（Claude）：決定 7 の 6 本と `README.md`。

## やらないこと（MUST NOT）

- 仕様書を改訂しない（決定 6）。
- DB の列・マイグレーション・`api/dto.ts`・`shared/src/api/` を触らない（決定 4）。
- `isRetryable` の判断（HTTP 応答ありの `connection` だけ再試行）を変えない。
- `treatUnconfirmedAsPending` の意味を変えない。待機時間（`recoveryConfirmMs`）を経路の判別子にしない（決定 45-3）。
- CLI（`runPipeline`）の挙動と結果 JSON の形を変えない（`UnitFailure` に項目を足さない。決定 1 の代案）。
- `RunStop.generationUnconfirmed` の決め方（`haltForChatError` / `haltForEnsureLoadedError`）を変えない。
- `packages/web/` を触らない。画面での案内は PR12b の範囲。
- 失敗の事実（`failure_reason` 等）を捨てない（決定 20 の後半）。

## 完了条件

- `pnpm check` が通る（typecheck + lint + test）。テスト総数が減っていないこと。
- 新規テストがすべて変異検査を通る（直しを戻すと落ちる）。
- 決定 7 の文書 4 本と `README.md` が更新されている。
- Windows での実機確認は行わない。本 PR は server の内部状態の話で、Windows 固有の経路
  （ネイティブモジュール、パス、静的配信、Ctrl+C）に触れず、`windows-latest` の CI が
  型検査・lint・テスト・ビルドを毎回通す（`docs/guides/windows-verification.md` 1 節）。
