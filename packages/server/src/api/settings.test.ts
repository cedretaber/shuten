/**
 * A1：接続設定（`api/settings.test.ts`。決定 5・8）。
 *
 * `PUT`/`POST /check` は必ず HTTP（`harness.app.request`）を通す。**実行が使うクライアントは
 * `harness.connection.current().client`**（`harness.client.client` ではない。`api/test-support.ts`
 * のドキュメント参照）。「PUT 前後で実行が使うクライアントが変わる」ことは、その参照の恒等性と、
 * `ChatStep` の文脈（`endpointUrl`）に現れる接続先の違いの両方で確かめる。
 */

import { afterEach, describe, expect, it } from "vitest";

import { createConnectionManager } from "../connection.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import type { ChatResult, ModelInfo, Usage } from "../lmstudio/types.ts";
import type { StartRunInput } from "../run/orchestrator.ts";
import { SCRIPTED_ENDPOINT_URL, SCRIPTED_LOADED_MODEL } from "../run/test-support.ts";
import { CONNECTION_CHECK_ERROR_MESSAGES } from "./messages.ts";
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

async function getConnection(harness: ApiHarness): Promise<{ status: number; body: unknown }> {
  const res = await harness.app.request("/api/settings/connection");
  return { status: res.status, body: await res.json() };
}

