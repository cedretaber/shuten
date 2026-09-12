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
        exportPaths: [],
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

  it("--result が無いとエラー（入力が合計2本に満たない）", () => {
    const result = parseAggregateArgs(["--manuscript", "manuscript.txt", "--truth", "truth.json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--result");
    expect(result.error).toContain("--export");
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

  it("必須オプションがすべて無いと --truth 不足のエラーになる（--truth が唯一常に必須のため）", () => {
    const result = parseAggregateArgs([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--truth");
  });

  it("未知のオプションはエラー", () => {
    const result = parseAggregateArgs([...REQUIRED, "--unknown", "x"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--unknown");
  });

  // --- 決定29：--export の配線（Task 11） ------------------------------------------------------

  it("--result 1本 ＋ --export 1本なら通る（合計2本以上。--manuscript は不要）", () => {
    const result = parseAggregateArgs([
      "--truth",
      "truth.json",
      "--result",
      "a.json",
      "--export",
      "export.json",
    ]);
    expect(result).toEqual({
      ok: true,
      value: {
        manuscriptPath: null,
        truthPath: "truth.json",
        resultPaths: ["a.json"],
        exportPaths: ["export.json"],
        outPath: null,
        reportPath: null,
      },
    });
  });

  it("--export だけを2本渡しても通る（--manuscript は不要）", () => {
    const result = parseAggregateArgs([
      "--truth",
      "truth.json",
      "--export",
      "a.json",
      "--export",
      "b.json",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exportPaths).toEqual(["a.json", "b.json"]);
    expect(result.value.manuscriptPath).toBeNull();
  });

  it("入力（--result / --export）が合計1本ならエラー（決定12）", () => {
    const result = parseAggregateArgs(["--truth", "truth.json", "--export", "export.json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      "入力（--result / --export）は合計 2 本以上指定してください" +
        "（1 本では複数回実行のぶれを測れません。決定12）",
    );
  });

  it("--export を指定したときに --manuscript も指定するとエラー", () => {
    const result = parseAggregateArgs([
      "--manuscript",
      "manuscript.txt",
      "--truth",
      "truth.json",
      "--export",
      "a.json",
      "--export",
      "b.json",
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      "--export を指定したときは --manuscript を指定できません（本文はエクスポートに含まれます）",
    );
  });

  it("--export が無く --manuscript も無いとエラー", () => {
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
    expect(result.error).toBe("--manuscript がありません（--result だけを使うときは必要です）");
  });
});
