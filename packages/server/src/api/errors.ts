/**
 * API のエラー写像と、要求本文の読み取り・応答の送出（PR10 決定 4・3）。
 *
 * エラーの形は 1 つだけ（`{ error: { code, message } }`。`@shuten/shared` の `apiErrorSchema`）。
 * 写像はこのファイルの `handleApiError` にだけ書き、ハンドラー側では投げるだけにする。
 *
 * `message` には ID だけを入れる。**接続先 URL・API キー・原稿の断片を入れない**
 * （決定 4、不変条件）。500 のときサーバーのログには例外のクラス名とスタックを出すが、
 * `LmStudioError` の `message` は接続先を含みうるのでログにも出さない。
 */

import { InvalidChunkSettingsError, Utf8DecodeError } from "@shuten/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import { InvalidLmStudioUrlError } from "../config.ts";
import { MalformedBodyError } from "../db/errors.ts";
import { LmStudioError } from "../lmstudio/errors.ts";
import { RetryTargetError } from "../run/orchestrator.ts";

/** 500 の本文。例外の中身を一切転記しない定型文（決定 4）。 */
export const INTERNAL_ERROR_MESSAGE = "サーバー内部でエラーが発生しました";

/** 400 `invalid-json` の本文。要求本文の中身は転記しない。 */
export const INVALID_JSON_MESSAGE =
  "要求本文を JSON として読めません（Content-Type: application/json の JSON を送ってください）";

/**
 * API のエラー。`status` と `code` を持つだけの `Error`。
 *
 * 計画書の `constructor(readonly status, readonly code, message)` はパラメータプロパティで、
 * 規約の `erasableSyntaxOnly` が禁じているため、同じ公開形のまま明示のフィールドで書く。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** 404 `not-found`。`message` には対象の種類と ID だけを入れる。 */
export function notFound(what: string, id: string): ApiError {
  return new ApiError(404, "not-found", `${what}が見つかりません: ${id}`);
}

/**
 * zod の失敗を 400 `validation` の `message` に写す。**不正なパス名の列挙だけ**で、
 * 値も zod の既定メッセージも入れない（既定メッセージは受け取った値を含みうる）。
 */
function formatZodPaths(error: z.ZodError): string {
  const paths = error.issues.map((issue) =>
    issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join("."),
  );
  return `入力の検証に失敗しました: ${[...new Set(paths)].join(", ")}`;
}

/** 既知の例外 → 状態と `code` と `message`。未知なら null（呼び出し元が 500 にする）。 */
function mapKnownError(error: unknown): ApiError | null {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return new ApiError(400, "validation", formatZodPaths(error));
  }
  if (error instanceof MalformedBodyError) {
    return new ApiError(400, "malformed-body", error.message);
  }
  if (error instanceof Utf8DecodeError) {
    return new ApiError(400, "invalid-utf8", error.message);
  }
  if (error instanceof InvalidChunkSettingsError) {
    return new ApiError(400, "invalid-run-settings", error.message);
  }
  if (error instanceof RetryTargetError) {
    return new ApiError(400, "invalid-retry-target", error.message);
  }
  if (error instanceof InvalidLmStudioUrlError) {
    // 接続先 URL を含みうるので `message` は転記しない（決定 5・不変条件）。
    return new ApiError(400, "validation", "入力の検証に失敗しました: endpointUrl");
  }
  return null;
}

/**
 * 500 のログ。クラス名とスタックだけを出す。`LmStudioError` は `message` が接続先を含みうるので、
 * スタックの先頭行（`name: message`）を含む「フレーム行以外」を落として出す。
 */
function logInternalError(error: unknown): void {
  if (error instanceof LmStudioError) {
    const frames = (error.stack ?? "")
      .split("\n")
      .filter((line) => /^\s+at /.test(line))
      .join("\n");
    console.error(`API internal error: ${error.name}\n${frames}`);
    return;
  }
  if (error instanceof Error) {
    console.error(`API internal error: ${error.name}`, error.stack ?? "(no stack)");
    return;
  }
  console.error(`API internal error: ${typeof error}`);
}

/**
 * `app.onError` に渡す写像（決定 4）。既知の例外は表のとおりに、それ以外は 500 `internal`。
 *
 * `SyntaxError` はここでは写さない。JSON として読めない本文は `readJson` が読む場所で
 * `invalid-json` に写す（無関係な `SyntaxError` まで 400 にしないため）。
 */
export function handleApiError(error: unknown, c: Context): Response {
  const mapped = mapKnownError(error);
  if (mapped === null) {
    logInternalError(error);
    return c.json(
      { error: { code: "internal", message: INTERNAL_ERROR_MESSAGE } },
      { status: 500 },
    );
  }
  // `ApiError.status` は number（計画書の signature どおり）。Hono は本文付き応答の状態コードを
  // 型で絞るので、ここで 1 度だけ写す（この関数以外に状態コードを決める場所を作らないため）。
  return c.json(
    { error: { code: mapped.code, message: mapped.message } },
    { status: mapped.status as ContentfulStatusCode },
  );
}

/** `Content-Type` が `application/json`（媒体型のみを見る。パラメータは無視）か。 */
function isJsonContentType(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const mediaType = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json";
}

/**
 * JSON 本文を読む。決定 4 のとおり、ここで `invalid-json` に写す（500 にしない）。
 *
 * - `Content-Type` が `application/json` でない（省略を含む）→ 400 `invalid-json`。
 *   `c.req.json()` は `Content-Type` を見ないので、自前でヘッダーを見る。
 * - 本文が空：`optional` なら `{}`、そうでなければ 400 `invalid-json`。
 * - `JSON.parse` の `SyntaxError` → 400 `invalid-json`。
 *
 * `Content-Type` の検査は `optional` でも行う（本文の有無より先に、要求の形を見る）。
 */
export async function readJson(
  c: Context,
  options?: { readonly optional?: boolean },
): Promise<unknown> {
  if (!isJsonContentType(c.req.header("content-type"))) {
    throw new ApiError(400, "invalid-json", INVALID_JSON_MESSAGE);
  }

  const text = await c.req.text();
  if (text.trim() === "") {
    if (options?.optional === true) {
      return {};
    }
    throw new ApiError(400, "invalid-json", INVALID_JSON_MESSAGE);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ApiError(400, "invalid-json", INVALID_JSON_MESSAGE);
    }
    throw error;
  }
}

/**
 * 応答を送る唯一の入口（決定 3）。ハンドラーは `c.json` を直接呼ばない。
 *
 * スキーマに合わない値は射影漏れか DB 不整合なので、**そのまま流さずに** 500 `internal` にする。
 * 例外にも本文にも値の中身は入れない（`endpointUrl` を含む `RunRecord` をそのまま渡した場合に
 * 接続先が漏れないようにするため）。ログにも不正だったキーのパスだけを出す。
 */
export function respond<T>(
  c: Context,
  schema: z.ZodType<T>,
  value: T,
  status: 200 | 201 | 202 = 200,
): Response {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const paths = parsed.error.issues.map(
      (issue) =>
        `${issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join(".")}:${issue.code}`,
    );
    console.error(`API response validation failed: ${[...new Set(paths)].join(", ")}`);
    throw new ApiError(500, "internal", INTERNAL_ERROR_MESSAGE);
  }
  return c.json(parsed.data, { status });
}
