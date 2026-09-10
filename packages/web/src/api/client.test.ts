import type {
  ConnectionCheckDto,
  ConnectionSettingsDto,
  ManuscriptVersionDto,
  RunDetailDto,
  RunDto,
  StartRunRequest,
} from "@shuten/shared";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client.ts";
import {
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
  GENERIC_REQUEST_ERROR,
} from "./errors.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorJsonResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

function htmlResponse(status: number): Response {
  return new Response("<html>予期しないエラー</html>", {
    status,
    headers: { "content-type": "text/html" },
  });
}

/** 本文の読み取り自体が失敗する fake。`new Response` では作れないため最小オブジェクトで作る。 */
function brokenBodyResponse(status: number, ok: boolean): Response {
  return {
    ok,
    status,
    text: () => Promise.reject(new Error("読み取り中に切断した")),
  } as unknown as Response;
}

function makeConnectionSettingsDto(): ConnectionSettingsDto {
  return { endpointUrl: "http://127.0.0.1:1234", hasApiKey: true };
}

function makeConnectionCheckDto(): ConnectionCheckDto {
  return { reachable: true, error: null, models: [], model: null };
}

function makeManuscriptVersionDto(): ManuscriptVersionDto {
  return {
    id: "manuscript-1",
    name: "テスト原稿",
    body: "本文",
    bodyHash: "hash-1",
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}

function makeRunDto(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: "run-1",
    manuscriptVersionId: "manuscript-1",
    modelId: "model-1",
    modelInfo: null,
    generationSettings: { maxTokens: 1000, temperature: 0.2 },
    chunkSettings: {
      targetGraphemes: 1500,
      contextGraphemes: 200,
      recheckContextGraphemes: 200,
      roundingTolerance: 0.1,
      maxInputGraphemes: 100000,
    },
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: true,
    allowedWords: [],
    allowedWordRuleVersion: "1",
    promptVersion: "1",
    diagnosticTransformVersion: "1",
    status: "running",
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    stopRequestedAt: null,
    recoveryConfirmedAt: null,
    recoveryConfirmMs: 60_000,
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function makeStartRunRequest(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    startOperationId: "op-1",
    manuscriptVersionId: "manuscript-1",
    modelId: "model-1",
    generation: { maxTokens: 1000, temperature: 0.2 },
    chunkSettings: {
      targetGraphemes: 1500,
      contextGraphemes: 200,
      recheckContextGraphemes: 200,
      roundingTolerance: 0.1,
      maxInputGraphemes: 100000,
    },
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: true,
    allowedWordsRaw: "",
    ...overrides,
  };
}

function makeRunDetailDto(): RunDetailDto {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, "not-applicable": 0 } as const;
  return {
    run: makeRunDto(),
    progress: { checkUnits: { ...counts }, recheckUnits: { ...counts } },
    targets: [],
  };
}

function fetchMock(response: Response): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValueOnce(response);
}

