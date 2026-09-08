import type { DiagnosticCandidate } from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { createDatabase } from "../client.ts";
import { applyMigrations } from "../migrate.ts";
import { insertCheckUnit } from "./check-units.ts";
import { findDiagnostic, insertDiagnostic, listDiagnostics } from "./diagnostics.ts";
import { insertCandidate } from "./findings.ts";
import { insertManuscriptVersion } from "./manuscripts.ts";
import { insertRun, insertRunTarget } from "./runs.ts";

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

/** `diagnostics` の外部キー先（原稿版・検査実行・検査対象・検査単位・元候補）を最小限だけ作る。 */
function setupCandidate(db: ReturnType<typeof setupDb>["db"], candidateId: string) {
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
  const unit = insertCheckUnit(db, {
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
  const candidate = insertCandidate(db, {
    id: candidateId,
    runId: run.id,
    checkUnitId: unit.id,
    findingId: null,
    candidateIndex: 0,
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
  return { run, candidate };
}

describe("db/repositories/diagnostics", () => {
  it("R13: 位置診断：transform_candidates が最大3件・range: null を含む形で往復し、ambiguous では null", () => {
    const { db, close } = setupDb();
    const { run } = setupCandidate(db, "c-not-found");

    const transformCandidates: readonly DiagnosticCandidate[] = [
      { transform: "newline", text: "候補1", range: { start: 1, end: 3 } },
      { transform: "nfc", text: "候補2", range: null },
      { transform: "newline+nfc", text: "候補3", range: { start: 5, end: 7 } },
    ];

    const inserted = insertDiagnostic(db, {
      candidateId: "c-not-found",
      runId: run.id,
      quote: "存在しない引用",
      reason: "not-found",
      searchRange: { start: 0, end: 10 },
      exactMatches: [],
      transformVersion: "1",
      transformCandidates,
      omitted: 2,
      tied: true,
    });
    expect(inserted.transformCandidates).toEqual(transformCandidates);

    const found = findDiagnostic(db, "c-not-found");
    expect(found).not.toBeNull();
    expect(found?.transformVersion).toBe("1");
    expect(found?.transformCandidates).toEqual(transformCandidates);
    expect(found?.transformCandidates).toHaveLength(3);
    expect(found?.transformCandidates?.[1]?.range).toBeNull();
    expect(found?.omitted).toBe(2);
    expect(found?.tied).toBe(true);
    close();
  });

  it("R13: ambiguous では transform_candidates などが null のまま往復する", () => {
    const { db, close } = setupDb();
    const { run } = setupCandidate(db, "c-ambiguous");

    insertDiagnostic(db, {
      candidateId: "c-ambiguous",
      runId: run.id,
      quote: "存在しない引用",
      reason: "ambiguous",
      searchRange: { start: 0, end: 10 },
      exactMatches: [
        { start: 1, end: 3 },
        { start: 5, end: 7 },
      ],
      transformVersion: null,
      transformCandidates: null,
      omitted: null,
      tied: null,
    });

    const found = findDiagnostic(db, "c-ambiguous");
    expect(found).not.toBeNull();
    expect(found?.reason).toBe("ambiguous");
    expect(found?.transformVersion).toBeNull();
    expect(found?.transformCandidates).toBeNull();
    expect(found?.omitted).toBeNull();
    expect(found?.tied).toBeNull();
    expect(found?.exactMatches).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 7 },
    ]);
    close();
  });

  it("listDiagnostics は検査実行に属する位置診断を candidate_id の昇順で列挙する", () => {
    const { db, close } = setupDb();
    setupCandidate(db, "c-not-found");
    insertDiagnostic(db, {
      candidateId: "c-not-found",
      runId: "r1",
      quote: "存在しない引用",
      reason: "not-found",
      searchRange: { start: 0, end: 10 },
      exactMatches: [],
      transformVersion: "1",
      transformCandidates: [],
      omitted: 0,
      tied: false,
    });

    const listed = listDiagnostics(db, "r1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.candidateId).toBe("c-not-found");
    close();
  });

  it("findDiagnostic: 存在しない候補 ID は null を返す", () => {
    const { db, close } = setupDb();
    expect(findDiagnostic(db, "no-such-id")).toBeNull();
    close();
  });
});
