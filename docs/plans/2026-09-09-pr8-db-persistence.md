# PR8 詳細計画：DB スキーマと永続化（server）

作成日：2026-09-09
状態：計画（未実装）
仕様：`docs/spec/mvp-spec.md`（v0.8）8.1 全体、8.2（永続化する対象）、5.3、5.4、6.3、6.4、6.5、11 節（12・13 項）
前提：`docs/plans/2026-09-07-mvp-roadmap.md` の PR8 節、`docs/reference/invariants.md`、
`docs/decisions/0001-tech-stack.md`、PR1〜PR4（`shared`）、PR7（`server/src/run/`）

## 目標

仕様書 8.1 節の 7 単位（原稿版、検査実行、検査単位、再確認単位、位置診断、指摘、作者の判断）を
SQLite に保存する層を作る。すなわち、

- Drizzle のスキーマ（`db/schema.ts` の置き換え）と、`drizzle-kit generate` が出す SQL のコミット
- 起動時にマイグレーションを適用し、失敗したら API を受け付けずに起動を止める経路（`db/migrate.ts`）
- 単位ごとのリポジトリ（`db/repositories/*.ts`）。読み書きの往復と、再起動をまたぐ保持を保証する

PR9 のオーケストレーションは、PR7 のパイプラインが出す結果をこの層に書き、再開時にはこの層から
検査対象範囲と完了済み単位を読み戻す。本 PR はその「置き場」だけを作り、いつ何を書くかは決めない。

## 対象外（MUST NOT）

- **オーケストレーション・キュー・復旧待ちの制御を書かない**（PR9）。状態列と、状態を条件に
  更新する原子的な操作は用意するが、遷移をいつ起こすかは PR9 が決める。
- **`runPipeline` の引数・戻り値を変えない**（PR9）。保存済み `TargetPlan[]` を注入する口は
  PR9 が設計する。本 PR は「注入できるデータが DB にある」状態までにとどめる。
- **`PipelineResult` を直接受け取るリポジトリを作らない**。保存の入力は本 PR が定義する
  素のレコード型（`db/records.ts`）とし、`PipelineResult` からレコードへの変換は PR9 に置く。
  永続化層が PR7 の結果型に依存すると、再開時（結果型がまだ存在しない時点）に読み戻せない。
- **HTTP API・SSE を作らない**（PR10）。UI からの接続先上書きを保存する `settings` 表も
  本 PR では作らない（ロードマップの「接続先の設定」。PR10 で API と同時に決める）。
- **一括エクスポート形式を決めない**（PR13）。
- **本文を加工しない。** 保存本文は取り込み時点の文字列をそのまま入れる。SQLite に入れる前後で
  改行変換・正規化・trim を一切しない。
- **API キーを保存しない。** `runs` にキーの列を作らない（決定 10）。
- **`chat` の生の応答（`ChatResult.raw`）を保存しない**（決定 9）。
- 検出率などの評価指標を集計しない（PR13）。

## 全体の制約（不変条件から）

- 位置は UTF-16 コード単位、範囲は `[start, end)`。**分割範囲と確定位置の正本は DB に保存した値**で、
  再開時も保存済み範囲を使い、ブラウザの再計算で上書きしない。
- 保存本文は BOM 除外以外の加工をしない。CRLF はそのまま保持する。
- 引用は完全一致でのみ位置を確定する。**診断候補を正式な位置に使わない**ので、診断候補の範囲は
  指摘の位置列に入れず、診断の表にだけ置く。
- 位置特定失敗（`not-found` / `ambiguous`）は一覧表示のために指摘として保存し、
  `outside-target` は診断記録にだけ残す（決定 4）。
- 重複統合は同一の検査実行内に限る。**別実行の候補・再確認結果・採否を混ぜない**（決定 6）。
- 「完了」「一部失敗」「停止中」「実行中」を区別する。未処理範囲がある状態を「問題なし」にしない。
- 失敗・形式不正を指摘ゼロに置き換えない。失敗理由を列として持つ。
- 再確認は作者の採否を上書きしない。初回判定は履歴に残す（決定 5）。
- DB トランザクションに LLM 応答待ちを含めない。トランザクションは短い更新に限る。
- 採否は評価の記録であり、本文への修正適用ではない。本文を書き換える経路を作らない。
- 依存の版は完全固定。相対 import は `.ts` 拡張子付き。scripts は Windows で動く書き方。

## 作るもの

| ファイル | 内容 |
| --- | --- |
| `server/src/db/schema.ts` | Drizzle スキーマ（scaffold の `manuscripts` を置き換え）。9 表 |
| `server/src/db/client.ts` | 既存を拡張。SQLite ハンドルを返し `close()` できるようにする（決定 12） |
| `server/src/db/migrate.ts` | `migrate()` の呼び出しと、マイグレーション SQL の位置解決 |
| `server/src/db/ids.ts` | `createId()`（`crypto.randomUUID()`）。PR9 が採番器として注入する |
| `server/src/db/hash.ts` | `hashBody(text)`。UTF-8 の SHA-256 を小文字 16 進で返す |
| `server/src/db/json.ts` | JSON 列の読み戻し用 zod スキーマと列挙タプル（決定 8） |
| `server/src/db/records.ts` | リポジトリの入出力レコード型（PR7 の結果型に依存しない） |
| `server/src/db/errors.ts` | `MalformedBodyError`（孤立サロゲートの拒否。決定 17） |
| `server/src/db/path.ts` | `resolveDatabaseFile(config)`（決定 2） |
| `server/src/db/repositories/manuscripts.ts` | 原稿版 |
| `server/src/db/repositories/runs.ts` | 検査実行と検査対象（`runs`、`run_targets`） |
| `server/src/db/repositories/check-units.ts` | 検査単位 |
| `server/src/db/repositories/findings.ts` | 元候補と指摘（`candidates`、`findings`） |
| `server/src/db/repositories/rechecks.ts` | 再確認単位 |
| `server/src/db/repositories/diagnostics.ts` | 位置診断 |
| `server/src/db/repositories/judgments.ts` | 作者の判断 |
| `server/src/run/status.ts` | `RunStatus`・`UnitStatus`（DB の状態名。決定 3） |
| `server/src/run/judgment.ts` | `JudgmentStatus`（決定 5） |
| `server/drizzle/*.sql` + `meta/` | `drizzle-kit generate` の出力。コミットする |

