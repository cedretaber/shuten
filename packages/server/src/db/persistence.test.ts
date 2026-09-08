import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createDatabase } from "./client.ts";
import { applyMigrations } from "./migrate.ts";
import {
  findCheckUnit,
  insertCheckUnit,
  listUnfinishedCheckUnits,
} from "./repositories/check-units.ts";
import { findFinding, insertFinding } from "./repositories/findings.ts";
import { findJudgment, setJudgment } from "./repositories/judgments.ts";
import { findManuscriptVersion, insertManuscriptVersion } from "./repositories/manuscripts.ts";
import { insertRecheckUnit, listUnfinishedRecheckUnits } from "./repositories/rechecks.ts";
import { findRun, insertRun, insertRunTarget, listRunTargets } from "./repositories/runs.ts";

/**
 * 再起動をまたぐ保持のテスト（仕様書 8.2 節「バックエンド終了時は完了分を保持し、
 * 再起動後に未完了分を再開できる」）。
 *
 * `:memory:` は開き直せないため、一時ディレクトリのファイル DB を使う。
 * WAL ファイルが残るため、開き直す前に必ず `close()` する（Windows でのファイルロックを避ける）。
 */

/** `insertRun` に渡す最小限の入力。 */
function baseRunInput(id: string) {
  return {
    id,
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
    perspectives: ["typo"] as const,
    recheckEnabled: true,
    allowedWords: [],
    allowedWordRuleVersion: "1",
    promptVersion: "1",
    diagnosticTransformVersion: "1",
    status: "running" as const,
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    startOperationId: null,
    finishedAt: null,
  };
}

