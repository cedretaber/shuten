import { FAILURE_REASONS } from "@shuten/shared";
import { sql } from "drizzle-orm";
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
    const finished = finishCheckUnit(db, "cu1", {
      expectedStatus: "running",
      status: "done",
      attempts: 1,
      failure: null,
      pendingNote: null,
      usage: USAGE,
      inputGraphemes: 42,
      elapsedMs: 1234,
      finishedAt,
    });
    expect(finished).toBe(true);

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
      const finished = finishCheckUnit(db, id, {
        expectedStatus: "pending",
        status: "failed",
        attempts: 1,
        failure,
        pendingNote: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: null,
        finishedAt: new Date("2026-09-09T00:00:00.000Z"),
      });
      expect(finished).toBe(true);

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

  it("S3: claimUnit は started_at を状態の変更と同じ更新で設定し、from に合わない行は started_at を含め1列も変わらない", () => {
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

    const startedAt1 = new Date("2026-09-09T00:00:00.000Z");
    const claimed = claimUnit(db, "cu1", "pending", "running", { startedAt: startedAt1 });
    expect(claimed).toBe(true);
    const running = findCheckUnit(db, "cu1");
    expect(running?.status).toBe("running");
    expect(running?.startedAt).toEqual(startedAt1);

    // from（"pending"）に合わない行は started_at を含め1列も変わらない（別の started_at を渡しても
    // 上書きされない）。
    const startedAt2 = new Date("2026-09-09T01:00:00.000Z");
    const secondClaim = claimUnit(db, "cu1", "pending", "running", { startedAt: startedAt2 });
    expect(secondClaim).toBe(false);
    const stillRunning = findCheckUnit(db, "cu1");
    expect(stillRunning?.status).toBe("running");
    expect(stillRunning?.startedAt).toEqual(startedAt1);
    close();
  });

  it("S3c: claimUnit（started_at 付き）は check_units への UPDATE を1回しか発行しない（必須事項1の本体：同じ1文であること）", () => {
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

    // check_units への UPDATE の発行回数を、行レベルの AFTER UPDATE トリガーで数える。
    // WHERE が対象行1件にちょうど一致する構成なので、トリガーの発火回数 = 実際に発行された
    // UPDATE 文の本数になる（2文に分けて status → started_at の順に書けば2回発火する）。
    db.run(sql`CREATE TEMP TABLE update_log (n integer)`);
    db.run(sql`
      CREATE TEMP TRIGGER t_check_units_update AFTER UPDATE ON check_units
      BEGIN
        INSERT INTO update_log VALUES (1);
      END
    `);

    const claimed = claimUnit(db, "cu1", "pending", "running", {
      startedAt: new Date("2026-09-09T00:00:00.000Z"),
    });
    expect(claimed).toBe(true);

    const count = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM update_log`);
    expect(count.n).toBe(1);
    close();
  });

  it("S4: finishCheckUnit は expectedStatus に合わない行を更新せず false を返し、状態以外の列も一切変わらない", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTarget(db);
    insertCheckUnit(db, {
      id: "cu1",
      runId: run.id,
      targetId: target.id,
      perspective: "typo",
      status: "running",
      attempts: 1,
      failure: null,
      pendingNote: null,
      usage: null,
      inputGraphemes: null,
      elapsedMs: null,
      startedAt: new Date("2026-09-09T00:00:00.000Z"),
      finishedAt: null,
    });

    // 実際の status は "running" だが、expectedStatus に "pending"（不一致）を渡す
    // （停止処理などが先に決着していた状況を模す）。
    const finished = finishCheckUnit(db, "cu1", {
      expectedStatus: "pending",
      status: "done",
      attempts: 99,
      failure: null,
      pendingNote: null,
      usage: USAGE,
      inputGraphemes: 42,
      elapsedMs: 1234,
      finishedAt: new Date("2026-09-09T02:00:00.000Z"),
    });
    expect(finished).toBe(false);

    // status だけでなく attempts・usage・inputGraphemes・elapsedMs・finishedAt も一切変わらない
    // （false のときに WHERE 句が効いていることを、更新しようとした値と比較して確認する）。
    const found = findCheckUnit(db, "cu1");
    expect(found?.status).toBe("running");
    expect(found?.attempts).toBe(1);
    expect(found?.usage).toBeNull();
    expect(found?.inputGraphemes).toBeNull();
    expect(found?.elapsedMs).toBeNull();
    expect(found?.finishedAt).toBeNull();
    close();
  });
});
