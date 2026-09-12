/**
 * エクスポートの組み立て（`api/run-export.ts`）のテスト（T13）。
 *
 * HTTP を通さず、DB に直接行を入れて組み立てだけを見る（`run-export.ts` は Hono に依存しない。
 * `run-view.test.ts` と同じ姿勢）。404 の経路は `api/leak.test.ts` がハンドラー経由で確かめる
 * （PR13a-2 Task 9）。
 */

import { describe, expect, it } from "vitest";

import { createDatabase } from "../db/client.ts";
import { applyMigrations } from "../db/migrate.ts";
import type { RunRecord } from "../db/records.ts";
import { insertCheckUnit } from "../db/repositories/check-units.ts";
import type { UnlocatedLocateResult } from "../db/repositories/findings.ts";
import {
  insertCandidate,
  insertFinding,
  saveUnlocatedCandidate,
} from "../db/repositories/findings.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { insertRecheckUnit } from "../db/repositories/rechecks.ts";
import { insertRun, insertRunTarget } from "../db/repositories/runs.ts";
import { buildRunExport } from "./run-export.ts";

function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

type Db = ReturnType<typeof setupDb>["db"];

/** 20 書記素・1 段落。同じ文字が 2 度出ないので範囲の指定が読みやすい（`findings.test.ts` と同じ本文）。 */
const BODY = "あいうえおかきくけこさしすせそたちつてと";

const CHUNK_SETTINGS = {
  targetGraphemes: 20,
  contextGraphemes: 0,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 50,
};

/** 原稿版・実行・検査対象・検査単位を 1 つずつ作る（`findings.test.ts` の `seedRun` と同じ形）。 */
function seedRun(
  db: Db,
  runId: string,
): {
  readonly run: RunRecord;
  readonly targetId: string;
  readonly checkUnitId: string;
  readonly manuscriptVersionId: string;
} {
  const manuscriptVersionId = `mv-${runId}`;
  insertManuscriptVersion(db, { id: manuscriptVersionId, name: "原稿", body: BODY });
  const run = insertRun(db, {
    id: runId,
    manuscriptVersionId,
    modelId: "model-a",
    modelInfo: null,
    endpointUrl: "http://127.0.0.1:1234",
    generationSettings: { maxTokens: 512, temperature: 0 },
    chunkSettings: CHUNK_SETTINGS,
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
    startOperationId: `seed-${runId}`,
    finishedAt: null,
  });
  const targetId = `t-${runId}`;
  insertRunTarget(db, {
    id: targetId,
    runId,
    targetIndex: 0,
    target: { start: 0, end: 20 },
    contextBefore: null,
    contextAfter: null,
    input: { start: 0, end: 20 },
    paragraphIds: [0],
  });
  const checkUnitId = `cu-${runId}`;
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
  return { run, targetId, checkUnitId, manuscriptVersionId };
}

