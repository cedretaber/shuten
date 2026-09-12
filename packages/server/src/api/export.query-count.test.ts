/**
 * `GET /api/runs/:id/export` の問い合わせ本数の回帰テスト（PR13a-2 決定 17・25。T15）。
 *
 * `findings.query-count.test.ts`（PR12c 決定 7）の `onStatement` 継ぎ目をそのまま写す。
 * 時間のしきい値は環境差で揺れるため N+1 の再発を守るのに向かないので、実際に実行された SQL 文の
 * 本数を `createDatabase` の `onStatement` 継ぎ目（`db/client.ts`）で数え、**指摘の件数を変えても
 * 本数が変わらない**ことを検査する。
 *
 * 期待は `findRun` 1・`findManuscriptVersion` 1・`listRunTargets` 1・`listCheckUnits` 1・
 * `listFindings` 1（内部で使う `listReasonsByRun` を含め 2）・`listRecheckUnits` 1・
 * `listJudgments` 1・`listCandidates` 1・`listDiagnostics` 1 の合計 10 本（決定 17・25）。
 * 実装時に実測した値（3 件・30 件とも 10 本）をそのまま上限に固定する（実測より緩い上限にしない）。
 */

import {
  ALLOWED_WORD_RULE_VERSION,
  DIAGNOSTIC_TRANSFORM_VERSION,
  PROMPT_VERSION,
} from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { insertCheckUnit } from "../db/repositories/check-units.ts";
import { insertCandidate, insertFinding } from "../db/repositories/findings.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { insertRecheckUnit } from "../db/repositories/rechecks.ts";
import { insertRun, insertRunTarget } from "../db/repositories/runs.ts";
import type { ApiHarness } from "./test-support.ts";
import { createHarnessRegistry } from "./test-support.ts";

const { open } = createHarnessRegistry();

/**
 * 実装時（PR13a-2 Task 9）に実測した SQL 文の本数の上限。指摘 3 件・30 件のどちらでも一致した
 * （実測より緩めた値にはしていない。決定 17・25。`findings.query-count.test.ts` の決定 7 と同じ姿勢）。
 */
const MAX_STATEMENT_COUNT = 10;

/** 合成の原稿本文（実原稿は使わない）。指摘の範囲が収まる程度の長さがあればよい。 */
const MANUSCRIPT_BODY = "あ".repeat(1_000);

const CHUNK_SETTINGS = {
  targetGraphemes: 1_500,
  contextGraphemes: 200,
  recheckContextGraphemes: 200,
  roundingTolerance: 50,
  maxInputGraphemes: 12_000,
};

/** 実行・検査対象・検査単位を 1 つずつ作る（`findings.query-count.test.ts` の `seedRun` と同じ形）。 */
function seedRun(
  harness: ApiHarness,
  runId: string,
): {
  readonly targetId: string;
  readonly checkUnitId: string;
  readonly manuscriptVersionId: string;
} {
  const manuscriptVersionId = `mv-${runId}`;
  insertManuscriptVersion(harness.db, {
    id: manuscriptVersionId,
    name: "原稿",
    body: MANUSCRIPT_BODY,
  });
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
    target: { start: 0, end: MANUSCRIPT_BODY.length },
    contextBefore: null,
    contextAfter: null,
    input: { start: 0, end: MANUSCRIPT_BODY.length },
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

/**
 * 指摘を `count` 件、理由（元候補）・再確認・採否の行をすべて添えて投入する
 * （`findings.query-count.test.ts` の `seedManyFindings` と同じ形。候補・診断・再確認・採否を
 * 指摘ごとに引く実装にすると本数が指摘数に比例して増える、という変異を検出するための材料）。
 */
function seedManyFindings(
  harness: ApiHarness,
  args: {
    readonly runId: string;
    readonly manuscriptVersionId: string;
    readonly targetId: string;
    readonly checkUnitId: string;
    readonly count: number;
  },
): void {
  harness.db.transaction((tx) => {
    for (let i = 0; i < args.count; i++) {
      const findingId = `f-${i}`;
      const quote = `誤字${i}`;
      const range = { start: i * 10, end: i * 10 + quote.length };

      const finding = insertFinding(tx, {
        id: findingId,
        runId: args.runId,
        manuscriptVersionId: args.manuscriptVersionId,
        targetId: args.targetId,
        locateStatus: "located",
        range,
        paragraphId: 0,
        quote,
        suggestion: `${quote}(訂正)`,
        category: "notation",
        initialVerdict: "likely-error",
        mergeKey: null,
        suppression: null,
      });

      insertCandidate(tx, {
        id: `${findingId}-c1`,
        runId: args.runId,
        checkUnitId: args.checkUnitId,
        findingId: finding.id,
        candidateIndex: i,
        llm: {
          paragraphId: 0,
          quote,
          before: "",
          after: "",
          category: "notation",
          reason: `${quote} が誤字の可能性`,
          suggestion: `${quote}(訂正)`,
          verdict: "likely-error",
        },
        locateStatus: "located",
        range,
        mergeKey: null,
      });

      insertRecheckUnit(tx, {
        id: `${findingId}-rc`,
        runId: args.runId,
        findingId: finding.id,
        inputRange: range,
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
    }
  });
}

/**
 * 実行 1 件ぶんを投入し、`GET /api/runs/:id/export` を 1 回叩いた際に実行された SQL 文を返す。
 *
 * 本数だけでなく文そのものも返す。失敗時にどの問い合わせが増えたのかをテストの失敗メッセージ
 * から追えるようにするため（`findings.query-count.test.ts` の決定 7 と同じ姿勢）。
 */
async function collectStatements(runId: string, findingCount: number): Promise<readonly string[]> {
  const statements: string[] = [];
  const harness = open({ onStatement: (sql) => statements.push(sql) });
  const { targetId, checkUnitId, manuscriptVersionId } = seedRun(harness, runId);
  seedManyFindings(harness, {
    runId,
    manuscriptVersionId,
    targetId,
    checkUnitId,
    count: findingCount,
  });

  // マイグレーション・データ投入ぶんの SQL は数えない。計数は `app.request` の直前に 0 に戻す。
  statements.length = 0;

  const res = await harness.app.request(`/api/runs/${runId}/export`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { readonly findings: readonly unknown[] };
  expect(body.findings).toHaveLength(findingCount);

  return statements;
}

/** 失敗メッセージに載せる SQL 文の一覧（`[0] ...` のように番号を振って読みやすくする）。 */
function describeStatements(label: string, statements: readonly string[]): string {
  const lines = statements.map((sql, index) => `  [${index}] ${sql}`);
  return `${label}: ${statements.length} 本\n${lines.join("\n")}`;
}

describe("GET /api/runs/:id/export の問い合わせ本数（決定 17・25）", () => {
  it("指摘 3 件と 30 件で本数が等しく、実測した上限以下である", async () => {
    const statementsFor3 = await collectStatements("run-3", 3);
    const statementsFor30 = await collectStatements("run-30", 30);

    // 失敗したときに実行された SQL の内訳がテストの失敗メッセージから追えるようにする。
    const diagnostic = `${describeStatements("3件", statementsFor3)}\n${describeStatements("30件", statementsFor30)}`;

    expect(statementsFor3.length, diagnostic).toBe(statementsFor30.length);
    expect(statementsFor3.length, diagnostic).toBeLessThanOrEqual(MAX_STATEMENT_COUNT);
    expect(statementsFor30.length, diagnostic).toBeLessThanOrEqual(MAX_STATEMENT_COUNT);
  });
});
