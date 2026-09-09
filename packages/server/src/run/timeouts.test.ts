/**
 * `validateHardTimeouts`（決定 44・PR10 決定 14）のテスト。4 つの違反分岐と正常を見る。
 */

import { describe, expect, it } from "vitest";

import { MAX_TIMEOUT_MS } from "../config.ts";
import { validateHardTimeouts } from "./timeouts.ts";

describe("run/timeouts: validateHardTimeouts（決定 44）", () => {
  it("H1: 1 以上の安全な整数で上限を超えなければ null", () => {
    expect(validateHardTimeouts({ checkMs: 60_000, recheckMs: 60_000 }, 120_000)).toBeNull();
    // 境界：加算した値がちょうど上限のときは通す。
    expect(
      validateHardTimeouts({ checkMs: MAX_TIMEOUT_MS - 1, recheckMs: MAX_TIMEOUT_MS - 1 }, 1),
    ).toBeNull();
  });

  it("H2: checkMs が 1 未満・非整数・安全でない整数なら checkMs のメッセージ", () => {
    const message =
      "タイムアウト設定が不正なため実行を開始できなかった（checkMs は 1 以上の整数である必要がある）";
    expect(validateHardTimeouts({ checkMs: 0, recheckMs: 1 }, 0)).toBe(message);
    expect(validateHardTimeouts({ checkMs: -1, recheckMs: 1 }, 0)).toBe(message);
    expect(validateHardTimeouts({ checkMs: 1.5, recheckMs: 1 }, 0)).toBe(message);
    expect(validateHardTimeouts({ checkMs: Number.NaN, recheckMs: 1 }, 0)).toBe(message);
    expect(validateHardTimeouts({ checkMs: Number.MAX_SAFE_INTEGER + 2, recheckMs: 1 }, 0)).toBe(
      message,
    );
  });

  it("H3: recheckMs が 1 未満・非整数なら recheckMs のメッセージ", () => {
    const message =
      "タイムアウト設定が不正なため実行を開始できなかった（recheckMs は 1 以上の整数である必要がある）";
    expect(validateHardTimeouts({ checkMs: 1, recheckMs: 0 }, 0)).toBe(message);
    expect(validateHardTimeouts({ checkMs: 1, recheckMs: 1.5 }, 0)).toBe(message);
  });

  it("H4: checkMs + recoveryConfirmMs が上限を超えたらそのメッセージ", () => {
    expect(validateHardTimeouts({ checkMs: MAX_TIMEOUT_MS, recheckMs: 1 }, 1)).toBe(
      "タイムアウト設定が不正なため実行を開始できなかった（checkMs + recoveryConfirmMs が上限を超えている）",
    );
  });

  it("H5: recheckMs + recoveryConfirmMs が上限を超えたらそのメッセージ（checkMs は上限内）", () => {
    expect(validateHardTimeouts({ checkMs: 1, recheckMs: MAX_TIMEOUT_MS }, 1)).toBe(
      "タイムアウト設定が不正なため実行を開始できなかった（recheckMs + recoveryConfirmMs が上限を超えている）",
    );
  });

  it("H6: メッセージに接続先 URL・API キーを含めない（定型文だけ）", () => {
    const message = validateHardTimeouts({ checkMs: 0, recheckMs: 0 }, 0);
    expect(message).not.toBeNull();
    expect(message).not.toMatch(/http/i);
  });
});
