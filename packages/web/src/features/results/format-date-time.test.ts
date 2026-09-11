import { describe, expect, it } from "vitest";
import { formatDateTime } from "./format-date-time.ts";

describe("formatDateTime", () => {
  it("offsetMinutes=0 なら Z 付きの ISO 文字列を UTC のまま整形する", () => {
    expect(formatDateTime("2026-09-11T10:40:57.000Z", 0)).toBe("2026-09-11 10:40:57");
  });

  it("オフセット付きの ISO 文字列は UTC に変換してから offsetMinutes を適用する", () => {
    // +09:00 の 19:40:57 は UTC の 10:40:57。offsetMinutes=0 なので UTC のまま整形される。
    expect(formatDateTime("2026-09-11T19:40:57+09:00", 0)).toBe("2026-09-11 10:40:57");
  });

  it("null はそのまま null を返す（offsetMinutes を渡しても変わらない）", () => {
    expect(formatDateTime(null, 540)).toBeNull();
    expect(formatDateTime(null, -300)).toBeNull();
  });

  it("offsetMinutes=+540（JST）で時刻をそのぶんシフトする", () => {
    // UTC 10:40:57 + 9h = 19:40:57（日付をまたがない基本ケース）。
    expect(formatDateTime("2026-09-11T10:40:57.000Z", 540)).toBe("2026-09-11 19:40:57");
  });

  it("offsetMinutes=+540（JST）で日付をまたぐ", () => {
    // UTC 9/11 23:00:00 + 9h = 9/12 08:00:00。
    expect(formatDateTime("2026-09-11T23:00:00.000Z", 540)).toBe("2026-09-12 08:00:00");
  });

  it("offsetMinutes=+540（JST）で月をまたぐ", () => {
    // UTC 9/30 23:00:00 + 9h = 10/1 08:00:00。
    expect(formatDateTime("2026-09-30T23:00:00.000Z", 540)).toBe("2026-10-01 08:00:00");
  });

  it("offsetMinutes=-300（西側のオフセット）で日付をまたぐ（前日側）", () => {
    // UTC 9/11 03:00:00 - 5h = 9/10 22:00:00。
    expect(formatDateTime("2026-09-11T03:00:00.000Z", -300)).toBe("2026-09-10 22:00:00");
  });

  it("offsetMinutes=-300 で年をまたぐ（前年側）", () => {
    // UTC 2026-01-01 03:00:00 - 5h = 2025-12-31 22:00:00。
    expect(formatDateTime("2026-01-01T03:00:00.000Z", -300)).toBe("2025-12-31 22:00:00");
  });
});
