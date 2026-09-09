import type {
  ChunkSettings,
  DiagnosticCandidate,
  FailureReason,
  FindingCategory,
  InitialVerdict,
  LlmFinding,
  LocateFailureReason,
  Perspective,
  Range,
  RecheckReasonKind,
  RecheckVerdict,
} from "@shuten/shared";

import type { ModelInfo, Usage } from "../lmstudio/types.ts";
import type { GenerationSettings } from "../prompts/types.ts";
import type { JudgmentStatus } from "../run/judgment.ts";
import type { RunStatus, UnitStatus } from "../run/status.ts";

/**
 * リポジトリ（次のタスク）の入出力に使うレコード型。
 *
 * drizzle の推論型（`typeof table.$inferInsert` など）をそのまま公開しない。永続化層の
 * 外向きの形をスキーマ実装の詳細から独立させるため。同じ理由で、PR7 のパイプライン結果型
 * （`../run/result.ts`）にも依存しない。列挙・意味が重なる場合でも（`StopReason` /
 * `UnitFailure` など）、ここでは独立した型として持つ。
 */

/** `candidates` / `findings` の位置特定状態。`located` の有無だけが違う。 */
export type CandidateLocateStatus = "located" | "not-found" | "ambiguous" | "outside-target";
export type FindingLocateStatus = "located" | "not-found" | "ambiguous";

/** `runs.stop_reason`。`../run/result.ts` の `StopReason` と値は同じだが、独立させて持つ。 */
export type RunStopReason =
  | "model-not-loaded"
  | "recovery-needed"
  | "connection-lost"
  | "settings"
  | "aborted"
  | "internal-error"
  | "recovery-blocked";

/** `recheck_units.not_applicable_reason`。仕様書 6.5 節。 */
export type RecheckNotApplicableReason = "disabled" | "suppressed" | "unlocated";

/** ---------------------------------------------------------------------- */
/** 原稿版 */
/** ---------------------------------------------------------------------- */

export interface ManuscriptVersionRecord {
  readonly id: string;
  readonly name: string;
  readonly body: string;
  readonly bodyHash: string;
  readonly createdAt: Date;
}

/** ---------------------------------------------------------------------- */
/** 検査実行 */
/** ---------------------------------------------------------------------- */

