/**
 * A3：実行（`api/runs.test.ts`。決定 10・14・15）。
 *
 * 一覧・開始・詳細・単位・停止・再開・失敗単位の再試行を、`setupApi()` が組んだ実物のアプリ
 * （`app.request`）から見る。
 *
 * **ループを起こしたテストは必ず `waitSettled` で決着を待ってから終わること。** 待たずに終わると
 * `afterEach` の `close()` が走っているループの下で DB を閉じ、後続のテストに雑音が混じる
 * （`done` は決して reject しないので、失敗としては現れない）。
 *
 * 実行の状態を作り込むテスト（再開・再試行の拒否）は、その状態に至る経路を API で再現できない
 * （`completed` の実行、版が変わった実行など）ので、リポジトリで直接行を入れる。
 */

import {
  ALLOWED_WORD_RULE_VERSION,
  DIAGNOSTIC_TRANSFORM_VERSION,
  MAX_TIMEOUT_MS,
  PROMPT_VERSION,
} from "@shuten/shared";
import { describe, expect, it } from "vitest";

import type { RunRecord, UnitFailureRecord } from "../db/records.ts";
import { insertCheckUnit } from "../db/repositories/check-units.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { findRun, insertRun, insertRunTarget, listRuns } from "../db/repositories/runs.ts";
import type { ModelInfo } from "../lmstudio/types.ts";
import type { ChatStep } from "../run/test-support.ts";
import { SCRIPTED_LOADED_MODEL } from "../run/test-support.ts";
import type { ApiHarness } from "./test-support.ts";
import { createHarnessRegistry, JSON_HEADERS, waitSettled } from "./test-support.ts";

const { open } = createHarnessRegistry();

/** ---------------------------------------------------------------------- */
/** 素材 */
/** ---------------------------------------------------------------------- */

/** 20 書記素・1 段落。同じ文字が 2 度出ないので分割結果が決定的になる。 */
const BODY = "あいうえおかきくけこさしすせそたちつてと";

/** 本文全体（20 書記素）が 1 対象になる設定。参考文脈なし。 */
const CHUNK_ONE_TARGET = {
  targetGraphemes: 20,
  contextGraphemes: 0,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 50,
};

/** `[0,10)` `[10,20)` の 2 対象に割れる設定。 */
const CHUNK_TWO_TARGETS = { ...CHUNK_ONE_TARGET, targetGraphemes: 10 };

/** 2 対象に割れるが、参考文脈 5 書記素を足すと必ず上限を超える設定（開始計画で同期に判明する）。 */
const CHUNK_TOO_LONG = {
  targetGraphemes: 10,
  contextGraphemes: 5,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 10,
};

/**
 * 応答を解釈できない失敗を返す台本。当該単位は `failed` になるが実行は続く（PR9b 決定 5(a)）ので、
 * 「ループが最後まで回って決着する」ことだけが要るテストで使う。`malformed` は 1 回だけ再試行
 * されるので、単位数の 2 倍の要求が来る。
 */
function malformedSteps(count: number): ChatStep[] {
  return Array.from(
    { length: count },
    (): ChatStep =>
      ({ failure }) => {
        throw failure("malformed");
      },
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 条件が満たされるまで待つ（実タイマー）。満たされなければ例外で落とす。 */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`条件が満たされませんでした: ${label}`);
}

/** ---------------------------------------------------------------------- */
/** 要求のヘルパー */
/** ---------------------------------------------------------------------- */

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