既存ファイルの変更：

| ファイル | 変更 |
| --- | --- |
| `server/src/index.ts` | `createApp` の前に `applyMigrations` を呼ぶ（決定 2） |
| `server/src/db/client.test.ts` | 手書きの `CREATE TABLE` を消し、`migrate()` を通す（決定 1・12） |
| `server/src/run/result.ts` | `RunStatus` を `PipelineRunStatus` に改名し `run/status.ts` から導く（決定 3） |
| `server/src/run/events.ts`、`run/pipeline.ts` | 同じ改名への追随 |
| `cli/src/main.ts`、`cli/src/main.test.ts` | 同じ改名への追随（`exitCodeForStatus` の引数型） |

`createApp` の引数は変えない。現状 `app.ts` は DB に触れておらず、DB ハンドルを渡すのは
API を作る PR10 の変更になる。

### 表と仕様書 8.1 の対応

| 仕様書 8.1 の単位 | 表 |
| --- | --- |
| 原稿版 | `manuscript_versions` |
| 検査実行 | `runs` |
| （8.2「再開では保存済み範囲を使う」） | `run_targets` |
| 検査単位 | `check_units` |
| （6.4「元候補」） | `candidates` |
| 再確認単位 | `recheck_units` |
| 位置診断 | `diagnostics` |
| 指摘 | `findings` |
| 作者の判断 | `judgments` |

`run_targets` と `candidates` は 8.1 の表に単独の行としては現れないが、
前者は 8.2 の「分割範囲を保存し再開で使う」、後者は 8.1 の指摘の項目「元候補への参照」と
「再確認前の候補と撤回理由も保存し、再確認による見逃し増加を評価できるようにする」を満たすために要る。

## スキーマ

以下は列の一覧であり、SQL の正本は `drizzle-kit generate` の出力とする。
すべての表に `id TEXT PRIMARY KEY`（決定 7）を置き、参照には `ON DELETE` を指定しない（決定 13）。

### `manuscript_versions`

| 列 | 型 | 備考 |
| --- | --- | --- |
| `id` | text PK | |
| `name` | text not null | 原稿名 |
| `body` | text not null | 保存本文。BOM 除外以外は無加工 |
| `body_hash` | text not null | UTF-8 の SHA-256（小文字 16 進） |
| `created_at` | integer(timestamp_ms) not null | |

### `runs`

| 列 | 型 | 備考 |
| --- | --- | --- |
| `id` | text PK | |
| `manuscript_version_id` | text not null → `manuscript_versions.id` | |
| `model_id` | text not null | モデル ID の正本。`generation_settings` には入れない（決定 11） |
| `model_info` | text(json) nullable | `ensureLoaded` が返した `ModelInfo`。量子化・コンテキスト長 |
| `endpoint_url` | text not null | 接続先のルート URL。**API キーは持たない**（決定 10） |
| `generation_settings` | text(json) not null | `Omit<GenerationSettings, "model">`。既定値を DB 側に置かない（決定 11） |
| `chunk_settings` | text(json) not null | `ChunkSettings` |
| `timeouts` | text(json) not null | `{ checkMs, recheckMs }`。再開で設定を変えないため実行に紐づけて保存する |
| `perspectives` | text(json) not null | 観点の配列 |
| `recheck_enabled` | integer(boolean) not null | 再確認の有無（決定 3 の補足） |
| `allowed_words` | text(json) not null | 分割・trim 済みの配列 |
| `allowed_word_rule_version` | text not null | |
| `prompt_version` | text not null | |
| `diagnostic_transform_version` | text not null | |
| `status` | text not null | `RunStatus`（決定 3） |
| `stop_reason` | text nullable | `StopReason` |
| `stop_message` | text nullable | |
| `generation_unconfirmed` | integer(boolean) not null default 0 | PR9 の「復旧待ち」の入口 |
| `start_operation_id` | text nullable | 開始操作の識別子。一意制約（決定 14） |
| `started_at` | integer(timestamp_ms) not null | |
| `finished_at` | integer(timestamp_ms) nullable | |

一意制約：`(start_operation_id)`、および複合外部キーの参照先として `(id, manuscript_version_id)`（決定 16）。

### `run_targets`

| 列 | 型 | 備考 |
| --- | --- | --- |
| `id` | text PK | |
| `run_id` | text not null → `runs.id` | |
| `target_index` | integer not null | 実行内で 0 始まり。`(run_id, target_index)` に一意制約 |
| `target_start` / `target_end` | integer not null | 検査対象範囲（UTF-16、`[start, end)`） |
| `context_before_start` / `context_before_end` | integer nullable | 参考文脈（前）。無ければ両方 null |
| `context_after_start` / `context_after_end` | integer nullable | 参考文脈（後） |
| `input_start` / `input_end` | integer not null | 初回検査の入力範囲 |
| `paragraph_ids` | text(json) not null | 段落 ID の配列 |

一意制約：`(run_id, target_index)`、`(id, run_id)`（決定 16）。

### `check_units`

