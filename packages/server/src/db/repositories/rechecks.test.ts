import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Usage } from "../../lmstudio/types.ts";
import { createDatabase } from "../client.ts";
import { applyMigrations } from "../migrate.ts";
import type { RecheckNotApplicableReason, UnitFailureRecord } from "../records.ts";
import { insertCheckUnit } from "./check-units.ts";
import { insertFinding } from "./findings.ts";
import { insertManuscriptVersion } from "./manuscripts.ts";
import {
  claimRecheckUnit,
  findRecheckUnitByFinding,
  finishRecheckUnit,
  type InsertRecheckUnitInput,
  insertRecheckUnit,
  listRecheckUnits,
} from "./rechecks.ts";
import { insertRun, insertRunTarget } from "./runs.ts";

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

/** `recheck_units` の外部キー先（原稿版・検査実行・検査対象・検査単位）を最小限だけ作る。 */
function setupBase(db: ReturnType<typeof setupDb>["db"]) {
  insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
  const run = insertRun(db, {
    id: "r1",
    manuscriptVersionId: "mv1",
    modelId: "model-a",
    modelInfo: null,
    endpointUrl: "http://127.0.0.1:1234",
    generationSettings: { maxTokens: 512, temperature: 0.2 },
    chunkSettings: {
      targetGraphemes: 1500,
      contextGraphemes: 1000,
      recheckContextGraphemes: 3000,
      roundingTolerance: 0.2,
      maxInputGraphemes: 8000,
    },
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: true,
    allowedWords: [],
    allowedWordRuleVersion: "1",
    promptVersion: "1",
    diagnosticTransformVersion: "1",
    status: "running",
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    startOperationId: null,
    finishedAt: null,
  });
  const target = insertRunTarget(db, {
    id: "t1",
    runId: run.id,
    targetIndex: 0,
    target: { start: 0, end: 10 },
    contextBefore: null,
    contextAfter: null,
    input: { start: 0, end: 10 },
    paragraphIds: [0],
  });
  insertCheckUnit(db, {
    id: "cu1",
    runId: run.id,
    targetId: target.id,
    perspective: "typo",
    status: "done",
    attempts: 1,
    failure: null,
    pendingNote: null,
    usage: null,
    inputGraphemes: null,
    elapsedMs: null,
    startedAt: null,
    finishedAt: null,
  });
  return { run, target };
}

/** 指摘を 1 件作る（再確認単位の外部キー先）。`mergeKey` は null にして一意制約を避ける。 */
function makeFinding(
  db: ReturnType<typeof setupDb>["db"],
  run: { readonly id: string },
  target: { readonly id: string },
  findingId: string,
) {
  return insertFinding(db, {
    id: findingId,
    runId: run.id,
    manuscriptVersionId: "mv1",
    targetId: target.id,
    locateStatus: "located",
    range: { start: 0, end: 2 },
    paragraphId: 0,
    quote: "誤字",
    suggestion: "修正案",
    category: "notation",
    initialVerdict: "likely-error",
    mergeKey: null,
    suppression: null,
  });
}

