import type { Perspective } from "@shuten/shared";

import type { CheckUnitResult, RecheckResult, RunStatus, RunStop } from "./result.ts";

/**
 * パイプラインの進捗イベント（決定 10）。1 つのコールバックに union で流す。PR10 の SSE がそのまま流せる形にする。
 * `run-started` は必ず最初、`run-finished` は必ず最後（`stopped` でも出す）。
 */
export type PipelineEvent =
  | { readonly type: "run-started"; readonly targetCount: number; readonly unitCount: number }
  | {
      readonly type: "check-started";
      readonly targetIndex: number;
      readonly perspective: Perspective;
    }
  | { readonly type: "check-finished"; readonly result: CheckUnitResult }
  | { readonly type: "target-merged"; readonly targetIndex: number; readonly findingCount: number }
  | { readonly type: "recheck-started"; readonly findingId: string }
  | {
      readonly type: "recheck-finished";
      readonly findingId: string;
      readonly result: RecheckResult;
    }
  | { readonly type: "run-finished"; readonly status: RunStatus; readonly stop: RunStop | null };
