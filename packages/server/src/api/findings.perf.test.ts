/**
 * `GET /api/runs/:id/findings` の性能計測（PR12a Task 11・決定 14）。
 *
 * `listFindings` は指摘 1 件ごとに理由（`listReasons`）を問い合わせ、ハンドラー側も指摘 1 件
 * ごとに再確認（`findRecheckUnitByFinding`）・採否（`findJudgment`）を問い合わせる。実質
 * 3N+1 になっている（`docs/plans/2026-09-07-mvp-roadmap.md`）。この持ち越しを「件数を見て判断
 * する」ではなく実測値で決着させるための計測専用テストで、**サーバーの実装は変えない**。
 *
 * - 指摘 800 件（1 万字程度の原稿で想定される規模）を、理由・再確認・採否の行をすべて添えて
 *   投入する（3N+1 の 3 本すべてが走る状態でないと計測の意味がない）。
 * - 投入は `insertFinding` / `insertCandidate` / `insertRecheckUnit`（既存のリポジトリ関数）を
 *   1 つの外側トランザクションにまとめて呼ぶ（各関数が内部で持つトランザクションは
 *   better-sqlite3 上ではセーブポイントとしてネストする。800 件を個別コミットするより速く、
 *   プロダクションコードには一切触れない）。
 * - 判断に使う値はウォームアップ 1 回の後に測った 5 回の中央値。CI のばらつきに耐えるため、
 *   テストに残す上限は緩めの 5,000 ms とし、判断そのものは作業報告・計画書に残す実測値で行う
 *   （最終レビュー Minor 6：Windows 実機未確認の遅い CI ランナーでも 1,000 ms は落ちうる時間依存の
 *   しきい値だったため引き上げた。この上限は桁違いの回帰を捕まえるための歯止めであって、
 *   据え置き／後続 PR 送りの判断基準ではない——判断は決定 14 に残した実測値（WSL2/Linux で
 *   中央値 110〜130 ms 台）で行う。決定 14 の実測値の記述そのものは変えていない）。
 * - 実測の中央値は `console.log` に出す（実行環境での値をテスト出力から追えるようにするため）。
 *   Vitest v5 の既定レポーターは**成功したテストの標準出力を畳んで表示しない**ため、値を見るには
 *   `npx vitest run findings.perf.test.ts --reporter=verbose`（または `pnpm --filter @shuten/server exec
 *   vitest run src/api/findings.perf.test.ts --reporter=verbose`）のように明示的に verbose を指定する
 *   か、テストを失敗させて出力を見る。CI の既定実行では値そのものは出力に現れないことがある。
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

/** 計測に使う指摘の件数（1 万字程度の原稿で想定される規模）。 */
const FINDING_COUNT = 800;

/** 合成の原稿本文（実原稿は使わない）。指摘の範囲が収まる程度の長さがあればよい。 */
const MANUSCRIPT_BODY = "あ".repeat(10_000);

const CHUNK_SETTINGS = {
  targetGraphemes: 1_500,
  contextGraphemes: 200,
  recheckContextGraphemes: 200,
  roundingTolerance: 50,
  maxInputGraphemes: 12_000,
};

/** 実行・検査対象・検査単位を 1 つずつ作る（`findings.test.ts` の `seedRun` と同じ形）。 */
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
 * 指摘を `count` 件、理由（元候補）・再確認・採否の行をすべて添えて投入する。
 *
 * 採否（`judgments`）は `insertFinding` が指摘と同一トランザクションで `undecided` の行を
 * 必ず作る（決定 5）ので、ここで別途作る必要はない。理由は `insertCandidate`、再確認は
 * `insertRecheckUnit` で作る（再確認は決着済みの状態を直接書き、`claimRecheckUnit` /
 * `finishRecheckUnit` の状態遷移は経由しない。行が 1 件あることだけが計測に要る条件で、
 * 遷移そのものはこのテストの対象ではない）。
 *
 * 800 件分を 1 つの外側トランザクションにまとめることで、個別コミットのオーバーヘッドを避ける
 * （各リポジトリ関数の内部トランザクションは better-sqlite3 上でセーブポイントとしてネストする。
 * リポジトリ関数の呼び方を変えるだけで、プロダクションコードには触れない）。
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

/** `values` の中央値。奇数個の入力を前提にする（5 回測るのでこのテストでは常に奇数）。 */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted[mid];
  if (value === undefined) {
    throw new Error("中央値を計算する配列が空です");
  }
  return value;
}

describe("GET /api/runs/:id/findings の性能（計測専用。決定 14）", () => {
  it(`指摘 ${FINDING_COUNT} 件（理由・再確認・採否つき）を通しても、5 回測った中央値が 5,000 ms を下回る`, async () => {
    const harness = open();
    const runId = "perf-run";
    const { targetId, checkUnitId, manuscriptVersionId } = seedRun(harness, runId);
    seedManyFindings(harness, {
      runId,
      manuscriptVersionId,
      targetId,
      checkUnitId,
      count: FINDING_COUNT,
    });

    async function measureOnce(): Promise<number> {
      const started = performance.now();
      const res = await harness.app.request(`/api/runs/${runId}/findings`);
      const body = (await res.json()) as unknown[];
      const elapsed = performance.now() - started;
      expect(res.status).toBe(200);
      expect(body).toHaveLength(FINDING_COUNT);
      return elapsed;
    }

    // ウォームアップ 1 回（JIT・キャッシュの温まりで初回だけ遅くなるのを判断値から除く）。
    await measureOnce();

    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      samples.push(await measureOnce());
    }

    const medianMs = median(samples);
    // 実行環境での実測値をテスト出力から追えるようにする（判断は作業報告・計画書に残す）。
    console.log(
      `[findings.perf] GET /api/runs/:id/findings (${FINDING_COUNT} 件): ` +
        `median=${medianMs.toFixed(2)}ms samples=${samples.map((s) => s.toFixed(2)).join(",")}ms`,
    );

    // CI のばらつきに耐える緩い歯止め（最終レビュー Minor 6：遅い Windows の CI ランナーでも
    // 落ちないよう 1,000 ms から引き上げた）。据え置き／後続 PR 送りの判断基準は 100 ms（決定 14）で、
    // これはあくまで桁違いの回帰を検出するための上限であり、据え置きの判断基準ではない。
    expect(medianMs).toBeLessThan(5_000);
  }, 20_000);
});
