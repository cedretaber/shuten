/**
 * A4：復旧（`api/recovery.test.ts`。決定 11）。
 *
 * `POST /api/recovery/confirm` は実行の `status` を変えない（ゲートを開けるだけ）。
 * `GET /api/runs/:id`（Task 6）がまだ無いので、`recoveryConfirmedAt` の観測は
 * `findRun` で DB を直接読む（ブリーフ手順 5 の指示を GET /api/recovery にもあてはめたもの）。
 */

import {
  ALLOWED_WORD_RULE_VERSION,
  DIAGNOSTIC_TRANSFORM_VERSION,
  PROMPT_VERSION,
} from "@shuten/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { RunRecord } from "../db/records.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { findRun, insertRun } from "../db/repositories/runs.ts";
import { LmStudioError } from "../lmstudio/errors.ts";
import type { ChatResult, Usage } from "../lmstudio/types.ts";
import type { StartRunInput } from "../run/orchestrator.ts";
import { SCRIPTED_ENDPOINT_URL, SCRIPTED_LOADED_MODEL } from "../run/test-support.ts";
import type { ApiHarness, SetupApiOverrides } from "./test-support.ts";
import { setupApi } from "./test-support.ts";

const JSON_HEADERS = { "content-type": "application/json" };

const opened: ApiHarness[] = [];
function open(overrides?: SetupApiOverrides): ApiHarness {
  const harness = setupApi(overrides);
  opened.push(harness);
  return harness;
}
afterEach(() => {
  for (const harness of opened.splice(0)) {
    harness.close();
  }
});

async function getRecovery(harness: ApiHarness): Promise<{ status: number; body: unknown }> {
  const res = await harness.app.request("/api/recovery");
  return { status: res.status, body: await res.json() };
}

async function confirmRecovery(
  harness: ApiHarness,
  runId: string,
): Promise<{ status: number; body: unknown }> {
  const res = await harness.app.request("/api/recovery/confirm", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ runId }),
  });
  return { status: res.status, body: await res.json() };
}

const MANUSCRIPT_ID = "mv1";
/** 本文全体（10 書記素）がちょうど 1 対象になる本文。 */
const TEXT = "0123456789";

let seedCounter = 0;

/**
 * `startRun` を経由せず、`recovery-waiting`（既定）の実行を 1 行だけ作る。`registry` には
 * 乗らない（`orchestrator.startRun` を呼んでいないため）ので、`confirmRecovery` は
 * `markRecoveryConfirmed` まで進む。走っているループがある実行のガード（レビュー裁定 R11）は
 * `registry` に乗る必要があるため、この関数では作れない。別のテスト
 * （「走っているループがある実行への confirm」）で `orchestrator.startRun` を直接呼んで作る。
 */
function seedRun(db: ApiHarness["db"], status: RunRecord["status"]): RunRecord {
  seedCounter += 1;
  const id = `run-${String(seedCounter)}`;
  return insertRun(db, {
    id,
    manuscriptVersionId: MANUSCRIPT_ID,
    modelId: SCRIPTED_LOADED_MODEL.id,
    modelInfo: null,
    endpointUrl: SCRIPTED_ENDPOINT_URL,
    generationSettings: { maxTokens: 64, temperature: 0 },
    chunkSettings: {
      targetGraphemes: 10,
      contextGraphemes: 0,
      recheckContextGraphemes: 0,
      roundingTolerance: 0,
      maxInputGraphemes: 50,
    },
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: false,
    allowedWords: [],
    allowedWordRuleVersion: ALLOWED_WORD_RULE_VERSION,
    promptVersion: PROMPT_VERSION,
    diagnosticTransformVersion: DIAGNOSTIC_TRANSFORM_VERSION,
    status,
    stopReason: status === "running" ? null : "aborted",
    stopMessage: status === "running" ? null : "前回の停止",
    generationUnconfirmed: status === "recovery-waiting",
    startOperationId: null,
    startedAt: new Date(1000),
    finishedAt: status === "running" ? null : new Date(2000),
  });
}

const USAGE: Usage = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
  reasoningTokens: null,
};

function emptyCheckResult(): ChatResult {
  return {
    content: JSON.stringify({ findings: [] }),
    reasoningContent: null,
    finishReason: "stop",
    usage: USAGE,
    raw: {},
  };
}

/** 外から解決・拒否できる Promise（`orchestrator.stop.test.ts` と同じ形）。 */
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** マイクロタスクを流し切る（キューへの投入・`ensureLoaded` の開始・`chat` 呼び出しを待つ）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function baseStartInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    startOperationId: "op-1",
    manuscriptVersionId: MANUSCRIPT_ID,
    modelId: SCRIPTED_LOADED_MODEL.id,
    generation: { maxTokens: 64, temperature: 0 },
    chunkSettings: {
      targetGraphemes: 10,
      contextGraphemes: 0,
      recheckContextGraphemes: 0,
      roundingTolerance: 0,
      maxInputGraphemes: 50,
    },
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: false,
    allowedWordsRaw: "",
    ...overrides,
  };
}

