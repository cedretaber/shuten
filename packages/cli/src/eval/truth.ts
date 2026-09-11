import type { GraphemeIndex, Perspective, Range } from "@shuten/shared";
import { buildGraphemeIndex, isGraphemeBoundary, splitParagraphs } from "@shuten/shared";
import { z } from "zod";

/**
 * 正解ファイルの読み込みと位置解決（仕様書 10 節、決定 2・4）。
 *
 * `node:fs` には依存しない。ファイルの読み込み・CLI 配線は呼び出し側（`main.ts` 相当）の責務。
 * `packages/shared` の `locateQuote` は使わない。あれは `CheckInput` に縛られ複数一致を
 * `ambiguous` として失敗にする検査用の位置特定器で、規則が違う（決定 4）。ここでは
 * 「人が指定した paragraphId ＋ quote ＋ occurrence 番目」を取るための専用の解決器を書き、
 * 書記素境界の判定だけ `@shuten/shared` と共有する。
 */

/** 正解ファイルの 1 項目（zod で検証した後の形）。 */
export type TruthEntry =
  | {
      readonly kind: "error";
      readonly id: string;
      readonly perspective: Perspective; // @shuten/shared の "typo" | "naturalness"
      readonly paragraphId: number;
      readonly quote: string;
      readonly occurrence: number; // 省略時は 1 に埋める
      readonly expected: string | null; // 省略時は null
      readonly note: string | null; // 省略時は null
    }
  | {
      readonly kind: "normal";
      readonly id: string;
      readonly paragraphId: number;
      readonly quote: string;
      readonly occurrence: number;
      readonly note: string | null;
    };

export interface TruthFile {
  readonly formatVersion: "1";
  readonly manuscript: { readonly name: string; readonly bodyHash: string };
  readonly entries: readonly TruthEntry[];
}

/** 本文中で確定した位置。`range` は UTF-16 の半開区間（`@shuten/shared` の `Range`）。 */
export interface ResolvedTruthEntry {
  readonly entry: TruthEntry;
  readonly range: Range;
}

/**
 * 解決に失敗した理由。`--report` に段落本文と一致位置を差し込めるよう、文字列化する前の
 * 構造を保つ（決定 4）。`paragraph-out-of-range` は段落自体が存在しないので、`--report` 側は
 * 本文を出さない分岐になる。
 */
export type TruthResolveFailureReason =
  | { readonly kind: "paragraph-out-of-range"; readonly paragraphCount: number }
  | { readonly kind: "no-match" }
  | { readonly kind: "not-enough-matches"; readonly matchCount: number }
  | { readonly kind: "error-normal-overlap"; readonly otherId: string };

export interface TruthResolveFailure {
  readonly entryId: string;
  readonly paragraphId: number;
  readonly reason: TruthResolveFailureReason;
  /**
   * 標準出力・標準エラーにそのまま出してよい 1 行。
   * 引用（`quote`）と原稿本文を含めない（決定 9）。
   */
  readonly message: string;
}

/** 解決の失敗は 1 件ずつではなく全件を返す（決定 4）。 */
export type TruthResolveResult =
  | { readonly ok: true; readonly value: readonly ResolvedTruthEntry[] }
  | { readonly ok: false; readonly failures: readonly TruthResolveFailure[] };

// --- zod スキーマ（決定 2 の値域の表を固定する） ------------------------------------------------

const PERSPECTIVE_VALUES = ["typo", "naturalness"] as const satisfies readonly Perspective[];

const idSchema = z.string().min(1, "id は空文字にできません");

// 段落 ID は splitParagraphs（仕様書 6.1）が振る 0 起点の通し番号。空行も 1 段落として数える。
// エディターの行番号（1 起点）や目で数えた「段落」とはずれるため、ここで明示する。
const PARAGRAPH_ID_HELP =
  "段落 ID は本文を仕様書 6.1 節の規則で分けた段落の 0 起点の通し番号です（空行も 1 段落として数えます。エディターの行番号や目で数えた段落とは一致しません）";
const paragraphIdSchema = z
  .number()
  .int(`paragraphId は整数でなければなりません（${PARAGRAPH_ID_HELP}）`)
  .min(0, `paragraphId は 0 以上でなければなりません（${PARAGRAPH_ID_HELP}）`);

// 空文字を許すとゼロ長の範囲になり、どの指摘とも重ならない「絶対に検出されない正解項目」が
// 静かに残る（決定 2）。必ず拒否する。
const quoteSchema = z
  .string()
  .min(1, "quote は空文字にできません（ゼロ長の範囲は検出できない正解項目として残ります）");