| 列 | 型 | 備考 |
| --- | --- | --- |
| `id` | text PK | |
| `run_id` | text not null → `runs.id` | |
| `target_id` | text not null | `(target_id, run_id)` → `run_targets(id, run_id)`（決定 16） |
| `perspective` | text not null | |
| `status` | text not null | `UnitStatus`（決定 3） |
| `attempts` | integer not null default 0 | 送信した生成要求の回数 |
| `failure_reason` / `failure_message` / `failure_finish_reason` / `failure_origin` | text nullable | `UnitFailure` |
| `pending_note` | text nullable | 未完了の理由（未送信、停止、アンロードなど） |
| `usage` | text(json) nullable | `Usage` |
| `input_graphemes` | integer nullable | 換算係数の実測用 |
| `elapsed_ms` | integer nullable | |
| `started_at` / `finished_at` | integer(timestamp_ms) nullable | |

一意制約：`(target_id, perspective)`、`(id, run_id)`（決定 16）。

### `candidates`（元候補）

| 列 | 型 | 備考 |
| --- | --- | --- |
| `id` | text PK | |
| `run_id` | text not null → `runs.id` | |
| `check_unit_id` | text not null | `(check_unit_id, run_id)` → `check_units(id, run_id)`（決定 16） |
| `finding_id` | text nullable | `(finding_id, run_id)` → `findings(id, run_id)`。統合先。`outside-target` は null（決定 4） |
| `candidate_index` | integer not null | 実行内で 0 始まりの生成順。`(run_id, candidate_index)` に一意制約（決定 19） |
| `llm` | text(json) not null | `LlmFinding` をそのまま。引用を破壊しない |
| `locate_status` | text not null | `located` / `not-found` / `ambiguous` / `outside-target` |
| `start` / `end` | integer nullable | `located` のときだけ非 null |
| `merge_key` | text nullable | `mergeKey()` の値。修正案なしは null |
| `created_at` | integer(timestamp_ms) not null | |

観点の列は置かない。`check_unit_id` から辿れば一意に決まり、列を持つと `check_units.perspective` と
二重管理になるため（決定 19）。
一意制約：`(id, run_id)`、`(run_id, candidate_index)`（決定 19）。

### `findings`（指摘）

| 列 | 型 | 備考 |
| --- | --- | --- |
| `id` | text PK | |
| `run_id` | text not null → `runs.id` | |
| `manuscript_version_id` | text not null | `(run_id, manuscript_version_id)` → `runs(id, manuscript_version_id)`（決定 16） |
| `target_id` | text not null | `(target_id, run_id)` → `run_targets(id, run_id)`（決定 16） |
| `locate_status` | text not null | `located` / `not-found` / `ambiguous` |
| `start` / `end` | integer nullable | 位置特定失敗では null（8.1「未確定可」） |
| `paragraph_id` | integer not null | 位置確定時は本文から導いた段落、失敗時は候補の申告値（決定 15） |
| `quote` | text not null | |
| `suggestion` | text nullable | |
| `category` | text not null | 統合後の分類 |
| `initial_verdict` | text not null | 初回判定。再確認で上書きしない（決定 5） |
| `merge_key` | text nullable | `(run_id, merge_key)` に部分一意索引（決定 6） |
| `suppression_word` / `suppression_rule_version` | text nullable | 許容語抑制の理由。抑制なしは null |
| `created_at` | integer(timestamp_ms) not null | |

指摘の「理由」の列は置かない。`MergedFinding` に `reason` がなく、統合元ごとに違いうるため、
読み出し時に元候補から組み立てる（決定 18）。
一意制約：`(run_id, merge_key)` の部分索引（決定 6）、`(id, run_id)`（決定 16）。

### `recheck_units`

| 列 | 型 | 備考 |
| --- | --- | --- |
| `id` | text PK | 再確認の固有 ID（仕様 6.5。PR7 からの持ち越し） |
| `run_id` | text not null → `runs.id` | |
| `finding_id` | text not null | `(finding_id, run_id)` → `findings(id, run_id)`（決定 16）。一意制約（1 指摘に 1 件） |
| `input_start` / `input_end` | integer nullable | 入力を組み立てる前に終わったら null |
| `status` | text not null | `UnitStatus` |
| `not_applicable_reason` | text nullable | `disabled` / `suppressed` / `unlocated` |
| `attempts` | integer not null default 0 | |
| `failure_reason` / `failure_message` / `failure_finish_reason` / `failure_origin` | text nullable | |
| `pending_note` | text nullable | |
| `verdict` | text nullable | `RecheckVerdict` |
| `reason_kind` | text nullable | `RecheckReasonKind` |
| `reason` | text nullable | |
| `suggestion_valid` | integer(boolean) nullable | |
| `usage` | text(json) nullable | |
| `input_graphemes` / `elapsed_ms` | integer nullable | |
| `started_at` / `finished_at` | integer(timestamp_ms) nullable | |

仕様 8.1 の指摘の項目「再確認結果」は、`findings` に列を複製せず
`recheck_units.finding_id` の関連で表す（決定 5）。

### `diagnostics`（位置診断）

| 列 | 型 | 備考 |
| --- | --- | --- |
| `candidate_id` | text PK | `(candidate_id, run_id)` → `candidates(id, run_id)`（決定 16）。1 候補に 1 件 |
| `run_id` | text not null → `runs.id` | |
| `quote` | text not null | LLM の引用 |
| `reason` | text not null | `LocateFailureReason` |
| `search_start` / `search_end` | integer not null | 照合に使った `inputRange` |
| `exact_matches` | text(json) not null | 絞り込み後に残った完全一致の範囲。採用位置には使わない |
| `transform_version` | text nullable | `not-found` のときだけ非 null |
| `transform_candidates` | text(json) nullable | `DiagnosticCandidate[]`（最大 3 件） |
| `omitted` | integer nullable | 打ち切り件数 |
| `tied` | integer(boolean) nullable | 同順位あり |

### `judgments`（作者の判断）

| 列 | 型 | 備考 |
| --- | --- | --- |
| `finding_id` | text PK → `findings.id` | 指摘 1 件につき必ず 1 行（決定 5） |
| `status` | text not null | `JudgmentStatus`（決定 5） |
| `note` | text nullable | 任意メモ |
| `updated_at` | integer(timestamp_ms) not null | |

