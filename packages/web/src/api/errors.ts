/**
 * API クライアントの例外 3 種類と、開始要求の結果が不明かどうかの判定（決定 14・15）。
 */

/** 非 2xx で本文が `apiErrorSchema` に合ったときの例外。合わないときは `code` を `"unknown"` にする。 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

/** 2xx だが本文が JSON でない、または応答スキーマに合わないときの例外。 */
export class ApiResponseError extends Error {
  constructor(message = "応答の形式が不正です", options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiResponseError";
  }
}

/** `fetch` 自体が throw した、または本文の読み取り中に切れたときの例外。 */
export class ApiTransportError extends Error {
  constructor(message = "サーバーとの通信に失敗しました", options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiTransportError";
  }
}

/** 非 2xx で本文が apiErrorSchema に合わないときの定型文。要求の中身を含めない（決定 18）。 */
export const GENERIC_REQUEST_ERROR = "サーバーへの要求が失敗しました";

/**
 * 開始要求（`startRun`）の結果が不明か（決定 15）。同じ `startOperationId` で再送してよいかの
 * 判定に使う。**例外を受け取ったときだけ呼ぶ**：成功時（有効な `RunDto` を受け取った、または
 * 4xx で本文を最後まで読めた）はこの述語を通さずに確定とする。
 *
 * 判定は決定 15 の表のとおり：
 * - `ApiTransportError`（fetch が throw した、または本文の読み取り中に切れた）→ 不明
 * - `ApiResponseError`（2xx だが契約違反）→ 不明
 * - `ApiRequestError` は 5xx なら不明、4xx なら確定（本文を最後まで読めているため）
 * - 素性の分からない例外は不明に倒す
 */
export function isStartOutcomeUnknown(error: unknown): boolean {
  if (error instanceof ApiTransportError) return true;
  if (error instanceof ApiResponseError) return true;
  if (error instanceof ApiRequestError) return error.status >= 500;
  return true; // 素性の分からない例外は「不明」に倒す
}
