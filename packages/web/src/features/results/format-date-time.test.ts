import { describe, expect, it } from "vitest";
import { formatDateTime } from "./format-date-time.ts";

describe("formatDateTime", () => {
  it("Z 付きの ISO 文字列を UTC のまま整形する", () => {
    expect(formatDateTime("2026-09-11T10:40:57.000Z")).toBe("2026-09-11 10:40:57");
  });

  it("オフセット付きの ISO 文字列は UTC に変換してから整形する", () => {
    // +09:00 の 19:40:57 は UTC の 10:40:57。
    expect(formatDateTime("2026-09-11T19:40:57+09:00")).toBe("2026-09-11 10:40:57");
  });

  it("null はそのまま null を返す", () => {
    expect(formatDateTime(null)).toBeNull();
  });
});