## 設計上の決定

### 決定 1：scaffold の `manuscripts` 表は置き換える

`db/schema.ts` の `manuscripts` は動作確認用で、稼働中の DB は存在しない。
移行 SQL を書かず、初回のマイグレーションを新しい 9 表の `CREATE TABLE` にする。
`db/client.test.ts` の手書き `CREATE TABLE` も消し、`migrate()` を通す形に直す。

### 決定 2：マイグレーションは起動時、API 受付前

`db/migrate.ts` に `applyMigrations(db)` を置き、`drizzle-orm/better-sqlite3/migrator` の
`migrate(db, { migrationsFolder })` を呼ぶ（同期関数。0.45.2 の型定義で確認済み）。
`migrationsFolder` は **モジュール基準で解決する**（`path.join(import.meta.dirname, "../../drizzle")`）。
`pnpm dev` をリポジトリ直下から実行する場合と `packages/server` で `node src/index.ts` する場合で
カレントディレクトリが違い、cwd 基準だと片方が壊れるため。
`src/index.ts` では `createApp` の前に呼び、例外は捕まえずに（接続先 URL・API キーを出さずに）
プロセスを非ゼロ終了させる。

DB ファイルは `db/path.ts` の `resolveDatabaseFile(config)` で `path.join(config.dataDir, "shuten.db")`
に固定する。`dataDir` は既に `config.ts` が `SHUTEN_DATA_DIR`（既定 `.data`）から絶対パスに解決していて、
`index.ts` が `mkdirSync` している。`.gitignore` は `.data/` と `*.db` の両方を除外済み。
`createApp` の引数は本 PR では変えない（DB ハンドルを渡すのは PR10）。

### 決定 3：状態名は DB の 5 値、パイプラインの 3 値はその部分集合

`server/src/run/status.ts` に置く（ロードマップの共通語彙どおり server 側）。

```ts
export const RUN_STATUSES = ["running", "stopped", "recovery-waiting", "completed", "partially-failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const UNIT_STATUSES = ["pending", "running", "done", "failed", "not-applicable"] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];
```

PR7 の `run/result.ts` は `RunStatus` を独自に 3 値で定義しているので、
`PipelineRunStatus = Extract<RunStatus, "completed" | "partially-failed" | "stopped">` に改名して
`status.ts` から導く。`pipeline.ts` と `packages/cli` の参照も同時に直す（機械的な改名）。
これで DB の列挙とパイプラインの結果が 1 つの定義から出る。

`PipelineMode`（`split` / `split-recheck` / `full-text`）は `runs` に保存しない。
`full-text` は評価 CLI だけの経路で、UI が切り替えるのは再確認の有無だから、
`recheck_enabled` を持つ。CLI の実行を DB に入れる予定は本 PR にはない。

### 決定 4：位置特定失敗の置き場

| `LocateResult` | `candidates` | `findings` | `diagnostics` |
| --- | --- | --- | --- |
| `located` | 1 行（`finding_id` あり） | 統合先に 1 行 | なし |
| `not-found` | 1 行（`finding_id` あり） | 1 行（`locate_status = not-found`、位置は null） | 1 行（変換候補あり） |
| `ambiguous` | 1 行（`finding_id` あり） | 1 行（`locate_status = ambiguous`、位置は null） | 1 行（変換候補は null） |
| `outside-target` | 1 行（`finding_id` は null） | **作らない** | 1 行（変換候補は null） |

`not-found` / `ambiguous` は一覧に出すので指摘として保存する。
`outside-target` は通常一覧に出さないので指摘を作らず、候補と診断だけ残す。
`LocateResult.diagnostic` は `not-found` のときだけ非 null（PR3）なので、
`transform_version` などが非 null になるのも `not-found` だけ。

位置特定失敗の候補は統合・抑制・再確認に進まないため、`merge_key` は null、
`suppression_*` は null、`recheck_units` は `not-applicable`（`not_applicable_reason = "unlocated"`）で作る。
これは指摘の行がある `not-found` / `ambiguous` に限る。`outside-target` は指摘を作らないので
`recheck_units`（`finding_id` は not null）の行も作らない。

### 決定 5：初回判定・再確認・採否を別の場所に置く

- 初回判定は `findings.initial_verdict` に残し、再確認で書き換えない。
- 再確認の結果は `recheck_units` にだけ入れる。表示上の最終判定は読み出し側が組み立てる（PR12）。
- 採否は `judgments` に 1 指摘 1 行。再確認の書き込みは `judgments` に触れない。

`JudgmentStatus` は `server/src/run/judgment.ts` に置く。

```ts
export const JUDGMENT_STATUSES = ["undecided", "adopt-planned", "rejected", "held"] as const;
export type JudgmentStatus = (typeof JUDGMENT_STATUSES)[number];
```

`adopt-planned` としたのは、仕様が「採用予定」は本文への修正適用ではないと繰り返し
強調しているため（5.3、不変条件）。`adopt` だと適用したように読める。

**指摘を作るときに `undecided` の行を必ず一緒に作る**。未判断の表し方を「行なし」と `undecided` の
2 通りにすると読み出し側が両方を扱うことになるので、常に 1 指摘 1 行にする。
未判断へ戻す操作も行を消さず `undecided` に更新し、`updated_at` を残す。

### 決定 6：`mergeKey` は実行 ID で名前空間を切る

`findings.merge_key` に `(run_id, merge_key)` の部分一意索引を張る（`WHERE merge_key IS NOT NULL`）。
`mergeKey()` の鍵は実行 ID を含まないので、索引で実行をまたいだ統合を構造的に禁じる。
修正案なしの候補は統合しない（鍵が null）ので、部分索引にして複数行を許す。