async function postJson(harness: ApiHarness, path: string, body: unknown): Promise<ApiResponse> {
  const res = await harness.app.request(path, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** 本文も `Content-Type` も送らない POST（`fetch(url, { method: "POST" })` と同じ形）。 */
async function postEmpty(harness: ApiHarness, path: string): Promise<ApiResponse> {
  const res = await harness.app.request(path, { method: "POST" });
  return { status: res.status, body: await res.json() };
}

async function getJson(harness: ApiHarness, path: string): Promise<ApiResponse> {
  const res = await harness.app.request(path);
  return { status: res.status, body: await res.json() };
}

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

interface RunBody {
  readonly id: string;
  readonly status: string;
  readonly stopReason: string | null;
  readonly perspectives: readonly string[];
  readonly stopRequestedAt: string | null;
}

function runOf(body: unknown): RunBody {
  return body as RunBody;
}

/** `stop` / `resume` / `retry-failed` の応答（`{ run: RunDto }`）。 */
function actionRunOf(body: unknown): RunBody {
  return (body as { run: RunBody }).run;
}

/** 原稿を 1 件保存して ID を返す。 */
async function createManuscript(harness: ApiHarness, name = "原稿A"): Promise<string> {
  const { status, body } = await postJson(harness, "/api/manuscripts", { name, body: BODY });
  expect(status).toBe(201);
  return (body as { id: string }).id;
}

interface StartRequestOverrides {
  readonly startOperationId?: string;
  readonly manuscriptVersionId?: string;
  readonly chunkSettings?: unknown;
  readonly perspectives?: readonly string[];
  readonly timeouts?: { readonly checkMs: number; readonly recheckMs: number };
}

function startRequest(manuscriptVersionId: string, overrides: StartRequestOverrides = {}) {
  return {
    startOperationId: "op-1",
    manuscriptVersionId,
    modelId: "model-a",
    generation: { maxTokens: 512, temperature: 0 },
    chunkSettings: CHUNK_ONE_TARGET,
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: false,
    allowedWordsRaw: "",
    ...overrides,
  };
}

/** ---------------------------------------------------------------------- */
/** 状態を作り込む実行（API では再現できない状態） */
/** ---------------------------------------------------------------------- */

interface SeedRunOptions {
  readonly runId: string;
  readonly status: RunRecord["status"];
  readonly stopReason?: RunRecord["stopReason"];
  readonly promptVersion?: string;
  /** 省略時は現在の接続先（`connection.current()`）。実際に保存される値と揃える。 */
  readonly endpointUrl?: string;
  readonly startedAt?: Date;
}

/** 原稿版・実行・検査対象を 1 件ずつ作る。検査単位は `seedUnit` で足す。 */
function seedRun(harness: ApiHarness, options: SeedRunOptions): { targetId: string } {
  const manuscriptVersionId = `mv-${options.runId}`;
  insertManuscriptVersion(harness.db, { id: manuscriptVersionId, name: "原稿", body: BODY });
  insertRun(harness.db, {
    id: options.runId,
    manuscriptVersionId,
    modelId: "model-a",
    modelInfo: null,
    endpointUrl: options.endpointUrl ?? harness.connection.current().endpointUrl,
    generationSettings: { maxTokens: 512, temperature: 0 },
    chunkSettings: CHUNK_ONE_TARGET,
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: false,
    allowedWords: [],
    allowedWordRuleVersion: ALLOWED_WORD_RULE_VERSION,
    promptVersion: options.promptVersion ?? PROMPT_VERSION,
    diagnosticTransformVersion: DIAGNOSTIC_TRANSFORM_VERSION,
    status: options.status,
    stopReason: options.stopReason ?? null,
    stopMessage: null,
    generationUnconfirmed: false,
    startOperationId: `seed-${options.runId}`,
    ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
    finishedAt: null,
  });
  const targetId = `t-${options.runId}`;
  insertRunTarget(harness.db, {
    id: targetId,
    runId: options.runId,
    targetIndex: 0,
    target: { start: 0, end: 20 },
    contextBefore: null,
    contextAfter: null,
    input: { start: 0, end: 20 },
    paragraphIds: [0],
  });
  return { targetId };
}

const MALFORMED_FAILURE: UnitFailureRecord = {
  reason: "malformed",
  message: "応答を解釈できなかった",
  finishReason: "stop",
  origin: "chat",
};

const INPUT_TOO_LONG_FAILURE: UnitFailureRecord = {
  reason: "input-too-long",
  message: "入力が上限を超えた",
  finishReason: null,
  origin: "local",
};

function seedUnit(
  harness: ApiHarness,
  runId: string,
  targetId: string,
  unit: {
    readonly id: string;
    readonly status: "pending" | "failed";
    readonly failure?: UnitFailureRecord;
  },
): string {
  insertCheckUnit(harness.db, {
    id: unit.id,
    runId,
    targetId,
    perspective: "typo",
    status: unit.status,
    attempts: unit.status === "failed" ? 1 : 0,
    failure: unit.failure ?? null,
    pendingNote: null,
    usage: null,
    inputGraphemes: null,
    elapsedMs: null,
    startedAt: null,
    finishedAt: null,
  });
  return unit.id;
}

/** ---------------------------------------------------------------------- */
/** POST /api/runs */
/** ---------------------------------------------------------------------- */

describe("POST /api/runs（開始）", () => {
  it("201 は作成直後のスナップショット。RunDto に endpointUrl と startOperationId を含まない", async () => {
    const harness = open({ steps: malformedSteps(4) });
    const manuscriptVersionId = await createManuscript(harness);

    const { status, body } = await postJson(
      harness,
      "/api/runs",
      startRequest(manuscriptVersionId),
    );

    expect(status).toBe(201);
    const run = runOf(body);
    expect(run.status).toBe("running");
    expect(run.stopReason).toBeNull();
    expect(body).not.toHaveProperty("endpointUrl");
    expect(body).not.toHaveProperty("startOperationId");
    expect((body as { manuscriptVersionId: string }).manuscriptVersionId).toBe(manuscriptVersionId);

    await waitSettled(harness.hub, harness.db, run.id);
  });

  it("同じ startOperationId の 2 回目は 200 で既存の実行。実行は 1 本（chat の回数が増えない）", async () => {
    const harness = open({ steps: malformedSteps(4) });
    const manuscriptVersionId = await createManuscript(harness);

    const first = await postJson(harness, "/api/runs", startRequest(manuscriptVersionId));
    expect(first.status).toBe(201);
    await waitSettled(harness.hub, harness.db, runOf(first.body).id);
    const requestsAfterFirst = harness.client.requests.length;
    expect(requestsAfterFirst).toBeGreaterThan(0);

    const second = await postJson(harness, "/api/runs", startRequest(manuscriptVersionId));

    expect(second.status).toBe(200);
    expect(runOf(second.body).id).toBe(runOf(first.body).id);
    expect(listRuns(harness.db)).toHaveLength(1);
    expect(harness.client.requests).toHaveLength(requestsAfterFirst);
  });

  it("同じ startOperationId なら、設定値が違っても・2 回目が無効でも 200 で既存を返す（冪等判定が先）", async () => {
    const harness = open({ steps: malformedSteps(4) });
    const manuscriptVersionId = await createManuscript(harness);

    const first = await postJson(harness, "/api/runs", startRequest(manuscriptVersionId));
    expect(first.status).toBe(201);
    const runId = runOf(first.body).id;
    await waitSettled(harness.hub, harness.db, runId);

    // 設定値が違う 2 回目（比較しない）。
    const different = await postJson(
      harness,
      "/api/runs",
      startRequest(manuscriptVersionId, { chunkSettings: CHUNK_TWO_TARGETS }),
    );
    expect(different.status).toBe(200);
    expect(runOf(different.body).id).toBe(runId);

    // 2 回目の設定が無効（`targetGraphemes: -1`）でも 200（検証は既存判定の後）。
    const invalid = await postJson(
      harness,
      "/api/runs",
      startRequest(manuscriptVersionId, {
        chunkSettings: { ...CHUNK_ONE_TARGET, targetGraphemes: -1 },
      }),
    );
    expect(invalid.status).toBe(200);
    expect(runOf(invalid.body).id).toBe(runId);

    // 要求の同一性だけで判定するので、startOperationId しか無い本文でも既存を返す。
    const headOnly = await postJson(harness, "/api/runs", { startOperationId: "op-1" });
    expect(headOnly.status).toBe(200);
    expect(runOf(headOnly.body).id).toBe(runId);

    expect(listRuns(harness.db)).toHaveLength(1);
  });

  it("分割設定が不正なら 400 invalid-run-settings で、実行の行が作られない", async () => {
    const harness = open();
    const manuscriptVersionId = await createManuscript(harness);

    const { status, body } = await postJson(
      harness,
      "/api/runs",
      startRequest(manuscriptVersionId, {
        chunkSettings: { ...CHUNK_ONE_TARGET, targetGraphemes: -1 },
      }),
    );

    expect(status).toBe(400);
    expect(errorCode(body)).toBe("invalid-run-settings");
    // `startRun` は設定不正でも stopped/settings の実行を作るので、事前検証が効いていることを行数で見る。
    expect(listRuns(harness.db)).toEqual([]);
  });

  it("タイムアウトと復旧確認の合計が上限を超えたら 400 invalid-run-settings で、実行の行が作られない", async () => {
    const harness = open({ recoveryConfirmMs: 1 });
    const manuscriptVersionId = await createManuscript(harness);

    const { status, body } = await postJson(
      harness,
      "/api/runs",
      startRequest(manuscriptVersionId, {
        timeouts: { checkMs: MAX_TIMEOUT_MS, recheckMs: 60_000 },
      }),
    );

    expect(status).toBe(400);
    expect(errorCode(body)).toBe("invalid-run-settings");
    expect(listRuns(harness.db)).toEqual([]);
  });

  it("原稿版が無ければ 404（実行の行を作らない）", async () => {
    const harness = open();

    const { status, body } = await postJson(harness, "/api/runs", startRequest("mv-missing"));

    expect(status).toBe(404);
    expect(errorCode(body)).toBe("not-found");
    expect(listRuns(harness.db)).toEqual([]);
  });

  it("観点の重複を除いて開始する", async () => {
    const harness = open({ steps: malformedSteps(8) });
    const manuscriptVersionId = await createManuscript(harness);

    const { status, body } = await postJson(
      harness,
      "/api/runs",
      startRequest(manuscriptVersionId, { perspectives: ["typo", "typo", "naturalness"] }),
    );

    expect(status).toBe(201);
    const run = runOf(body);
    expect(run.perspectives).toEqual(["typo", "naturalness"]);
    await waitSettled(harness.hub, harness.db, run.id);
    // 1 対象 × 2 観点 = 2 単位（重複した観点の分の単位は作られない）。
    const units = await getJson(harness, `/api/runs/${run.id}/units`);
    expect((units.body as { checkUnits: unknown[] }).checkUnits).toHaveLength(2);
  });

  it("モデル未ロードは 201 の時点では running。決着後の GET で stopped / model-not-loaded", async () => {
    const harness = open({
      ensureLoaded: ({ failure }) => Promise.reject(failure("model-not-loaded")),
    });
    const manuscriptVersionId = await createManuscript(harness);

    const { status, body } = await postJson(
      harness,
      "/api/runs",
      startRequest(manuscriptVersionId),
    );

    expect(status).toBe(201);
    expect(runOf(body).status).toBe("running");

    const settled = await waitSettled(harness.hub, harness.db, runOf(body).id);
    expect(settled.status).toBe("stopped");

    const detail = await getJson(harness, `/api/runs/${runOf(body).id}`);
    const run = runOf((detail.body as { run: unknown }).run);
    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("model-not-loaded");
    // 生成要求は 1 件も送らない（未ロードのモデルに送らない）。
    expect(harness.client.requests).toHaveLength(0);
  });

  it("入力上限超過は 201 の時点で stopped / settings（開始計画で同期に判明する）", async () => {
    const harness = open();
    const manuscriptVersionId = await createManuscript(harness);

    const { status, body } = await postJson(
      harness,
      "/api/runs",
      startRequest(manuscriptVersionId, { chunkSettings: CHUNK_TOO_LONG }),
    );

    expect(status).toBe(201);
    const run = runOf(body);
    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("settings");
    expect(harness.client.requests).toHaveLength(0);
    // 既に決着している実行では `waitSettled` はその場で解決する（購読より後に DB を読む経路）。
    expect((await waitSettled(harness.hub, harness.db, run.id)).status).toBe("stopped");
  });
});

/** ---------------------------------------------------------------------- */
/** GET */
/** ---------------------------------------------------------------------- */

describe("GET /api/runs（一覧）", () => {
  it("原稿名付きで開始日時の降順に返す", async () => {
    let clock = 1_000;
    const harness = open({ now: () => new Date(clock) });
    const first = await createManuscript(harness, "原稿A");
    const second = await createManuscript(harness, "原稿B");

    // どちらも入力上限超過にして、ループを起こさずに 2 本の実行だけを作る。
    const older = await postJson(
      harness,
      "/api/runs",
      startRequest(first, { startOperationId: "op-old", chunkSettings: CHUNK_TOO_LONG }),
    );
    clock += 5_000;
    const newer = await postJson(
      harness,
      "/api/runs",
      startRequest(second, { startOperationId: "op-new", chunkSettings: CHUNK_TOO_LONG }),
    );
    expect(older.status).toBe(201);
    expect(newer.status).toBe(201);

    const { status, body } = await getJson(harness, "/api/runs");

    expect(status).toBe(200);
    const summaries = body as readonly {
      id: string;
      manuscriptName: string;
      status: string;
    }[];
    expect(summaries.map((entry) => entry.id)).toEqual([
      runOf(newer.body).id,
      runOf(older.body).id,
    ]);
    expect(summaries.map((entry) => entry.manuscriptName)).toEqual(["原稿B", "原稿A"]);
    expect(summaries[0]).not.toHaveProperty("endpointUrl");
  });

  it("実行が無ければ空配列", async () => {
    const harness = open();

    const { status, body } = await getJson(harness, "/api/runs");

    expect(status).toBe(200);
    expect(body).toEqual([]);
  });
});

describe("GET /api/runs/:id・/units（詳細と単位）", () => {
  it("progress は 5 状態すべてを持ち合計が単位数に一致し、targets が保存済み範囲。units の targetIndex が対応する", async () => {
    // 2 対象 × 2 観点 = 4 単位。malformed は 1 回だけ再試行されるので要求は最大 8 件。
    const harness = open({ steps: malformedSteps(8) });
    const manuscriptVersionId = await createManuscript(harness);

    const started = await postJson(
      harness,
      "/api/runs",
      startRequest(manuscriptVersionId, {
        chunkSettings: CHUNK_TWO_TARGETS,
        perspectives: ["typo", "naturalness"],
      }),
    );
    expect(started.status).toBe(201);
    const runId = runOf(started.body).id;
    await waitSettled(harness.hub, harness.db, runId);

    const detail = await getJson(harness, `/api/runs/${runId}`);
    expect(detail.status).toBe(200);
    const { progress, targets } = detail.body as {
      progress: { checkUnits: Record<string, number>; recheckUnits: Record<string, number> };
      targets: readonly {
        id: string;
        targetIndex: number;
        target: { start: number; end: number };
      }[];
    };
    expect(Object.keys(progress.checkUnits).sort()).toEqual(
      ["done", "failed", "not-applicable", "pending", "running"].sort(),
    );
    expect(Object.values(progress.checkUnits).reduce((sum, n) => sum + n, 0)).toBe(4);
    expect(Object.values(progress.recheckUnits).reduce((sum, n) => sum + n, 0)).toBe(0);
    // 保存済みの UTF-16 範囲をそのまま返す。
    expect(targets.map((target) => target.target)).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ]);

    const units = await getJson(harness, `/api/runs/${runId}/units`);
    expect(units.status).toBe(200);
    const { checkUnits } = units.body as {
      checkUnits: readonly { targetId: string; targetIndex: number }[];
    };
    expect(checkUnits).toHaveLength(4);
    const indexById = new Map(targets.map((target) => [target.id, target.targetIndex]));
    for (const unit of checkUnits) {
      expect(unit.targetIndex).toBe(indexById.get(unit.targetId));
    }
  });

  it("実行が無ければ 404（詳細も単位も）", async () => {
    const harness = open();

    expect((await getJson(harness, "/api/runs/missing")).status).toBe(404);
    const units = await getJson(harness, "/api/runs/missing/units");
    expect(units.status).toBe(404);
    expect(errorCode(units.body)).toBe("not-found");
  });
});