/** `insertRecheckUnit` に渡す最小限の入力（`pending` 状態）を組み立てる。 */
function basePendingInput(
  overrides: Partial<InsertRecheckUnitInput> &
    Pick<InsertRecheckUnitInput, "id" | "runId" | "findingId">,
): InsertRecheckUnitInput {
  return {
    inputRange: { start: 0, end: 20 },
    status: "pending",
    notApplicableReason: null,
    attempts: 0,
    failure: null,
    pendingNote: null,
    verdict: null,
    reasonKind: null,
    reason: null,
    suggestionValid: null,
    usage: null,
    inputGraphemes: null,
    elapsedMs: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const USAGE: Usage = {
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  reasoningTokens: null,
};

describe("db/repositories/rechecks", () => {
  it("R11: 再確認：done で verdict / reason_kind / suggestion_valid が往復する", () => {
    const { db, close } = setupDb();
    const { run, target } = setupBase(db);
    const finding = makeFinding(db, run, target, "f1");

    const inserted = insertRecheckUnit(
      db,
      basePendingInput({ id: "rc1", runId: run.id, findingId: finding.id }),
    );
    expect(inserted.status).toBe("pending");

    const claimed = claimRecheckUnit(db, "rc1", "pending", "running");
    expect(claimed).toBe(true);
    expect(findRecheckUnitByFinding(db, finding.id)?.status).toBe("running");

    const finishedAt = new Date("2026-09-09T00:00:00.000Z");
    finishRecheckUnit(db, "rc1", {
      status: "done",
      attempts: 1,
      failure: null,
      pendingNote: null,
      notApplicableReason: null,
      verdict: "confirm-with-author",
      reasonKind: "suggestion-inappropriate",
      reason: "問題は実在するが修正案が不適切",
      suggestionValid: false,
      usage: USAGE,
      inputGraphemes: 500,
      elapsedMs: 2345,
      finishedAt,
    });

    const found = findRecheckUnitByFinding(db, finding.id);
    expect(found?.status).toBe("done");
    expect(found?.verdict).toBe("confirm-with-author");
    expect(found?.reasonKind).toBe("suggestion-inappropriate");
    expect(found?.suggestionValid).toBe(false);
    expect(found?.reason).toBe("問題は実在するが修正案が不適切");
    expect(found?.usage).toEqual(USAGE);
    expect(found?.inputGraphemes).toBe(500);
    expect(found?.elapsedMs).toBe(2345);
    expect(found?.finishedAt).toEqual(finishedAt);

    const listed = listRecheckUnits(db, run.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("rc1");
    close();
  });

  it("R12: 再確認：not-applicable で not_applicable_reason の3値がそれぞれ保存できる", () => {
    const { db, close } = setupDb();
    const { run, target } = setupBase(db);

    const reasons: readonly RecheckNotApplicableReason[] = ["disabled", "suppressed", "unlocated"];
    for (const [index, notApplicableReason] of reasons.entries()) {
      const findingId = `f-${index}`;
      const finding = makeFinding(db, run, target, findingId);
      const unitId = `rc-${index}`;
      insertRecheckUnit(
        db,
        basePendingInput({ id: unitId, runId: run.id, findingId: finding.id, inputRange: null }),
      );

      finishRecheckUnit(db, unitId, {
        status: "not-applicable",
        attempts: 0,
        failure: null,
        pendingNote: null,
        notApplicableReason,
        verdict: null,
        reasonKind: null,
        reason: null,
        suggestionValid: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: null,
        finishedAt: new Date("2026-09-09T00:00:00.000Z"),
      });

      const found = findRecheckUnitByFinding(db, finding.id);
      expect(found?.status).toBe("not-applicable");
      expect(found?.notApplicableReason).toBe(notApplicableReason);
      // 対象外は入力範囲を組み立てる前に終わったことも表せる。
      expect(found?.inputRange).toBeNull();
    }
    close();
  });

  it("R12b: 再確認：failed で failure_reason / failure_message / failure_finish_reason / failure_origin が往復する（origin は chat・ensure-loaded の両方）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupBase(db);

    const origins: readonly UnitFailureRecord["origin"][] = ["chat", "ensure-loaded"];
    for (const [index, origin] of origins.entries()) {
      const findingId = `f-failed-${index}`;
      const finding = makeFinding(db, run, target, findingId);
      const unitId = `rc-failed-${index}`;
      insertRecheckUnit(db, basePendingInput({ id: unitId, runId: run.id, findingId: finding.id }));

      const failure: UnitFailureRecord = {
        reason: "timeout",
        message: `失敗理由: timeout（origin: ${origin}）`,
        finishReason: origin === "chat" ? "length" : null,
        origin,
      };
      finishRecheckUnit(db, unitId, {
        status: "failed",
        attempts: 1,
        failure,
        pendingNote: null,
        notApplicableReason: null,
        verdict: null,
        reasonKind: null,
        reason: null,
        suggestionValid: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: null,
        finishedAt: new Date("2026-09-09T00:00:00.000Z"),
      });

      const found = findRecheckUnitByFinding(db, finding.id);
      expect(found?.status).toBe("failed");
      expect(found?.failure).toEqual(failure);
    }
    close();
  });

  it("R12c: recheck_units の failure_* が中途半端な行（failure_reason だけ非 null）は読み出しで例外になる（不変条件の防御）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupBase(db);
    const finding = makeFinding(db, run, target, "f-broken");

    // finishRecheckUnit 経由ではこの壊れた行は作れない（toFailureColumns が 4 列を対で書くため）。
    // 不変条件が壊れた行を模すため SQL で直接書き込む（failure_message / finish_reason / origin は NULL のまま）。
    db.run(sql`
      INSERT INTO recheck_units (id, run_id, finding_id, status, attempts, failure_reason)
      VALUES ('rc-broken', ${run.id}, ${finding.id}, 'failed', 1, 'timeout')
    `);

    expect(() => findRecheckUnitByFinding(db, finding.id)).toThrow(
      /failure_message \/ failure_origin/,
    );
    close();
  });
});