describe("GET /api/recovery", () => {
  it("ゲートの状態を返す", async () => {
    const harness = open();

    const empty = await getRecovery(harness);
    expect(empty).toEqual({ status: 200, body: { blocked: false, runIds: [] } });

    harness.gate.block("run-x");
    harness.gate.block("run-y");
    const blocked = await getRecovery(harness);
    expect(blocked.status).toBe(200);
    const body = blocked.body as { blocked: boolean; runIds: string[] };
    expect(body.blocked).toBe(true);
    expect([...body.runIds].sort()).toEqual(["run-x", "run-y"]);
  });
});

describe("POST /api/recovery/confirm", () => {
  it("存在しない runId は 404", async () => {
    const harness = open();

    const { status, body } = await confirmRecovery(harness, "does-not-exist");

    expect(status).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe("not-found");
  });

  it("ゲートが開き、以後の startRun が recovery-blocked にならない", async () => {
    const harness = open();
    insertManuscriptVersion(harness.db, { id: MANUSCRIPT_ID, name: "原稿", body: TEXT });
    const waiting = seedRun(harness.db, "recovery-waiting");
    harness.gate.block(waiting.id);
    expect(harness.gate.blocked).toBe(true);

    const { status, body } = await confirmRecovery(harness, waiting.id);

    expect(status).toBe(200);
    expect(body).toEqual({ blocked: false, runIds: [] });
    expect(harness.gate.blocked).toBe(false);

    // ゲートが開いたので、新しい実行は recovery-blocked で止まらずに完了する。
    harness.client.steps.push(() => emptyCheckResult());
    const { done } = harness.orchestrator.startRun(baseStartInput());
    const finished = await done;
    expect(finished.status).toBe("completed");
    expect(finished.stopReason).not.toBe("recovery-blocked");
  });

  it("confirm 後は recoveryConfirmedAt が非 null。実行の status は変えない", async () => {
    const harness = open();
    insertManuscriptVersion(harness.db, { id: MANUSCRIPT_ID, name: "原稿", body: TEXT });
    const waiting = seedRun(harness.db, "recovery-waiting");
    harness.gate.block(waiting.id);

    const { status } = await confirmRecovery(harness, waiting.id);
    expect(status).toBe(200);

    const after = findRun(harness.db, waiting.id);
    expect(after?.recoveryConfirmedAt).not.toBeNull();
    expect(after?.status).toBe("recovery-waiting");
  });

  it("走っているループがある実行への confirm は 200 で、ゲートを開けず recoveryConfirmedAt も書かない（裁定 R11）", async () => {
    const harness = open();
    insertManuscriptVersion(harness.db, { id: MANUSCRIPT_ID, name: "原稿", body: TEXT });

    // 生成要求そのものを送信済みのまま保留する（`chat` が呼ばれ、応答待ちで止まる）。
    // `runOne` の「ゲートが閉じていれば送らない」判定は `chat` を呼ぶ**前**の 1 回だけなので、
    // ここで `gate.block` しても、既に送信済みのこの要求は止まらない（`orchestrator.stop.test.ts`
    // D7 と同じ組み立て）。
    const pending = deferred<ChatResult>();
    harness.client.steps.push(() => pending.promise);

    const started = harness.orchestrator.startRun(baseStartInput());
    await flush();
    expect(harness.orchestrator.activeRunIds()).toEqual([started.run.id]);
    expect(findRun(harness.db, started.run.id)?.status).toBe("running");

    // `run/loop.ts` の `onRecoveryRequired` と同じ副作用。executor が生成の終了を確認できなく
    // なった時点で閉じるので、実行が `recovery-waiting` になる前から `blockedRunIds` に入る
    // （PR10 決定 11 のレビュー裁定 R11）。
    harness.gate.block(started.run.id);

    const { status, body } = await confirmRecovery(harness, started.run.id);

    expect(status).toBe(200);
    // ゲートは開かない（GET と同じ形で、閉じたままの現在値を返す）。
    expect(body).toEqual({ blocked: true, runIds: [started.run.id] });
    expect(harness.gate.blocked).toBe(true);
    const after = findRun(harness.db, started.run.id);
    expect(after?.recoveryConfirmedAt).toBeNull();
    expect(after?.status).toBe("running");

    // 後片付け：保留していた生成要求を切断して実行を終わらせる（応答を受け取れず切断した扱い）。
    pending.reject(new LmStudioError("connection", "応答を受け取れずに切断した", { status: null }));
    const finished = await started.done;
    expect(finished.status).toBe("recovery-waiting");
  });

  it("recovery-waiting 以外の実行への confirm は 200 で DB を変えない", async () => {
    const harness = open();
    insertManuscriptVersion(harness.db, { id: MANUSCRIPT_ID, name: "原稿", body: TEXT });
    const stopped = seedRun(harness.db, "stopped");
    const before = findRun(harness.db, stopped.id);

    const { status, body } = await confirmRecovery(harness, stopped.id);

    expect(status).toBe(200);
    // GET と同じ形（ゲートの現在値）。実行の DB は変わっていない。
    expect(body).toEqual({ blocked: false, runIds: [] });
    expect(findRun(harness.db, stopped.id)).toEqual(before);
  });
});
