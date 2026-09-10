import { describe, expect, it } from "vitest";
import {
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
  GENERIC_REQUEST_ERROR,
  isStartOutcomeUnknown,
} from "./errors.ts";

/**
 * 計画書（`docs/plans/2026-09-10-pr11-web-shell.md`）の W2 節（例外の分類と解析順）のうち、
 * W2-8（`isStartOutcomeUnknown` の真理値表）だけをここに置く。W2-1〜7 は「本文の読み取り・
 * `JSON.parse`・状態コードによる分岐」という `client.ts` の応答処理そのものを検証する項目で、
 * 実際の `Response`（または本文の読み取りが失敗する fake）と `fetch` 経由の呼び出しが要るため、
 * `api/errors.ts` の単体テストでは再現できない。`client.test.ts` に同じ番号のコメント付きで置く。
 */

describe("ApiRequestError（基礎的な形の確認。計画書の番号には無い）", () => {
  it("status・code・message を保持し、Error のインスタンスになる", () => {
    const error = new ApiRequestError(404, "not-found", "見つかりません: abc");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.status).toBe(404);
    expect(error.code).toBe("not-found");
    expect(error.message).toBe("見つかりません: abc");
    expect(error.name).toBe("ApiRequestError");
  });
});

describe("ApiResponseError（基礎的な形の確認。計画書の番号には無い）", () => {
  it("既定のメッセージを持ち、cause を保持できる", () => {
    const cause = new Error("zod failed");
    const error = new ApiResponseError(undefined, { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect(error.name).toBe("ApiResponseError");
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.cause).toBe(cause);
  });
});

describe("ApiTransportError（基礎的な形の確認。計画書の番号には無い）", () => {
  it("既定のメッセージを持ち、cause を保持できる", () => {
    const cause = new Error("network down");
    const error = new ApiTransportError(undefined, { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiTransportError);
    expect(error.name).toBe("ApiTransportError");
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.cause).toBe(cause);
  });
});

describe("GENERIC_REQUEST_ERROR（基礎的な形の確認。計画書の番号には無い）", () => {
  it("空でない定型文の文字列である（要求本文の中身は含めない）", () => {
    expect(typeof GENERIC_REQUEST_ERROR).toBe("string");
    expect(GENERIC_REQUEST_ERROR.length).toBeGreaterThan(0);
  });
});

describe("isStartOutcomeUnknown", () => {
  it("W2-8: 真理値表のとおり（4xx は code に関わらず false、5xx・ApiResponseError・ApiTransportError・素性不明は true）", () => {
    // 4xx（code 既知）＝ false。本文を最後まで読めており、サーバーが要求を受け取って断ったことは確定している。
    expect(
      isStartOutcomeUnknown(new ApiRequestError(400, "validation", "入力の検証に失敗しました")),
    ).toBe(false);
    expect(isStartOutcomeUnknown(new ApiRequestError(404, "not-found", "見つかりません"))).toBe(
      false,
    );

    // 4xx（code: "unknown"。本文が apiErrorSchema に合わない HTML 等）＝ false。
    // code が "unknown" というだけでは「不明」に倒さないことを明示する（誤って
    // `error.code === "unknown"` を見る実装に変えても、この行が無いと検出できない）。
    expect(isStartOutcomeUnknown(new ApiRequestError(400, "unknown", GENERIC_REQUEST_ERROR))).toBe(
      false,
    );

    // 5xx ＝ true（code の有無に関わらず。サーバーが実行を作った後に落ちた可能性があるため）。
    expect(isStartOutcomeUnknown(new ApiRequestError(500, "unknown", GENERIC_REQUEST_ERROR))).toBe(
      true,
    );
    expect(isStartOutcomeUnknown(new ApiRequestError(503, "unknown", GENERIC_REQUEST_ERROR))).toBe(
      true,
    );

    // 2xx だが契約違反 ＝ true。
    expect(isStartOutcomeUnknown(new ApiResponseError())).toBe(true);

    // 通信の失敗（fetch が throw、または本文の読み取り中に切れた）＝ true。
    expect(isStartOutcomeUnknown(new ApiTransportError())).toBe(true);

    // 素性の分からない例外は不明（true）に倒す。
    expect(isStartOutcomeUnknown(new Error("何か"))).toBe(true);
    expect(isStartOutcomeUnknown("boom")).toBe(true);
    expect(isStartOutcomeUnknown(undefined)).toBe(true);
  });
});
