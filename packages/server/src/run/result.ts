import type {
  CheckInput,
  ChunkSettings,
  FailureReason,
  LlmRecheckOutput,
  MergedFinding,
  Perspective,
  Range,
  Suppression,
  TargetRange,
  UnlocatedCandidate,
} from "@shuten/shared";

import type { ModelInfo, Usage } from "../lmstudio/types.ts";
import type { GenerationSettings } from "../prompts/types.ts";
import type { RunStatus } from "./status.ts";

/** 結果 JSON の版。破壊的に形を変えるときだけ上げる。 */
export const RESULT_VERSION: string = "1";

/** 検査方式。分割の効果を比べるための対照。仕様書 10 節の「現在の全文チャット方式」とは別条件（決定 8）。 */
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
      /** 送信した生成要求の回数。未送信なら 0。 */
      readonly attempts: number;
      /** 未完了の理由（未送信、送信後のアンロード、停止操作など）。 */
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
  | {
      readonly status: "pending";
      /** 送信した生成要求の回数。未送信なら 0。 */
      readonly attempts: number;
      /** 入力を組み立てる前に終わったら null。 */
      readonly inputRange: Range | null;
      readonly note: string;
    }
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

/**
 * 検査対象と、その対象に対して実際に組み立てた入力範囲。位置の正本として結果に残す。
 * 組み立てた時点で記録するので、この対象に生成要求を送り終えたことは意味しない
 * （停止・失敗で 1 度も送っていない対象にも TargetPlan がありうる。送信の有無は checkUnits で見る）。
 */
export interface TargetPlan {
  readonly target: TargetRange;
  readonly input: CheckInput;
}

/**
 * パイプライン実行（`runPipeline`）が返す状態。DB の実行状態（`./status.ts` の `RunStatus`）の
 * うち、1 回のパイプライン呼び出しの結果として取りうるものだけを `Extract` で絞り込む
 * （「実行中」「復旧待ち」はパイプライン呼び出しの外で管理する状態なのでここには含まれない）。
 * `Extract` で導くことで、`status.ts` から値が削られたときにコンパイルで気づける。ただし
 * 型エラーが出るのはこの `Extract` の定義行ではなく、`PipelineRunStatus` を使う下流の箇所
 * （`pipeline.ts` の代入、`packages/cli` の `switch`）である。
 */
export type PipelineRunStatus = Extract<RunStatus, "completed" | "partially-failed" | "stopped">;

export type StopReason =
  | "model-not-loaded"
  | "recovery-needed"
  | "connection-lost"
  | "settings"
  | "aborted"
  /** 想定外の例外で停止した（決定 14・決定 33）。 */
  | "internal-error"
  /** 別の実行が復旧待ちのため、プロセス全体の送信ゲートに止められた（決定 39）。 */
  | "recovery-blocked";

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
  readonly status: PipelineRunStatus;
  readonly stop: RunStop | null;
  readonly conditions: RunConditions;
  readonly targets: readonly TargetPlan[];
  readonly checkUnits: readonly CheckUnitResult[];
  readonly findings: readonly FindingResult[];
  readonly unlocated: readonly UnlocatedResult[];
  readonly totals: RunTotals;
}
