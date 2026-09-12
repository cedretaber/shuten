import { describe, expect, it } from "vitest";

import {
  collectRawOptions,
  parseFiniteNumberOption,
  parseIntegerOption,
  parseRangedNumberOption,
} from "./common.ts";

describe("collectRawOptions", () => {
  const KNOWN = ["--a", "--b"] as const;

  it("既知のオプションを 1 要素の配列として集める", () => {
    const result = collectRawOptions(["--a", "1", "--b", "2"], { known: KNOWN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.get("--a")).toEqual(["1"]);
    expect(result.value.get("--b")).toEqual(["2"]);
  });

  it("未知のオプションを拒否する", () => {
    const result = collectRawOptions(["--c", "1"], { known: KNOWN });
    expect(result.ok).toBe(false);
  });

  it("未知のオプション名（-- 始まり）はメッセージに含める", () => {
    const result = collectRawOptions(["--c", "1"], { known: KNOWN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--c");
  });

  it("オプション名以外の引数は、値をメッセージに含めない", () => {
    // オプション名を付け忘れると値＝ファイルパスが渡ってくる。それを出すとパスが
    // 標準エラーに漏れる（決定 9。レビュー指摘）。
    const leakPath = "/private/leak-should-not-appear/manuscript.txt";
    const result = collectRawOptions([leakPath, "--a", "1"], { known: KNOWN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain(leakPath);
    expect(result.error).not.toContain("leak-should-not-appear");
  });

  it("値のないオプションを拒否する", () => {
    const result = collectRawOptions(["--a"], { known: KNOWN });
    expect(result.ok).toBe(false);
  });

  it("repeatable に無いオプションの重複を拒否する", () => {
    const result = collectRawOptions(["--a", "1", "--a", "2"], { known: KNOWN });
    expect(result.ok).toBe(false);
  });

  it("repeatable に指定したオプションは複数回指定でき、出現順に配列へ集まる", () => {
    const result = collectRawOptions(["--a", "1", "--a", "2", "--a", "3"], {
      known: KNOWN,
      repeatable: ["--a"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.get("--a")).toEqual(["1", "2", "3"]);
  });

  it("repeatable に 1 回だけ現れても配列で返す", () => {
    const result = collectRawOptions(["--a", "1"], { known: KNOWN, repeatable: ["--a"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.get("--a")).toEqual(["1"]);
  });

  it("repeatable 指定があっても他の既知オプションは今までどおり重複でエラーになる", () => {
    const result = collectRawOptions(["--b", "1", "--b", "2"], {
      known: KNOWN,
      repeatable: ["--a"],
    });
    expect(result.ok).toBe(false);
  });

  it("例外を投げない（エラー値で返す）", () => {
    expect(() => collectRawOptions([], { known: KNOWN })).not.toThrow();
  });
});

describe("parseIntegerOption", () => {
  it("十進の整数を受け付ける", () => {
    expect(parseIntegerOption("42", "--n", 0, 100)).toEqual({ ok: true, value: 42 });
  });

  it("範囲外を拒否する", () => {
    expect(parseIntegerOption("101", "--n", 0, 100).ok).toBe(false);
  });

  it("整数でない表記を拒否する", () => {
    expect(parseIntegerOption("1.5", "--n", 0, 100).ok).toBe(false);
  });
});

describe("parseFiniteNumberOption / parseRangedNumberOption", () => {
  it("小数を受け付ける", () => {
    expect(parseFiniteNumberOption("1.5", "--x")).toEqual({ ok: true, value: 1.5 });
  });

  it("指数表記を拒否する", () => {
    expect(parseFiniteNumberOption("1e1", "--x").ok).toBe(false);
  });

  it("範囲チェックが上限を含む/含まないの両方で働く", () => {
    expect(parseRangedNumberOption("1", "--x", 0, 1, true).ok).toBe(true);
    expect(parseRangedNumberOption("1", "--x", 0, 1, false).ok).toBe(false);
  });
});
