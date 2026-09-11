import { describe, expect, it } from "vitest";

import { parseAggregateArgs } from "./aggregate.ts";

const REQUIRED = [
  "--manuscript",
  "manuscript.txt",
  "--truth",
  "truth.json",
  "--result",
  "a.json",
  "--result",
  "b.json",
];

describe("parseAggregateArgs", () => {
  it("必須オプションが揃い --result が2本以上あれば解釈できる（--out・--report は省略時 null）", () => {
    const result = parseAggregateArgs(REQUIRED);
    expect(result).toEqual({
      ok: true,
      value: {
        manuscriptPath: "manuscript.txt",
        truthPath: "truth.json",
        resultPaths: ["a.json", "b.json"],
        outPath: null,
        reportPath: null,
      },
    });
  });

  it("--result を3本以上指定できる", () => {
    const result = parseAggregateArgs([...REQUIRED, "--result", "c.json"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resultPaths).toEqual(["a.json", "b.json", "c.json"]);
  });

  it("--out と --report を指定すると値が入る", () => {
    const result = parseAggregateArgs([
      ...REQUIRED,
      "--out",
      "aggregate.json",
      "--report",
      "report.md",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outPath).toBe("aggregate.json");
    expect(result.value.reportPath).toBe("report.md");
  });

  it("--manuscript が無いとエラー", () => {
    const result = parseAggregateArgs([
      "--truth",
      "truth.json",
      "--result",
      "a.json",
      "--result",
      "b.json",
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--manuscript");
  });

  it("--truth が無いとエラー", () => {
    const result = parseAggregateArgs([
      "--manuscript",
      "manuscript.txt",
      "--result",
      "a.json",
      "--result",
      "b.json",
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--truth");
  });

  it("--result が無いとエラー", () => {
    const result = parseAggregateArgs(["--manuscript", "manuscript.txt", "--truth", "truth.json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--result");
  });

  it("--result が1本だけならエラー（ぶれを測れないため。決定12）", () => {
    const result = parseAggregateArgs([
      "--manuscript",
      "manuscript.txt",
      "--truth",
      "truth.json",
      "--result",
      "a.json",
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--result");
  });

  it("必須オプションがすべて無いとまとめてエラーになる", () => {
    const result = parseAggregateArgs([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--manuscript");
    expect(result.error).toContain("--truth");
    expect(result.error).toContain("--result");
  });

  it("未知のオプションはエラー", () => {
    const result = parseAggregateArgs([...REQUIRED, "--unknown", "x"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--unknown");
  });
});