索引は**安全網であって合流の手段ではない**。PR9 の失敗観点の再試行では、
先に `(run_id, merge_key)` で既存の指摘を引いて候補を紐づけ、無ければ新しい指摘を作る。
索引は、その手順を飛ばして二重に作ろうとしたときに失敗させるためにある。

部分索引は `uniqueIndex()` の `.on(...)` に `.where(...)` を続けて書く（条件は `merge_key is not null`）。
`drizzle-orm@0.45.2` の `sqlite-core/indexes.d.ts` に `where(condition: SQL)` があることは確認した。
`drizzle-kit@0.31.10` が生成 SQL に `WHERE` を出すかは実装時に生成結果を見て確かめ、
出ないようなら `drizzle-kit generate --custom` で索引だけ手書きの SQL にする。

### 決定 7：ID は `crypto.randomUUID()` の文字列

ロードマップの提案どおり。`db/ids.ts` の `createId()` に 1 本化し、PR9 がこれを
PR7 の `createCandidateId` / `createFindingId` に注入する。
PR7 の既定（`c1`, `c2`, …）はテストの決定性のための既定値で、DB を使う経路では置き換わる。

### 決定 8：JSON 列と通常列の使い分け

- **通常列**：問い合わせ・更新の対象になるもの。状態、試行回数、位置、判定、採否。
  位置を JSON に入れないのは、位置が正本であり SQL から直接検査できる形にしておきたいため。
- **JSON 列**：実行中に変わらず、まとめて読み書きするだけのもの。
  `chunk_settings`、`generation_settings`、`perspectives`、`allowed_words`、`model_info`、
  `paragraph_ids`、`usage`、`llm`、`exact_matches`、`transform_candidates`。

JSON 列の読み戻しは `db/json.ts` の zod スキーマを必ず通す（`JSON.parse` の結果を
そのまま型付けしない）。スキーマは `shared` が公開している列挙タプル
（`FINDING_CATEGORIES`、`INITIAL_VERDICTS` など）から組み、
`satisfies z.ZodType<LlmFinding>` を付けて型のずれをコンパイル時に落とす。
`Perspective` のタプルは `shared` が公開していないので `db/json.ts` に置く
（`["typo", "naturalness"] as const satisfies readonly Perspective[]`）。

### 決定 9：`ChatResult.raw` を保存しない

仕様 8.1 の項目に生の応答はない。保存すると、PR7 が持ち越した
`truncateRaw` の 2,000 文字境界（UTF-16 単位で切るため孤立サロゲートが残りうる）が
そのまま DB に入る経路になる。本 PR は `raw` を保存せず、`usage`・`finish_reason`・
失敗理由だけを残すことで、この持ち越しを開かないまま閉じる。
`truncateRaw` 自体は例外メッセージ用に残す（現状どおり結果 JSON には出ない）。

### 決定 10：接続先 URL は保存し、API キーは保存しない

仕様 8.1 の検査実行の項目に「接続先」がある。同じ節が「API キーを検査履歴に含めない」と
言っているので、`endpoint_url` は持ち、キーの列は作らない。
PR7 で決めた「接続先 URL を結果 JSON・標準出力・標準エラーに出さない」は出力側の規則で、
DB への保存はこれに当たらない。エクスポート時の伏せ方は PR13 で決める。

`parseLmStudioUrl`（`config.ts`）は資格情報付き URL を拒否済みなので、
`endpoint_url` にパスワードが混ざる経路はない。

### 決定 11：生成設定に DB 既定値を置かない

`generation_settings` は JSON 列にして `DEFAULT` を付けない。
`temperature`・`reasoningEffort`・`maxTokens` は仕様書 13 節の未決事項であり、
スキーマに既定値を書くと DB 側で勝手に確定してしまう。値は常に呼び出し側が明示する。

モデル ID は `runs.model_id` だけに置き、JSON には入れない（`Omit<GenerationSettings, "model">`）。
`GenerationSettings.model` をそのまま JSON にすると `model_id` と二重管理になり、
食い違ったときにどちらを使うかが決まらない。読み出しでは `model_id` を足して
`GenerationSettings` に戻す。

### 決定 12：`createDatabase` は `close()` できる形にする

再起動を模したテスト（一度閉じて開き直す）に SQLite ハンドルが要る。

```ts
export interface AppDatabaseHandle {
  readonly db: BetterSQLite3Database<typeof schema>;
  close(): void;
}
export function createDatabase(file: string): AppDatabaseHandle
```

WAL のまま開いたファイルを Windows で開き直せないことがあるので、テストは必ず `close()` してから開く。
既存の `AppDatabase` 型は `handle.db` の型に読み替える（`client.test.ts` を直す）。

### 決定 13：外部キーは `ON DELETE` を指定しない

MVP に実行・原稿版の削除機能はなく（仕様 3.2）、削除の経路を作らない。
`CASCADE` を書くと「消せる」という設計上の含みが入るので付けない。
`foreign_keys = ON` は既に `client.ts` で設定済みで、参照違反は例外になる。

### 決定 14：状態の条件付き更新を永続化層に置く

仕様 8.2 の「同一処理を同時に取得・実行しない」を満たすには、
「今の状態が期待どおりのときだけ次の状態にする」更新が要る。

```ts
// check-units.ts / rechecks.ts
function claimUnit(db, id: string, from: UnitStatus, to: UnitStatus): boolean
// UPDATE ... SET status = to WHERE id = id AND status = from。更新行数が 1 なら true
```

検査実行の状態（`running` → `stopped`、再開時の `stopped` → `running`）にも同じ守りが要るので、
`runs.ts` に `claimRun(db, id, from: RunStatus, to: RunStatus): boolean` を置く。