describe("db/persistence", () => {
  it("D1: 一時ディレクトリのファイル DB に書いて close() し、開き直して同じ値が読める（本文は CRLF と単独 CR を含む）", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "shuten-persistence-"));
    const file = path.join(dir, "shuten.db");

    // CRLF と単独 CR を含む本文（仕様書 6.1 節：段落区切りは CRLF・単独 LF・単独 CR のいずれか）。
    const body = "一行目\r\n二行目\r三行目\n四行目";

    const opened = createDatabase(file);
    applyMigrations(opened.db);

    insertManuscriptVersion(opened.db, { id: "mv1", name: "原稿", body });
    const run = insertRun(opened.db, baseRunInput("r1"));
    const target = insertRunTarget(opened.db, {
      id: "t1",
      runId: run.id,
      targetIndex: 0,
      target: { start: 0, end: body.length },
      contextBefore: null,
      contextAfter: null,
      input: { start: 0, end: body.length },
      paragraphIds: [0, 1, 2, 3],
    });
    insertCheckUnit(opened.db, {
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
    const finding = insertFinding(opened.db, {
      id: "f1",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 0, end: 3 },
      paragraphId: 0,
      quote: "一行目",
      suggestion: "修正案",
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: "key1",
      suppression: null,
    });
    const judgedAt = new Date("2026-09-09T00:00:00.000Z");
    setJudgment(opened.db, finding.id, {
      status: "adopt-planned",
      note: "確認済み",
      updatedAt: judgedAt,
    });

    // 開き直す前に WAL ファイルが存在することを確かめる（journal_mode = WAL）。
    const filesBeforeClose = readdirSync(dir);
    expect(filesBeforeClose.some((f) => f.endsWith("-wal"))).toBe(true);

    opened.close();

    const reopened = createDatabase(file);
    applyMigrations(reopened.db);

    const foundManuscript = findManuscriptVersion(reopened.db, "mv1");
    expect(foundManuscript?.body).toBe(body);
    // CRLF がそのまま保持されている。
    expect(foundManuscript?.body.includes("一行目\r\n二行目")).toBe(true);
    // 単独 CR（LF を伴わない）も保持されている。
    expect(foundManuscript?.body.includes("二行目\r三行目")).toBe(true);

    const foundRun = findRun(reopened.db, "r1");
    expect(foundRun?.id).toBe("r1");
    expect(foundRun?.perspectives).toEqual(["typo"]);
    expect(foundRun?.recheckEnabled).toBe(true);

    const listedTargets = listRunTargets(reopened.db, "r1");
    expect(listedTargets).toHaveLength(1);
    expect(listedTargets[0]?.id).toBe("t1");
    expect(listedTargets[0]?.target).toEqual({ start: 0, end: body.length });

    const foundCheckUnit = findCheckUnit(reopened.db, "cu1");
    expect(foundCheckUnit?.status).toBe("done");

    const foundFinding = findFinding(reopened.db, "f1");
    expect(foundFinding?.quote).toBe("一行目");
    expect(foundFinding?.range).toEqual({ start: 0, end: 3 });

    const foundJudgment = findJudgment(reopened.db, "f1");
    expect(foundJudgment?.status).toBe("adopt-planned");
    expect(foundJudgment?.note).toBe("確認済み");
    expect(foundJudgment?.updatedAt).toEqual(judgedAt);

    reopened.close();

    rmSync(dir, { recursive: true, force: true });
    // WAL・SHM ファイルを含め、一時ディレクトリごと消えている。
    expect(existsSync(dir)).toBe(false);
  });

  it("D2: 開き直した後に未完了（pending / running）の検査単位と再確認単位を実行IDで列挙できる", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "shuten-persistence-"));
    const file = path.join(dir, "shuten.db");

    const opened = createDatabase(file);
    applyMigrations(opened.db);

    insertManuscriptVersion(opened.db, { id: "mv1", name: "原稿", body: "本文" });
    const run = insertRun(opened.db, baseRunInput("r1"));

    const statuses = ["pending", "running", "done", "failed", "not-applicable"] as const;
    let firstTargetId = "";
    for (const [index, status] of statuses.entries()) {
      const target = insertRunTarget(opened.db, {
        id: `t${index}`,
        runId: run.id,
        targetIndex: index,
        target: { start: 0, end: 10 },
        contextBefore: null,
        contextAfter: null,
        input: { start: 0, end: 10 },
        paragraphIds: [0],
      });
      if (index === 0) {
        firstTargetId = target.id;
      }

      insertCheckUnit(opened.db, {
        id: `cu-${status}`,
        runId: run.id,
        targetId: target.id,
        perspective: "typo",
        status,
        attempts: status === "pending" ? 0 : 1,
        failure:
          status === "failed"
            ? {
                reason: "timeout",
                message: "タイムアウトしました",
                finishReason: null,
                origin: "local",
              }
            : null,
        pendingNote: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: null,
        startedAt: null,
        finishedAt: null,
      });

      // recheck_units は finding_id に一意制約があるため、対象外理由（3値）とは無関係に
      // status ごとに 1 指摘・1 再確認単位を作る。findings 側は target_id を共有してよい。
      const finding = insertFinding(opened.db, {
        id: `f-${status}`,
        runId: run.id,
        manuscriptVersionId: "mv1",
        targetId: firstTargetId,
        locateStatus: "located",
        range: { start: 0, end: 2 },
        paragraphId: 0,
        quote: "誤字",
        suggestion: null,
        category: "notation",
        initialVerdict: "likely-error",
        mergeKey: null,
        suppression: null,
      });
      insertRecheckUnit(opened.db, {
        id: `rc-${status}`,
        runId: run.id,
        findingId: finding.id,
        inputRange: status === "pending" ? null : { start: 0, end: 20 },
        status,
        notApplicableReason: status === "not-applicable" ? "suppressed" : null,
        attempts: status === "pending" ? 0 : 1,
        failure:
          status === "failed"
            ? {
                reason: "timeout",
                message: "タイムアウトしました",
                finishReason: null,
                origin: "local",
              }
            : null,
        pendingNote: null,
        verdict: status === "done" ? "keep" : null,
        reasonKind: status === "done" ? "error-confirmed" : null,
        reason: null,
        suggestionValid: status === "done" ? true : null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: null,
        startedAt: null,
        finishedAt: null,
      });
    }

    opened.close();

    const reopened = createDatabase(file);
    applyMigrations(reopened.db);

    const unfinishedCheckUnits = listUnfinishedCheckUnits(reopened.db, run.id);
    expect(unfinishedCheckUnits.map((u) => u.id).sort()).toEqual(["cu-pending", "cu-running"]);

    const unfinishedRecheckUnits = listUnfinishedRecheckUnits(reopened.db, run.id);
    expect(unfinishedRecheckUnits.map((u) => u.id).sort()).toEqual(["rc-pending", "rc-running"]);

    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
