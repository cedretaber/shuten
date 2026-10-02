/**
 * 朱筆化（PR14c）の約束を CSS の文字列から確かめる。jsdom は CSS を描かないので、
 * 見た目そのものは実ブラウザで確かめ、ここでは「値の置き場所」と「比」だけを見る。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(import.meta.dirname, "..");
const TOKENS = join(import.meta.dirname, "tokens.css");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

function tokens(): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of readFileSync(TOKENS, "utf8").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1] as string, (m[2] as string).trim());
  }
  return map;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("色の変数のコントラスト比", () => {
  const t = tokens();
  const v = (name: string): string => {
    const value = t.get(name);
    if (value === undefined) throw new Error(`${name} がない`);
    return value;
  };

  test.each([
    // [前景, 背景, 基準]
    ["--color-accent", "--color-bg", 4.5],
    ["--color-accent", "--color-bg-muted", 4.5],
    ["--color-accent", "--color-accent-bg", 4.5],
    ["--color-bg", "--color-accent", 4.5],
    ["--color-fg", "--color-accent-bg", 4.5],
    ["--color-fg-muted", "--color-accent-bg", 4.5],
    ["--color-danger", "--color-bg", 4.5],
    ["--color-danger", "--color-danger-bg", 4.5],
    ["--color-fg", "--color-notice-bg", 4.5],
    ["--color-fg-muted", "--color-notice-bg", 4.5],
    ["--color-fg-muted", "--color-bg", 4.5],
    ["--color-fg-muted", "--color-bg-muted", 4.5],
    ["--color-accent-line", "--color-bg", 3],
    ["--color-accent-line", "--color-bg-muted", 3],
    ["--color-accent-line", "--color-accent-bg", 3],
    ["--color-notice-border", "--color-notice-bg", 3],
  ] as const)("%s on %s ≥ %d", (fg, bg, min) => {
    expect(contrast(v(fg), v(bg))).toBeGreaterThanOrEqual(min);
  });
});

describe("CSS の書き方", () => {
  const files = cssFiles(SRC);
  const defined = new Set(tokens().keys());

  test.each(files.map((f) => [relative(SRC, f), f]))("%s", (_name, file) => {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    if (file !== TOKENS) {
      // 色の値は tokens.css にだけ書く。
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      // 角丸は変数で書く（0 は除く）。
      expect(css).not.toMatch(/border-radius:\s*[1-9]/);
    }
    // composes はテストと本番でクラス名が変わるので使わない。
    expect(css).not.toMatch(/\bcomposes\s*:/);
    // 使っている変数はすべて tokens.css で定義されている。
    for (const m of css.matchAll(/var\((--[\w-]+)/g)) {
      expect(defined, `${m[1]} が tokens.css にない`).toContain(m[1]);
    }
  });
});