二重送信の防止（仕様 8.2「同じ開始操作の重複送信を重複登録しない」）は、
`runs.start_operation_id` の一意制約で表す。同じ識別子で 2 回目の実行を作ろうとすると
一意制約違反になり、呼び出し側は既存の実行を引き直す。
仕様が明示するとおり、原稿版と設定の一致は二重送信の判定に使わないので、
これらの列に一意制約は付けない。

これらは永続化の原始操作なので本 PR に置く。いつ呼ぶか（キューの取り出し、
再開と新規開始の区別、識別子の発行）は PR9。

### 決定 15：`findings.paragraph_id` は位置確定の有無で出所が変わる

`MergedFinding`（PR4）は `paragraphId` を持たない（`{ id, range, quote, category, suggestion, verdict, sources }`）。
`mergeKey` も段落 ID を含まないので、統合された複数の候補が別々の段落 ID を申告していることがありうる。
そこで `findings.paragraph_id` の決め方を分ける。

- `located`：**保存本文から導く**。`start` を含む段落の ID。LLM の申告ではなく事実。
- `not-found` / `ambiguous`：候補は 1 件なので、その候補が申告した段落 ID をそのまま入れる
  （位置が確定していない以上、本文から導けない）。

いずれの場合も、LLM が申告した生の値は `candidates.llm` に残っているので情報は失われない。

### 決定 16：実行をまたぐ参照を複合外部キーで塞ぐ

`run_id` と親の ID を別々の外部キーにすると、実行 A の候補を実行 B の指摘に紐づけられてしまう。
不変条件「重複統合は同一の検査実行内に限る。別実行の候補・再確認結果・採否を混ぜない」を
DB の制約として表すため、子は `(親 ID, run_id)` の**複合外部キー**で親を参照する。
参照先には `(id, run_id)` の一意制約を置く（SQLite は親側に UNIQUE 索引を要求する）。

| 子 | 参照 |
| --- | --- |
| `run_targets` | `(run_id)` → `runs(id)` |
| `check_units` | `(target_id, run_id)` → `run_targets(id, run_id)` |
| `candidates` | `(check_unit_id, run_id)` → `check_units(id, run_id)`、`(finding_id, run_id)` → `findings(id, run_id)` |
| `findings` | `(target_id, run_id)` → `run_targets(id, run_id)`、`(run_id, manuscript_version_id)` → `runs(id, manuscript_version_id)` |
| `recheck_units` | `(finding_id, run_id)` → `findings(id, run_id)` |
| `diagnostics` | `(candidate_id, run_id)` → `candidates(id, run_id)` |

`candidates.finding_id` は null を許すが、SQLite の複合外部キーは既定（MATCH SIMPLE）で
どれか 1 列でも null なら制約を検査しないので、`outside-target` の行は通る。

`findings.manuscript_version_id` は `run_id` から辿れば導けるが、仕様 8.1 が指摘の項目として
挙げているので列として持ち、`runs` との複合参照で食い違いを起こせなくする。

SQLite の外部キーは既定で即時検査なので、書き込みの順序が決まる。
`runs` → `run_targets` → `check_units` → `findings`（と `judgments`）→ `candidates` → `diagnostics` → `recheck_units`。
`candidates.finding_id` が `findings` を指すので、統合結果を先に書いてから候補を書く
（候補を先に書いて後から `finding_id` を更新する形でもよい。リポジトリはどちらでも通るようにし、
1 つの検査対象分をまとめて 1 トランザクションで書く）。

`drizzle-orm` の `foreignKey({ columns, foreignColumns })` は複数列を取れる
（`sqlite-core/foreign-keys.d.ts` の `TColumns extends [AnySQLiteColumn, ...AnySQLiteColumn[]]`）。
生成 SQL に `FOREIGN KEY (a, b) REFERENCES t(x, y)` が出ることは、決定 6 の部分索引と一緒に
生成結果を見て確認する。

### 決定 17：孤立サロゲートを持つ本文は永続化層が拒否する

`ingestUtf8Bytes` は厳密デコードなので孤立サロゲートを作らないが、PR10 の貼り付け経路は
JS 文字列を受け取る。better-sqlite3 は JS 文字列を UTF-8 にして書くため、孤立サロゲートは
U+FFFD に置き換わり、「保存本文は BOM 除外以外を加工しない」に反した保存になる。
さらに、置換前にハッシュを取ると `body` と `body_hash` も食い違う。

そこで、原稿版を保存する入口で `body.isWellFormed()`（Node 20 以降。Node 24 で確認済み）を検査し、
false なら `MalformedBodyError` を投げて行を作らない。ハッシュは検査を通った後に計算する。
PR10 の API 入力でも検証してよいが、永続化層自身がこの不変条件を守る。

### 決定 18：指摘の「理由」は列にせず元候補から組み立てる

`MergedFinding`（PR4）に `reason` はなく、統合された元候補は別々の理由を返しうる
（`mergeKey` は範囲・引用・修正案だけで、理由を含まない）。
代表値を 1 つ選ぶと、どの候補の理由かが読み出し側から分からなくなる。

`findings` に `reason` 列を置かず、読み出しレコードに
`reasons: readonly { candidateId: string; perspective: Perspective; reason: string }[]` を持たせ、
`candidates.llm.reason` から `candidate_index` の昇順で組み立てる（決定 19）。
`perspective` は `check_units` との結合で導く。位置特定失敗の指摘は候補 1 件なので 1 要素になる。
仕様 5.4 の「指摘理由」は表示項目であり、正本は元候補の理由（8.1 の「元候補への参照」）だと読む。

### 決定 19：元候補の順序は列で持ち、観点は持たない

決定 18 が「候補の順」で理由を並べる以上、順序を復元できなければならない。
`created_at` は同一ミリ秒になりうるし、ID は UUID（決定 7）なので並び順に使えない。
`candidates.candidate_index`（実行内で 0 始まりの生成順）を持ち、`(run_id, candidate_index)` を一意にする。
`mergeCandidates` は入力順に依存して統合先を決める（最初の元候補の順で並ぶ）ので、
この列はパイプラインが候補を作った順そのものにする。

