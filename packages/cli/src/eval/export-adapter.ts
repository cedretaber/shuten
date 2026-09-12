import type { RunExportDto } from "@shuten/shared";
import { runExportDtoSchema } from "@shuten/shared";

import { formatIssues } from "./result-schema.ts";

/**
 * エクスポート JSON を評価入力（`EvaluationResultInput`）に変換するアダプター
 * （PR13a-2 Task 10。計画書の決定 27・28・30・31）。
 *
 * 純粋関数だけを置く。`node:fs`・HTTP・時計には依存しない。読み込みと CLI 配線は
 * `io.ts` / `main.ts`（Task 11）の責務。
 *
 * **`adaptExportToResult` は未実装。** 決定 27 の `totals.requests` は
 * `Σ checkUnits.attempts + Σ recheckUnits.attempts` と定めているが、エクスポート JSON に
 * 埋め込まれる再確認の要約（`RecheckSummaryDto`。`@shuten/shared` の `api/dto.ts`）は
 * `RecheckUnitDto` から usage・時刻に加えて `attempts` も落としており、再確認側の要求数を
 * 復元する材料が無い。writable な値を作れないので、既定値へ丸めずに実装を止めている
 * （`docs/reference/invariants.md`「失敗・形式不正を正常な値に置き換えない」と同じ理由）。
 * 対応方針はコントローラーの判断待ち（詳細は `task-10-report.md`）。
 */

export type ExportParseResult =
  | { readonly ok: true; readonly value: RunExportDto }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * エクスポート JSON（`JSON.parse` の戻り値）の形を検証する。`runExportDtoSchema`
 * （`@shuten/shared`）を正本とし、形の正本を 2 つ持たない。
 */
export function parseExportJson(json: unknown): ExportParseResult {
  const result = runExportDtoSchema.safeParse(json);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, errors: formatIssues(result.error.issues) };
}
