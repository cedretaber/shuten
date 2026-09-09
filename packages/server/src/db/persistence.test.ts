import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { LmStudioClient } from "../lmstudio/types.ts";
import { createOrchestrator } from "../run/orchestrator.ts";
import { createRequestQueue } from "../run/queue.ts";
import { createRecoveryGate } from "../run/recovery-gate.ts";
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
 * テストが失敗して assertion 例外を投げても、開いた DB ハンドルと一時ディレクトリが残らないよう、
 * `try` / `finally` で必ず後片付けする（`createTempDbContext` を参照）。
 */

/** `close()` を持つ最小限の型（`AppDatabaseHandle`）。 */
interface Closable {
  close(): void;
}

/**
 * 一時ディレクトリのファイル DB を使うテストの後片付けをまとめる。
 *
 * `track()` で開いたハンドルを登録しておくと、テストが正常終了しても assertion 失敗で
 * 例外を投げても、`cleanup()`（`finally` から呼ぶ）がすべてのハンドルを `close()` してから
 * 一時ディレクトリを `rmSync` で消す。二重に `close()` しても（例：テスト内で明示的に閉じた後の
 * ハンドルも登録したまま）例外を無視するので安全。
 */
function createTempDbContext(): {
  readonly dir: string;
  readonly file: string;
  track<T extends Closable>(handle: T): T;
  cleanup(): void;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shuten-persistence-"));
  const file = path.join(dir, "shuten.db");
  const handles: Closable[] = [];
  return {
    dir,
    file,
    track<T extends Closable>(handle: T): T {
      handles.push(handle);
      return handle;
    },
    cleanup(): void {
      for (const handle of handles) {
        try {
          handle.close();
        } catch {
          // 既にテスト内で明示的に close() 済みのハンドルは無視する。
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

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
    const ctx = createTempDbContext();
    try {
      // CRLF と単独 CR を含む本文（仕様書 6.1 節：段落区切りは CRLF・単独 LF・単独 CR のいずれか）。
      const body = "一行目\r\n二行目\r三行目\n四行目";

      const opened = ctx.track(createDatabase(ctx.file));
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
      const filesBeforeClose = readdirSync(ctx.dir);
      expect(filesBeforeClose.some((f) => f.endsWith("-wal"))).toBe(true);

      opened.close();

      const reopened = ctx.track(createDatabase(ctx.file));
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
    } finally {
      ctx.cleanup();
    }
    // WAL・SHM ファイルを含め、一時ディレクトリごと消えている（cleanup() が rmSync 済み）。
    expect(existsSync(ctx.dir)).toBe(false);
  });

  it("D2: 開き直した後に未完了（pending / running）の検査単位と再確認単位を実行IDで列挙できる", () => {
    const ctx = createTempDbContext();
    try {
      const opened = ctx.track(createDatabase(ctx.file));
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

      const reopened = ctx.track(createDatabase(ctx.file));
      applyMigrations(reopened.db);

      const unfinishedCheckUnits = listUnfinishedCheckUnits(reopened.db, run.id);
      expect(unfinishedCheckUnits.map((u) => u.id).sort()).toEqual(["cu-pending", "cu-running"]);

      const unfinishedRecheckUnits = listUnfinishedRecheckUnits(reopened.db, run.id);
      expect(unfinishedRecheckUnits.map((u) => u.id).sort()).toEqual(["rc-pending", "rc-running"]);

      reopened.close();
    } finally {
      ctx.cleanup();
    }
  });

  /**
   * Task 9 の D1（起動時照合を含む再起動テスト）。PR8 の D2（このファイルの上のテスト）が
   * 「行が残ること」を確認したのに対し、ここでは「残った running の行を起動時照合がどう扱い、
   * 再開でその続きから最後まで進められるか」（決定 13）を、ファイル DB を実際に閉じて
   * 開き直した上で確認する。
   */
  it("起動時照合と再開：ハンドルを閉じて開き直した後、reconcileOnStartup → resumeRun で最後まで進む（Task 9 D1）", async () => {
    const ctx = createTempDbContext();
    try {
      const body = "あいうえおかきくけこさしすせそたちつてと"; // 20 書記素・1 段落

      const opened = ctx.track(createDatabase(ctx.file));
      applyMigrations(opened.db);

      insertManuscriptVersion(opened.db, { id: "mv1", name: "原稿", body });
      const run = insertRun(opened.db, {
        ...baseRunInput("run-d1"),
        perspectives: ["typo", "naturalness"],
        recheckEnabled: false,
        status: "running",
        finishedAt: null,
      });
      const target = insertRunTarget(opened.db, {
        id: "run-d1-t0",
        runId: run.id,
        targetIndex: 0,
        target: { start: 0, end: body.length },
        contextBefore: null,
        contextAfter: null,
        input: { start: 0, end: body.length },
        paragraphIds: [0],
      });
      // 1 観点目はプロセスが落ちる前に完了していた。
      insertCheckUnit(opened.db, {
        id: "run-d1-cu-typo",
        runId: run.id,
        targetId: target.id,
        perspective: "typo",
        status: "done",
        attempts: 1,
        failure: null,
        pendingNote: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: 5,
        startedAt: new Date(1000),
        finishedAt: new Date(2000),
      });
      // 2 観点目は生成要求を送った直後（running）にバックエンドが落ちた、という状況を再現する。
      insertCheckUnit(opened.db, {
        id: "run-d1-cu-naturalness",
        runId: run.id,
        targetId: target.id,
        perspective: "naturalness",
        status: "running",
        attempts: 1,
        failure: null,
        pendingNote: null,
        usage: null,
        inputGraphemes: null,
        elapsedMs: null,
        startedAt: new Date(1500),
        finishedAt: null,
      });

      opened.close();

      // ハンドルを閉じて開き直す（バックエンドの再起動を模す）。
      const reopened = ctx.track(createDatabase(ctx.file));
      applyMigrations(reopened.db);

      // 起動時照合の後に再開が続きから進められることを確かめるための、台本つきモック
      // クライアント。「naturalness」観点の 1 回の生成要求にだけ応答する。
      const requests: unknown[] = [];
      const client: LmStudioClient = {
        listModels: () =>
          Promise.resolve([
            {
              id: "model-a",
              type: "llm",
              state: "loaded",
              quantization: null,
              maxContextLength: 4096,
              loadedContextLength: 2048,
            },
          ]),
        ensureLoaded: () =>
          Promise.resolve({
            id: "model-a",
            type: "llm",
            state: "loaded",
            quantization: null,
            maxContextLength: 4096,
            loadedContextLength: 2048,
          }),
        chat: (request) => {
          requests.push(request);
          if (requests.length > 1) {
            throw new Error("台本にない生成要求（続きから進むはずが、やり直している）");
          }
          return Promise.resolve({
            content: JSON.stringify({ findings: [] }),
            reasoningContent: null,
            finishReason: "stop",
            usage: {
              promptTokens: 10,
              completionTokens: 5,
              totalTokens: 15,
              reasoningTokens: null,
            },
            raw: {},
          });
        },
      };

      const recoveryGate = createRecoveryGate();
      const orchestrator = createOrchestrator({
        db: reopened.db,
        client,
        queue: createRequestQueue(),
        recoveryGate,
        endpointUrl: "http://127.0.0.1:1234",
        recoveryConfirmMs: 60_000,
      });

      // 決定 13：自動では再開しない。running の単位を持っていたので recovery-waiting になる。
      orchestrator.reconcileOnStartup();
      const reconciled = findRun(reopened.db, "run-d1");
      expect(reconciled?.status).toBe("recovery-waiting");
      expect(reconciled?.generationUnconfirmed).toBe(true);
      const pendingUnit = findCheckUnit(reopened.db, "run-d1-cu-naturalness");
      expect(pendingUnit?.status).toBe("pending");
      expect(pendingUnit?.pendingNote).toBe("バックエンドが終了したため未完了のまま残った");
      // 完了済みの単位は触られない。
      expect(findCheckUnit(reopened.db, "run-d1-cu-typo")?.status).toBe("done");
      // 決定 39：起動時照合が復旧ゲートを閉じる（再起動しただけでは自動で送信を再開しない）。
      expect(recoveryGate.blocked).toBe(true);

      // 利用者が LM Studio 側を確認し、手で再開する。
      const resumed = orchestrator.resumeRun("run-d1");
      expect(resumed.accepted).toBe(true);
      // resumeRun が recovery-waiting の claim に成功した時点でゲートが開く（決定 39 の唯一の口）。
      expect(recoveryGate.blocked).toBe(false);
      const finished = await resumed.done;

      expect(finished.status).toBe("completed");
      expect(requests).toHaveLength(1);
      expect(findCheckUnit(reopened.db, "run-d1-cu-naturalness")?.status).toBe("done");
      // 完了済みだった単位の attempts は再開の影響を受けない。
      expect(findCheckUnit(reopened.db, "run-d1-cu-typo")?.attempts).toBe(1);

      reopened.close();
    } finally {
      ctx.cleanup();
    }
  });
});