describe("api/run-export: buildRunExport", () => {
  it("仕様 8.1 の保存単位すべてを含み、位置特定失敗の内訳を findings / unlocatedCandidates に正しく振り分ける（決定 23）", () => {
    const { db, close } = setupDb();
    const runId = "r1";
    const { run, targetId, checkUnitId, manuscriptVersionId } = seedRun(db, runId);

    // located の指摘：理由（元候補）・再確認・採否を持つ。
    const located = insertFinding(db, {
      id: "f-located",
      runId,
      manuscriptVersionId,
      targetId,
      locateStatus: "located",
      range: { start: 0, end: 2 },
      paragraphId: 0,
      quote: "あい",
      suggestion: "あい(訂正)",
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: null,
      suppression: null,
    });
    insertCandidate(db, {
      id: "f-located-c1",
      runId,
      checkUnitId,
      findingId: located.id,
      candidateIndex: 0,
      llm: {
        paragraphId: 0,
        quote: "あい",
        before: "",
        after: "うえ",
        category: "notation",
        reason: "あいが誤字の可能性",
        suggestion: "あい(訂正)",
        verdict: "likely-error",
      },
      locateStatus: "located",
      range: { start: 0, end: 2 },
      mergeKey: null,
    });
    insertRecheckUnit(db, {
      id: "rc-located",
      runId,
      findingId: located.id,
      inputRange: { start: 0, end: 2 },
      status: "done",
      notApplicableReason: null,
      attempts: 1,
      failure: null,
      pendingNote: null,
      verdict: "keep",
      reasonKind: "error-confirmed",
      reason: "問題を確認した",
      suggestionValid: true,
      usage: null,
      inputGraphemes: null,
      elapsedMs: 10,
      startedAt: null,
      finishedAt: new Date(),
    });

    // not-found の指摘：位置は null、候補・診断（変換候補あり）を伴う（決定 23 の表の 1 行目）。
    const notFoundLocate: UnlocatedLocateResult = {
      status: "failed",
      reason: "not-found",
      exactMatches: [],
      diagnostic: {
        transformVersion: "1",
        candidates: [{ transform: "nfc", text: "たちつ", range: { start: 15, end: 18 } }],
        omitted: 0,
        tied: false,
      },
    };
    saveUnlocatedCandidate(db, {
      runId,
      checkUnitId,
      candidateIndex: 1,
      llm: {
        paragraphId: 0,
        quote: "たちつ",
        before: "せそ",
        after: "てと",
        category: "notation",
        reason: "変換後にしか一致しない",
        suggestion: null,
        verdict: "confirm-with-author",
      },
      manuscriptVersionId,
      targetId,
      searchRange: { start: 0, end: 20 },
      locate: notFoundLocate,
      findingId: "f-not-found",
      candidateId: "f-not-found-c1",
    });

    // ambiguous の指摘：位置は null、診断は非空だが変換候補は null（決定 23 の表の 2 行目）。
    const ambiguousLocate: UnlocatedLocateResult = {
      status: "failed",
      reason: "ambiguous",
      exactMatches: [
        { start: 2, end: 4 },
        { start: 6, end: 8 },
      ],
      diagnostic: null,
    };
    saveUnlocatedCandidate(db, {
      runId,
      checkUnitId,
      candidateIndex: 2,
      llm: {
        paragraphId: 0,
        quote: "うえ",
        before: "",
        after: "",
        category: "notation",
        reason: "複数箇所に一致",
        suggestion: null,
        verdict: "confirm-with-author",
      },
      manuscriptVersionId,
      targetId,
      searchRange: { start: 0, end: 20 },
      locate: ambiguousLocate,
      findingId: "f-ambiguous",
      candidateId: "f-ambiguous-c1",
    });

    // outside-target の候補：指摘は作らない（`findingId` は null。決定 23 の表の 3 行目）。
    const outsideLocate: UnlocatedLocateResult = {
      status: "failed",
      reason: "outside-target",
      exactMatches: [{ start: 0, end: 2 }],
      diagnostic: null,
    };
    saveUnlocatedCandidate(db, {
      runId,
      checkUnitId,
      candidateIndex: 3,
      llm: {
        paragraphId: 0,
        quote: "あい",
        before: "",
        after: "",
        category: "notation",
        reason: "参考文脈内から始まる",
        suggestion: null,
        verdict: "confirm-with-author",
      },
      manuscriptVersionId,
      targetId,
      searchRange: { start: 0, end: 20 },
      locate: outsideLocate,
      candidateId: "f-outside-c1",
    });

    const result = buildRunExport(db, run);

    // 形式の版・時刻。
    expect(result.formatVersion).toBe("1");
    expect(() => new Date(result.exportedAt).toISOString()).not.toThrow();
    expect(new Date(result.exportedAt).toISOString()).toBe(result.exportedAt);

    // 実行・原稿版・検査対象・検査単位（仕様 8.1 の保存単位）。
    expect(result.run.id).toBe(runId);
    expect(result.run).not.toHaveProperty("endpointUrl");
    expect(result.manuscript).toEqual({
      id: manuscriptVersionId,
      name: "原稿",
      body: BODY,
      bodyHash: expect.any(String),
      createdAt: expect.any(String),
    });
    expect(result.targets.map((t) => t.id)).toEqual([targetId]);
    expect(result.checkUnits.map((u) => u.id)).toEqual([checkUnitId]);
    expect(result.checkUnits[0]?.targetIndex).toBe(0);

    // findings：located ＋ not-found ＋ ambiguous の 3 件（outside-target は指摘を持たない）。
    expect(result.findings).toHaveLength(3);
    const findingById = new Map(result.findings.map((f) => [f.id, f]));

    const locatedDto = findingById.get("f-located");
    expect(locatedDto?.locateStatus).toBe("located");
    expect(locatedDto?.range).toEqual({ start: 0, end: 2 });
    expect(locatedDto?.candidates.map((c) => c.id)).toEqual(["f-located-c1"]);
    expect(locatedDto?.diagnostics).toEqual([]);
    expect(locatedDto?.recheck?.verdict).toBe("keep");
    // judgment は常に非 null（`undecided` が指摘の作成と同時にできる。PR8 決定 5）。
    expect(locatedDto?.judgment.status).toBe("undecided");

    const notFoundDto = findingById.get("f-not-found");
    expect(notFoundDto?.locateStatus).toBe("not-found");
    expect(notFoundDto?.range).toBeNull();
    expect(notFoundDto?.candidates.map((c) => c.id)).toEqual(["f-not-found-c1"]);
    expect(notFoundDto?.diagnostics).toHaveLength(1);
    expect(notFoundDto?.diagnostics[0]?.reason).toBe("not-found");
    expect(notFoundDto?.diagnostics[0]?.transformCandidates).not.toBeNull();

    const ambiguousDto = findingById.get("f-ambiguous");
    expect(ambiguousDto?.locateStatus).toBe("ambiguous");
    expect(ambiguousDto?.range).toBeNull();
    expect(ambiguousDto?.candidates.map((c) => c.id)).toEqual(["f-ambiguous-c1"]);
    expect(ambiguousDto?.diagnostics).toHaveLength(1);
    expect(ambiguousDto?.diagnostics[0]?.reason).toBe("ambiguous");
    expect(ambiguousDto?.diagnostics[0]?.transformCandidates).toBeNull();

    // outside-target は findings に出ない。
    expect(findingById.has("f-outside")).toBe(false);

    // unlocatedCandidates は「finding_id が null の候補」＝ outside-target だけ（決定 23）。
    // ID の集合まで見る：件数だけの検査では、finding_id を無視して全候補を出す誤りを検出できない。
    expect(result.unlocatedCandidates.map((c) => c.id)).toEqual(["f-outside-c1"]);
    expect(result.unlocatedDiagnostics.map((d) => d.candidateId)).toEqual(["f-outside-c1"]);
    expect(result.unlocatedDiagnostics[0]?.reason).toBe("outside-target");

    close();
  });

  it("指摘も候補も無い実行では、findings / unlocatedCandidates / unlocatedDiagnostics が空になる", () => {
    const { db, close } = setupDb();
    const { run } = seedRun(db, "r-empty");

    const result = buildRunExport(db, run);

    expect(result.findings).toEqual([]);
    expect(result.unlocatedCandidates).toEqual([]);
    expect(result.unlocatedDiagnostics).toEqual([]);

    close();
  });
});