const occurrenceSchema = z
  .number()
  .int("occurrence は整数でなければなりません")
  .min(1, "occurrence は 1 以上でなければなりません（1 起点。省略時は 1）");

const manuscriptSchema = z.object({
  name: z.string(),
  bodyHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "manuscript.bodyHash は小文字 16 進 64 文字でなければなりません"),
});

const errorEntryWire = z.object({
  kind: z.literal("error"),
  id: idSchema,
  perspective: z.enum(
    PERSPECTIVE_VALUES,
    'perspective は kind: "error" のとき必須で、"typo" または "naturalness" のいずれかでなければなりません',
  ),
  paragraphId: paragraphIdSchema,
  quote: quoteSchema,
  occurrence: occurrenceSchema.optional(),
  expected: z.string().optional(),
  note: z.string().optional(),
});

const normalEntryWire = z.object({
  kind: z.literal("normal"),
  id: idSchema,
  paragraphId: paragraphIdSchema,
  quote: quoteSchema,
  occurrence: occurrenceSchema.optional(),
  note: z.string().optional(),
});

const entryWireSchema = z.discriminatedUnion("kind", [errorEntryWire, normalEntryWire]);

// expected / note は `?:` と `undefined` の組み合わせで受け取り、ここで `string | null` に正規化する
// （`exactOptionalPropertyTypes` が有効なので、後続タスクに undefined と null の両方を扱わせない）。
const entrySchema: z.ZodType<TruthEntry> = entryWireSchema.transform((entry): TruthEntry => {
  if (entry.kind === "error") {
    return {
      kind: "error",
      id: entry.id,
      perspective: entry.perspective,
      paragraphId: entry.paragraphId,
      quote: entry.quote,
      occurrence: entry.occurrence ?? 1,
      expected: entry.expected ?? null,
      note: entry.note ?? null,
    };
  }
  return {
    kind: "normal",
    id: entry.id,
    paragraphId: entry.paragraphId,
    quote: entry.quote,
    occurrence: entry.occurrence ?? 1,
    note: entry.note ?? null,
  };
});

const truthFileSchema: z.ZodType<TruthFile> = z
  .object({
    formatVersion: z.literal(
      "1",
      '別形式のファイルを黙って読まないため formatVersion は "1" でなければなりません',
    ),
    manuscript: manuscriptSchema,
    entries: z.array(entrySchema),
  })
  .superRefine((file, ctx) => {
    // id は全項目で一意（決定 2）。レポートと正解ファイルを突き合わせる鍵になるため。
    const seen = new Set<string>();
    file.entries.forEach((entry, index) => {
      if (seen.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: "id が他の項目と重複しています（id は全項目で一意でなければなりません）",
        });
      } else {
        seen.add(entry.id);
      }
    });
  });

/**
 * zod の issues を path と理由だけの文字列に写す。**値そのものは含めない**
 * （受け取った JSON の内容、とくに引用や原稿の断片が混ざりうるため）。
 */
function formatIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string[] {
  return issues.map((issue) => {
    const path =
      issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join(".");
    return `${path}: ${issue.message}`;
  });
}

/** 正解ファイルの JSON（`JSON.parse` の戻り値）を検証する。 */
export function parseTruthFile(
  json: unknown,
): { ok: true; value: TruthFile } | { ok: false; errors: readonly string[] } {
  const result = truthFileSchema.safeParse(json);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, errors: formatIssues(result.error.issues) };
}

// --- 位置解決（決定 4） -------------------------------------------------------------------------

/**
 * `paragraphRange` の内側で `quote` に完全一致する範囲をすべて集める。
 * 書記素境界の内側に落ちる一致（開始・終了のどちらかが境界でない）は採らない（仕様書 6.3 と同じ規則）。
 *
 * 一致は 1 文字ずつ前進しながら探すため、`quote` が自己重複する場合（例：本文「あああ」に対する
 * `quote: "ああ"`）は重なった一致も別々に数える。`packages/shared` の `locateQuote` と同じ数え方
 * （決定 4 は occurrence の数え方まで規定していないため、検査側の既存規則に揃えた）。
 */
function findQuoteMatches(
  text: string,
  paragraphRange: Range,
  quote: string,
  index: GraphemeIndex,
): Range[] {
  const matches: Range[] = [];
  let pos = text.indexOf(quote, paragraphRange.start);
  while (pos !== -1 && pos + quote.length <= paragraphRange.end) {
    if (isGraphemeBoundary(index, pos) && isGraphemeBoundary(index, pos + quote.length)) {
      matches.push({ start: pos, end: pos + quote.length });
    }
    pos = text.indexOf(quote, pos + 1);
  }
  return matches;
}

