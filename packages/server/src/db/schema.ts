import type {
  ChunkSettings,
  DiagnosticCandidate,
  FailureReason,
  FindingCategory,
  InitialVerdict,
  LlmFinding,
  LocateFailureReason,
  RecheckReasonKind,
  RecheckVerdict,
} from "@shuten/shared";
import {
  FAILURE_REASONS,
  FINDING_CATEGORIES,
  INITIAL_VERDICTS,
  RECHECK_REASON_KINDS,
  RECHECK_VERDICTS,
} from "@shuten/shared";
import { sql } from "drizzle-orm";
import { foreignKey, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import type { ModelInfo, Usage } from "../lmstudio/types.ts";
import type { GenerationSettings } from "../prompts/types.ts";
import { JUDGMENT_STATUSES, type JudgmentStatus } from "../run/judgment.ts";
import type { StopReason, UnitFailure } from "../run/result.ts";
import { RUN_STATUSES, type RunStatus, UNIT_STATUSES, type UnitStatus } from "../run/status.ts";
import { PERSPECTIVES } from "./json.ts";

/**
 * Drizzle スキーマ（仕様書 8.1 節）。
 *
 * 保存単位ごとに 1 表を対応させる。原稿版・検査実行・検査対象・検査単位・元候補・指摘・
 * 再確認単位・位置診断・作者の判断の 9 表。すべて `id TEXT PRIMARY KEY`（決定 7）、
 * 外部キーに `ON DELETE` は指定しない（決定 13。MVP に削除機能がないため）。
 *
 * 実行をまたぐ参照は複合外部キー `(親 ID, run_id)` で塞ぐ（決定 16）。
 * 生成 SQL に `WHERE` 付きの部分索引・複合外部キーが実際に出るかは `db:generate` の出力で確認する
 * （docs/plans/2026-09-09-pr8-db-persistence.md 決定 6・16）。
 */

/**
 * 検査の観点。`@shuten/shared` はランタイム定数を公開していないため、`db/json.ts` にローカルに
 * `as const` タプルを持ち、ここではそれを再利用する（JSON 列の読み戻しと列挙列で同じ値を使う）。
 */
export type SchemaPerspective = (typeof PERSPECTIVES)[number];

/** `candidates` / `findings` の位置特定状態。`LocateFailureReason`（shared）に `located` を加えたもの。 */
const CANDIDATE_LOCATE_STATUSES = ["located", "not-found", "ambiguous", "outside-target"] as const;
const FINDING_LOCATE_STATUSES = ["located", "not-found", "ambiguous"] as const;

/** `recheck_units.not_applicable_reason`。仕様書 6.5 節。 */
const RECHECK_NOT_APPLICABLE_REASONS = ["disabled", "suppressed", "unlocated"] as const;

/** `UnitFailure.origin`。ensureLoaded 由来・生成要求由来・送信前の例外の別。 */
type FailureOrigin = UnitFailure["origin"];

/** ---------------------------------------------------------------------- */
/** 原稿版 */
/** ---------------------------------------------------------------------- */

export const manuscriptVersions = sqliteTable("manuscript_versions", {
  id: text("id").primaryKey(),
  /** 原稿名。 */
  name: text("name").notNull(),
  /** 保存本文。BOM 除外以外は無加工（仕様書 5.1 節）。 */
  body: text("body").notNull(),
  /** UTF-8 の SHA-256（小文字 16 進）。 */
  bodyHash: text("body_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** ---------------------------------------------------------------------- */
/** 検査実行 */
/** ---------------------------------------------------------------------- */

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    manuscriptVersionId: text("manuscript_version_id")
      .notNull()
      .references(() => manuscriptVersions.id),
    /** モデル ID の正本。`generationSettings` には入れない（決定 11）。 */
    modelId: text("model_id").notNull(),
    /** `ensureLoaded` が返した `ModelInfo`（量子化・コンテキスト長）。 */
    modelInfo: text("model_info", { mode: "json" }).$type<ModelInfo>(),
    /** 接続先のルート URL。API キーは持たない（決定 10）。 */
    endpointUrl: text("endpoint_url").notNull(),
    /** `Omit<GenerationSettings, "model">`。既定値は DB 側に置かない（決定 11）。 */
    generationSettings: text("generation_settings", { mode: "json" })
      .notNull()
      .$type<Omit<GenerationSettings, "model">>(),
    chunkSettings: text("chunk_settings", { mode: "json" }).notNull().$type<ChunkSettings>(),
    /** 再開で設定を変えないため実行に紐づけて保存する。 */
    timeouts: text("timeouts", { mode: "json" })
      .notNull()
      .$type<{ readonly checkMs: number; readonly recheckMs: number }>(),
    perspectives: text("perspectives", { mode: "json" })
      .notNull()
      .$type<readonly SchemaPerspective[]>(),
    /** 再確認の有無（決定 3 の補足）。 */
    recheckEnabled: integer("recheck_enabled", { mode: "boolean" }).notNull(),
    /** 分割・trim 済みの許容語配列。 */
    allowedWords: text("allowed_words", { mode: "json" }).notNull().$type<readonly string[]>(),
    allowedWordRuleVersion: text("allowed_word_rule_version").notNull(),
    promptVersion: text("prompt_version").notNull(),
    diagnosticTransformVersion: text("diagnostic_transform_version").notNull(),
    status: text("status", { enum: RUN_STATUSES }).notNull().$type<RunStatus>(),
    stopReason: text("stop_reason").$type<StopReason>(),
    stopMessage: text("stop_message"),
    /** PR9 の「復旧待ち」の入口。 */
    generationUnconfirmed: integer("generation_unconfirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    /** 開始操作の識別子。一意制約（決定 14）。 */
    startOperationId: text("start_operation_id"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("runs_start_operation_id_key").on(t.startOperationId),
    // 複合外部キーの参照先（決定 16）。子表が (id, manuscript_version_id) で参照する。
    uniqueIndex("runs_id_manuscript_version_id_key").on(t.id, t.manuscriptVersionId),
  ],
);

/** ---------------------------------------------------------------------- */
/** 検査対象 */
/** ---------------------------------------------------------------------- */

export const runTargets = sqliteTable(
  "run_targets",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    /** 実行内で 0 始まり。 */
    targetIndex: integer("target_index").notNull(),
    /** 検査対象範囲（UTF-16、`[start, end)`）。 */
    targetStart: integer("target_start").notNull(),
    targetEnd: integer("target_end").notNull(),
    /** 参考文脈（前）。無ければ両方 null。 */
    contextBeforeStart: integer("context_before_start"),
    contextBeforeEnd: integer("context_before_end"),
    /** 参考文脈（後）。 */
    contextAfterStart: integer("context_after_start"),
    contextAfterEnd: integer("context_after_end"),
    /** 初回検査の入力範囲。 */
    inputStart: integer("input_start").notNull(),
    inputEnd: integer("input_end").notNull(),
    /** 段落 ID の配列。 */
    paragraphIds: text("paragraph_ids", { mode: "json" }).notNull().$type<readonly number[]>(),
  },
  (t) => [
    uniqueIndex("run_targets_run_id_target_index_key").on(t.runId, t.targetIndex),
    // 複合外部キーの参照先（決定 16）。
    uniqueIndex("run_targets_id_run_id_key").on(t.id, t.runId),
  ],
);

/** ---------------------------------------------------------------------- */
/** 検査単位 */
/** ---------------------------------------------------------------------- */

export const checkUnits = sqliteTable(
  "check_units",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    targetId: text("target_id").notNull(),
    perspective: text("perspective", { enum: PERSPECTIVES }).notNull().$type<SchemaPerspective>(),
    status: text("status", { enum: UNIT_STATUSES }).notNull().$type<UnitStatus>(),
    /** 送信した生成要求の回数。 */
    attempts: integer("attempts").notNull().default(0),
    failureReason: text("failure_reason", { enum: FAILURE_REASONS }).$type<FailureReason>(),
    failureMessage: text("failure_message"),
    failureFinishReason: text("failure_finish_reason"),
    failureOrigin: text("failure_origin").$type<FailureOrigin>(),
    /** 未完了の理由（未送信、停止、アンロードなど）。 */
    pendingNote: text("pending_note"),
    usage: text("usage", { mode: "json" }).$type<Usage>(),
    /** 換算係数の実測用。 */
    inputGraphemes: integer("input_graphemes"),
    elapsedMs: integer("elapsed_ms"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("check_units_target_id_perspective_key").on(t.targetId, t.perspective),
    // 複合外部キーの参照先（決定 16）。
    uniqueIndex("check_units_id_run_id_key").on(t.id, t.runId),
    foreignKey({
      columns: [t.targetId, t.runId],
      foreignColumns: [runTargets.id, runTargets.runId],
    }),
  ],
);

/** ---------------------------------------------------------------------- */
/** 元候補 */
/** ---------------------------------------------------------------------- */

export const candidates = sqliteTable(
  "candidates",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    checkUnitId: text("check_unit_id").notNull(),
    /** 統合先。`outside-target` は null（決定 4）。 */
    findingId: text("finding_id"),
    /** 実行内で 0 始まりの生成順（決定 19）。 */
    candidateIndex: integer("candidate_index").notNull(),
    /** `LlmFinding` をそのまま。引用を破壊しない。 */
    llm: text("llm", { mode: "json" }).notNull().$type<LlmFinding>(),
    locateStatus: text("locate_status", { enum: CANDIDATE_LOCATE_STATUSES }).notNull(),
    /** `located` のときだけ非 null。 */
    start: integer("start"),
    end: integer("end"),
    /** `mergeKey()` の値。修正案なしは null。 */
    mergeKey: text("merge_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    // 複合外部キーの参照先（決定 19）。
    uniqueIndex("candidates_id_run_id_key").on(t.id, t.runId),
    uniqueIndex("candidates_run_id_candidate_index_key").on(t.runId, t.candidateIndex),
    foreignKey({
      columns: [t.checkUnitId, t.runId],
      foreignColumns: [checkUnits.id, checkUnits.runId],
    }),
    // finding_id は null を許す（outside-target）。SQLite の複合外部キーは既定（MATCH SIMPLE）で
    // 列のどれかが null なら検査しないため、この行は通る（決定 16）。
    foreignKey({
      columns: [t.findingId, t.runId],
      foreignColumns: [findings.id, findings.runId],
    }),
  ],
);

/** ---------------------------------------------------------------------- */
/** 指摘 */
/** ---------------------------------------------------------------------- */

export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    manuscriptVersionId: text("manuscript_version_id").notNull(),
    targetId: text("target_id").notNull(),
    locateStatus: text("locate_status", { enum: FINDING_LOCATE_STATUSES }).notNull(),
    /** 位置特定失敗では null（8.1「未確定可」）。 */
    start: integer("start"),
    end: integer("end"),
    /** 位置確定時は本文から導いた段落、失敗時は候補の申告値（決定 15）。 */
    paragraphId: integer("paragraph_id").notNull(),
    quote: text("quote").notNull(),
    suggestion: text("suggestion"),
    /** 統合後の分類。 */
    category: text("category", { enum: FINDING_CATEGORIES }).notNull().$type<FindingCategory>(),
    /** 初回判定。再確認で上書きしない（決定 5）。 */
    initialVerdict: text("initial_verdict", { enum: INITIAL_VERDICTS })
      .notNull()
      .$type<InitialVerdict>(),
    /** `(run_id, merge_key)` に部分一意索引（決定 6）。 */
    mergeKey: text("merge_key"),
    /** 許容語抑制の理由。抑制なしは両方 null。 */
    suppressionWord: text("suppression_word"),
    suppressionRuleVersion: text("suppression_rule_version"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    // 部分一意索引（決定 6）。merge_key が null の行は何行あっても衝突しない。
    uniqueIndex("findings_run_id_merge_key_key")
      .on(t.runId, t.mergeKey)
      .where(sql`${t.mergeKey} is not null`),
    // 複合外部キーの参照先（決定 16）。
    uniqueIndex("findings_id_run_id_key").on(t.id, t.runId),
    foreignKey({
      columns: [t.targetId, t.runId],
      foreignColumns: [runTargets.id, runTargets.runId],
    }),
    foreignKey({
      columns: [t.runId, t.manuscriptVersionId],
      foreignColumns: [runs.id, runs.manuscriptVersionId],
    }),
  ],
);

/** ---------------------------------------------------------------------- */
/** 再確認単位 */
/** ---------------------------------------------------------------------- */

export const recheckUnits = sqliteTable(
  "recheck_units",
  {
    /** 再確認の固有 ID（仕様 6.5。PR7 からの持ち越し）。 */
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    /** 一意制約（1 指摘に 1 件）。 */
    findingId: text("finding_id").notNull(),
    /** 入力を組み立てる前に終わったら null。 */
    inputStart: integer("input_start"),
    inputEnd: integer("input_end"),
    status: text("status", { enum: UNIT_STATUSES }).notNull().$type<UnitStatus>(),
    notApplicableReason:
      text("not_applicable_reason").$type<(typeof RECHECK_NOT_APPLICABLE_REASONS)[number]>(),
    attempts: integer("attempts").notNull().default(0),
    failureReason: text("failure_reason", { enum: FAILURE_REASONS }).$type<FailureReason>(),
    failureMessage: text("failure_message"),
    failureFinishReason: text("failure_finish_reason"),
    failureOrigin: text("failure_origin").$type<FailureOrigin>(),
    pendingNote: text("pending_note"),
    verdict: text("verdict", { enum: RECHECK_VERDICTS }).$type<RecheckVerdict>(),
    reasonKind: text("reason_kind", { enum: RECHECK_REASON_KINDS }).$type<RecheckReasonKind>(),
    reason: text("reason"),
    suggestionValid: integer("suggestion_valid", { mode: "boolean" }),
    usage: text("usage", { mode: "json" }).$type<Usage>(),
    inputGraphemes: integer("input_graphemes"),
    elapsedMs: integer("elapsed_ms"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("recheck_units_finding_id_key").on(t.findingId),
    foreignKey({
      columns: [t.findingId, t.runId],
      foreignColumns: [findings.id, findings.runId],
    }),
  ],
);

/** ---------------------------------------------------------------------- */
/** 位置診断 */
/** ---------------------------------------------------------------------- */

export const diagnostics = sqliteTable(
  "diagnostics",
  {
    /** 1 候補に 1 件。 */
    candidateId: text("candidate_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    /** LLM の引用。 */
    quote: text("quote").notNull(),
    reason: text("reason").notNull().$type<LocateFailureReason>(),
    /** 照合に使った `inputRange`。 */
    searchStart: integer("search_start").notNull(),
    searchEnd: integer("search_end").notNull(),
    /** 絞り込み後に残った完全一致の範囲。採用位置には使わない。 */
    exactMatches: text("exact_matches", { mode: "json" })
      .notNull()
      .$type<ReadonlyArray<{ readonly start: number; readonly end: number }>>(),
    /** `not-found` のときだけ非 null。 */
    transformVersion: text("transform_version"),
    transformCandidates: text("transform_candidates", { mode: "json" }).$type<
      readonly DiagnosticCandidate[]
    >(),
    /** 打ち切り件数。 */
    omitted: integer("omitted"),
    /** 同順位あり。 */
    tied: integer("tied", { mode: "boolean" }),
  },
  (t) => [
    foreignKey({
      columns: [t.candidateId, t.runId],
      foreignColumns: [candidates.id, candidates.runId],
    }),
  ],
);

/** ---------------------------------------------------------------------- */
/** 作者の判断 */
/** ---------------------------------------------------------------------- */

export const judgments = sqliteTable("judgments", {
  /** 指摘 1 件につき必ず 1 行（決定 5）。 */
  findingId: text("finding_id")
    .primaryKey()
    .references(() => findings.id),
  status: text("status", { enum: JUDGMENT_STATUSES }).notNull().$type<JudgmentStatus>(),
  note: text("note"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