/** ---------------------------------------------------------------------- */
/** 停止 */
/** ---------------------------------------------------------------------- */

describe("POST /api/runs/:id/stop", () => {
  it("202 を返し、決着後は stopped になる", async () => {
    const loading = deferred<ModelInfo>();
    const harness = open({ ensureLoaded: () => loading.promise });
    const manuscriptVersionId = await createManuscript(harness);

    const started = await postJson(harness, "/api/runs", startRequest(manuscriptVersionId));
    expect(started.status).toBe(201);
    const runId = runOf(started.body).id;
    // ループが動き出して ensureLoaded を待っている（＝レジストリに載っている）ことを確かめてから止める。
    await waitFor(() => harness.client.ensureLoadedCalls.length === 1, "ensureLoaded が呼ばれる");

    const stopped = await postJson(harness, `/api/runs/${runId}/stop`, {});

    expect(stopped.status).toBe(202);
    const accepted = actionRunOf(stopped.body);
    expect(accepted.id).toBe(runId);
    // 202 は「受け付けた」。実行はまだ running で、停止要求の時刻だけが入る（決定 21）。
    expect(accepted.status).toBe("running");
    expect(accepted.stopRequestedAt).not.toBeNull();

    loading.resolve(SCRIPTED_LOADED_MODEL);
    const settled = await waitSettled(harness.hub, harness.db, runId);
    expect(settled.status).toBe("stopped");
    // 生成要求は 1 件も送らずに止まる。
    expect(harness.client.requests).toHaveLength(0);

    const detail = await getJson(harness, `/api/runs/${runId}`);
    expect(runOf((detail.body as { run: unknown }).run).status).toBe("stopped");
  });

  it("レジストリに無い実行は 409 run-not-active（DB を変えない）", async () => {
    const harness = open();
    seedRun(harness, { runId: "r-stopped", status: "stopped", stopReason: "aborted" });

    const { status, body } = await postJson(harness, "/api/runs/r-stopped/stop", {});

    expect(status).toBe(409);
    expect(errorCode(body)).toBe("run-not-active");
    expect(findRun(harness.db, "r-stopped")?.stopRequestedAt).toBeNull();
  });

  it("実行が無ければ 404", async () => {
    const harness = open();

    const { status, body } = await postJson(harness, "/api/runs/missing/stop", {});

    expect(status).toBe(404);
    expect(errorCode(body)).toBe("not-found");
  });
});

