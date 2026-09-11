import type {
  ConnectionCheckDto,
  ConnectionSettingsDto,
  FindingDetailDto,
  FindingDto,
  JudgmentDto,
  ManuscriptVersionDto,
  RecoveryDto,
  RunDetailDto,
  RunDto,
  RunSummaryDto,
  RunUnitsDto,
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
import type { RunEventHandlers } from "./events.ts";
import * as eventsModule from "./events.ts";

/**
 * このファイルは計画書（`docs/plans/2026-09-10-pr11-web-shell.md`）の W1 節（API クライアント）を
 * 全 5 項目カバーする。加えて、W2 節（例外の分類と解析順）の 7 項目（W2-1〜7）もここに置く：
 * それらは「本文の読み取り・`JSON.parse`・状態コードによる分岐」という `client.ts` の応答処理
 * そのものの検証であり、実際の `Response`（または本文の読み取りが失敗する fake）と `fetch` 経由の
 * 呼び出しが要るため、`api/errors.ts` の単体テストでは再現できない（W2-8 だけは純粋な関数
 * `isStartOutcomeUnknown` の真理値表なので `errors.test.ts` に置く）。
 */

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

function makeRunSummaryDto(overrides: Partial<RunSummaryDto> = {}): RunSummaryDto {
  return {
    id: "run-1",
    manuscriptVersionId: "manuscript-1",
    manuscriptName: "テスト原稿",
    modelId: "model-1",
    status: "running",
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function makeJudgmentDto(overrides: Partial<JudgmentDto> = {}): JudgmentDto {
  return {
    findingId: "finding-1",
    status: "undecided",
    note: null,
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeFindingDto(overrides: Partial<FindingDto> = {}): FindingDto {
  return {
    id: "finding-1",
    runId: "run-1",
    targetId: "target-1",
    locateStatus: "located",
    range: { start: 0, end: 5 },
    paragraphId: 0,
    quote: "誤字",
    suggestion: null,
    category: "notation",
    initialVerdict: "likely-error",
    suppression: null,
    reasons: [],
    recheck: null,
    judgment: makeJudgmentDto(),
    createdAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeFindingDetailDto(overrides: Partial<FindingDetailDto> = {}): FindingDetailDto {
  return {
    ...makeFindingDto(),
    candidates: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeRunUnitsDto(): RunUnitsDto {
  return { checkUnits: [], recheckUnits: [] };
}

function makeRecoveryDto(overrides: Partial<RecoveryDto> = {}): RecoveryDto {
  return { blocked: false, runIds: [], ...overrides };
}

function fetchMock(response: Response): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValueOnce(response);
}

describe("createApiClient", () => {
  it("W1-1: 8 つの口それぞれについて、fetch に渡るメソッド・パス・本文が正しい", async () => {
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
      const fetchImpl = fetchMock(jsonResponse(201, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      const file = new File(["本文"], "manuscript.txt", { type: "text/plain" });
      await expect(client.uploadManuscript({ file, name: "テスト原稿" })).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/manuscripts/upload");
      expect(init.method).toBe("POST");
    }

    {
      const dto = makeManuscriptVersionDto();
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(client.getManuscript("manuscript-1")).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/manuscripts/manuscript-1");
      expect(init.method).toBe("GET");
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
      await expect(client.getRun("run-1")).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/runs/run-1");
      expect(init.method).toBe("GET");
    }
  });

  it("W1-2: uploadManuscript の FormData に File がそのまま載り、Content-Type を指定していない", async () => {
    const dto = makeManuscriptVersionDto();
    const fetchImpl = fetchMock(jsonResponse(201, dto));
    const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
    const file = new File(["本文"], "manuscript.txt", { type: "text/plain" });

    await expect(client.uploadManuscript({ file, name: "テスト原稿" })).resolves.toEqual(dto);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("file")).toBe(file);
    expect(form.get("name")).toBe("テスト原稿");
    const headers = init.headers === undefined ? new Headers() : new Headers(init.headers);
    expect(headers.has("content-type")).toBe(false);
  });

  it("W1-3: checkConnection() を引数なしで呼ぶと本文に modelId を入れない", async () => {
    const dto = makeConnectionCheckDto();
    const fetchImpl = fetchMock(jsonResponse(200, dto));
    const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });

    await expect(client.checkConnection()).resolves.toEqual(dto);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body: unknown = JSON.parse(String(init.body));
    expect(body).toEqual({});
    expect(body).not.toHaveProperty("modelId");
  });

  it("W1-4: getRun(id, { signal }) の signal が fetch に渡る", async () => {
    const dto = makeRunDetailDto();
    const fetchImpl = fetchMock(jsonResponse(200, dto));
    const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
    const controller = new AbortController();

    await expect(client.getRun("run-1", { signal: controller.signal })).resolves.toEqual(dto);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it("W1-5: 応答に余分なキーがあると ApiResponseError（.strict() が拒む）", async () => {
    // 必須フィールドはすべて満たした上で、余分なキーを 1 つ足す。必須フィールド欠落
    // （W2-7）と違い、.strict() を外した z.object() でも通ってしまう入力ではないことを確認する。
    const bodyWithExtraKey = { ...makeConnectionSettingsDto(), extra: "余分な値" };
    const client = createApiClient({
      fetch: fetchMock(jsonResponse(200, bodyWithExtraKey)) as unknown as typeof fetch,
    });

    await expect(client.getConnection()).rejects.toBeInstanceOf(ApiResponseError);
  });

  it("W2-1: 応答本文の読み取りが失敗（reject）すると ApiTransportError", async () => {
    const client = createApiClient({
      fetch: fetchMock(brokenBodyResponse(200, true)) as unknown as typeof fetch,
    });
    await expect(client.getConnection()).rejects.toBeInstanceOf(ApiTransportError);

    // 5xx でも本文の読み取りが切れたら ApiTransportError（apiErrorSchema での分類より前）。
    const client5xx = createApiClient({
      fetch: fetchMock(brokenBodyResponse(500, false)) as unknown as typeof fetch,
    });
    await expect(client5xx.getConnection()).rejects.toBeInstanceOf(ApiTransportError);
  });

  it("W2-2: fetch 自体が reject すると ApiTransportError", async () => {
    const throwingFetch = vi.fn().mockRejectedValueOnce(new Error("network down"));
    const client = createApiClient({ fetch: throwingFetch as unknown as typeof fetch });

    await expect(client.getConnection()).rejects.toBeInstanceOf(ApiTransportError);
  });

  it("W2-3: 400 で apiErrorSchema に合う本文 → ApiRequestError(400, code, message)", async () => {
    const client = createApiClient({
      fetch: fetchMock(
        errorJsonResponse(400, "validation", "入力の検証に失敗しました"),
      ) as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await client.getConnection();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiRequestError);
    expect(caught).toMatchObject({
      status: 400,
      code: "validation",
      message: "入力の検証に失敗しました",
    });
  });

  it('W2-4: 400 で HTML 本文 → ApiRequestError(400, "unknown", GENERIC_REQUEST_ERROR)。ApiResponseError にしない', async () => {
    const client = createApiClient({
      fetch: fetchMock(htmlResponse(400)) as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await client.getConnection();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiRequestError);
    expect(caught).not.toBeInstanceOf(ApiResponseError);
    expect(caught).toMatchObject({ status: 400, code: "unknown", message: GENERIC_REQUEST_ERROR });
  });

  it('W2-5: 500 で HTML 本文 → ApiRequestError(500, "unknown", GENERIC_REQUEST_ERROR)', async () => {
    const client = createApiClient({
      fetch: fetchMock(htmlResponse(500)) as unknown as typeof fetch,
    });

    await expect(client.getConnection()).rejects.toMatchObject({
      status: 500,
      code: "unknown",
      message: GENERIC_REQUEST_ERROR,
    });
  });

  it("W2-6: 200 で HTML 本文 → ApiResponseError", async () => {
    const client = createApiClient({
      fetch: fetchMock(htmlResponse(200)) as unknown as typeof fetch,
    });

    await expect(client.getConnection()).rejects.toBeInstanceOf(ApiResponseError);
  });

  it("W2-7: 200 で JSON だがスキーマ違反（必須フィールド欠落） → ApiResponseError", async () => {
    const client = createApiClient({
      fetch: fetchMock(jsonResponse(200, { unexpected: "field" })) as unknown as typeof fetch,
    });

    await expect(client.getConnection()).rejects.toBeInstanceOf(ApiResponseError);
  });

  it("付随テスト：startRun の再送（200 で既存実行）も RunDto として扱う（決定 15）", async () => {
    const existingRun = makeRunDto({ id: "run-existing" });
    const fetchImpl = fetchMock(jsonResponse(200, existingRun));
    const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });

    const result = await client.startRun(makeStartRunRequest({ startOperationId: "op-existing" }));

    expect(result).toEqual(existingRun);
  });

  it("付随テスト：putConnection の apiKey は失敗時の例外にも console にも出ない（決定 18）", async () => {
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

  it("R9-1: getRuns / getFindings / getFinding / putJudgment それぞれについて、fetch に渡るメソッド・パス・本文と戻り値が正しい", async () => {
    {
      const dtos = [makeRunSummaryDto()];
      const fetchImpl = fetchMock(jsonResponse(200, dtos));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(client.getRuns()).resolves.toEqual(dtos);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/runs");
      expect(init.method).toBe("GET");
    }

    {
      const dtos = [makeFindingDto()];
      const fetchImpl = fetchMock(jsonResponse(200, dtos));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      const controller = new AbortController();
      await expect(client.getFindings("run-1", { signal: controller.signal })).resolves.toEqual(
        dtos,
      );
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/runs/run-1/findings");
      expect(init.method).toBe("GET");
      expect(init.signal).toBe(controller.signal);
    }

    {
      const dto = makeFindingDetailDto();
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(client.getFinding("finding-1")).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/findings/finding-1");
      expect(init.method).toBe("GET");
    }

    {
      const dto = makeJudgmentDto({ status: "adopt-planned", note: "採用予定" });
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(
        client.putJudgment("finding-1", { status: "adopt-planned", note: "採用予定" }),
      ).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/findings/finding-1/judgment");
      expect(init.method).toBe("PUT");
      const headers = init.headers === undefined ? new Headers() : new Headers(init.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init.body))).toEqual({
        status: "adopt-planned",
        note: "採用予定",
      });
    }
  });

  it("R9-2: URL に含む ID を encodeURIComponent する", async () => {
    {
      const dtos = [makeFindingDto()];
      const fetchImpl = fetchMock(jsonResponse(200, dtos));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await client.getFindings("run/1 あ");
      const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`/api/runs/${encodeURIComponent("run/1 あ")}/findings`);
    }

    {
      const dto = makeFindingDetailDto();
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await client.getFinding("finding/1 あ");
      const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`/api/findings/${encodeURIComponent("finding/1 あ")}`);
    }

    {
      const dto = makeJudgmentDto();
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await client.putJudgment("finding/1 あ", { status: "held" });
      const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`/api/findings/${encodeURIComponent("finding/1 あ")}/judgment`);
    }
  });

  it("R9-3: getFindings が形のおかしい応答（要素から id を落とす）を受け取ると ApiResponseError", async () => {
    const { id: _id, ...findingWithoutId } = makeFindingDto();
    const client = createApiClient({
      fetch: fetchMock(jsonResponse(200, [findingWithoutId])) as unknown as typeof fetch,
    });

    await expect(client.getFindings("run-1")).rejects.toBeInstanceOf(ApiResponseError);
  });

  it('R9-4: putJudgment の note を省略すると本文が {"status":"held"} になる（null を補わない）', async () => {
    const dto = makeJudgmentDto({ status: "held" });
    const fetchImpl = fetchMock(jsonResponse(200, dto));
    const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });

    await expect(client.putJudgment("finding-1", { status: "held" })).resolves.toEqual(dto);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).toBe('{"status":"held"}');
  });

  it("PR12b-1: getRunUnits / stopRun / resumeRun / retryFailedUnits / getRecovery / confirmRecovery それぞれについて、fetch に渡るメソッド・パス・本文と戻り値が正しい", async () => {
    {
      const dto = makeRunUnitsDto();
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      const controller = new AbortController();
      await expect(client.getRunUnits("run-1", { signal: controller.signal })).resolves.toEqual(
        dto,
      );
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/runs/run-1/units");
      expect(init.method).toBe("GET");
      expect(init.signal).toBe(controller.signal);
    }

    {
      const run = makeRunDto({ status: "stopped" });
      const fetchImpl = fetchMock(jsonResponse(202, { run }));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(client.stopRun("run-1")).resolves.toEqual(run);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/runs/run-1/stop");
      expect(init.method).toBe("POST");
      expect(init.body).toBeUndefined();
    }

    {
      const run = makeRunDto({ status: "running" });
      const fetchImpl = fetchMock(jsonResponse(202, { run }));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(client.resumeRun("run-1")).resolves.toEqual(run);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/runs/run-1/resume");
      expect(init.method).toBe("POST");
      expect(init.body).toBeUndefined();
    }

    {
      const run = makeRunDto({ status: "running" });
      const fetchImpl = fetchMock(jsonResponse(202, { run }));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(
        client.retryFailedUnits("run-1", { unitIds: ["unit-1", "unit-2"] }),
      ).resolves.toEqual(run);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/runs/run-1/retry-failed");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ unitIds: ["unit-1", "unit-2"] });
    }

    {
      const dto = makeRecoveryDto({ blocked: true, runIds: ["run-1"] });
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      const controller = new AbortController();
      await expect(client.getRecovery({ signal: controller.signal })).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/recovery");
      expect(init.method).toBe("GET");
      expect(init.signal).toBe(controller.signal);
    }

    {
      const dto = makeRecoveryDto();
      const fetchImpl = fetchMock(jsonResponse(200, dto));
      const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(client.confirmRecovery("run-1")).resolves.toEqual(dto);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/recovery/confirm");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ runId: "run-1" });
    }
  });

  it("PR12b-2: retryFailedUnits は body 省略で本文なしの POST（{ unitIds: [] } を送らない）", async () => {
    const run = makeRunDto({ status: "running" });
    const fetchImpl = fetchMock(jsonResponse(202, { run }));
    const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });

    await expect(client.retryFailedUnits("run-1")).resolves.toEqual(run);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it("PR12b-3: 202 応答に余分なキーがあると ApiResponseError（{ run } の .strict() が拒む）", async () => {
    const run = makeRunDto({ status: "stopped" });
    const client = createApiClient({
      fetch: fetchMock(jsonResponse(202, { run, extra: "余分な値" })) as unknown as typeof fetch,
    });

    await expect(client.stopRun("run-1")).rejects.toBeInstanceOf(ApiResponseError);
  });

  it("PR12b-4: getRunUnits / stopRun / resumeRun / retryFailedUnits / getRecovery / confirmRecovery それぞれで非 2xx は ApiRequestError になる", async () => {
    const errorResponse = () => errorJsonResponse(409, "run-not-active", "実行中ではありません");

    const getRunUnitsClient = createApiClient({
      fetch: fetchMock(errorResponse()) as unknown as typeof fetch,
    });
    await expect(getRunUnitsClient.getRunUnits("run-1")).rejects.toBeInstanceOf(ApiRequestError);

    const stopRunClient = createApiClient({
      fetch: fetchMock(errorResponse()) as unknown as typeof fetch,
    });
    await expect(stopRunClient.stopRun("run-1")).rejects.toBeInstanceOf(ApiRequestError);

    const resumeRunClient = createApiClient({
      fetch: fetchMock(errorResponse()) as unknown as typeof fetch,
    });
    await expect(resumeRunClient.resumeRun("run-1")).rejects.toBeInstanceOf(ApiRequestError);

    const retryFailedUnitsClient = createApiClient({
      fetch: fetchMock(errorResponse()) as unknown as typeof fetch,
    });
    await expect(retryFailedUnitsClient.retryFailedUnits("run-1")).rejects.toBeInstanceOf(
      ApiRequestError,
    );

    const getRecoveryClient = createApiClient({
      fetch: fetchMock(errorResponse()) as unknown as typeof fetch,
    });
    await expect(getRecoveryClient.getRecovery()).rejects.toBeInstanceOf(ApiRequestError);

    const confirmRecoveryClient = createApiClient({
      fetch: fetchMock(errorResponse()) as unknown as typeof fetch,
    });
    await expect(confirmRecoveryClient.confirmRecovery("run-1")).rejects.toBeInstanceOf(
      ApiRequestError,
    );
  });

  it("PR12b-5: subscribeRunEvents は runId・handlers・EventSource を events.ts の実装にそのまま委譲する", () => {
    const handlers: RunEventHandlers = {
      onOpen: () => {},
      onEvent: () => {},
      onUnknownEvent: () => {},
      onError: () => {},
    };
    const unsubscribe = () => {};
    const spy = vi.spyOn(eventsModule, "subscribeRunEvents").mockReturnValue(unsubscribe);
    class FakeEventSource {
      addEventListener(): void {}
      close(): void {}
      onopen = null;
      onerror = null;
      // 最終レビュー Important 1：`EventSourceLike` は `readyState` を要求する（0: CONNECTING）。
      readyState = 0;
    }

    const client = createApiClient({
      fetch: vi.fn() as unknown as typeof fetch,
      EventSource: FakeEventSource,
    });
    const result = client.subscribeRunEvents("run-1", handlers);

    expect(spy).toHaveBeenCalledWith("run-1", handlers, { EventSource: FakeEventSource });
    expect(result).toBe(unsubscribe);

    spy.mockRestore();
  });
});
