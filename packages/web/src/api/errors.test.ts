import { describe, expect, it } from "vitest";
import {
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
  GENERIC_REQUEST_ERROR,
  isStartOutcomeUnknown,
} from "./errors.ts";

describe("ApiRequestError", () => {
  it("W2-1: status・code・message を保持し、Error のインスタンスになる", () => {
    const error = new ApiRequestError(404, "not-found", "見つかりません: abc");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.status).toBe(404);
    expect(error.code).toBe("not-found");
    expect(error.message).toBe("見つかりません: abc");
    expect(error.name).toBe("ApiRequestError");
  });
});

describe("ApiResponseError", () => {
  it("W2-2: 既定のメッセージを持ち、cause を保持できる", () => {
    const cause = new Error("zod failed");
    const error = new ApiResponseError(undefined, { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect(error.name).toBe("ApiResponseError");
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.cause).toBe(cause);
  });
});

describe("ApiTransportError", () => {
  it("W2-3: 既定のメッセージを持ち、cause を保持できる", () => {
    const cause = new Error("network down");
    const error = new ApiTransportError(undefined, { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiTransportError);
    expect(error.name).toBe("ApiTransportError");
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.cause).toBe(cause);
  });
});

describe("GENERIC_REQUEST_ERROR", () => {
  it("W2-4: 空でない定型文の文字列である（要求本文の中身は含めない）", () => {
    expect(typeof GENERIC_REQUEST_ERROR).toBe("string");
    expect(GENERIC_REQUEST_ERROR.length).toBeGreaterThan(0);
  });
});

describe("isStartOutcomeUnknown", () => {
  it("W2-5: ApiTransportError は不明（true）", () => {
    expect(isStartOutcomeUnknown(new ApiTransportError())).toBe(true);
  });

  it("W2-6: ApiResponseError は不明（true）", () => {
    expect(isStartOutcomeUnknown(new ApiResponseError())).toBe(true);
  });

  it("W2-7: ApiRequestError は 5xx なら不明（true）、4xx なら確定（false）", () => {
    expect(isStartOutcomeUnknown(new ApiRequestError(500, "unknown", GENERIC_REQUEST_ERROR))).toBe(
      true,
    );
    expect(isStartOutcomeUnknown(new ApiRequestError(503, "unknown", GENERIC_REQUEST_ERROR))).toBe(
      true,
    );
    expect(
      isStartOutcomeUnknown(new ApiRequestError(400, "validation", "入力の検証に失敗しました")),
    ).toBe(false);
    expect(isStartOutcomeUnknown(new ApiRequestError(404, "not-found", "見つかりません"))).toBe(
      false,
    );
  });

  it("W2-8: 素性の分からない例外は不明（true）に倒す", () => {
    expect(isStartOutcomeUnknown(new Error("何か"))).toBe(true);
    expect(isStartOutcomeUnknown("boom")).toBe(true);
    expect(isStartOutcomeUnknown(undefined)).toBe(true);
  });
});
