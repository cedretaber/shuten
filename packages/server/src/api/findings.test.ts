/**
 * A5：指摘と採否（`api/findings.test.ts`。決定 15）。
 *
 * 一覧・詳細・採否を、`setupApi()` が組んだ実物のアプリ（`app.request`）から見る。指摘は
 * `insertFinding` / `insertCandidate` / `saveUnlocatedCandidate` で直接作る（ループを走らせるより
 * 速く、位置特定失敗の指摘も `saveUnlocatedCandidate` で素直に作れる）。
 */

import {
  ALLOWED_WORD_RULE_VERSION,
  DIAGNOSTIC_TRANSFORM_VERSION,
  PROMPT_VERSION,
} from "@shuten/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { insertCheckUnit } from "../db/repositories/check-units.ts";
import type { UnlocatedLocateResult } from "../db/repositories/findings.ts";
import {
  insertCandidate,
  insertFinding,
  saveUnlocatedCandidate,
} from "../db/repositories/findings.ts";
import { setJudgment } from "../db/repositories/judgments.ts";
import { findManuscriptVersion, insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { finishRecheckUnit, insertRecheckUnit } from "../db/repositories/rechecks.ts";
import { insertRun, insertRunTarget } from "../db/repositories/runs.ts";
import { judgments } from "../db/schema.ts";
import type { ApiHarness } from "./test-support.ts";
import { createHarnessRegistry, JSON_HEADERS } from "./test-support.ts";

const { open } = createHarnessRegistry();

/** ---------------------------------------------------------------------- */
/** 素材 */
/** ---------------------------------------------------------------------- */

/** 20 書記素・1 段落。同じ文字が 2 度出ないので範囲の指定が読みやすい。 */
const BODY = "あいうえおかきくけこさしすせそたちつてと";

const CHUNK_SETTINGS = {
  targetGraphemes: 20,
  contextGraphemes: 0,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 50,
};

/** 実行・検査対象・検査単位を 1 つずつ作る（原稿・実行・対象・単位は指摘の外部キー先）。 */
function seedRun(
  harness: ApiHarness,
  runId: string,
): {
  readonly targetId: string;
  readonly checkUnitId: string;
  readonly manuscriptVersionId: string;
} {
  const manuscriptVersionId = `mv-${runId}`;
  insertManuscriptVersion(harness.db, { id: manuscriptVersionId, name: "原稿", body: BODY });
  insertRun(harness.db, {
    id: runId,
    manuscriptVersionId,
    modelId: "model-a",
    modelInfo: null,
    endpointUrl: harness.connection.current().endpointUrl,
    generationSettings: { maxTokens: 512, temperature: 0 },
    chunkSettings: CHUNK_SETTINGS,
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: true,
    allowedWords: [],
    allowedWordRuleVersion: ALLOWED_WORD_RULE_VERSION,
    promptVersion: PROMPT_VERSION,
    diagnosticTransformVersion: DIAGNOSTIC_TRANSFORM_VERSION,
    status: "completed",
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    startOperationId: `seed-${runId}`,
    finishedAt: null,
  });
  const targetId = `t-${runId}`;
  insertRunTarget(harness.db, {
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
  insertCheckUnit(harness.db, {
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
  return { targetId, checkUnitId, manuscriptVersionId };
}

/** 位置確定済みの指摘を 1 件、元候補（理由の元）を添えて作る。 */
function seedLocatedFinding(
  harness: ApiHarness,
  args: {
    readonly runId: string;
    readonly manuscriptVersionId: string;
    readonly targetId: string;
    readonly checkUnitId: string;
    readonly findingId: string;
    readonly quote: string;
    readonly range: { readonly start: number; readonly end: number };
    readonly suppression?: { readonly word: string; readonly ruleVersion: string } | null;
    /** 実行内で一意にすること（`candidates` は `(run_id, candidate_index)` が一意制約）。既定 0。 */
    readonly candidateIndex?: number;
  },
): void {
  const finding = insertFinding(harness.db, {
    id: args.findingId,
    runId: args.runId,
    manuscriptVersionId: args.manuscriptVersionId,
    targetId: args.targetId,
    locateStatus: "located",
    range: args.range,
    paragraphId: 0,
    quote: args.quote,
    suggestion: `${args.quote}(訂正)`,
    category: "notation",
    initialVerdict: "likely-error",
    mergeKey: null,
    suppression: args.suppression ?? null,
  });
  insertCandidate(harness.db, {
    id: `${args.findingId}-c1`,
    runId: args.runId,
    checkUnitId: args.checkUnitId,
    findingId: finding.id,
    candidateIndex: args.candidateIndex ?? 0,
    llm: {
      paragraphId: 0,
      quote: args.quote,
      before: "",
      after: "",
      category: "notation",
      reason: `${args.quote} が誤字の可能性`,
      suggestion: `${args.quote}(訂正)`,
      verdict: "likely-error",
    },
    locateStatus: "located",
    range: args.range,
    mergeKey: null,
  });
}

/** 位置特定失敗（`not-found`）の指摘を 1 件、位置診断（変換候補あり）を添えて作る。 */
function seedUnlocatedFinding(
  harness: ApiHarness,
  args: {
    readonly runId: string;
    readonly manuscriptVersionId: string;
    readonly targetId: string;
    readonly checkUnitId: string;
    readonly findingId: string;
    /** 実行内で一意にすること（`candidates` は `(run_id, candidate_index)` が一意制約）。既定 1。 */
    readonly candidateIndex?: number;
  },
): void {
  const locate: UnlocatedLocateResult = {
    status: "failed",
    reason: "not-found",
    exactMatches: [],
    diagnostic: {
      transformVersion: DIAGNOSTIC_TRANSFORM_VERSION,
      candidates: [{ transform: "nfc", text: "たちつ", range: { start: 15, end: 18 } }],
      omitted: 0,
      tied: false,
    },
  };
  saveUnlocatedCandidate(harness.db, {
    runId: args.runId,
    checkUnitId: args.checkUnitId,
    candidateIndex: args.candidateIndex ?? 1,
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
    manuscriptVersionId: args.manuscriptVersionId,
    targetId: args.targetId,
    searchRange: { start: 0, end: 20 },
    locate,
    findingId: args.findingId,
    candidateId: `${args.findingId}-c1`,
  });
}

/** ---------------------------------------------------------------------- */
/** 要求のヘルパー */
/** ---------------------------------------------------------------------- */

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

async function getJson(harness: ApiHarness, path: string): Promise<ApiResponse> {
  const res = await harness.app.request(path);
  return { status: res.status, body: await res.json() };
}

async function putJson(harness: ApiHarness, path: string, body: unknown): Promise<ApiResponse> {
  const res = await harness.app.request(path, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

interface FindingReasonBody {
  readonly candidateId: string;
  readonly perspective: string;
  readonly reason: string;
}

interface RecheckSummaryBody {
  readonly id: string;
  readonly status: string;
  readonly verdict: string | null;
}

interface JudgmentBody {
  readonly findingId: string;
  readonly status: string;
  readonly note: string | null;
  readonly updatedAt: string;
}

interface FindingBody {
  readonly id: string;
  readonly locateStatus: string;
  readonly range: { start: number; end: number } | null;
  readonly quote: string;
  readonly suppression: { word: string; ruleVersion: string } | null;
  readonly reasons: readonly FindingReasonBody[];
  readonly recheck: RecheckSummaryBody | null;
  readonly judgment: JudgmentBody;
}

interface CandidateBody {
  readonly id: string;
  readonly checkUnitId: string;
  readonly perspective: string;
}

interface DiagnosticBody {
  readonly candidateId: string;
  readonly reason: string;
}

interface FindingDetailBody extends FindingBody {
  readonly candidates: readonly CandidateBody[];
  readonly diagnostics: readonly DiagnosticBody[];
}

function findingsOf(body: unknown): FindingBody[] {
  return body as FindingBody[];
}

function detailOf(body: unknown): FindingDetailBody {
  return body as FindingDetailBody;
}

function judgmentOf(body: unknown): JudgmentBody {
  return body as JudgmentBody;
}

/** `noUncheckedIndexedAccess` の下で非 null 断言（`!`。biome が禁じる）を使わずに要素を取る。 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`配列の要素がありません（index: ${index}）`);
  }
  return item;
}

/** ---------------------------------------------------------------------- */
/** GET /api/runs/:id/findings */
/** ---------------------------------------------------------------------- */

describe("GET /api/runs/:id/findings", () => {
  it("理由（観点付き）・再確認・採否・抑制を含め、listFindings の並び（start 昇順、未確定は最後）で返す", async () => {
    const harness = open();
    const { targetId, checkUnitId, manuscriptVersionId } = seedRun(harness, "r1");

    // 挿入順をあえて並び順と逆にする（並びが `listFindings` 由来であることを確かめるため）。
    seedLocatedFinding(harness, {
      runId: "r1",
      manuscriptVersionId,
      targetId,
      checkUnitId,
      findingId: "f2",
      quote: "かきく",
      range: { start: 5, end: 8 },
      candidateIndex: 0,
    });
    seedLocatedFinding(harness, {
      runId: "r1",
      manuscriptVersionId,
      targetId,
      checkUnitId,
      findingId: "f1",
      quote: "あいう",
      range: { start: 0, end: 3 },
      suppression: { word: "あいう", ruleVersion: "v1" },
      candidateIndex: 1,
    });
    seedUnlocatedFinding(harness, {
      runId: "r1",
      manuscriptVersionId,
      targetId,
      checkUnitId,
      findingId: "f3",
      candidateIndex: 2,
    });

    // f1 に再確認単位を起票して決着させる。f2・f3 には起票しない（recheck が null になることを見る）。
    insertRecheckUnit(harness.db, {
      id: "rc1",
      runId: "r1",
      findingId: "f1",
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
    finishRecheckUnit(harness.db, "rc1", {
      expectedStatus: "pending",
      status: "done",
      attempts: 1,
      failure: null,
      pendingNote: null,
      notApplicableReason: null,
      verdict: "keep",
      reasonKind: "error-confirmed",
      reason: "問題を確認した",
      suggestionValid: true,
      usage: null,
      inputGraphemes: null,
      elapsedMs: 50,
      finishedAt: new Date(),
    });

    // f1 は採用予定に設定。f2・f3 は既定の未判断のまま。
    setJudgment(harness.db, "f1", { status: "adopt-planned", note: "対応する" });

    const { status, body } = await getJson(harness, "/api/runs/r1/findings");

    expect(status).toBe(200);
    const findings = findingsOf(body);
    // start 昇順（f1: 0, f2: 5）、位置未確定（f3）は最後。
    expect(findings.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);

    const f1 = at(findings, 0);
    expect(f1.reasons).toEqual([
      { candidateId: "f1-c1", perspective: "typo", reason: "あいう が誤字の可能性" },
    ]);
    expect(f1.suppression).toEqual({ word: "あいう", ruleVersion: "v1" });
    expect(f1.recheck).toMatchObject({ id: "rc1", status: "done", verdict: "keep" });
    expect(f1.judgment).toMatchObject({
      findingId: "f1",
      status: "adopt-planned",
      note: "対応する",
    });

    const f2 = at(findings, 1);
    expect(f2.suppression).toBeNull();
    expect(f2.recheck).toBeNull();
    expect(f2.judgment).toMatchObject({ findingId: "f2", status: "undecided", note: null });

    const f3 = at(findings, 2);
    expect(f3.locateStatus).toBe("not-found");
    expect(f3.range).toBeNull();
    expect(f3.recheck).toBeNull();
    expect(f3.judgment).toMatchObject({ findingId: "f3", status: "undecided", note: null });
  });

  it("実行が無ければ 404", async () => {
    const harness = open();

    const { status, body } = await getJson(harness, "/api/runs/missing/findings");

    expect(status).toBe(404);
    expect(errorCode(body)).toBe("not-found");
  });

  it("judgments の行を消した指摘の一覧は 500 internal（正常値に丸めない）", async () => {
    const harness = open();
    const { targetId, checkUnitId, manuscriptVersionId } = seedRun(harness, "r1");
    seedLocatedFinding(harness, {
      runId: "r1",
      manuscriptVersionId,
      targetId,
      checkUnitId,
      findingId: "f1",
      quote: "あいう",
      range: { start: 0, end: 3 },
    });

    harness.db.delete(judgments).where(eq(judgments.findingId, "f1")).run();

    const { status, body } = await getJson(harness, "/api/runs/r1/findings");

    expect(status).toBe(500);
    expect(errorCode(body)).toBe("internal");
  });
});

/** ---------------------------------------------------------------------- */
/** GET /api/findings/:id */
/** ---------------------------------------------------------------------- */

describe("GET /api/findings/:id", () => {
  it("位置確定済みの詳細は元候補（観点付き）を含み、位置診断は空", async () => {
    const harness = open();
    const { targetId, checkUnitId, manuscriptVersionId } = seedRun(harness, "r1");
    seedLocatedFinding(harness, {
      runId: "r1",
      manuscriptVersionId,
      targetId,
      checkUnitId,
      findingId: "f1",
      quote: "あいう",
      range: { start: 0, end: 3 },
    });

    const { status, body } = await getJson(harness, "/api/findings/f1");

    expect(status).toBe(200);
    const detail = detailOf(body);
    expect(detail.candidates).toHaveLength(1);
    expect(detail.candidates[0]).toMatchObject({ id: "f1-c1", checkUnitId, perspective: "typo" });
    expect(detail.diagnostics).toEqual([]);
  });

  it("位置特定失敗の詳細は元候補と位置診断を非空で含む", async () => {
    const harness = open();
    const { targetId, checkUnitId, manuscriptVersionId } = seedRun(harness, "r1");
    seedUnlocatedFinding(harness, {
      runId: "r1",
      manuscriptVersionId,
      targetId,
      checkUnitId,
      findingId: "f3",
    });

    const { status, body } = await getJson(harness, "/api/findings/f3");

    expect(status).toBe(200);
    const detail = detailOf(body);
    expect(detail.locateStatus).toBe("not-found");
    expect(detail.candidates).toHaveLength(1);
    expect(detail.candidates[0]).toMatchObject({ id: "f3-c1", checkUnitId, perspective: "typo" });
    expect(detail.diagnostics).toHaveLength(1);
    expect(detail.diagnostics[0]).toMatchObject({ candidateId: "f3-c1", reason: "not-found" });
  });

  it("指摘が無ければ 404", async () => {
    const harness = open();

    const { status, body } = await getJson(harness, "/api/findings/missing");

    expect(status).toBe(404);
    expect(errorCode(body)).toBe("not-found");
  });
});

/** ---------------------------------------------------------------------- */
/** PUT /api/findings/:id/judgment */
/** ---------------------------------------------------------------------- */

describe("PUT /api/findings/:id/judgment", () => {
  it("作成・更新でき、note 省略は null になる。本文（原稿版）は変わらない", async () => {
    const harness = open();
    const { targetId, checkUnitId, manuscriptVersionId } = seedRun(harness, "r1");
    seedLocatedFinding(harness, {
      runId: "r1",
      manuscriptVersionId,
      targetId,
      checkUnitId,
      findingId: "f1",
      quote: "あいう",
      range: { start: 0, end: 3 },
    });
    const bodyBefore = findManuscriptVersion(harness.db, manuscriptVersionId)?.body;

    const created = await putJson(harness, "/api/findings/f1/judgment", {
      status: "adopt-planned",
      note: "対応する",
    });
    expect(created.status).toBe(200);
    expect(judgmentOf(created.body)).toMatchObject({
      findingId: "f1",
      status: "adopt-planned",
      note: "対応する",
    });

    // note 省略 → null（PUT の置き換えセマンティクス。部分更新ではない）。
    const updated = await putJson(harness, "/api/findings/f1/judgment", { status: "rejected" });
    expect(updated.status).toBe(200);
    expect(judgmentOf(updated.body)).toMatchObject({
      findingId: "f1",
      status: "rejected",
      note: null,
    });

    expect(findManuscriptVersion(harness.db, manuscriptVersionId)?.body).toBe(bodyBefore);
  });

  it("不正な status は 400 validation", async () => {
    const harness = open();
    const { targetId, checkUnitId, manuscriptVersionId } = seedRun(harness, "r1");
    seedLocatedFinding(harness, {
      runId: "r1",
      manuscriptVersionId,
      targetId,
      checkUnitId,
      findingId: "f1",
      quote: "あいう",
      range: { start: 0, end: 3 },
    });

    const { status, body } = await putJson(harness, "/api/findings/f1/judgment", {
      status: "not-a-status",
    });

    expect(status).toBe(400);
    expect(errorCode(body)).toBe("validation");
  });

  it("指摘が無ければ 404", async () => {
    const harness = open();

    const { status, body } = await putJson(harness, "/api/findings/missing/judgment", {
      status: "held",
    });

    expect(status).toBe(404);
    expect(errorCode(body)).toBe("not-found");
  });

  it("採否を設定した後に再確認を決着させても採否は上書きされない（仕様 6.5）", async () => {
    const harness = open();
    const { targetId, checkUnitId, manuscriptVersionId } = seedRun(harness, "r1");
    seedLocatedFinding(harness, {
      runId: "r1",
      manuscriptVersionId,
      targetId,
      checkUnitId,
      findingId: "f1",
      quote: "あいう",
      range: { start: 0, end: 3 },
    });
    insertRecheckUnit(harness.db, {
      id: "rc1",
      runId: "r1",
      findingId: "f1",
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

    const put = await putJson(harness, "/api/findings/f1/judgment", {
      status: "adopt-planned",
      note: "採用する",
    });
    expect(put.status).toBe(200);

    // 採否の設定後に再確認を決着させる。
    finishRecheckUnit(harness.db, "rc1", {
      expectedStatus: "pending",
      status: "done",
      attempts: 1,
      failure: null,
      pendingNote: null,
      notApplicableReason: null,
      verdict: "withdraw",
      reasonKind: "intentional-expression",
      reason: "意図的な表現だった",
      suggestionValid: false,
      usage: null,
      inputGraphemes: null,
      elapsedMs: 30,
      finishedAt: new Date(),
    });

    const { body } = await getJson(harness, "/api/findings/f1");
    const detail = detailOf(body);
    expect(detail.recheck).toMatchObject({ id: "rc1", status: "done", verdict: "withdraw" });
    // 再確認の決着後も採否は設定したまま（上書きされない）。
    expect(detail.judgment).toMatchObject({
      findingId: "f1",
      status: "adopt-planned",
      note: "採用する",
    });

    const list = await getJson(harness, "/api/runs/r1/findings");
    expect(at(findingsOf(list.body), 0).judgment).toMatchObject({
      status: "adopt-planned",
      note: "採用する",
    });
  });
});
