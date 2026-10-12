import { eq, inArray } from "drizzle-orm";

import type { AppDatabaseLike } from "../client.ts";
import {
  candidates,
  checkUnits,
  diagnostics,
  findings,
  judgments,
  manuscriptVersions,
  recheckUnits,
  runs,
  runTargets,
} from "../schema.ts";

/** ---------------------------------------------------------------------- */
/** 検査実行の削除（仕様 8.3） */
/** ---------------------------------------------------------------------- */

/** `deleteRunWithChildren` の結果。 */
export interface DeleteRunResult {
  /** 実行の行を消したか。実行が無ければ false（何も消さない）。 */
  readonly deleted: boolean;
  /** 参照する実行がなくなった原稿版を本文ごと消したか。 */
  readonly manuscriptVersionDeleted: boolean;
}

/**
 * 検査実行 1 件と、その実行に属する行をすべて 1 トランザクションで消す（仕様 8.3）。
 *
 * 外部キーに `ON DELETE` を付けていない（`schema.ts` 決定 13）ので、子から順に消す。
 * 順序は外部キーの向きで決まる：
 * `judgments`（`findings` 経由。`run_id` を持たない）→ `recheck_units`（→ findings）→
 * `diagnostics`（→ candidates）→ `candidates`（→ check_units・findings）→ `findings`
 * （→ run_targets・runs）→ `check_units`（→ run_targets）→ `run_targets` → `runs`。
 *
 * 最後に、実行が参照していた原稿版を、**他の実行から参照されていなければ**消す。
 * 他の実行が参照する原稿版は残す。実行から参照されていない原稿版（確定したが検査を
 * 始めなかったもの）はこの関数の対象外で、触れない。
 *
 * 処理中かどうかの判定はここでは行わない（オーケストレーターの状態はリポジトリから見えない）。
 * 呼び出し元（`api/runs.ts`）が判定し、同じ同期区間でこの関数を呼ぶこと。
 */
export function deleteRunWithChildren(db: AppDatabaseLike, runId: string): DeleteRunResult {
  return db.transaction((tx): DeleteRunResult => {
    const run = tx
      .select({ manuscriptVersionId: runs.manuscriptVersionId })
      .from(runs)
      .where(eq(runs.id, runId))
      .get();
    if (run === undefined) {
      return { deleted: false, manuscriptVersionDeleted: false };
    }

    const findingIdsOfRun = tx
      .select({ id: findings.id })
      .from(findings)
      .where(eq(findings.runId, runId));
    tx.delete(judgments).where(inArray(judgments.findingId, findingIdsOfRun)).run();
    tx.delete(recheckUnits).where(eq(recheckUnits.runId, runId)).run();
    tx.delete(diagnostics).where(eq(diagnostics.runId, runId)).run();
    tx.delete(candidates).where(eq(candidates.runId, runId)).run();
    tx.delete(findings).where(eq(findings.runId, runId)).run();
    tx.delete(checkUnits).where(eq(checkUnits.runId, runId)).run();
    tx.delete(runTargets).where(eq(runTargets.runId, runId)).run();
    tx.delete(runs).where(eq(runs.id, runId)).run();

    const stillReferenced = tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.manuscriptVersionId, run.manuscriptVersionId))
      .limit(1)
      .get();
    if (stillReferenced !== undefined) {
      return { deleted: true, manuscriptVersionDeleted: false };
    }
    tx.delete(manuscriptVersions).where(eq(manuscriptVersions.id, run.manuscriptVersionId)).run();
    return { deleted: true, manuscriptVersionDeleted: true };
  });
}
