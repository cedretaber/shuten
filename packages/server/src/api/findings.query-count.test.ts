/**
 * `GET /api/runs/:id/findings` の問い合わせ本数の回帰テスト（PR12c 決定 7）。
 *
 * 時間のしきい値は環境差で揺れるため N+1 の再発を守るのに向かない（`findings.perf.test.ts`）。
 * 代わりに、実際に実行された SQL 文の本数を `createDatabase` の `onStatement` 継ぎ目
 * （`db/client.ts`）で数え、**指摘の件数を変えても本数が変わらない**ことを検査する。
 *
 * 期待は 5 本（`findRun` 1・`findings` 1・理由（候補）1・再確認 1・採否 1。決定 1・7）。
 * 実装時に実測した値（3 件・30 件とも 5 本）をそのまま上限に固定する（実測より緩い上限にしない）。
 * 実測した本数の内訳・巻き戻し検証の実測値は
 * `docs/plans/2026-09-11-pr12c-findings-batch.md` の決定 7 に残す。
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
 * 実装時（PR12c Task 3）に実測した SQL 文の本数の上限。`findRun` 1・`findings` 1・
 * 理由（候補）1・再確認 1・採否 1 の 5 本で、指摘 3 件・30 件のどちらでも一致した
 * （実測より緩めた値にはしていない。決定 7）。
 */
const MAX_STATEMENT_COUNT = 5;

/** 合成の原稿本文（実原稿は使わない）。指摘の範囲が収まる程度の長さがあればよい。 */
const MANUSCRIPT_BODY = "あ".repeat(1_000);

const CHUNK_SETTINGS = {
  targetGraphemes: 1_500,
  contextGraphemes: 200,
  recheckContextGraphemes: 200,
  roundingTolerance: 50,
  maxInputGraphemes: 12_000,
};

/** 実行・検査対象・検査単位を 1 つずつ作る（`findings.perf.test.ts` の `seedRun` と同じ形）。 */
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
 * （`findings.perf.test.ts` の `seedManyFindings` と同じ形。3 本すべてが走る条件でないと
 * 本数の検査にならない）。採否（`judgments`）は `insertFinding` が同一トランザクションで
 * 必ず作るので、別途作る必要はない。
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
 * 実行 1 件ぶんを投入し、`GET /api/runs/:id/findings` を 1 回叩いた際に実行された SQL 文を返す。
 *
 * 本数だけでなく文そのものも返す。失敗時にどの問い合わせが増えたのかをテストの失敗メッセージ
 * から追えるようにするため（決定 7）。`runId` は合成の識別子（`run-3` / `run-30`）であり、
 * ここで記録する SQL は指摘一覧を `run_id` で絞り込む問い合わせだけなので、原稿の断片・
 * 接続先 URL・API キーなどのデータは混ざらない。
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

  // マイグレーション・データ投入ぶんの SQL は数えない。計数は `app.request` の直前に 0 に戻す（決定 7）。
  statements.length = 0;

  const res = await harness.app.request(`/api/runs/${runId}/findings`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as unknown[];
  expect(body).toHaveLength(findingCount);

  return statements;
}

/** 失敗メッセージに載せる SQL 文の一覧（`[0] ...` のように番号を振って読みやすくする）。 */
function describeStatements(label: string, statements: readonly string[]): string {
  const lines = statements.map((sql, index) => `  [${index}] ${sql}`);
  return `${label}: ${statements.length} 本\n${lines.join("\n")}`;
}

describe("GET /api/runs/:id/findings の問い合わせ本数（決定 7）", () => {
  it("指摘 3 件と 30 件で本数が等しく、実測した上限以下である", async () => {
    const statementsFor3 = await collectStatements("run-3", 3);
    const statementsFor30 = await collectStatements("run-30", 30);

    // 失敗したときに実行された SQL の内訳がテストの失敗メッセージから追えるようにする
    // （Vitest は既定レポーターでも成功時の console.log は畳むが、アサーションのメッセージは
    // 失敗時に必ず表示される。決定 7・レビュー Minor 5）。
    const diagnostic = `${describeStatements("3件", statementsFor3)}\n${describeStatements("30件", statementsFor30)}`;

    expect(statementsFor3.length, diagnostic).toBe(statementsFor30.length);
    expect(statementsFor3.length, diagnostic).toBeLessThanOrEqual(MAX_STATEMENT_COUNT);
    expect(statementsFor30.length, diagnostic).toBeLessThanOrEqual(MAX_STATEMENT_COUNT);
  });
});
