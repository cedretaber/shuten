import { describe, expect, it } from "vitest";

import { parseCheckTruthArgs } from "./check-truth.ts";

describe("parseCheckTruthArgs", () => {
  it("必須2つが揃えば成功し、reportPath の既定は null", () => {
    const result = parseCheckTruthArgs(["--manuscript", "manuscript.txt", "--truth", "truth.json"]);
    expect(result).toEqual({
      ok: true,
      value: {
        manuscriptPath: "manuscript.txt",
        truthPath: "truth.json",
        reportPath: null,
      },
    });
  });

  it("--report を指定すると値が入る", () => {
    const result = parseCheckTruthArgs([
      "--manuscript",
      "manuscript.txt",
      "--truth",
      "truth.json",
      "--report",
      "report.md",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reportPath).toBe("report.md");
  });

  it("--manuscript だけ欠けるとメッセージに --manuscript だけ出る", () => {
    const result = parseCheckTruthArgs(["--truth", "truth.json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("必須オプションがありません: --manuscript");
  });

  it("--truth だけ欠けるとメッセージに --truth だけ出る", () => {
    const result = parseCheckTruthArgs(["--manuscript", "manuscript.txt"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("必須オプションがありません: --truth");
  });

  it("2つとも欠けると欠けている順にメッセージへ並ぶ", () => {
    const result = parseCheckTruthArgs([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("必須オプションがありません: --manuscript, --truth");
  });

  it("--out は未知のオプションとして拒否される", () => {
    const result = parseCheckTruthArgs([
      "--manuscript",
      "manuscript.txt",
      "--truth",
      "truth.json",
      "--out",
      "out.json",
    ]);
    expect(result.ok).toBe(false);
  });

  it("--result は未知のオプションとして拒否される", () => {
    const result = parseCheckTruthArgs([
      "--manuscript",
      "manuscript.txt",
      "--truth",
      "truth.json",
      "--result",
      "result.json",
    ]);
    expect(result.ok).toBe(false);
  });

  it("例外を投げない（エラー値で返す）", () => {
    expect(() => parseCheckTruthArgs([])).not.toThrow();
  });
});