逆に `candidates.perspective` は持たない。`check_unit_id` から一意に決まるうえ、
列として持つと `check_units.perspective` と食い違いうる。読み出しでは結合して導く。

## レビューで決着した点（2026-09-09）

計画の初稿で判断を保留した 8 点は、設計レビューで次のとおり決着した。

| # | 論点 | 決着 |
| --- | --- | --- |
| 1 | 8.1 にない `run_targets` を足すか | 足す。保存済み範囲の正本として必要 |
| 2 | 8.1 にない `candidates` を足すか | 足す。元候補と撤回理由の保持に必要 |
| 3 | 「再確認結果」を列でなく関連で表すか | 関連で表す。`findings` への複製はしない（決定 5） |
| 4 | 対象外でも `recheck_units` を作るか | 作る。対象外理由を書く場所になる（決定 4） |
| 5 | `endpoint_url` を保存するか | 保存する。8.1 の要求で、ローカル DB への保存は PR7 の出力制限と矛盾しない（決定 10） |
| 6 | 「未判断」を行なしと `undecided` の 2 通りで表すか | **表さない**。指摘の作成時に `undecided` の行を必ず作り、常に 1 指摘 1 行にする（決定 5 を修正） |
| 7 | 位置確定時の段落 ID を本文から導くか | 導く（決定 15）。`findings` の表の説明も直した |
| 8 | `start_operation_id` を本 PR で持つか | 持つ。一意制約まで初回マイグレーションに含める（決定 14） |

あわせて、初稿の 4 つの欠陥を指摘されたので直した。

| 指摘 | 対応 |
| --- | --- |
| `run_id` と親 ID が独立した外部キーで、実行をまたぐ参照を止められない | 決定 16（複合外部キー）を追加 |
| 孤立サロゲートの保存を PR10 に先送りしていた（本文が U+FFFD に変わり、`body_hash` とも食い違う） | 決定 17（永続化層で拒否）を追加。テスト R1b を「保存に失敗し行が残らない」に変更 |
| `findings.reason` の導出規則がなかった（`MergedFinding` に `reason` がない） | 決定 18（列を置かず元候補から組み立てる）を追加 |
| `runs.model_id` と `generation_settings.model` の二重管理 | 決定 11 で JSON 側から `model` を外した |

さらに 2 巡目のレビューで 3 点を追加した。

| 指摘 | 対応 |
| --- | --- |
| 元候補の順序を復元できない（`created_at` は同一ミリ秒がありうる、ID は UUID） | 決定 19。`candidate_index` を追加 |
| 再起動後の再開テストが初回検査だけで、再確認を見ていない | テスト D2 に `recheck_units` を追加 |
| `candidates.perspective` が `check_units.perspective` と二重管理 | 決定 19。候補側の列を削除し結合で導く |

## PR9・PR10・PR13 への持ち越し

- 保存済み `TargetPlan[]` を `runPipeline` に渡す口の設計と、`target-planned` イベント（PR9）。
  本 PR は `run_targets` を作るところまでで、パイプライン側の入口は触らない。
- 生成終了の確認と上限付き待機（`recovery-waiting` への遷移）の制御（PR9）。
  本 PR は列（`status`、`generation_unconfirmed`）だけ用意する。
- UI からの接続先上書きを保存する `settings` 表（PR10）。
- `LmStudioClient` の `close()` / `dispose()`（PR10。PR7 からの持ち越し）。
- 一括エクスポート形式と、そこでの接続先 URL の扱い（PR13）。
- **貼り付け経路の孤立サロゲートを API 側でも弾くか**（PR10）。本 PR は決定 17 で
  永続化層が拒否するようにしたので保存は守られる。ユーザーに何を返すかは PR10 で決める。
- `truncateRaw` のサロゲートペア境界（PR7 からの持ち越し）は、決定 9 により
  **本 PR で永続化の経路を開かないことで閉じる**。`raw` を保存する必要が出たら再検討する。

## テスト

`packages/server/src/db/*.test.ts` に置く（規約どおりソースと同じディレクトリ）。
DB を使うテストは通常の `pnpm test` で走る（LM Studio に依存しない）。

### M：マイグレーション（`migrate.test.ts`）

| # | 内容 |
| --- | --- |
| M1 | メモリ DB に `applyMigrations` を適用でき、`sqlite_master` に 9 表がすべてある（`__drizzle_migrations` も作られるので、表の総数ではなく 9 表の存在を検査する） |
| M2 | 二度適用しても失敗しない（冪等） |
| M3 | 解決した `migrationsFolder` が絶対パスで、`packages/server/drizzle` を指す（vitest は既定でワーカースレッドで走り `process.chdir` が使えないため、cwd を変える形では検査しない） |

### S：スキーマの制約（`schema.test.ts`）

| # | 内容 |
| --- | --- |
| S1 | 存在しない `run_id` で `check_units` を挿入すると外部キー違反で例外（`foreign_keys = ON` の確認） |
| S2 | 同じ `run_id` で同じ `merge_key` の `findings` を 2 行入れると一意制約違反 |
| S3 | 別の `run_id` なら同じ `merge_key` を入れられる（実行ごとの名前空間） |
| S4 | `merge_key` が null の `findings` は同じ実行に何行でも入る（部分索引） |
| S5 | 同じ `target_id` と同じ `perspective` の `check_units` を 2 行入れると一意制約違反 |
| S6 | 同じ `finding_id` の `recheck_units` を 2 行入れると一意制約違反 |
| S6b | 同じ `start_operation_id` の `runs` を 2 行入れると一意制約違反。null は何行でも入る |
| S8 | 実行 A の候補に実行 B の指摘の ID を入れると外部キー違反（決定 16） |
| S9 | 実行 A の検査単位に実行 B の検査対象の ID を入れると外部キー違反 |
| S10 | `findings.manuscript_version_id` に `runs` と違う原稿版 ID を入れると外部キー違反 |
| S11 | `candidates.finding_id` が null なら（`outside-target`）複合外部キーを通る |
| S12 | 同じ `run_id` で同じ `candidate_index` の候補を 2 行入れると一意制約違反。別実行なら入る |
| S7 | `runs` の挿入型に API キーの列がない（型レベル。`@ts-expect-error` で確認） |

