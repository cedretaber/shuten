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
        input: { kind: "result", resultPath: "result.json", manuscriptPath: "manuscript.txt" },
        truthPath: "truth.json",
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

  it("--manuscript が無いとエラー（--result だけを使うときは必須。決定29）", () => {
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

  it("--result も --export も無いとエラー", () => {
    const result = parseEvaluateArgs(["--manuscript", "manuscript.txt", "--truth", "truth.json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--result");
    expect(result.error).toContain("--export");
  });

  it("必須オプションがすべて無いと --truth 不足のエラーになる（--truth が唯一常に必須のため）", () => {
    const result = parseEvaluateArgs([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--truth");
  });

  it("未知のオプションはエラー", () => {
    const result = parseEvaluateArgs([...REQUIRED, "--unknown", "x"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 受け取ったトークンは出さない（オプション名を付け忘れて渡された値かもしれず、
    // この位置では区別できないため。`args/common.ts` の `collectRawOptions`）。
    expect(result.error).not.toContain("--unknown");
    expect(result.error).toContain("使えないオプション");
  });

  it("--result の重複はエラー（evaluate は 1 本だけ）", () => {
    const result = parseEvaluateArgs([...REQUIRED, "--result", "another.json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--result");
  });

  // --- 決定29：--export の配線（Task 11） ------------------------------------------------------

  it("--export だけを指定すると解釈できる（--manuscript は不要）", () => {
    const result = parseEvaluateArgs(["--truth", "truth.json", "--export", "export.json"]);
    expect(result).toEqual({
      ok: true,
      value: {
        input: { kind: "export", exportPath: "export.json" },
        truthPath: "truth.json",
        outPath: null,
        reportPath: null,
      },
    });
  });

  it("--result と --export の両方を指定するとエラー", () => {
    const result = parseEvaluateArgs([
      "--truth",
      "truth.json",
      "--result",
      "result.json",
      "--export",
      "export.json",
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("--result と --export は同時に指定できません");
  });

  it("--result も --export も無いと「どちらかを指定してください」エラーになる", () => {
    const result = parseEvaluateArgs(["--truth", "truth.json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("--result か --export のどちらかを指定してください");
  });

  it("--export と --manuscript を併用するとエラー（本文はエクスポートに含まれるため）", () => {
    const result = parseEvaluateArgs([
      "--manuscript",
      "manuscript.txt",
      "--truth",
      "truth.json",
      "--export",
      "export.json",
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      "--export を指定したときは --manuscript を指定できません（本文はエクスポートに含まれます）",
    );
  });

  it("--result を使うのに --manuscript が無いとエラー", () => {
    const result = parseEvaluateArgs(["--truth", "truth.json", "--result", "result.json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("--manuscript がありません（--result だけを使うときは必要です）");
  });

  it("--export の重複はエラー（evaluate は 1 本だけ。--result と同じ扱い）", () => {
    const result = parseEvaluateArgs([
      "--truth",
      "truth.json",
      "--export",
      "export.json",
      "--export",
      "another.json",
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--export");
  });
});