async function putConnection(
  harness: ApiHarness,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await harness.app.request("/api/settings/connection", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function postCheck(
  harness: ApiHarness,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await harness.app.request("/api/settings/connection/check", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

const USAGE: Usage = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
  reasoningTokens: null,
};

/** 指摘なしの検査応答。 */
function emptyCheckResult(): ChatResult {
  return {
    content: JSON.stringify({ findings: [] }),
    reasoningContent: null,
    finishReason: "stop",
    usage: USAGE,
    raw: {},
  };
}

/** 本文全体（10 書記素）がちょうど 1 対象になる本文。 */
const TEXT = "0123456789";

function baseStartInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    startOperationId: "op-1",
    manuscriptVersionId: "mv1",
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

describe("GET /api/settings/connection", () => {
  it("endpointUrl と hasApiKey を返し、キー本体を返さない", async () => {
    const harness = open({
      env: { lmStudioUrl: SCRIPTED_ENDPOINT_URL, lmStudioApiKey: "s3cr3t-api-key" },
    });

    const { status, body } = await getConnection(harness);

    expect(status).toBe(200);
    expect(body).toEqual({ endpointUrl: SCRIPTED_ENDPOINT_URL, hasApiKey: true });
    expect(JSON.stringify(body)).not.toContain("s3cr3t-api-key");
  });
});

describe("PUT /api/settings/connection", () => {
  it("/v1 付きの URL は 400 validation", async () => {
    const harness = open();

    const { status, body } = await putConnection(harness, {
      endpointUrl: `${SCRIPTED_ENDPOINT_URL}/v1`,
    });

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("validation");
  });

  it("非 http（例：ftp）の URL は 400 validation", async () => {
    const harness = open();

    const { status, body } = await putConnection(harness, {
      endpointUrl: "ftp://127.0.0.1:1234",
    });

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("validation");
  });

  it("settings 表に書き、再起動（ConnectionManager の作り直し）で行が環境変数より優先される", async () => {
    const harness = open();
    const NEW_URL = "http://127.0.0.1:4321";

    const { status } = await putConnection(harness, { endpointUrl: NEW_URL });
    expect(status).toBe(200);

    // 「再起動」を、同じ DB から ConnectionManager を作り直すことで再現する。
    const restarted = createConnectionManager({
      db: harness.db,
      env: { lmStudioUrl: "http://127.0.0.1:9999", lmStudioApiKey: null },
    });
    expect(restarted.describe().endpointUrl).toBe(NEW_URL);
  });

  it("apiKey は省略で維持、null で消去、文字列で設定（hasApiKey で観測）", async () => {
    const harness = open({
      env: { lmStudioUrl: SCRIPTED_ENDPOINT_URL, lmStudioApiKey: "initial-api-key" },
    });

    const kept = await putConnection(harness, { endpointUrl: SCRIPTED_ENDPOINT_URL });
    expect((kept.body as { hasApiKey: boolean }).hasApiKey).toBe(true);

    const cleared = await putConnection(harness, {
      endpointUrl: SCRIPTED_ENDPOINT_URL,
      apiKey: null,
    });
    expect((cleared.body as { hasApiKey: boolean }).hasApiKey).toBe(false);

    const set = await putConnection(harness, {
      endpointUrl: SCRIPTED_ENDPOINT_URL,
      apiKey: "new-api-key",
    });
    expect((set.body as { hasApiKey: boolean }).hasApiKey).toBe(true);
  });

  it("実行中（activeRunIds が空でない）の PUT は 409 runs-active で、update が呼ばれない", async () => {
    const harness = open();
    insertManuscriptVersion(harness.db, { id: "mv1", name: "原稿", body: TEXT });

    // chat 応答を意図的に保留し、実行を「走っている」状態に留める。
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.client.steps.push(async () => {
      await gate;
      return emptyCheckResult();
    });

    const started = harness.orchestrator.startRun(baseStartInput());
    expect(harness.orchestrator.activeRunIds()).toEqual([started.run.id]);

    const before = harness.connection.describe();
    const { status, body } = await putConnection(harness, {
      endpointUrl: "http://127.0.0.1:5555",
    });

    expect(status).toBe(409);
    expect((body as { error: { code: string } }).error.code).toBe("runs-active");
    // update は呼ばれていない（接続設定も、古いクライアントの close も変化しない）。
    expect(harness.connection.describe()).toEqual(before);
    expect(harness.client.closeCalls).toBe(0);

    release?.();
    const finished = await started.done;
    expect(finished.status).toBe("completed");
  });

  it("PUT が古いクライアントの close() を呼ぶ", async () => {
    const harness = open();
    expect(harness.client.closeCalls).toBe(0);

    const { status } = await putConnection(harness, { endpointUrl: "http://127.0.0.1:4321" });

    expect(status).toBe(200);
    expect(harness.client.closeCalls).toBe(1);
  });

  it("PUT 後の startRun は新しいクライアントを使い、PUT 前に走っていた実行は古いクライアントのまま", async () => {
    const harness = open();
    insertManuscriptVersion(harness.db, { id: "mv1", name: "原稿", body: TEXT });

    const seenEndpoints: string[] = [];
    harness.client.steps.push(({ endpointUrl }) => {
      seenEndpoints.push(endpointUrl);
      return emptyCheckResult();
    });

    const beforeClient = harness.connection.current().client;
    const before = harness.orchestrator.startRun(baseStartInput({ startOperationId: "op-before" }));
    const beforeFinished = await before.done;
    expect(beforeFinished.status).toBe("completed");

    const NEW_URL = "http://127.0.0.1:4321";
    const { status } = await putConnection(harness, { endpointUrl: NEW_URL });
    expect(status).toBe(200);

    const afterClient = harness.connection.current().client;
    // PUT で作られたのは新しい（＝別の恒等性を持つ）クライアント。
    expect(afterClient).not.toBe(beforeClient);

    harness.client.steps.push(({ endpointUrl }) => {
      seenEndpoints.push(endpointUrl);
      return emptyCheckResult();
    });
    const after = harness.orchestrator.startRun(baseStartInput({ startOperationId: "op-after" }));
    const afterFinished = await after.done;
    expect(afterFinished.status).toBe("completed");

    // PUT 前の実行が呼んだ chat は旧接続先、PUT 後の実行が呼んだ chat は新接続先を見ていた。
    expect(seenEndpoints).toEqual([SCRIPTED_ENDPOINT_URL, NEW_URL]);
  });
});

describe("POST /api/settings/connection/check（決定 8：listModels() までで、試験生成は送らない）", () => {
  it("到達不能：reachable: false、error.message は reason の定型文で URL を含まない。chat は呼ばれない", async () => {
    const harness = open({
      listModels: ({ failure }) => Promise.reject(failure("connection", "接続できない")),
    });

    const { status, body } = await postCheck(harness);

    expect(status).toBe(200);
    expect(body).toEqual({
      reachable: false,
      error: { reason: "connection", message: CONNECTION_CHECK_ERROR_MESSAGES.connection },
      models: [],
      model: null,
    });
    const message = (body as { error: { message: string } }).error.message;
    expect(message).not.toContain(SCRIPTED_ENDPOINT_URL);
    expect(message).not.toContain("127.0.0.1");
    expect(harness.client.requests).toHaveLength(0);
    expect(harness.client.ensureLoadedCalls).toEqual([]);
  });

  it("到達可能・modelId 未指定：model は null。chat は呼ばれない", async () => {
    const harness = open({ listModels: () => Promise.resolve([SCRIPTED_LOADED_MODEL]) });

    const { status, body } = await postCheck(harness);

    expect(status).toBe(200);
    expect(body).toEqual({
      reachable: true,
      error: null,
      models: [SCRIPTED_LOADED_MODEL],
      model: null,
    });
    expect(harness.client.requests).toHaveLength(0);
    expect(harness.client.ensureLoadedCalls).toEqual([]);
  });

  it("modelId が一覧に無い：found: false。chat は呼ばれない", async () => {
    const harness = open({ listModels: () => Promise.resolve([SCRIPTED_LOADED_MODEL]) });

    const { body } = await postCheck(harness, { modelId: "does-not-exist" });

    expect((body as { model: unknown }).model).toEqual({
      id: "does-not-exist",
      found: false,
      state: null,
      loaded: false,
    });
    expect(harness.client.requests).toHaveLength(0);
    expect(harness.client.ensureLoadedCalls).toEqual([]);
  });

  it("modelId が一覧にあるが未ロード：loaded: false。chat は呼ばれない", async () => {
    const notLoaded: ModelInfo = { ...SCRIPTED_LOADED_MODEL, id: "model-b", state: "not-loaded" };
    const harness = open({ listModels: () => Promise.resolve([notLoaded]) });

    const { body } = await postCheck(harness, { modelId: "model-b" });

    expect((body as { model: unknown }).model).toEqual({
      id: "model-b",
      found: true,
      state: "not-loaded",
      loaded: false,
    });
    expect(harness.client.requests).toHaveLength(0);
    expect(harness.client.ensureLoadedCalls).toEqual([]);
  });

  it("modelId がロード済み：loaded: true。chat は呼ばれない", async () => {
    const harness = open({ listModels: () => Promise.resolve([SCRIPTED_LOADED_MODEL]) });

    const { body } = await postCheck(harness, { modelId: SCRIPTED_LOADED_MODEL.id });

    expect((body as { model: unknown }).model).toEqual({
      id: SCRIPTED_LOADED_MODEL.id,
      found: true,
      state: "loaded",
      loaded: true,
    });
    expect(harness.client.requests).toHaveLength(0);
    expect(harness.client.ensureLoadedCalls).toEqual([]);
  });
});
