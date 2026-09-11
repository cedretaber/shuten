import { describe, expect, it } from "vitest";

import { parseEvaluateArgs } from "./evaluate.ts";

const REQUIRED = [
  "--manuscript",
  "manuscript.txt",
  "--truth",
  "truth.json",
  "--result",
  "result.json",
];

describe("parseEvaluateArgs", () => {
  it("必須オプションが揃っていれば解釈できる（--out・--report は省略時 null）", () => {
    const result = parseEvaluateArgs(REQUIRED);
    expect(result).toEqual({
      ok: true,
      value: {
        manuscriptPath: "manuscript.txt",
        truthPath: "truth.json",
        resultPath: "result.json",
        outPath: null,
        reportPath: null,
      },
    });
  });

  it("--out と --report を指定すると値が入る", () => {
    const result = parseEvaluateArgs([
      ...REQUIRED,
      "--out",
      "metrics.json",
      "--report",
      "report.md",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outPath).toBe("metrics.json");
    expect(result.value.reportPath).toBe("report.md");
  });

  it("--manuscript が無いとエラー", () => {
    const result = parseEvaluateArgs(["--truth", "truth.json", "--result", "result.json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--manuscript");
  });

  it("--truth が無いとエラー", () => {
    const result = parseEvaluateArgs(["--manuscript", "manuscript.txt", "--result", "result.json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--truth");
  });

  it("--result が無いとエラー", () => {
    const result = parseEvaluateArgs(["--manuscript", "manuscript.txt", "--truth", "truth.json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--result");
  });

  it("必須オプションがすべて無いとまとめてエラーになる", () => {
    const result = parseEvaluateArgs([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--manuscript");
    expect(result.error).toContain("--truth");
    expect(result.error).toContain("--result");
  });

  it("未知のオプションはエラー", () => {
    const result = parseEvaluateArgs([...REQUIRED, "--unknown", "x"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--unknown");
  });

  it("--result の重複はエラー（evaluate は 1 本だけ）", () => {
    const result = parseEvaluateArgs([...REQUIRED, "--result", "another.json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--result");
  });
});
