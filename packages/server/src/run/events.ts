import type { Perspective } from "@shuten/shared";

import type { CheckUnitResult, PipelineRunStatus, RecheckResult, RunStop } from "./result.ts";

/**
 * パイプラインの進捗イベント（決定 10）。1 つのコールバックに union で流す。PR10 の SSE がそのまま流せる形にする。
 * `run-started` は必ず最初、`run-finished` は最後（`stopped` でも出す）。
 *
 * 購読側（PR10 の SSE、PR12 の表示）が前提にしてよい／してはならない点：
 *
 * - `runPipeline` が想定外の例外（`LmStudioError` でも `InputTooLongError` でもないもの）で
 *   終わると `run-finished` は出ない。「`run-finished` が来れば実行は終わっている」は言えるが、
 *   その逆（実行が終われば必ず `run-finished` が来る）は言えない。購読側は例外での終了も想定すること。
 * - `check-finished` は対応する `check-started` なしで来ることがある。停止後に生成要求を送らずに
 *   `pending` とする単位と、送信前に入力上限を超えて（`InputTooLongError`）`failed` とする単位は、
 *   `check-started` を出さずに `check-finished` だけを出す。`recheck-finished` も同様に、
 *   `recheck-started` なしで来ることがある。「started と finished が 1 対 1」とみなしてはならない。
 * - `target-merged` の `findingCount: 0` は「その対象に指摘がなかった」場合と、
 *   「その対象の検査単位が `pending`（停止などで送っていない）」場合の両方で出る。
 *   両者を区別するには `check-finished` の `result.status` を見る必要がある。
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
  | {
      readonly type: "run-finished";
      readonly status: PipelineRunStatus;
      readonly stop: RunStop | null;
    };
