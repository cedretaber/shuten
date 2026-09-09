/**
 * 実行の詳細・単位の組み立て（`api/run-view.ts`）のテスト。
 *
 * HTTP を通さず、DB に直接行を入れて組み立てだけを見る（`run-view.ts` は Hono に依存しない）。
 * 経路（404・状態コード・`respond` の検証）は `api/runs.test.ts` の A3 が見る。
 */

import { describe, expect, it } from "vitest";

import { createDatabase } from "../db/client.ts";
import { applyMigrations } from "../db/migrate.ts";
import type { RunRecord } from "../db/records.ts";
import { insertCheckUnit } from "../db/repositories/check-units.ts";
import { insertFinding } from "../db/repositories/findings.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { insertRecheckUnit } from "../db/repositories/rechecks.ts";
import { insertRun, insertRunTarget } from "../db/repositories/runs.ts";
import { buildRunDetail, buildRunUnits } from "./run-view.ts";

function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

type Db = ReturnType<typeof setupDb>["db"];

/** 原稿版 1 件と実行 1 件を作る。`endpointUrl` は射影で落ちることの確認にも使う。 */
function seedRun(db: Db, runId: string, manuscriptVersionId = "mv1"): RunRecord {
  return insertRun(db, {
    id: runId,
    manuscriptVersionId,
    modelId: "model-a",
    modelInfo: null,
    endpointUrl: "http://127.0.0.1:1234",
    generationSettings: { maxTokens: 512, temperature: 0.2 },
    chunkSettings: {
      targetGraphemes: 10,
      contextGraphemes: 0,
      recheckContextGraphemes: 0,
      roundingTolerance: 0,
      maxInputGraphemes: 50,
    },
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo", "naturalness"],
    recheckEnabled: true,
    allowedWords: [],
    allowedWordRuleVersion: "1",
    promptVersion: "1",
    diagnosticTransformVersion: "1",
    status: "running",
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    startOperationId: "op-1",
    finishedAt: null,
  });
}

describe("api/run-view: buildRunDetail", () => {
  it("progress は 5 状態すべてを持ち、合計が単位数に一致する。targets は保存済みの範囲そのまま", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "あいうえおかきくけこ" });
    const run = seedRun(db, "r1");

    // 対象 2 件（保存の順序を targetIndex の昇順とわざと逆にして、並びが取得順でないことを見る）。
    insertRunTarget(db, {
      id: "t2",
      runId: run.id,
      targetIndex: 1,
      target: { start: 5, end: 10 },
      contextBefore: { start: 0, end: 5 },
      contextAfter: null,
      input: { start: 0, end: 10 },
      paragraphIds: [0],
    });
    insertRunTarget(db, {
      id: "t1",
      runId: run.id,
      targetIndex: 0,
      target: { start: 0, end: 5 },
      contextBefore: null,
      contextAfter: null,
      input: { start: 0, end: 5 },
      paragraphIds: [0],
    });

    // 検査単位 4 件：done / failed / pending / running。
    const unitStatuses = ["done", "failed", "pending", "running"] as const;
    unitStatuses.forEach((status, index) => {
      insertCheckUnit(db, {
        id: `cu${String(index)}`,
        runId: run.id,
        targetId: index < 2 ? "t1" : "t2",
        perspective: index % 2 === 0 ? "typo" : "naturalness",
        status,
        attempts: 0,
        failure: null,
        pendingNote: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: null,
        startedAt: null,
        finishedAt: null,
      });
    });

    // 再確認単位 1 件（not-applicable）。
    insertFinding(db, {
      id: "f1",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: "t1",
      locateStatus: "located",
      range: { start: 0, end: 2 },
      paragraphId: 0,
      quote: "あい",
      suggestion: null,
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: null,
      suppression: null,
    });
    insertRecheckUnit(db, {
      id: "ru1",
      runId: run.id,
      findingId: "f1",
      inputRange: null,
      status: "not-applicable",
      notApplicableReason: "unlocated",
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
    });

    const detail = buildRunDetail(db, run);

    // 5 状態すべてがキーとしてあり、0 件の状態も落ちない。
    expect(detail.progress.checkUnits).toEqual({
      pending: 1,
      running: 1,
      done: 1,
      failed: 1,
      "not-applicable": 0,
    });
    expect(detail.progress.recheckUnits).toEqual({
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      "not-applicable": 1,
    });
    const total = Object.values(detail.progress.checkUnits).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(4);

    // targets は targetIndex の昇順で、保存済みの UTF-16 範囲をそのまま返す。
    expect(detail.targets.map((target) => target.id)).toEqual(["t1", "t2"]);
    expect(detail.targets[1]).toEqual({
      id: "t2",
      targetIndex: 1,
      target: { start: 5, end: 10 },
      contextBefore: { start: 0, end: 5 },
      contextAfter: null,
      input: { start: 0, end: 10 },
      paragraphIds: [0],
    });

    // 実行の射影は接続先 URL・開始操作 ID を持たない（決定 3）。
    expect(detail.run).not.toHaveProperty("endpointUrl");
    expect(detail.run).not.toHaveProperty("startOperationId");
    expect(detail.run.id).toBe("r1");

    close();
  });

  it("単位も対象も無い実行では、progress が 5 状態すべて 0 で targets は空", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    const run = seedRun(db, "r1");

    const detail = buildRunDetail(db, run);

    expect(detail.progress).toEqual({
      checkUnits: { pending: 0, running: 0, done: 0, failed: 0, "not-applicable": 0 },
      recheckUnits: { pending: 0, running: 0, done: 0, failed: 0, "not-applicable": 0 },
    });
    expect(detail.targets).toEqual([]);

    close();
  });
});

describe("api/run-view: buildRunUnits", () => {
  it("checkUnits の targetIndex が対応する検査対象の連番になる", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "あいうえおかきくけこ" });
    const run = seedRun(db, "r1");

    insertRunTarget(db, {
      id: "t0",
      runId: run.id,
      targetIndex: 0,
      target: { start: 0, end: 5 },
      contextBefore: null,
      contextAfter: null,
      input: { start: 0, end: 5 },
      paragraphIds: [0],
    });
    insertRunTarget(db, {
      id: "t1",
      runId: run.id,
      targetIndex: 1,
      target: { start: 5, end: 10 },
      contextBefore: null,
      contextAfter: null,
      input: { start: 5, end: 10 },
      paragraphIds: [0],
    });
    // 連番が大きい対象の単位を先に入れ、単位の並びと対象の並びを取り違えないことを見る。
    insertCheckUnit(db, {
      id: "cu-a",
      runId: run.id,
      targetId: "t1",
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
    insertCheckUnit(db, {
      id: "cu-b",
      runId: run.id,
      targetId: "t0",
      perspective: "naturalness",
      status: "failed",
      attempts: 1,
      failure: {
        reason: "malformed",
        message: "応答を解釈できなかった",
        finishReason: "stop",
        origin: "chat",
      },
      pendingNote: null,
      usage: null,
      inputGraphemes: null,
      elapsedMs: null,
      startedAt: null,
      finishedAt: null,
    });

    const units = buildRunUnits(db, run);

    const byId = new Map(units.checkUnits.map((unit) => [unit.id, unit]));
    expect(byId.get("cu-a")?.targetIndex).toBe(1);
    expect(byId.get("cu-b")?.targetIndex).toBe(0);
    // 失敗の内容は落とさない（不変条件「失敗を指摘ゼロに置き換えない」）。
    expect(byId.get("cu-b")?.failure?.reason).toBe("malformed");
    expect(units.recheckUnits).toEqual([]);

    close();
  });
});