describe("createApiClient", () => {
  it("W1-1: 各メソッドが正しい URL・メソッド・本文で fetch を呼び、検証済みの DTO を返す", async () => {
    {
      const dto = makeConnectionSettingsDto();
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(client.getConnection()).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/settings/connection");
      expect(init.method).toBe("GET");
    }

    {
      const dto = makeConnectionSettingsDto();
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(
        client.putConnection({ endpointUrl: "http://127.0.0.1:1234", apiKey: "sk-abc" }),
      ).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/settings/connection");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(String(init.body))).toEqual({
        endpointUrl: "http://127.0.0.1:1234",
        apiKey: "sk-abc",
      });
    }

    {
      const dto = makeConnectionCheckDto();
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      const controller = new AbortController();
      await expect(
        client.checkConnection("model-1", { signal: controller.signal }),
      ).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/settings/connection/check");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ modelId: "model-1" });
      expect(init.signal).toBe(controller.signal);
    }

    {
      // modelId を省略したときは要求本文にキーを含めない。
      const dto = makeConnectionCheckDto();
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(client.checkConnection()).resolves.toEqual(dto);
      const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({});
    }

    {
      const dto = makeManuscriptVersionDto();
      const fetchImpl = fetchMock(jsonResponse(201, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(client.createManuscript({ name: "テスト原稿", body: "本文" })).resolves.toEqual(
        dto,
      );
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/manuscripts");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ name: "テスト原稿", body: "本文" });
    }

    {
      const dto = makeManuscriptVersionDto();
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      const controller = new AbortController();
      await expect(
        client.getManuscript("manuscript-1", { signal: controller.signal }),
      ).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/manuscripts/manuscript-1");
      expect(init.method).toBe("GET");
      expect(init.signal).toBe(controller.signal);
    }

    {
      const dto = makeRunDto();
      const fetchImpl = fetchMock(jsonResponse(201, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      const request = makeStartRunRequest();
      await expect(client.startRun(request)).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/runs");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual(request);
    }

    {
      const dto = makeRunDetailDto();
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      const controller = new AbortController();
      await expect(client.getRun("run-1", { signal: controller.signal })).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/runs/run-1");
      expect(init.method).toBe("GET");
      expect(init.signal).toBe(controller.signal);
    }

    {
      // uploadManuscript は FormData に file・name を入れ、Content-Type を自分で指定しない。
      const dto = makeManuscriptVersionDto();
      const fetchImpl = fetchMock(jsonResponse(201, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      const file = new File(["本文"], "manuscript.txt", { type: "text/plain" });
      await expect(client.uploadManuscript({ file, name: "テスト原稿" })).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/manuscripts/upload");
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(form.get("file")).toBe(file);
      expect(form.get("name")).toBe("テスト原稿");
      const headers = init.headers === undefined ? new Headers() : new Headers(init.headers);
      expect(headers.has("content-type")).toBe(false);
    }
  });

  it("W1-2: 非 2xx で apiErrorSchema に合う本文 → ApiRequestError(status, code, message)", async () => {
    const fetchImpl = fetchMock(errorJsonResponse(409, "runs-active", "検査実行が走っています"));
    const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });

    await expect(
      client.putConnection({ endpointUrl: "http://127.0.0.1:1234" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "runs-active",
      message: "検査実行が走っています",
    });

    let caught: unknown;
    const fetchImpl2 = fetchMock(errorJsonResponse(404, "not-found", "見つかりません"));
    const client2 = createApiClient({ fetch: fetchImpl2 as unknown as typeof fetch });
    try {
      await client2.getManuscript("nope");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiRequestError);
  });

  it('W1-3: 非 2xx で本文が HTML／不正 JSON → ApiRequestError(status, "unknown", GENERIC_REQUEST_ERROR)', async () => {
    const client4xx = createApiClient({
      fetch: fetchMock(htmlResponse(400)) as unknown as typeof fetch,
    });
    await expect(client4xx.getConnection()).rejects.toMatchObject({
      status: 400,
      code: "unknown",
      message: GENERIC_REQUEST_ERROR,
    });

    const client5xx = createApiClient({
      fetch: fetchMock(htmlResponse(502)) as unknown as typeof fetch,
    });
    await expect(client5xx.getConnection()).rejects.toMatchObject({
      status: 502,
      code: "unknown",
      message: GENERIC_REQUEST_ERROR,
    });
  });

  it("W1-4: 2xx の契約違反は ApiResponseError、通信の失敗は ApiTransportError になる", async () => {
    const nonJsonClient = createApiClient({
      fetch: fetchMock(new Response("not json", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(nonJsonClient.getConnection()).rejects.toBeInstanceOf(ApiResponseError);

    const schemaViolationClient = createApiClient({
      fetch: fetchMock(jsonResponse(200, { unexpected: "field" })) as unknown as typeof fetch,
    });
    await expect(schemaViolationClient.getConnection()).rejects.toBeInstanceOf(ApiResponseError);

    const throwingFetch = vi.fn().mockRejectedValueOnce(new Error("network down"));
    const transportClient = createApiClient({ fetch: throwingFetch as unknown as typeof fetch });
    await expect(transportClient.getConnection()).rejects.toBeInstanceOf(ApiTransportError);

    const brokenBodyClient = createApiClient({
      fetch: fetchMock(brokenBodyResponse(200, true)) as unknown as typeof fetch,
    });
    await expect(brokenBodyClient.getConnection()).rejects.toBeInstanceOf(ApiTransportError);

    // 5xx でも本文の読み取りが切れたら ApiTransportError（apiErrorSchema での分類より前）。
    const brokenBody5xxClient = createApiClient({
      fetch: fetchMock(brokenBodyResponse(500, false)) as unknown as typeof fetch,
    });
    await expect(brokenBody5xxClient.getConnection()).rejects.toBeInstanceOf(ApiTransportError);
  });

  it("W1-5: startRun の再送（200 で既存実行）も RunDto として扱い、apiKey は例外にも console にも出ない", async () => {
    const existingRun = makeRunDto({ id: "run-existing" });
    const fetchImpl = fetchMock(jsonResponse(200, existingRun));
    const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
    const result = await client.startRun(makeStartRunRequest({ startOperationId: "op-existing" }));
    expect(result).toEqual(existingRun);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const apiKey = "sk-super-secret";
    const failingFetch = fetchMock(errorJsonResponse(409, "runs-active", "検査実行が走っています"));
    const failingClient = createApiClient({ fetch: failingFetch as unknown as typeof fetch });

    let caught: unknown;
    try {
      await failingClient.putConnection({ endpointUrl: "http://127.0.0.1:1234", apiKey });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiRequestError);
    expect(JSON.stringify(caught)).not.toContain(apiKey);
    expect((caught as ApiRequestError).message).not.toContain(apiKey);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
