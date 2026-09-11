/**
 * `fetch` を注入できる薄い API クライアント（決定 14）。
 *
 * PR11・PR12a が呼ぶ口を持つ（実行の一覧・開始・詳細、原稿、接続設定、指摘の一覧・詳細・採否）。
 * 停止・再開・再試行・復旧確認・SSE は PR12b が担当。
 * 応答は `@shuten/shared` の zod スキーマで検証し、型注釈と実際の JSON のずれを実行時に検知する。
 */

import {
  apiErrorSchema,
  type ConnectionCheckDto,
  type ConnectionCheckRequest,
  type ConnectionSettingsDto,
  type CreateManuscriptRequest,
  connectionCheckDtoSchema,
  connectionSettingsDtoSchema,
  type FindingDetailDto,
  type FindingDto,
  findingDetailDtoSchema,
  findingDtoSchema,
  type JudgmentDto,
  judgmentDtoSchema,
  type ManuscriptVersionDto,
  manuscriptVersionDtoSchema,
  type PutConnectionRequest,
  type PutJudgmentRequest,
  type RunDetailDto,
  type RunDto,
  type RunSummaryDto,
  runDetailDtoSchema,
  runDtoSchema,
  runSummaryDtoSchema,
  type StartRunRequest,
} from "@shuten/shared";
import { z } from "zod";

import {
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
  GENERIC_REQUEST_ERROR,
} from "./errors.ts";

export interface ApiClient {
  getConnection(): Promise<ConnectionSettingsDto>;
  putConnection(body: PutConnectionRequest): Promise<ConnectionSettingsDto>;
  checkConnection(
    modelId?: string,
    options?: { signal?: AbortSignal },
  ): Promise<ConnectionCheckDto>;
  createManuscript(body: CreateManuscriptRequest): Promise<ManuscriptVersionDto>;
  uploadManuscript(input: { file: File; name: string }): Promise<ManuscriptVersionDto>;
  getManuscript(id: string, options?: { signal?: AbortSignal }): Promise<ManuscriptVersionDto>;
  startRun(body: StartRunRequest): Promise<RunDto>;
  getRun(id: string, options?: { signal?: AbortSignal }): Promise<RunDetailDto>;
  getRuns(options?: { signal?: AbortSignal }): Promise<RunSummaryDto[]>;
  getFindings(runId: string, options?: { signal?: AbortSignal }): Promise<FindingDto[]>;
  getFinding(findingId: string, options?: { signal?: AbortSignal }): Promise<FindingDetailDto>;
  putJudgment(findingId: string, body: PutJudgmentRequest): Promise<JudgmentDto>;
}

/** zod スキーマの構造的な最小形。スキーマの実装（バージョンや具体の型）に縛られずに受け取るための型。 */
interface ResponseSchema<T> {
  parse(data: unknown): T;
}

/** 本文を `text()` で 1 回だけ読む。読み取り中に切れたら `ApiTransportError`（決定 14）。 */
async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (cause) {
    throw new ApiTransportError("応答本文の読み取り中に通信が切断されました", { cause });
  }
}

/**
 * `fetch` を呼び、本文の読み取り → JSON の解析 → 状態コードによる分岐、の順で応答を扱う
 * （決定 14 のコードそのまま）。`JSON.parse` の失敗はその場で投げない。
 */
async function request<T>(
  fetchImpl: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
  responseSchema: ResponseSchema<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(input, init);
  } catch (cause) {
    throw new ApiTransportError("サーバーとの通信に失敗しました", { cause });
  }

  const text = await readResponseText(response); // 読み取りに失敗したら ApiTransportError

  let json: unknown;
  let parsedAsJson = true;
  try {
    json = JSON.parse(text);
  } catch {
    parsedAsJson = false; // ここでは投げない
  }

  if (!response.ok) {
    const parsedError = parsedAsJson ? apiErrorSchema.safeParse(json) : null;
    if (parsedError?.success) {
      throw new ApiRequestError(
        response.status,
        parsedError.data.error.code,
        parsedError.data.error.message,
      );
    }
    // 非 2xx で本文が JSON でない、または apiErrorSchema に合わない
    throw new ApiRequestError(response.status, "unknown", GENERIC_REQUEST_ERROR);
  }

  if (!parsedAsJson) {
    throw new ApiResponseError(); // 2xx なのに JSON でない
  }

  try {
    return responseSchema.parse(json); // zod の失敗も ApiResponseError に写す
  } catch (cause) {
    throw new ApiResponseError("応答がスキーマに一致しません", { cause });
  }
}

