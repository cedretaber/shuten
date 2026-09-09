import { describe, expect, it } from "vitest";

import { createDatabase } from "../db/client.ts";
import { applyMigrations } from "../db/migrate.ts";
import { findCheckUnit, insertCheckUnit } from "../db/repositories/check-units.ts";
import { insertFinding } from "../db/repositories/findings.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { findRecheckUnitByFinding, insertRecheckUnit } from "../db/repositories/rechecks.ts";
import { findRun, insertRun, insertRunTarget } from "../db/repositories/runs.ts";
import {
  claimRecheckUnitChecked,
  claimRunChecked,
  claimUnitChecked,
  finishCheckUnitChecked,
  finishRecheckUnitChecked,
  finishRunChecked,
  InvalidTransitionError,
} from "./transitions.ts";

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

/**
 * 6 関数の外部キー先を一通り作る：検査実行「r1」（running）、検査対象「t1」、検査単位「cu1」
 * （pending）、指摘「f1」（located）、再確認単位「ru1」（pending）。
 */
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
  const unit = insertCheckUnit(db, {
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
  const finding = insertFinding(db, {
    id: "f1",
    runId: run.id,
    manuscriptVersionId: "mv1",
    targetId: target.id,
    locateStatus: "located",
    range: { start: 0, end: 2 },
    paragraphId: 0,
    quote: "誤字",
    suggestion: "修正案",
    category: "notation",
    initialVerdict: "confirm-with-author",
    mergeKey: null,
    suppression: null,
  });
  const recheckUnit = insertRecheckUnit(db, {
    id: "ru1",
    runId: run.id,
    findingId: finding.id,
    inputRange: null,
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
  return { run, target, unit, finding, recheckUnit };
}

describe("run/transitions", () => {
  describe("W1: 許容表にない遷移は InvalidTransitionError を投げ、DB を1行も触らない", () => {
    it("claimUnitChecked: done → pending は表にない（不変条件：終端状態からは戻さない）", () => {
      const { db, close } = setupDb();
      const { unit } = setupBase(db);
      // "done" 状態の単位を直接作る（同じ対象に 2 つ目の観点を足すだけで足りる）。
      insertCheckUnit(db, {
        id: "cu-done",
        runId: unit.runId,
        targetId: unit.targetId,
        perspective: "naturalness",
        status: "done",
        attempts: 1,
        failure: null,
        pendingNote: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: null,
        startedAt: null,
        finishedAt: new Date("2026-09-09T00:00:00.000Z"),
      });
      const before = findCheckUnit(db, "cu-done");

      expect(() => claimUnitChecked(db, "cu-done", "done", "pending")).toThrow(
        InvalidTransitionError,
      );

      const after = findCheckUnit(db, "cu-done");
      expect(after).toEqual(before);
      close();
    });

    it("claimRecheckUnitChecked: done → pending は表にない", () => {
      const { db, close } = setupDb();
      const { recheckUnit } = setupBase(db);
      insertFinding(db, {
        id: "f2",
        runId: recheckUnit.runId,
        manuscriptVersionId: "mv1",
        targetId: "t1",
        locateStatus: "located",
        range: { start: 3, end: 5 },
        paragraphId: 0,
        quote: "誤字2",
        suggestion: "修正案2",
        category: "notation",
        initialVerdict: "confirm-with-author",
        mergeKey: null,
        suppression: null,
      });
      insertRecheckUnit(db, {
        id: "ru-done",
        runId: recheckUnit.runId,
        findingId: "f2",
        inputRange: { start: 0, end: 5 },
        status: "done",
        notApplicableReason: null,
        attempts: 1,
        failure: null,
        pendingNote: null,
        verdict: "keep",
        reasonKind: null,
        reason: null,
        suggestionValid: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: null,
        startedAt: null,
        finishedAt: new Date("2026-09-09T00:00:00.000Z"),
      });
      const before = findRecheckUnitByFinding(db, "f2");

      expect(() => claimRecheckUnitChecked(db, "ru-done", "done", "pending")).toThrow(
        InvalidTransitionError,
      );

      const after = findRecheckUnitByFinding(db, "f2");
      expect(after).toEqual(before);
      close();
    });

    it("finishCheckUnitChecked: expectedStatus=done → status=failed は表にない", () => {
      const { db, close } = setupDb();
      setupBase(db);
      insertCheckUnit(db, {
        id: "cu-done2",
        runId: "r1",
        targetId: "t1",
        perspective: "naturalness",
        status: "done",
        attempts: 1,
        failure: null,
        pendingNote: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: null,
        startedAt: null,
        finishedAt: new Date("2026-09-09T00:00:00.000Z"),
      });
      const before = findCheckUnit(db, "cu-done2");

      expect(() =>
        finishCheckUnitChecked(db, "cu-done2", {
          expectedStatus: "done",
          status: "failed",
          attempts: 2,
          failure: null,
          pendingNote: null,
          usage: null,
          inputGraphemes: null,
          elapsedMs: null,
          finishedAt: new Date("2026-09-09T01:00:00.000Z"),
        }),
      ).toThrow(InvalidTransitionError);

      const after = findCheckUnit(db, "cu-done2");
      expect(after).toEqual(before);
      close();
    });

    it("finishRecheckUnitChecked: expectedStatus=not-applicable → status=pending は表にない（not-applicable は終端）", () => {
      const { db, close } = setupDb();
      const { recheckUnit } = setupBase(db);
      insertFinding(db, {
        id: "f3",
        runId: recheckUnit.runId,
        manuscriptVersionId: "mv1",
        targetId: "t1",
        locateStatus: "located",
        range: { start: 3, end: 5 },
        paragraphId: 0,
        quote: "誤字3",
        suggestion: null,
        category: "grammar",
        initialVerdict: "confirm-with-author",
        mergeKey: null,
        suppression: null,
      });
      insertRecheckUnit(db, {
        id: "ru-na",
        runId: recheckUnit.runId,
        findingId: "f3",
        inputRange: null,
        status: "not-applicable",
        notApplicableReason: "disabled",
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
      const before = findRecheckUnitByFinding(db, "f3");

      expect(() =>
        finishRecheckUnitChecked(db, "ru-na", {
          expectedStatus: "not-applicable",
          status: "pending",
          attempts: 0,
          failure: null,
          pendingNote: null,
          notApplicableReason: null,
          verdict: null,
          reasonKind: null,
          reason: null,
          suggestionValid: null,
          usage: null,
          inputGraphemes: null,
          elapsedMs: null,
          finishedAt: new Date("2026-09-09T01:00:00.000Z"),
        }),
      ).toThrow(InvalidTransitionError);

      const after = findRecheckUnitByFinding(db, "f3");
      expect(after).toEqual(before);
      close();
    });

    it("claimRunChecked: completed → running は表にない（決定 3 で明示的に禁止）", () => {
      const { db, close } = setupDb();
      setupBase(db);
      // completed の実行を新たに作る（r1 は running のまま他のテストで使う想定はないが、
      // 目的をはっきりさせるため専用の行を作る）。
      insertRun(db, {
        id: "r-completed",
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
        status: "completed",
        stopReason: null,
        stopMessage: null,
        generationUnconfirmed: false,
        startOperationId: null,
        finishedAt: new Date("2026-09-09T00:00:00.000Z"),
      });
      const before = findRun(db, "r-completed");

      expect(() => claimRunChecked(db, "r-completed", "completed", "running")).toThrow(
        InvalidTransitionError,
      );

      const after = findRun(db, "r-completed");
      expect(after).toEqual(before);
      close();
    });

    it("finishRunChecked: expectedStatus=stopped → status=completed は表にない（決定 3 で明示的に禁止）", () => {
      const { db, close } = setupDb();
      setupBase(db);
      insertRun(db, {
        id: "r-stopped",
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
        status: "stopped",
        stopReason: "aborted",
        stopMessage: "ユーザーが停止しました",
        generationUnconfirmed: false,
        startOperationId: null,
        finishedAt: new Date("2026-09-09T00:00:00.000Z"),
      });
      const before = findRun(db, "r-stopped");

      expect(() =>
        finishRunChecked(db, "r-stopped", {
          expectedStatus: "stopped",
          status: "completed",
          stopReason: null,
          stopMessage: null,
          generationUnconfirmed: false,
          finishedAt: new Date("2026-09-09T02:00:00.000Z"),
        }),
      ).toThrow(InvalidTransitionError);

      const after = findRun(db, "r-stopped");
      expect(after).toEqual(before);
      close();
    });
  });

  describe("W2: 許容表にある遷移はリポジトリへそのまま委譲し、戻り値をそのまま返す", () => {
    it("claimUnitChecked: pending → running は options.startedAt ごと委譲され、true を返す", () => {
      const { db, close } = setupDb();
      setupBase(db);
      const startedAt = new Date("2026-09-09T00:00:00.000Z");

      const result = claimUnitChecked(db, "cu1", "pending", "running", { startedAt });
      expect(result).toBe(true);

      const after = findCheckUnit(db, "cu1");
      expect(after?.status).toBe("running");
      expect(after?.startedAt).toEqual(startedAt);
      close();
    });

    it("finishCheckUnitChecked: running → done は表にあり、委譲されて true を返す", () => {
      const { db, close } = setupDb();
      setupBase(db);
      claimUnitChecked(db, "cu1", "pending", "running", {
        startedAt: new Date("2026-09-09T00:00:00.000Z"),
      });

      const result = finishCheckUnitChecked(db, "cu1", {
        expectedStatus: "running",
        status: "done",
        attempts: 1,
        failure: null,
        pendingNote: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: 100,
        finishedAt: new Date("2026-09-09T01:00:00.000Z"),
      });
      expect(result).toBe(true);

      const after = findCheckUnit(db, "cu1");
      expect(after?.status).toBe("done");
      expect(after?.attempts).toBe(1);
      close();
    });

    it("claimRunChecked: 表にある遷移でもリポジトリの条件（実際の status）に合わなければ false を返す（例外にしない。決定 12）", () => {
      const { db, close } = setupDb();
      setupBase(db);
      // r1 は実際には running。stopped → running は許容表にあるが、リポジトリ側の条件付き
      // 更新（WHERE status = 'stopped'）に一致しないので false（決定 12：受け付けない状態は
      // 拒否し、現在のレコードを返す。例外にはしない）。
      const result = claimRunChecked(db, "r1", "stopped", "running");
      expect(result).toBe(false);

      const after = findRun(db, "r1");
      expect(after?.status).toBe("running");
      close();
    });

    it("claimRunChecked: options.clearStopState はそのままリポジトリへ渡り、5列を消す（決定 36）", () => {
      const { db, close } = setupDb();
      setupBase(db);
      // r1 を stopped にし、停止関連の列を埋める。
      finishRunChecked(db, "r1", {
        expectedStatus: "running",
        status: "stopped",
        stopReason: "aborted",
        stopMessage: "ユーザーが停止しました",
        generationUnconfirmed: true,
        finishedAt: new Date("2026-09-09T00:00:00.000Z"),
      });
      const stopped = findRun(db, "r1");
      expect(stopped?.status).toBe("stopped");
      expect(stopped?.stopReason).toBe("aborted");

      const resumed = claimRunChecked(db, "r1", "stopped", "running", { clearStopState: true });
      expect(resumed).toBe(true);

      const after = findRun(db, "r1");
      expect(after?.status).toBe("running");
      expect(after?.stopRequestedAt).toBeNull();
      expect(after?.generationUnconfirmed).toBe(false);
      expect(after?.finishedAt).toBeNull();
      expect(after?.stopReason).toBeNull();
      expect(after?.stopMessage).toBeNull();
      close();
    });

    it("finishRunChecked: running → completed は表にあり、委譲されて true を返す", () => {
      const { db, close } = setupDb();
      setupBase(db);
      const finishedAt = new Date("2026-09-09T03:00:00.000Z");

      const result = finishRunChecked(db, "r1", {
        expectedStatus: "running",
        status: "completed",
        stopReason: null,
        stopMessage: null,
        generationUnconfirmed: false,
        finishedAt,
      });
      expect(result).toBe(true);

      const after = findRun(db, "r1");
      expect(after?.status).toBe("completed");
      expect(after?.finishedAt).toEqual(finishedAt);
      close();
    });

    it("claimRecheckUnitChecked / finishRecheckUnitChecked: pending → running → done が委譲されて true を返す", () => {
      const { db, close } = setupDb();
      setupBase(db);

      const claimed = claimRecheckUnitChecked(db, "ru1", "pending", "running", {
        startedAt: new Date("2026-09-09T00:00:00.000Z"),
      });
      expect(claimed).toBe(true);
      expect(findRecheckUnitByFinding(db, "f1")?.status).toBe("running");

      const finished = finishRecheckUnitChecked(db, "ru1", {
        expectedStatus: "running",
        status: "done",
        attempts: 1,
        failure: null,
        pendingNote: null,
        notApplicableReason: null,
        verdict: "keep",
        reasonKind: null,
        reason: null,
        suggestionValid: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: 100,
        finishedAt: new Date("2026-09-09T01:00:00.000Z"),
      });
      expect(finished).toBe(true);
      expect(findRecheckUnitByFinding(db, "f1")?.status).toBe("done");
      close();
    });
  });
});
