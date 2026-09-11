import { describe, expect, it } from "vitest";

import type { TruthEntry, TruthFile } from "./truth.ts";
import { parseTruthFile, resolveTruthEntries } from "./truth.ts";

// すべて合成のテキスト（実原稿の断片を含まない）。

const VALID_HASH = "a".repeat(64);

/** 検証を通る正解ファイルの JSON（各テストで独立に組み立てる。使い回して汚染しない）。 */
function validTruthJson(): unknown {
  return {
    formatVersion: "1",
    manuscript: { name: "テスト原稿", bodyHash: VALID_HASH },
    entries: [
      {
        id: "e001",
        kind: "error",
        perspective: "typo",
        paragraphId: 0,
        quote: "本文",
        occurrence: 1,
        expected: "修正案",
        note: "メモ",
      },
      {
        id: "n001",
        kind: "normal",
        paragraphId: 0,
        quote: "本文",
        occurrence: 1,
        note: "メモ",
      },
    ],
  };
}

describe("parseTruthFile", () => {
  describe("正常系", () => {
    it("すべての項目が揃った正解ファイルを検証できる", () => {
      const result = parseTruthFile(validTruthJson());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.entries).toHaveLength(2);
      const [errorEntry, normalEntry] = result.value.entries;
      expect(errorEntry).toEqual({
        kind: "error",
        id: "e001",
        perspective: "typo",
        paragraphId: 0,
        quote: "本文",
        occurrence: 1,
        expected: "修正案",
        note: "メモ",
      });
      expect(normalEntry).toEqual({
        kind: "normal",
        id: "n001",
        paragraphId: 0,
        quote: "本文",
        occurrence: 1,
        note: "メモ",
      });
      // normal は perspective を持たない（決定 2）。
      expect(normalEntry).not.toHaveProperty("perspective");
    });

    it("occurrence・expected・note の省略時は occurrence: 1、expected/note: null に正規化する", () => {
      const json = {
        formatVersion: "1",
        manuscript: { name: "テスト原稿", bodyHash: VALID_HASH },
        entries: [
          { id: "e001", kind: "error", perspective: "typo", paragraphId: 0, quote: "本文" },
        ],
      };
      const result = parseTruthFile(json);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const entry = result.value.entries[0];
      expect(entry).toEqual({
        kind: "error",
        id: "e001",
        perspective: "typo",
        paragraphId: 0,
        quote: "本文",
        occurrence: 1,
        expected: null,
        note: null,
      });
    });
  });

  // 決定 2 の値域の表を 1 項目ずつ確認する。
  describe("値域（決定 2 の表）", () => {
    it('formatVersion が "2" なら拒否する', () => {
      const json = validTruthJson() as Record<string, unknown>;
      json.formatVersion = "2";
      const result = parseTruthFile(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.includes("formatVersion"))).toBe(true);
      // 値そのものは出さない。
      expect(result.errors.join(" ")).not.toContain('"2"');
    });

    it("bodyHash が大文字を含むなら拒否する", () => {
      const json = validTruthJson() as { manuscript: { bodyHash: string } };
      json.manuscript.bodyHash = "A".repeat(64);
      const result = parseTruthFile(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.includes("bodyHash"))).toBe(true);
      expect(result.errors.join(" ")).not.toContain("A".repeat(64));
    });

    it("bodyHash が 63 文字（切り詰め）なら拒否する", () => {
      const json = validTruthJson() as { manuscript: { bodyHash: string } };
      json.manuscript.bodyHash = "a".repeat(63);
      const result = parseTruthFile(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.includes("bodyHash"))).toBe(true);
    });

    it("id が空文字なら拒否する", () => {
      const json = validTruthJson() as { entries: Array<Record<string, unknown>> };
      const first = json.entries[0];
      if (first === undefined) throw new Error("fixture broken");
      first.id = "";
      const result = parseTruthFile(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.includes("entries.0.id"))).toBe(true);
    });

    it("id が重複するなら拒否する", () => {
      const json = validTruthJson() as { entries: Array<Record<string, unknown>> };
      const second = json.entries[1];
      if (second === undefined) throw new Error("fixture broken");
      second.id = "e001"; // 1 件目と同じ id にする
      const result = parseTruthFile(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.includes("重複"))).toBe(true);
    });

    it("paragraphId が -1 なら拒否する", () => {
      const json = validTruthJson() as { entries: Array<Record<string, unknown>> };
      const first = json.entries[0];
      if (first === undefined) throw new Error("fixture broken");
      first.paragraphId = -1;
      const result = parseTruthFile(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.includes("paragraphId"))).toBe(true);
      // 段落 ID が 0 起点で空行も 1 段落であることを文言に含める。
      expect(result.errors.some((e) => e.includes("0 起点"))).toBe(true);
    });

    it("paragraphId が 1.5（小数）なら拒否する", () => {
      const json = validTruthJson() as { entries: Array<Record<string, unknown>> };
      const first = json.entries[0];
      if (first === undefined) throw new Error("fixture broken");
      first.paragraphId = 1.5;
      const result = parseTruthFile(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.includes("paragraphId"))).toBe(true);
      expect(result.errors.some((e) => e.includes("0 起点"))).toBe(true);
      expect(result.errors.join(" ")).not.toContain("1.5");
    });

    it("paragraphId が安全な整数の範囲を超える（1e21）なら拒否する", () => {
      const json = validTruthJson() as { entries: Array<Record<string, unknown>> };
      const first = json.entries[0];
      if (first === undefined) throw new Error("fixture broken");
      first.paragraphId = 1e21;
      const result = parseTruthFile(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.includes("paragraphId"))).toBe(true);
    });

    it("occurrence が 0 なら拒否する", () => {
      const json = validTruthJson() as { entries: Array<Record<string, unknown>> };
      const first = json.entries[0];
      if (first === undefined) throw new Error("fixture broken");
      first.occurrence = 0;
      const result = parseTruthFile(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.includes("occurrence"))).toBe(true);
    });

    it("occurrence が安全な整数の範囲を超える（1e21）なら拒否する", () => {
      const json = validTruthJson() as { entries: Array<Record<string, unknown>> };
      const first = json.entries[0];
      if (first === undefined) throw new Error("fixture broken");
      first.occurrence = 1e21;
      const result = parseTruthFile(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.includes("occurrence"))).toBe(true);
    });

    it("quote が空文字なら拒否する", () => {
      const json = validTruthJson() as { entries: Array<Record<string, unknown>> };
      const first = json.entries[0];
      if (first === undefined) throw new Error("fixture broken");
      first.quote = "";
      const result = parseTruthFile(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.includes("quote"))).toBe(true);
    });

    it('kind: "error" に perspective が無いなら拒否する', () => {
      const json = validTruthJson() as { entries: Array<Record<string, unknown>> };
      const first = json.entries[0];
      if (first === undefined) throw new Error("fixture broken");
      delete first.perspective;
      const result = parseTruthFile(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.includes("perspective"))).toBe(true);
    });
  });
});