const JSON_HEADERS: HeadersInit = { "content-type": "application/json" };

/** `GET /api/runs` の応答。配列の包みだけここで作る（スキーマ本体は `@shuten/shared`）。 */
const runSummaryListSchema = z.array(runSummaryDtoSchema);

/** `GET /api/runs/:id/findings` の応答。 */
const findingListSchema = z.array(findingDtoSchema);

/** `options?.signal` が指定されたときだけ `init` に足す（`exactOptionalPropertyTypes` 対策）。 */
function withSignal(init: RequestInit, signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? init : { ...init, signal };
}

export function createApiClient(deps?: { fetch?: typeof globalThis.fetch }): ApiClient {
  const fetchImpl = deps?.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    getConnection() {
      return request(
        fetchImpl,
        "/api/settings/connection",
        { method: "GET" },
        connectionSettingsDtoSchema,
      );
    },

    putConnection(body) {
      return request(
        fetchImpl,
        "/api/settings/connection",
        { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) },
        connectionSettingsDtoSchema,
      );
    },

    checkConnection(modelId, options) {
      const body: ConnectionCheckRequest = modelId === undefined ? {} : { modelId };
      return request(
        fetchImpl,
        "/api/settings/connection/check",
        withSignal(
          { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) },
          options?.signal,
        ),
        connectionCheckDtoSchema,
      );
    },

    createManuscript(body) {
      return request(
        fetchImpl,
        "/api/manuscripts",
        { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) },
        manuscriptVersionDtoSchema,
      );
    },

    uploadManuscript({ file, name }) {
      // Content-Type は指定しない：ブラウザが multipart の boundary を付ける（自分で書くと壊れる）。
      const form = new FormData();
      form.set("file", file);
      form.set("name", name);
      return request(
        fetchImpl,
        "/api/manuscripts/upload",
        { method: "POST", body: form },
        manuscriptVersionDtoSchema,
      );
    },

    getManuscript(id, options) {
      return request(
        fetchImpl,
        `/api/manuscripts/${encodeURIComponent(id)}`,
        withSignal({ method: "GET" }, options?.signal),
        manuscriptVersionDtoSchema,
      );
    },

    startRun(body) {
      return request(
        fetchImpl,
        "/api/runs",
        { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) },
        runDtoSchema,
      );
    },

    getRun(id, options) {
      return request(
        fetchImpl,
        `/api/runs/${encodeURIComponent(id)}`,
        withSignal({ method: "GET" }, options?.signal),
        runDetailDtoSchema,
      );
    },

    getRuns(options) {
      return request(
        fetchImpl,
        "/api/runs",
        withSignal({ method: "GET" }, options?.signal),
        runSummaryListSchema,
      );
    },

    getFindings(runId, options) {
      return request(
        fetchImpl,
        `/api/runs/${encodeURIComponent(runId)}/findings`,
        withSignal({ method: "GET" }, options?.signal),
        findingListSchema,
      );
    },

    getFinding(findingId, options) {
      return request(
        fetchImpl,
        `/api/findings/${encodeURIComponent(findingId)}`,
        withSignal({ method: "GET" }, options?.signal),
        findingDetailDtoSchema,
      );
    },

    putJudgment(findingId, body) {
      return request(
        fetchImpl,
        `/api/findings/${encodeURIComponent(findingId)}/judgment`,
        { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) },
        judgmentDtoSchema,
      );
    },
  };
}