### R：リポジトリの往復

| # | 内容 |
| --- | --- |
| R1 | 原稿版：CRLF・単独 CR・本文中の U+FEFF・サロゲートペア・異体字セレクタ・ZWJ 絵文字を含む本文がそのまま戻る |
| R1b | 原稿版：孤立サロゲートを含む本文の保存が `MalformedBodyError` になり、DB に行が残らない（決定 17） |
| R2 | 原稿版：`body_hash` が CRLF 版と LF 版で異なる（改行が本文の一部であることの確認） |
| R3 | 検査実行：`chunk_settings`・`generation_settings`・`allowed_words`・`model_info` が値として往復する |
| R4 | 検査実行：`model_info` が null でも往復する |
| R5 | 検査対象：`[start, end)` と `paragraph_ids` が往復し、参考文脈なし（両側 null）も表せる |
| R6 | 検査単位：`pending` → `running` → `done` の更新で `attempts` と `usage` が保たれる |
| R7 | 検査単位：`failed` で `failure_reason` / `origin` / `finish_reason` が往復し、`FailureReason` の全値を入れられる |
| R8 | 元候補：`llm`（`LlmFinding`）が往復し、引用が 1 文字も変わらない |
| R9 | 指摘：位置特定失敗（`not-found`）で `start` / `end` が null のまま保存・取得できる |
| R10 | 指摘：`outside-target` の候補には `findings` の行を作らない（決定 4 の表どおりに書く関数の検査） |
| R11 | 再確認：`done` で `verdict` / `reason_kind` / `suggestion_valid` が往復する |
| R12 | 再確認：`not-applicable` で `not_applicable_reason` の 3 値がそれぞれ保存できる |
| R13 | 位置診断：`transform_candidates` が最大 3 件・`range: null` を含む形で往復し、`ambiguous` では null |
| R14 | 採否：同じ指摘に 2 回書いても行は 1 つで、`updated_at` が更新される |
| R15 | 採否：指摘を作ると `undecided` の行が必ずでき、`undecided` に戻しても行が残る |
| R16 | `claimUnit` は状態が一致するときだけ true を返し、二度目は false（同時取得の防止） |
| R16b | `claimRun` も同じ（`running` → `stopped` は 1 回だけ成功する） |
| R17 | 指摘の読み出しに再確認結果と採否が付き、再確認の書き込みが採否を変えない |
| R18 | 指摘の読み出しの `reasons` が、理由の異なる 2 候補を統合した指摘で 2 要素になり、`candidate_index` の昇順に並ぶ（挿入順を逆にしても並びが変わらないことを確認する。決定 18・19） |
| R18b | `reasons` の `perspective` が `check_units` との結合で入る（候補側に列がない。決定 19） |
| R19 | 検査実行の読み出しで `GenerationSettings` に `model_id` が入って戻る（決定 11） |

### D：再起動をまたぐ保持（`persistence.test.ts`）

| # | 内容 |
| --- | --- |
| D1 | 一時ディレクトリのファイル DB に書いて `close()` し、開き直して同じ値が読める |
| D2 | 開き直した後に未完了（`pending` / `running`）の**検査単位と再確認単位の両方**を実行 ID で列挙できる（仕様 8.2 は初回検査と再確認の両方を再開対象にしている。PR9 の再開の材料） |

D1・D2 は WAL ファイルを含めて閉じてから開く。**Windows では未確認**（CI の
`check (windows-latest)` で確認し、落ちたら PR 本文に書く）。

### J：JSON 列（`json.test.ts`）

| # | 内容 |
| --- | --- |
| J1 | 未知のキーを含む JSON を読み戻したときの扱いが決まっている（`llm` は未知キーを捨てる） |
| J2 | 列挙にない `category` の JSON を読むと例外（黙って通さない） |
| J3 | 壊れた JSON 文字列を読むと例外 |

## 進め方

1. 本計画のレビューは完了（「レビューで決着した点」）。以降は決定 1〜18 に従う。
2. 着手前に 2 点だけ確かめる：`.gitignore` が `drizzle/` を除外していないこと（現状していない）、
   `import.meta.dirname` が現在の TS 設定と `@types/node` で型付くこと。
3. `db/schema.ts` を書き、`pnpm --filter @shuten/server db:generate` で SQL を生成してコミット。
   生成された索引の SQL に `WHERE merge_key is not null` が入っているかを確認する（決定 6）。
4. `db/client.ts`（決定 12）、`db/migrate.ts`、`db/ids.ts`、`db/hash.ts`、`db/json.ts`、`db/records.ts`。
5. `run/status.ts`・`run/judgment.ts` と、それに伴う `run/result.ts` の改名（決定 3）。
6. リポジトリを 7 ファイル。テストは M → S → R → D → J の順に足す。
7. `src/index.ts` に `applyMigrations` を挿す（決定 2）。
8. `pnpm check` を通す。Windows は CI で確認する。
9. PR を作り、「レビューで決着した点」の 2 つの表をそのまま本文に載せる。

担当：Claude がスキーマ設計と決定、実装とテストは qwen（`qwen-delegate`。スペックは英語で書き、
不変条件を MUST / MUST NOT として明記する）、Claude が実ファイルを読んで検証する。
Unicode 境界を含むテスト（R1・R2・R8）の期待値は Claude が作る。