export interface RunRecord {
  readonly id: string;
  readonly manuscriptVersionId: string;
  /** モデル ID の正本。`generationSettings` には入れない（決定 11）。 */
  readonly modelId: string;
  /** `ensureLoaded` が返した `ModelInfo`。取れなければ null。 */
  readonly modelInfo: ModelInfo | null;
  readonly endpointUrl: string;
  /** `model` を除いた生成設定（決定 11）。 */
  readonly generationSettings: Omit<GenerationSettings, "model">;
  readonly chunkSettings: ChunkSettings;
  readonly timeouts: { readonly checkMs: number; readonly recheckMs: number };
  readonly perspectives: readonly Perspective[];
  readonly recheckEnabled: boolean;
  readonly allowedWords: readonly string[];
  readonly allowedWordRuleVersion: string;
  readonly promptVersion: string;
  readonly diagnosticTransformVersion: string;
  readonly status: RunStatus;
  readonly stopReason: RunStopReason | null;
  readonly stopMessage: string | null;
  /** PR9 の「復旧待ち」の入口。 */
  readonly generationUnconfirmed: boolean;
  /** 開始操作の識別子。一意制約。 */
  readonly startOperationId: string | null;
  /** 停止要求を受けた時刻。未受理・再開後は null（決定 21）。 */
  readonly stopRequestedAt: Date | null;
  /** 復旧確認の待機上限（ミリ秒）。0 は「checkMs がそのままハード上限」（決定 8）。 */
  readonly recoveryConfirmMs: number;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

/** ---------------------------------------------------------------------- */
/** 検査対象 */
/** ---------------------------------------------------------------------- */

export interface RunTargetRecord {
  readonly id: string;
  readonly runId: string;
  /** 実行内で 0 始まり。 */
  readonly targetIndex: number;
  readonly target: Range;
  /** 参考文脈（前）。無ければ null。 */
  readonly contextBefore: Range | null;
  /** 参考文脈（後）。無ければ null。 */
  readonly contextAfter: Range | null;
  /** 初回検査の入力範囲。 */
  readonly input: Range;
  readonly paragraphIds: readonly number[];
}

/** ---------------------------------------------------------------------- */
/** 検査単位 */
/** ---------------------------------------------------------------------- */

/** 生成要求の失敗の記録。`../run/result.ts` の `UnitFailure` と持ち物は同じだが独立させて持つ。 */
export interface UnitFailureRecord {
  readonly reason: FailureReason;
  readonly message: string;
  /** LM Studio が返した finish_reason（取れたときだけ）。 */
  readonly finishReason: string | null;
  /** ensureLoaded 由来なら "ensure-loaded"、生成要求由来なら "chat"、送信前の例外なら "local"。 */
  readonly origin: "ensure-loaded" | "chat" | "local";
}

export interface CheckUnitRecord {
  readonly id: string;
  readonly runId: string;
  readonly targetId: string;
  readonly perspective: Perspective;
  readonly status: UnitStatus;
  /** 送信した生成要求の回数。 */
  readonly attempts: number;
  readonly failure: UnitFailureRecord | null;
  /** 未完了の理由（未送信、停止、アンロードなど）。 */
  readonly pendingNote: string | null;
  readonly usage: Usage | null;
  /** 換算係数の実測用。 */
  readonly inputGraphemes: number | null;
  readonly elapsedMs: number | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

/** ---------------------------------------------------------------------- */
/** 元候補 */
/** ---------------------------------------------------------------------- */

export interface CandidateRecord {
  readonly id: string;
  readonly runId: string;
  readonly checkUnitId: string;
  /** 統合先。`outside-target` は null（決定 4）。 */
  readonly findingId: string | null;
  /** 実行内で 0 始まりの生成順（決定 19）。 */
  readonly candidateIndex: number;
  /** LLM の応答をそのまま。引用を破壊しない。 */
  readonly llm: LlmFinding;
  readonly locateStatus: CandidateLocateStatus;
  /** `located` のときだけ非 null。 */
  readonly range: Range | null;
  /** `mergeKey()` の値。修正案なしは null。 */
  readonly mergeKey: string | null;
  readonly createdAt: Date;
}

/** ---------------------------------------------------------------------- */
/** 指摘 */
/** ---------------------------------------------------------------------- */

export interface FindingRecord {
  readonly id: string;
  readonly runId: string;
  readonly manuscriptVersionId: string;
  readonly targetId: string;
  readonly locateStatus: FindingLocateStatus;
  /** 位置特定失敗では null。 */
  readonly range: Range | null;
  /** 位置確定時は本文から導いた段落、失敗時は候補の申告値（決定 15）。 */
  readonly paragraphId: number;
  readonly quote: string;
  readonly suggestion: string | null;
  /** 統合後の分類。 */
  readonly category: FindingCategory;
  /** 初回判定。再確認で上書きしない（決定 5）。 */
  readonly initialVerdict: InitialVerdict;
  readonly mergeKey: string | null;
  /** 許容語抑制の理由。抑制なしは null。 */
  readonly suppression: { readonly word: string; readonly ruleVersion: string } | null;
  readonly createdAt: Date;
}

/** ---------------------------------------------------------------------- */
/** 再確認単位 */
/** ---------------------------------------------------------------------- */

export interface RecheckUnitRecord {
  /** 再確認の固有 ID（仕様 6.5）。 */
  readonly id: string;
  readonly runId: string;
  /** 一意制約（1 指摘に 1 件）。 */
  readonly findingId: string;
  /** 入力を組み立てる前に終わったら null。 */
  readonly inputRange: Range | null;
  readonly status: UnitStatus;
  readonly notApplicableReason: RecheckNotApplicableReason | null;
  readonly attempts: number;
  readonly failure: UnitFailureRecord | null;
  readonly pendingNote: string | null;
  readonly verdict: RecheckVerdict | null;
  readonly reasonKind: RecheckReasonKind | null;
  readonly reason: string | null;
  /** 修正案を有効な修正案として表示してよいか。 */
  readonly suggestionValid: boolean | null;
  readonly usage: Usage | null;
  readonly inputGraphemes: number | null;
  readonly elapsedMs: number | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

/** ---------------------------------------------------------------------- */
/** 位置診断 */
/** ---------------------------------------------------------------------- */

export interface DiagnosticRecord {
  /** 1 候補に 1 件。`diagnostics` 表の主キーそのもの。 */
  readonly candidateId: string;
  readonly runId: string;
  /** LLM の引用。 */
  readonly quote: string;
  readonly reason: LocateFailureReason;
  /** 照合に使った範囲。 */
  readonly searchRange: Range;
  /** 絞り込み後に残った完全一致の範囲。採用位置には使わない。 */
  readonly exactMatches: readonly Range[];
  /** `not-found` のときだけ非 null。 */
  readonly transformVersion: string | null;
  readonly transformCandidates: readonly DiagnosticCandidate[] | null;
  /** 打ち切り件数。 */
  readonly omitted: number | null;
  /** 同順位あり。 */
  readonly tied: boolean | null;
}

/** ---------------------------------------------------------------------- */
/** 作者の判断 */
/** ---------------------------------------------------------------------- */

export interface JudgmentRecord {
  readonly findingId: string;
  readonly status: JudgmentStatus;
  readonly note: string | null;
  readonly updatedAt: Date;
}
