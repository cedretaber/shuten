import { FAILURE_REASONS } from "@shuten/shared";
import { describe, expect, it } from "vitest";

import type { Usage } from "../../lmstudio/types.ts";
import { createDatabase } from "../client.ts";
import { applyMigrations } from "../migrate.ts";
import type { UnitFailureRecord } from "../records.ts";
import { claimUnit, findCheckUnit, finishCheckUnit, insertCheckUnit } from "./check-units.ts";
import { insertManuscriptVersion } from "./manuscripts.ts";
import { insertRun, insertRunTarget } from "./runs.ts";

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

/** `check_units` の外部キー先（原稿版・検査実行・検査対象）を最小限だけ作る。 */
function setupTarget(db: ReturnType<typeof setupDb>["db"]) {
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
    recheckEnabled: false,
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
  return { run, target };
}

const USAGE: Usage = {
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  reasoningTokens: null,
};

describe("db/repositories/check-units", () => {
  it("R6: 検査単位：pending → running → done の更新で attempts と usage が保たれる", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTarget(db);

    const inserted = insertCheckUnit(db, {
      id: "cu1",
      runId: run.id,
      targetId: target.id,
      perspective: "typo",
      status: "pending",
      attempts: 0,
      failure: null,
      pendingNote: "未送信",
      usage: null,
      inputGraphemes: null,
      elapsedMs: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(inserted.status).toBe("pending");

    // claimUnit は状態以外の列を変えない（attempts は 0 のまま）。
    const claimed = claimUnit(db, "cu1", "pending", "running");
    expect(claimed).toBe(true);
    const running = findCheckUnit(db, "cu1");
    expect(running?.status).toBe("running");
    expect(running?.attempts).toBe(0);

    const finishedAt = new Date("2026-09-09T00:00:00.000Z");
    finishCheckUnit(db, "cu1", {
      status: "done",
      attempts: 1,
      failure: null,
      pendingNote: null,
      usage: USAGE,
      inputGraphemes: 42,
      elapsedMs: 1234,
      finishedAt,
    });

    const done = findCheckUnit(db, "cu1");
    expect(done?.status).toBe("done");
    expect(done?.attempts).toBe(1);
    expect(done?.usage).toEqual(USAGE);
    expect(done?.inputGraphemes).toBe(42);
    expect(done?.elapsedMs).toBe(1234);
    expect(done?.finishedAt).toEqual(finishedAt);
    close();
  });

  it("R7: 検査単位：failed で failure_reason / origin / finish_reason が往復し、FailureReason の全値を入れられる", () => {
    const { db, close } = setupDb();
    const { run } = setupTarget(db);

    for (const [index, reason] of FAILURE_REASONS.entries()) {
      const id = `cu-${index}`;
      // check_units は (target_id, perspective) に一意制約があるため、理由ごとに検査対象を分ける。
      const target = insertRunTarget(db, {
        id: `t-${index}`,
        runId: run.id,
        targetIndex: index + 1,
        target: { start: 0, end: 10 },
        contextBefore: null,
        contextAfter: null,
        input: { start: 0, end: 10 },
        paragraphIds: [0],
      });
      insertCheckUnit(db, {
        id,
        runId: run.id,
        targetId: target.id,
        perspective: "typo",
        status: "pending",
        attempts: 0,
        failure: null,
        pendingNote: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: null,
        startedAt: null,
        finishedAt: null,
      });

      const failure: UnitFailureRecord = {
        reason,
        message: `失敗理由: ${reason}`,
        finishReason: reason === "truncated" ? "length" : null,
        origin: index % 3 === 0 ? "ensure-loaded" : index % 3 === 1 ? "chat" : "local",
      };
      finishCheckUnit(db, id, {
        status: "failed",
        attempts: 1,
        failure,
        pendingNote: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: null,
        finishedAt: new Date("2026-09-09T00:00:00.000Z"),
      });

      const found = findCheckUnit(db, id);
      expect(found?.status).toBe("failed");
      expect(found?.failure).toEqual(failure);
    }
    close();
  });

  it("R16: claimUnit は状態が一致するときだけ true を返し、二度目は false（同時取得の防止）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTarget(db);
    insertCheckUnit(db, {
      id: "cu1",
      runId: run.id,
      targetId: target.id,
      perspective: "typo",
      status: "pending",
      attempts: 0,
      failure: null,
      pendingNote: null,
      usage: null,
      inputGraphemes: null,
      elapsedMs: null,
      startedAt: null,
      finishedAt: null,
    });

    const first = claimUnit(db, "cu1", "pending", "running");
    expect(first).toBe(true);
    expect(findCheckUnit(db, "cu1")?.status).toBe("running");

    const second = claimUnit(db, "cu1", "pending", "running");
    expect(second).toBe(false);
    // false のときに状態が変わっていないことも確認する。
    expect(findCheckUnit(db, "cu1")?.status).toBe("running");
    close();
  });
});
