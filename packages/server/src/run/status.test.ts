import * as shared from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { candidates, findings, recheckUnits, runs } from "../db/schema.ts";
import { JUDGMENT_STATUSES } from "./judgment.ts";
import { RUN_STATUSES, UNIT_STATUSES } from "./status.ts";

/**
 * A8：状態語彙の値の正本を `@shuten/shared` に一本化したことの確認。server 側が値のコピーでは
 * なく shared の配列そのものを使っていることを参照一致（`toBe`）で見る（PR10 決定 2・9）。
 *
 * `packages/shared/src/run/status.test.ts` ではなくこちらに置く：shared は server を
 * import できない（依存の向きは server → shared）ため、参照一致は server 側でしか書けない。
 *
 * `RUN_STOP_REASONS` / `RECHECK_NOT_APPLICABLE_REASONS` / `CANDIDATE_LOCATE_STATUSES` /
 * `FINDING_LOCATE_STATUSES`（移送元は `db/schema.ts`）は `run/status.ts` のような
 * server 側の再エクスポート shim を持たない（`db/schema.ts` が `@shuten/shared` から直接
 * import して使うだけ）。そのため drizzle の列定義（`text(..., { enum: X })`）が実際に
 * 保持している配列（`column.enumValues`）を shared の配列と比較する：drizzle は
 * `SQLiteText` の実装で `config.enum` をコピーせずそのまま `enumValues` に代入しているため、
 * ここでの参照一致は「列が shared の配列を直接使っている（コピーではない）」ことの確認になる。
 */
describe("状態語彙は @shuten/shared と参照が一致する（A8）", () => {
  it("RUN_STATUSES が shared のものと参照一致する", () => {
    expect(RUN_STATUSES).toBe(shared.RUN_STATUSES);
  });

  it("UNIT_STATUSES が shared のものと参照一致する", () => {
    expect(UNIT_STATUSES).toBe(shared.UNIT_STATUSES);
  });

  it("JUDGMENT_STATUSES が shared のものと参照一致する", () => {
    expect(JUDGMENT_STATUSES).toBe(shared.JUDGMENT_STATUSES);
  });

  it("runs.status の列挙が shared の RUN_STATUSES と参照一致する", () => {
    expect(runs.status.enumValues).toBe(shared.RUN_STATUSES);
  });

  it("runs.stopReason の列挙が shared の RUN_STOP_REASONS と参照一致する", () => {
    expect(runs.stopReason.enumValues).toBe(shared.RUN_STOP_REASONS);
  });

  it("recheckUnits.notApplicableReason の列挙が shared の RECHECK_NOT_APPLICABLE_REASONS と参照一致する", () => {
    expect(recheckUnits.notApplicableReason.enumValues).toBe(shared.RECHECK_NOT_APPLICABLE_REASONS);
  });

  it("candidates.locateStatus の列挙が shared の CANDIDATE_LOCATE_STATUSES と参照一致する", () => {
    expect(candidates.locateStatus.enumValues).toBe(shared.CANDIDATE_LOCATE_STATUSES);
  });

  it("findings.locateStatus の列挙が shared の FINDING_LOCATE_STATUSES と参照一致する", () => {
    expect(findings.locateStatus.enumValues).toBe(shared.FINDING_LOCATE_STATUSES);
  });
});