/** ---------------------------------------------------------------------- */
/** 再開 */
/** ---------------------------------------------------------------------- */

describe("POST /api/runs/:id/resume", () => {
  it("stopped からは 202 で受け付け、実行は running になる", async () => {
    const harness = open({ steps: malformedSteps(4) });
    const { targetId } = seedRun(harness, {
      runId: "r1",
      status: "stopped",
      stopReason: "aborted",
    });
    seedUnit(harness, "r1", targetId, { id: "cu1", status: "pending" });

    const { status, body } = await postJson(harness, "/api/runs/r1/resume", {});

    expect(status).toBe(202);
    expect(actionRunOf(body).status).toBe("running");

    const settled = await waitSettled(harness.hub, harness.db, "r1");
    expect(settled.status).toBe("partially-failed");
  });

  it("completed は 409 run-rejected-status", async () => {
    const harness = open();
    seedRun(harness, { runId: "r1", status: "completed" });

    const { status, body } = await postJson(harness, "/api/runs/r1/resume", {});

    expect(status).toBe(409);
    expect(errorCode(body)).toBe("run-rejected-status");
  });

  it("設定エラーで止まった実行は 409 run-rejected-settings", async () => {
    const harness = open();
    seedRun(harness, { runId: "r1", status: "stopped", stopReason: "settings" });

    const { status, body } = await postJson(harness, "/api/runs/r1/resume", {});

    expect(status).toBe(409);
    expect(errorCode(body)).toBe("run-rejected-settings");
  });

  it("版が変わった実行は 409 run-rejected-stale-version", async () => {
    const harness = open();
    seedRun(harness, {
      runId: "r1",
      status: "stopped",
      stopReason: "aborted",
      promptVersion: "旧版",
    });

    const { status, body } = await postJson(harness, "/api/runs/r1/resume", {});

    expect(status).toBe(409);
    expect(errorCode(body)).toBe("run-rejected-stale-version");
  });

  it("走っている実行は 409 run-rejected-running", async () => {
    const loading = deferred<ModelInfo>();
    const harness = open({ ensureLoaded: () => loading.promise });
    const manuscriptVersionId = await createManuscript(harness);

    const started = await postJson(harness, "/api/runs", startRequest(manuscriptVersionId));
    const runId = runOf(started.body).id;
    await waitFor(() => harness.client.ensureLoadedCalls.length === 1, "ensureLoaded が呼ばれる");

    const { status, body } = await postJson(harness, `/api/runs/${runId}/resume`, {});

    expect(status).toBe(409);
    expect(errorCode(body)).toBe("run-rejected-running");

    await postJson(harness, `/api/runs/${runId}/stop`, {});
    loading.resolve(SCRIPTED_LOADED_MODEL);
    await waitSettled(harness.hub, harness.db, runId);
  });

  it("実行が無ければ 404", async () => {
    const harness = open();

    const { status, body } = await postJson(harness, "/api/runs/missing/resume", {});

    expect(status).toBe(404);
    expect(errorCode(body)).toBe("not-found");
  });
});

