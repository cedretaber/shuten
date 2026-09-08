import { describe, expect, it } from "vitest";

import { createDatabase } from "../client.ts";
import { applyMigrations } from "../migrate.ts";
import { insertCheckUnit } from "./check-units.ts";
import { findFinding, insertFinding } from "./findings.ts";
import { findJudgment, listJudgments, setJudgment } from "./judgments.ts";
import { insertManuscriptVersion } from "./manuscripts.ts";
import { findRecheckUnitByFinding, finishRecheckUnit, insertRecheckUnit } from "./rechecks.ts";
import { insertRun, insertRunTarget } from "./runs.ts";

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

/** `findings` の外部キー先（原稿版・検査実行・検査対象・検査単位）を最小限だけ作る。 */
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

/** 指摘を 1 件作る。作成と同時に `judgments` に `undecided` の行ができる（決定 5）。 */
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

describe("db/repositories/judgments", () => {
  it("R14: 採否：同じ指摘に2回書いても行は1つで、updated_at が更新される", () => {
    const { db, close } = setupDb();
    const { run, target } = setupBase(db);
    const finding = makeFinding(db, run, target, "f1");

    const updatedAt1 = new Date("2026-09-09T00:00:00.000Z");
    setJudgment(db, finding.id, { status: "adopt-planned", note: "検討中", updatedAt: updatedAt1 });

    const updatedAt2 = new Date("2026-09-09T01:00:00.000Z");
    setJudgment(db, finding.id, { status: "rejected", note: null, updatedAt: updatedAt2 });

    const listed = listJudgments(db, run.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("rejected");
    expect(listed[0]?.note).toBeNull();
    expect(listed[0]?.updatedAt).toEqual(updatedAt2);

    const found = findJudgment(db, finding.id);
    expect(found?.status).toBe("rejected");
    expect(found?.updatedAt).toEqual(updatedAt2);
    close();
  });

  it("R15: 採否：指摘を作ると undecided の行が必ずでき、undecided に戻しても行が残る", () => {
    const { db, close } = setupDb();
    const { run, target } = setupBase(db);
    const finding = makeFinding(db, run, target, "f1");

    const initial = findJudgment(db, finding.id);
    expect(initial?.status).toBe("undecided");
    expect(initial?.note).toBeNull();

    const updatedAt1 = new Date("2026-09-09T00:00:00.000Z");
    setJudgment(db, finding.id, { status: "adopt-planned", updatedAt: updatedAt1 });
    expect(findJudgment(db, finding.id)?.status).toBe("adopt-planned");

    const updatedAt2 = new Date("2026-09-09T01:00:00.000Z");
    setJudgment(db, finding.id, { status: "undecided", updatedAt: updatedAt2 });

    const listed = listJudgments(db, run.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("undecided");
    expect(listed[0]?.updatedAt).toEqual(updatedAt2);
    close();
  });

  it("R17: 指摘・再確認・採否を独立に読め、再確認の書き込みが採否を変えない（仕様5.4）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupBase(db);
    const finding = makeFinding(db, run, target, "f1");

    const judgedAt = new Date("2026-09-09T00:00:00.000Z");
    setJudgment(db, finding.id, { status: "adopt-planned", note: "採用予定", updatedAt: judgedAt });

    insertRecheckUnit(db, {
      id: "rc1",
      runId: run.id,
      findingId: finding.id,
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
    });
    finishRecheckUnit(db, "rc1", {
      status: "done",
      attempts: 1,
      failure: null,
      pendingNote: null,
      notApplicableReason: null,
      verdict: "keep",
      reasonKind: "error-confirmed",
      reason: "文脈上も誤り",
      suggestionValid: true,
      usage: null,
      inputGraphemes: null,
      elapsedMs: null,
      finishedAt: new Date("2026-09-09T02:00:00.000Z"),
    });

    // 指摘・再確認・採否は別々の行で、findFinding・findRecheckUnitByFinding・findJudgment の
    // それぞれ独立した呼び出しで読む（1 回の読み出しで 3 つがまとめて付いてくるわけではない）。
    const foundFinding = findFinding(db, finding.id);
    expect(foundFinding).not.toBeNull();
    expect(foundFinding?.quote).toBe("誤字");
    const recheck = findRecheckUnitByFinding(db, finding.id);
    expect(recheck?.verdict).toBe("keep");
    expect(recheck?.reasonKind).toBe("error-confirmed");

    // 再確認の書き込み（finishRecheckUnit）が judgments の行を一切変えない（updated_at を含めて不変）。
    const judgment = findJudgment(db, finding.id);
    expect(judgment?.status).toBe("adopt-planned");
    expect(judgment?.note).toBe("採用予定");
    expect(judgment?.updatedAt).toEqual(judgedAt);
    close();
  });
});
