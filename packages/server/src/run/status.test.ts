import * as shared from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { JUDGMENT_STATUSES } from "./judgment.ts";
import { RUN_STATUSES, UNIT_STATUSES } from "./status.ts";

/**
 * A8：状態語彙の値の正本を `@shuten/shared` に一本化したことの確認。server 側の再エクスポートが
 * 値のコピーではなく shared の配列そのものであることを参照一致（`toBe`）で見る（PR10 決定 2・9）。
 *
 * `packages/shared/src/run/status.test.ts` ではなくこちらに置く：shared は server を
 * import できない（依存の向きは server → shared）ため、参照一致は server 側でしか書けない。
 *
 * `RUN_STOP_REASONS` / `RECHECK_NOT_APPLICABLE_REASONS` / `CANDIDATE_LOCATE_STATUSES` /
 * `FINDING_LOCATE_STATUSES`（移送元は `db/schema.ts`）は同種の参照一致テストを持たない：
 * `db/schema.ts` はこれらを `@shuten/shared` から直接 import するだけで、server 側に
 * 再エクスポートの中継点（`run/status.ts` のような shim）が無いため、比較対象となる
 * 独立した server 側の束縛が存在しない。これらの移送が正しいことは
 * `pnpm --filter @shuten/server db:generate` の無差分で確認する（手順 1）。
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
});