/** 半開区間 [start, end) 同士が重なるか。 */
function rangesOverlap(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * 各項目を本文上の範囲に解決する。失敗は全件まとめて返す（1 件ずつ直して再実行する往復を避けるため）。
 *
 * 解決できない項目としてエラーにするもの（決定 4）：
 * - 段落 ID が原稿の段落数を超える
 * - 一致が 0 件
 * - 一致が `occurrence` 件に満たない
 * - `error` の項目と `normal` の項目の範囲が重なる（正解として矛盾している）
 *
 * `message` に引用・原稿本文は含めない。`id`・`paragraphId`・見つかった件数・`occurrence` の値だけを使う。
 * 段落本文や一致位置が要る `--report` は、`reason`（と `entryId`・`paragraphId`）を材料に
 * 呼び出し側（Task 6）が別途組み立てる。
 */
export function resolveTruthEntries(truth: TruthFile, text: string): TruthResolveResult {
  const paragraphs = splitParagraphs(text);
  const index = buildGraphemeIndex(text);
  const failures: TruthResolveFailure[] = [];
  const resolved: ResolvedTruthEntry[] = [];

  for (const entry of truth.entries) {
    const paragraph = paragraphs[entry.paragraphId];
    if (paragraph === undefined) {
      const validRange =
        paragraphs.length === 0
          ? "有効な段落 ID はありません"
          : `有効な段落 ID は 0〜${String(paragraphs.length - 1)}`;
      failures.push({
        entryId: entry.id,
        paragraphId: entry.paragraphId,
        reason: { kind: "paragraph-out-of-range", paragraphCount: paragraphs.length },
        message: `${entry.id}: paragraphId ${String(entry.paragraphId)} は範囲外です（段落数 ${String(paragraphs.length)}、${validRange}。段落 ID は 0 起点で、空行も 1 段落として数えます）`,
      });
      continue;
    }

    const matches = findQuoteMatches(text, paragraph.range, entry.quote, index);
    if (matches.length === 0) {
      failures.push({
        entryId: entry.id,
        paragraphId: entry.paragraphId,
        reason: { kind: "no-match" },
        message: `${entry.id}: paragraphId ${String(entry.paragraphId)} 内に quote と完全一致する箇所が見つかりません`,
      });
      continue;
    }
    if (matches.length < entry.occurrence) {
      failures.push({
        entryId: entry.id,
        paragraphId: entry.paragraphId,
        reason: { kind: "not-enough-matches", matchCount: matches.length },
        message: `${entry.id}: paragraphId ${String(entry.paragraphId)} 内の一致は ${String(matches.length)} 件で、occurrence（${String(entry.occurrence)}）に届きません`,
      });
      continue;
    }

    const range = matches[entry.occurrence - 1];
    if (range === undefined) {
      // 直前の length < occurrence チェックで matches.length >= occurrence を確認済み。起こりえない。
      throw new Error("occurrence 番目の一致の取得に失敗しました（起こりえない）");
    }
    resolved.push({ entry, range });
  }

  // error の項目と normal の項目の範囲が重なっていないか（正解として矛盾しているため）。
  // kind が同じ項目同士（error 同士・normal 同士）は対象外。
  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      const a = resolved[i];
      const b = resolved[j];
      if (a === undefined || b === undefined || a.entry.kind === b.entry.kind) {
        continue;
      }
      if (rangesOverlap(a.range, b.range)) {
        // 組は必ず一方が error・他方が normal（同じ kind 同士は上でスキップ済み）。
        // entryId は常に error 側、otherId は常に normal 側に決定的に割り当てる
        // （ループの並び順に依存させないため）。
        const errorSide = a.entry.kind === "error" ? a : b;
        const normalSide = a.entry.kind === "error" ? b : a;
        failures.push({
          entryId: errorSide.entry.id,
          paragraphId: errorSide.entry.paragraphId,
          reason: { kind: "error-normal-overlap", otherId: normalSide.entry.id },
          message: `${errorSide.entry.id} と ${normalSide.entry.id} は kind が異なるのに範囲が重なっています（正解として矛盾しています）`,
        });
      }
    }
  }

  if (failures.length > 0) {
    return { ok: false, failures };
  }
  return { ok: true, value: resolved };
}