/** ---------------------------------------------------------------------- */
/** 接続先を変えてからの再開・再試行（決定 6） */
/** ---------------------------------------------------------------------- */

describe("接続先を変えた実行の再開・再試行", () => {
  const OTHER_ENDPOINT = "http://127.0.0.1:1235";

  it("409 run-rejected-connection で runs.endpoint_url が変わらない。接続先を戻せば再開できる", async () => {
    const harness = open({ steps: malformedSteps(4) });
    const originalEndpoint = harness.connection.current().endpointUrl;
    const { targetId } = seedRun(harness, {
      runId: "r1",
      status: "stopped",
      stopReason: "aborted",
      endpointUrl: originalEndpoint,
    });
    seedUnit(harness, "r1", targetId, {
      id: "cu1",
      status: "failed",
      failure: MALFORMED_FAILURE,
    });

    const changed = await harness.app.request("/api/settings/connection", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ endpointUrl: OTHER_ENDPOINT }),
    });
    expect(changed.status).toBe(200);

    const resumed = await postJson(harness, "/api/runs/r1/resume", {});
    expect(resumed.status).toBe(409);
    expect(errorCode(resumed.body)).toBe("run-rejected-connection");

    const retried = await postJson(harness, "/api/runs/r1/retry-failed", {});
    expect(retried.status).toBe(409);
    expect(errorCode(retried.body)).toBe("run-rejected-connection");

    // 拒否では保存済みの接続先を書き換えない（実行の状態も単位も変えない）。
    expect(findRun(harness.db, "r1")?.endpointUrl).toBe(originalEndpoint);
    expect(findRun(harness.db, "r1")?.status).toBe("stopped");

    // 接続先を戻せば再開できる。
    const restored = await harness.app.request("/api/settings/connection", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ endpointUrl: originalEndpoint }),
    });
    expect(restored.status).toBe(200);

    const again = await postJson(harness, "/api/runs/r1/resume", {});
    expect(again.status).toBe(202);
    await waitSettled(harness.hub, harness.db, "r1");
  });
});

