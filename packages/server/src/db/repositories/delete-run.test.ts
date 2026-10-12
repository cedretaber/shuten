import { describe, expect, it } from "vitest";

import { createDatabase } from "../client.ts";
import { applyMigrations } from "../migrate.ts";
import { insertCheckUnit, listCheckUnits } from "./check-units.ts";
import { deleteRunWithChildren } from "./delete-run.ts";
import { insertDiagnostic, listDiagnostics } from "./diagnostics.ts";
import { insertCandidate, insertFinding, listCandidates, listFindings } from "./findings.ts";
import { listJudgments, setJudgment } from "./judgments.ts";
import { findManuscriptVersion, insertManuscriptVersion } from "./manuscripts.ts";
import { insertRecheckUnit, listRecheckUnits } from "./rechecks.ts";
import { findRun, insertRun, insertRunTarget, listRunTargets } from "./runs.ts";

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

type Db = ReturnType<typeof setupDb>["db"];

/**
 * 実行 1 件と、その実行に属する行を全表ぶん作る：検査対象・検査単位・指摘（＋判断）・
 * 指摘に統合された候補・位置特定に失敗した候補とその位置診断・再確認単位。
 */
function seedFullRun(db: Db, runId: string, manuscriptVersionId: string): void {
  insertRun(db, {
    id: runId,
    manuscriptVersionId,
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
    status: "completed",
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    startOperationId: `op-${runId}`,
    finishedAt: null,
  });
  const targetId = `${runId}-t`;
  insertRunTarget(db, {
    id: targetId,
    runId,
    targetIndex: 0,
    target: { start: 0, end: 10 },
    contextBefore: null,
    contextAfter: null,
    input: { start: 0, end: 10 },
    paragraphIds: [0],
  });
  const checkUnitId = `${runId}-cu`;
  insertCheckUnit(db, {
    id: checkUnitId,
    runId,
    targetId,
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
  const findingId = `${runId}-f`;
  insertFinding(db, {
    id: findingId,
    runId,
    manuscriptVersionId,
    targetId,
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
  setJudgment(db, findingId, { status: "adopt-planned", note: "メモ" });
  insertCandidate(db, {
    id: `${runId}-c-located`,
    runId,
    checkUnitId,
    findingId,
    candidateIndex: 0,
    llm: {
      paragraphId: 0,
      quote: "誤字",
      before: "",
      after: "",
      category: "notation",
      reason: "理由",
      suggestion: "修正案",
      verdict: "likely-error",
    },
    locateStatus: "located",
    range: { start: 0, end: 2 },
    mergeKey: null,
  });
  const unlocatedId = `${runId}-c-unlocated`;
  insertCandidate(db, {
    id: unlocatedId,
    runId,
    checkUnitId,
    findingId: null,
    candidateIndex: 1,
    llm: {
      paragraphId: 0,
      quote: "存在しない引用",
      before: "",
      after: "",
      category: "notation",
      reason: "理由",
      suggestion: null,
      verdict: "confirm-with-author",
    },
    locateStatus: "not-found",
    range: null,
    mergeKey: null,
  });
  insertDiagnostic(db, {
    candidateId: unlocatedId,
    runId,
    quote: "存在しない引用",
    reason: "not-found",
    searchRange: { start: 0, end: 10 },
    exactMatches: [],
    transformVersion: "1",
    transformCandidates: [],
    omitted: 0,
    tied: false,
  });
  insertRecheckUnit(db, {
    id: `${runId}-rc`,
    runId,
    findingId,
    inputRange: { start: 0, end: 10 },
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
  });
}

/** 実行に属する行の件数を表ごとに数える。 */
function countRows(db: Db, runId: string) {
  return {
    run: findRun(db, runId) === null ? 0 : 1,
    targets: listRunTargets(db, runId).length,
    checkUnits: listCheckUnits(db, runId).length,
    findings: listFindings(db, runId).length,
    judgments: listJudgments(db, runId).length,
    candidates: listCandidates(db, runId).length,
    diagnostics: listDiagnostics(db, runId).length,
    recheckUnits: listRecheckUnits(db, runId).length,
  };
}

const FULL = {
  run: 1,
  targets: 1,
  checkUnits: 1,
  findings: 1,
  judgments: 1,
  candidates: 2,
  diagnostics: 1,
  recheckUnits: 1,
};

const NONE = {
  run: 0,
  targets: 0,
  checkUnits: 0,
  findings: 0,
  judgments: 0,
  candidates: 0,
  diagnostics: 0,
  recheckUnits: 0,
};

describe("db/repositories/delete-run", () => {
  it("実行に属する行を全表から消し、他の実行の行には触れない", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文の誤字です" });
    insertManuscriptVersion(db, { id: "mv2", name: "原稿2", body: "別の本文です" });
    seedFullRun(db, "r1", "mv1");
    seedFullRun(db, "r2", "mv2");
    expect(countRows(db, "r1")).toEqual(FULL);

    const result = deleteRunWithChildren(db, "r1");

    expect(result.deleted).toBe(true);
    expect(countRows(db, "r1")).toEqual(NONE);
    expect(countRows(db, "r2")).toEqual(FULL);
    expect(findManuscriptVersion(db, "mv2")).not.toBeNull();
    close();
  });

  it("他の実行から参照されない原稿版は本文ごと消す", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文の誤字です" });
    seedFullRun(db, "r1", "mv1");

    const result = deleteRunWithChildren(db, "r1");

    expect(result.manuscriptVersionDeleted).toBe(true);
    expect(findManuscriptVersion(db, "mv1")).toBeNull();
    close();
  });

  it("他の実行が参照する原稿版は残し、最後の実行を消したときに消す", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文の誤字です" });
    seedFullRun(db, "r1", "mv1");
    seedFullRun(db, "r2", "mv1");

    const first = deleteRunWithChildren(db, "r1");

    expect(first.manuscriptVersionDeleted).toBe(false);
    expect(findManuscriptVersion(db, "mv1")?.body).toBe("本文の誤字です");
    expect(countRows(db, "r2")).toEqual(FULL);

    const second = deleteRunWithChildren(db, "r2");

    expect(second.manuscriptVersionDeleted).toBe(true);
    expect(findManuscriptVersion(db, "mv1")).toBeNull();
    close();
  });

  it("実行から参照されていない原稿版には触れない", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文の誤字です" });
    insertManuscriptVersion(db, { id: "mv-unused", name: "未検査", body: "検査していない本文" });
    seedFullRun(db, "r1", "mv1");

    deleteRunWithChildren(db, "r1");

    expect(findManuscriptVersion(db, "mv-unused")).not.toBeNull();
    close();
  });

  it("実行が無ければ何も消さずに deleted: false", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文の誤字です" });
    seedFullRun(db, "r1", "mv1");

    const result = deleteRunWithChildren(db, "missing");

    expect(result).toEqual({ deleted: false, manuscriptVersionDeleted: false });
    expect(countRows(db, "r1")).toEqual(FULL);
    expect(findManuscriptVersion(db, "mv1")).not.toBeNull();
    close();
  });
});