describe("resolveTruthEntries", () => {
  function errorEntry(overrides: Partial<TruthEntry & { kind: "error" }>): TruthEntry {
    return {
      kind: "error",
      id: "e001",
      perspective: "typo",
      paragraphId: 0,
      quote: "x",
      occurrence: 1,
      expected: null,
      note: null,
      ...overrides,
    };
  }

  function normalEntry(overrides: Partial<TruthEntry & { kind: "normal" }>): TruthEntry {
    return {
      kind: "normal",
      id: "n001",
      paragraphId: 0,
      quote: "x",
      occurrence: 1,
      note: null,
      ...overrides,
    };
  }

  function truthOf(entries: readonly TruthEntry[]): TruthFile {
    return {
      formatVersion: "1",
      manuscript: { name: "テスト原稿", bodyHash: VALID_HASH },
      entries,
    };
  }

  it("段落内の 2 回目の出現を occurrence: 2 で取れる", () => {
    const text = "りんごとりんごとりんご";
    const truth = truthOf([errorEntry({ quote: "りんご", occurrence: 2 })]);
    const result = resolveTruthEntries(truth, text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.range).toEqual({ start: 4, end: 7 });
    expect(text.slice(4, 7)).toBe("りんご");
  });

  describe("書記素境界", () => {
    it("結合文字の内側に落ちる一致を採らない（e + 結合アクセント記号の内側の 'e' は不一致）", () => {
      // "e" + U+0301（結合アクセント）+ "e"。素朴な indexOf は index 0 でも "e" に一致するが、
      // その終端（index 1）は書記素境界ではないため採らない。2 個目の独立した "e"（index 2-3）だけが一致する。
      const text = "ée";
      const truth = truthOf([errorEntry({ quote: "e", occurrence: 1 })]);
      const result = resolveTruthEntries(truth, text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.range).toEqual({ start: 2, end: 3 });
    });

    it("異体字セレクタの内側に落ちる一致を採らない", () => {
      // U+2764（heart）+ U+FE0F（異体字セレクタ）+ U+2764（単独の heart）。
      // 素朴な indexOf は先頭の heart にも一致するが、その終端は書記素境界でないため採らない。
      const text = "❤️❤";
      const truth = truthOf([errorEntry({ quote: "❤", occurrence: 1 })]);
      const result = resolveTruthEntries(truth, text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.range).toEqual({ start: 2, end: 3 });
    });

    it("絵文字の ZWJ 連結の内側に落ちる一致を採らない", () => {
      // 家族の絵文字（ZWJ で 3 つの絵文字を連結した 1 つの書記素クラスタ）と、独立した「男性」絵文字。
      // 素朴な indexOf は ZWJ 連結の先頭要素にも一致するが、その終端は書記素境界でないため採らない。
      const text = "\u{1F468}‍\u{1F469}‍\u{1F467} and \u{1F468}";
      const truth = truthOf([errorEntry({ quote: "\u{1F468}", occurrence: 1 })]);
      const result = resolveTruthEntries(truth, text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.range).toEqual({ start: 13, end: 15 });
    });
  });

  describe("失敗の全件列挙", () => {
    it("段落 ID 超過・0 件・件数不足・error と normal の重なりがすべて 1 回の実行で列挙される", () => {
      const text = [
        "最初の段落。",
        "二番目の段落にはりんごとりんごがある。",
        "三番目の段落は正常な文章の例。",
      ].join("\n");

      const entries: TruthEntry[] = [
        // 段落 ID が原稿の段落数（3）を超える。
        errorEntry({ id: "e-toofar", paragraphId: 5, quote: "最初" }),
        // 一致が 0 件。
        errorEntry({ id: "e-notfound", paragraphId: 0, quote: "存在しない文字列" }),
        // 一致が occurrence（3）件に満たない（「りんご」は 2 件のみ）。
        errorEntry({ id: "e-insufficient", paragraphId: 1, quote: "りんご", occurrence: 3 }),
        // error と normal の範囲が重なる（"文章の例" は "正常な文章の例" の部分文字列）。
        errorEntry({ id: "e-overlap", paragraphId: 2, quote: "正常な文章の例" }),
        normalEntry({ id: "n-overlap", paragraphId: 2, quote: "文章の例" }),
      ];

      const result = resolveTruthEntries(truthOf(entries), text);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.failures).toHaveLength(4);
      const byId = new Map(result.failures.map((f) => [f.entryId, f]));

      const toofar = byId.get("e-toofar");
      expect(toofar?.paragraphId).toBe(5);
      expect(toofar?.reason).toEqual({ kind: "paragraph-out-of-range", paragraphCount: 3 });

      const notfound = byId.get("e-notfound");
      expect(notfound?.paragraphId).toBe(0);
      expect(notfound?.reason).toEqual({ kind: "no-match" });

      const insufficient = byId.get("e-insufficient");
      expect(insufficient?.paragraphId).toBe(1);
      // matchRanges は段落 1（"二番目の段落にはりんごとりんごがある。"）内で実際に見つかった
      // 2 件の "りんご" の位置（--report が段落本文と突き合わせるための材料）。
      expect(insufficient?.reason).toEqual({
        kind: "not-enough-matches",
        matchCount: 2,
        matchRanges: [
          { start: 15, end: 18 },
          { start: 19, end: 22 },
        ],
      });

      // error 側が entryId、normal 側が reason.otherId になる（決定的な割り当て）。
      const overlap = byId.get("e-overlap");
      expect(overlap?.paragraphId).toBe(2);
      expect(overlap?.reason).toEqual({ kind: "error-normal-overlap", otherId: "n-overlap" });
      expect(byId.has("n-overlap")).toBe(false);

      // message には id・paragraphId・件数・occurrence の値だけを使い、引用・原稿本文を含めない。
      const joined = result.failures.map((f) => f.message).join("\n");
      expect(joined).toContain("e-toofar");
      expect(joined).toContain("e-notfound");
      expect(joined).toContain("e-insufficient");
      expect(joined).toContain("e-overlap");
      expect(joined).toContain("n-overlap");
      expect(joined).not.toContain("存在しない文字列");
      expect(joined).not.toContain("りんご");
      expect(joined).not.toContain("正常な文章の例");
      expect(joined).not.toContain("最初の段落");
    });

    it("error/normal の重なりの entryId/otherId の割り当ては宣言順に依存しない", () => {
      // truth ファイル内で normal を error より先に書いても、entryId は常に error 側になる。
      const text = "重なる文章の例";
      const entries: TruthEntry[] = [
        normalEntry({ id: "n-first", paragraphId: 0, quote: "文章の例" }),
        errorEntry({ id: "e-second", paragraphId: 0, quote: "重なる文章の例" }),
      ];
      const result = resolveTruthEntries(truthOf(entries), text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        entryId: "e-second",
        reason: { kind: "error-normal-overlap", otherId: "n-first" },
      });
    });
  });
});