/** ---------------------------------------------------------------------- */
/** 失敗単位の再試行 */
/** ---------------------------------------------------------------------- */

describe("POST /api/runs/:id/retry-failed", () => {
  it("本文なしの要求は全件の再試行として 202", async () => {
    const harness = open({ steps: malformedSteps(4) });
    const { targetId } = seedRun(harness, {
      runId: "r1",
      status: "partially-failed",
    });
    seedUnit(harness, "r1", targetId, {
      id: "cu1",
      status: "failed",
      failure: MALFORMED_FAILURE,
    });

    const { status, body } = await postEmpty(harness, "/api/runs/r1/retry-failed");

    expect(status).toBe(202);
    expect(actionRunOf(body).status).toBe("running");

    const settled = await waitSettled(harness.hub, harness.db, "r1");
    expect(settled.status).toBe("partially-failed");
    // 再試行で実際に生成要求を送り直している。
    expect(harness.client.requests.length).toBeGreaterThan(0);
  });

  it("単位 ID を指定した再試行も 202", async () => {
    const harness = open({ steps: malformedSteps(4) });
    const { targetId } = seedRun(harness, { runId: "r1", status: "stopped" });
    seedUnit(harness, "r1", targetId, {
      id: "cu1",
      status: "failed",
      failure: MALFORMED_FAILURE,
    });

    const { status } = await postJson(harness, "/api/runs/r1/retry-failed", { unitIds: ["cu1"] });

    expect(status).toBe(202);
    await waitSettled(harness.hub, harness.db, "r1");
  });

  it("空配列は 400 validation（省略が「全件」なので、空配列を全件と読まない）", async () => {
    const harness = open();
    const { targetId } = seedRun(harness, { runId: "r1", status: "stopped" });
    seedUnit(harness, "r1", targetId, {
      id: "cu1",
      status: "failed",
      failure: MALFORMED_FAILURE,
    });

    const { status, body } = await postJson(harness, "/api/runs/r1/retry-failed", { unitIds: [] });

    expect(status).toBe(400);
    expect(errorCode(body)).toBe("validation");
    expect(findRun(harness.db, "r1")?.status).toBe("stopped");
  });

  it("input-too-long の単位を指定したら 400 invalid-retry-target（状態も単位も変えない）", async () => {
    const harness = open();
    const { targetId } = seedRun(harness, {
      runId: "r1",
      status: "stopped",
      stopReason: "settings",
    });
    seedUnit(harness, "r1", targetId, {
      id: "cu1",
      status: "failed",
      failure: INPUT_TOO_LONG_FAILURE,
    });

    const { status, body } = await postJson(harness, "/api/runs/r1/retry-failed", {
      unitIds: ["cu1"],
    });

    expect(status).toBe(400);
    expect(errorCode(body)).toBe("invalid-retry-target");
    expect(findRun(harness.db, "r1")?.status).toBe("stopped");
    expect(harness.client.requests).toHaveLength(0);
  });

  it("実行が無ければ 404", async () => {
    const harness = open();

    const { status, body } = await postEmpty(harness, "/api/runs/missing/retry-failed");

    expect(status).toBe(404);
    expect(errorCode(body)).toBe("not-found");
  });
});
