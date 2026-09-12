import type { Perspective } from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { formatEvaluationReport, formatTruthResolveFailureReport } from "./report.ts";
import type { EvaluationResultInput } from "./result-schema.ts";
import { scoreRun } from "./score.ts";
import type { ResolvedTruthEntry, TruthFile, TruthResolveFailure } from "./truth.ts";

// すべて合成のテキスト・合成の JSON（実原稿の断片を含まない）。

type FindingInput = EvaluationResultInput["findings"][number];
type UnlocatedInput = EvaluationResultInput["unlocated"][number];

function unlocatedCandidate(
  id: string,
  diagnostic: UnlocatedInput["candidate"]["locate"]["diagnostic"] = null,
): UnlocatedInput {
  return {
    targetIndex: 0,
    candidate: {
      id,
      perspective: "typo",
      llm: {
        paragraphId: 0,
        quote: "引用",
        before: "",
        after: "",
        category: "notation",
        reason: "理由",
        suggestion: null,
        verdict: "likely-error",
      },
      locate: { reason: "not-found", diagnostic },
    },
  };
}

function errorEntry(
  id: string,
  perspective: Perspective,
  start: number,
  end: number,
  options: { quote?: string; expected?: string | null; note?: string | null } = {},
): ResolvedTruthEntry {
  return {
    entry: {
      kind: "error",
      id,
      perspective,
      paragraphId: 0,
      quote: options.quote ?? "誤り",
      occurrence: 1,
      expected: options.expected ?? null,
      note: options.note ?? null,
    },
    range: { start, end },
  };
}

function normalEntry(
  id: string,
  start: number,
  end: number,
  options: { quote?: string; note?: string | null } = {},
): ResolvedTruthEntry {
  return {
    entry: {
      kind: "normal",
      id,
      paragraphId: 0,
      quote: options.quote ?? "口語",
      occurrence: 1,
      note: options.note ?? null,
    },
    range: { start, end },
  };
}

function truthFileOf(entries: readonly ResolvedTruthEntry[]): TruthFile {
  return {
    formatVersion: "1",
    manuscript: { name: "テスト原稿", bodyHash: "a".repeat(64) },
    entries: entries.map((resolved) => resolved.entry),
  };
}

interface FindingOptions {
  readonly perspectives?: readonly Perspective[];
  readonly suppressed?: boolean;
  readonly quote?: string;
  readonly suggestion?: string | null;
  readonly reason?: string;
}

function finding(
  id: string,
  start: number,
  end: number,
  options: FindingOptions = {},
): FindingInput {
  const perspectives = options.perspectives ?? (["typo"] as const);
  return {
    targetIndex: 0,
    finding: {
      id,
      range: { start, end },
      quote: options.quote ?? "引用",
      category: "notation",
      suggestion: options.suggestion ?? null,
      verdict: "likely-error",
      sources: perspectives.map((perspective, index) => ({
        id: `${id}-c${String(index)}`,
        perspective,
        llm: {
          paragraphId: 0,
          quote: options.quote ?? "引用",
          before: "",
          after: "",
          category: "notation",
          reason: options.reason ?? "理由",
          suggestion: options.suggestion ?? null,
          verdict: "likely-error",
        },
      })),
    },
    suppression: options.suppressed === true ? { word: "許容語", ruleVersion: "1" } : null,
    recheck: { status: "disabled" },
  };
}

function makeResult(
  findings: readonly FindingInput[],
  unlocated: EvaluationResultInput["unlocated"] = [],
): EvaluationResultInput {
  return {
    status: "completed",
    stop: null,
    conditions: {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:10:00.000Z",
      mode: "split-recheck",
      perspectives: ["typo", "naturalness"],
      generation: { model: "test-model", maxTokens: 1024, temperature: 0 },
      model: {
        id: "org/test-model",
        type: "llm",
        state: "loaded",
        quantization: null,
        maxContextLength: null,
        loadedContextLength: null,
      },
      chunkSettings: {
        targetGraphemes: 1500,
        contextGraphemes: 1000,
        recheckContextGraphemes: 3000,
        roundingTolerance: 0.2,
        maxInputGraphemes: 6000,
      },
      timeouts: { checkMs: 1000, recheckMs: 1000 },
      allowedWords: [],
      versions: { result: "1", prompt: "1", allowedWordRule: "1", diagnosticTransform: "1" },
      manuscript: {
        utf16Length: 100,
        graphemeCount: 100,
        paragraphCount: 1,
        targetCount: 1,
        bodyHash: "a".repeat(64),
      },
    },
    findings,
    unlocated,
    totals: {
      targets: 1,
      checkUnits: { done: 1, failed: 0, pending: 0 },
      requests: 1,
      candidates: findings.length + unlocated.length,
      located: findings.length,
      unlocated: { notFound: unlocated.length, ambiguous: 0, outsideTarget: 0 },
      findings: findings.length,
      suppressed: findings.filter((item) => item.suppression !== null).length,
      rechecks: { done: 0, failed: 0, pending: 0, suppressed: 0, disabled: findings.length },
      elapsedMs: 999,
    },
  };
}

describe("formatEvaluationReport", () => {
  it("実行条件・実行の状態・formatVersion を出す", () => {
    const entries = [errorEntry("e1", "typo", 0, 4)];
    const result = makeResult([finding("f1", 0, 4)]);
    const metrics = scoreRun(entries, result);

    const report = formatEvaluationReport({
      metrics,
      truth: truthFileOf(entries),
      result,
      source: "result",
    });

    expect(report).toContain("# 評価レポート");
    expect(report).toContain("formatVersion: 1");
    expect(report).toContain("org/test-model");
    expect(report).toContain("mode: split-recheck");
    expect(report).toContain("status: completed");
    expect(report).toContain("stopReason: (なし)");
  });

  it("決定 11 の人が判定する指標の表をそのまま出す", () => {
    const entries = [errorEntry("e1", "typo", 0, 4)];
    const result = makeResult([finding("f1", 0, 4)]);
    const metrics = scoreRun(entries, result);

    const report = formatEvaluationReport({
      metrics,
      truth: truthFileOf(entries),
      result,
      source: "result",
    });

    expect(report).toContain("| 指標（仕様 10 節） | 誰が | 出し方 |");
    expect(report).toContain("| 誤りの検出率 | 自動 | 決定 5・6 |");
    expect(report).toContain(
      "| **修正案の妥当性** | **人** | レポートの誤検出・検出一覧に空欄の列を置く |",
    );
    expect(report).toContain(
      "| **人間の確認負担** | **人** | ツールは測らない（`docs/experiments/` に記録する） |",
    );
    expect(report).toContain("| **診断候補の正誤** | **人** |");
  });

  it("決定 19：rate が null の行は「—（分母 0）」と書く", () => {
    // error 項目 0 件（normal だけ）なので検出率の分母が 0 になる。
    const entries = [normalEntry("n1", 0, 4)];
    const result = makeResult([]);
    const metrics = scoreRun(entries, result);
    expect(metrics.beforeRecheck.detection.detected.rate).toBeNull();

    const report = formatEvaluationReport({
      metrics,
      truth: truthFileOf(entries),
      result,
      source: "result",
    });

    expect(report).toContain("—（分母 0）");
  });

  it("検出されなかった誤り項目に id・note・expected が出る", () => {
    const entries = [errorEntry("e1", "typo", 0, 4, { expected: "直した形", note: "備考" })];
    const result = makeResult([]); // 指摘 0 件なので e1 は必ず未検出になる
    const metrics = scoreRun(entries, result);
    expect(metrics.afterRecheck.missedEntryIds).toEqual(["e1"]);

    const report = formatEvaluationReport({
      metrics,
      truth: truthFileOf(entries),
      result,
      source: "result",
    });

    expect(report).toContain("## 検出されなかった誤り項目（再確認後）");
    expect(report).toContain("| e1 | 備考 | 直した形 |");
  });

  it("誤検出の指摘を on-normal と other に分け、引用・修正案・理由を出し、最後の列を空にする", () => {
    const entries = [normalEntry("n1", 10, 14)];
    const onNormalFinding = finding("f-on", 10, 14, {
      quote: "口語",
      suggestion: "直した形1",
      reason: "on-normal の理由",
    });
    const otherFinding = finding("f-other", 30, 34, {
      quote: "無関係な指摘",
      suggestion: "直した形2",
      reason: "other の理由",
    });
    const result = makeResult([onNormalFinding, otherFinding]);
    const metrics = scoreRun(entries, result);

    const report = formatEvaluationReport({
      metrics,
      truth: truthFileOf(entries),
      result,
      source: "result",
    });

    expect(report).toContain("### 正常な文章への誤検出（on-normal）");
    expect(report).toContain("### その他の誤検出（other）");
    // 引用・修正案・理由が出て、最後の列（修正案の妥当性）が空欄になっている
    // （mdTable は空文字セルの前後に区切り " | " を置くので、行末は `|  |` になる）。
    expect(report).toContain("| f-on | 口語 | 直した形1 | [typo] on-normal の理由 |  |");
    expect(report).toContain("| f-other | 無関係な指摘 | 直した形2 | [typo] other の理由 |  |");
  });

  it("抑制された指摘の一覧に抑制語・規則版が出る", () => {
    const entries: ResolvedTruthEntry[] = [];
    const suppressed = finding("f-sup", 0, 4, { suppressed: true, quote: "抑制対象" });
    const result = makeResult([suppressed]);
    const metrics = scoreRun(entries, result);

    const report = formatEvaluationReport({
      metrics,
      truth: truthFileOf(entries),
      result,
      source: "result",
    });

    expect(report).toContain("## 抑制された指摘の一覧（決定 8）");
    expect(report).toContain("| f-sup | 抑制対象 | notation | 許容語 | 1 |");
  });

  it("複数の error 項目に重なった指摘の一覧に出る", () => {
    const entries = [errorEntry("e1", "typo", 0, 10), errorEntry("e2", "typo", 5, 15)];
    const overlapping = finding("f-wide", 0, 15, { quote: "段落まるごと" });
    const result = makeResult([overlapping]);
    const metrics = scoreRun(entries, result);
    expect(metrics.afterRecheck.findingsOverlappingMultipleErrors).toEqual(["f-wide"]);

    const report = formatEvaluationReport({
      metrics,
      truth: truthFileOf(entries),
      result,
      source: "result",
    });

    expect(report).toContain("## 複数の error 項目に重なった指摘（再確認後。決定 20）");
    expect(report).toContain("| f-wide | 段落まるごと |");
  });

  it("1 対 1 で対応した組の表に overlapKind と空欄の最終列が出る", () => {
    const entries = [errorEntry("e1", "typo", 0, 4, { expected: "直した形" })];
    const matched = finding("f1", 0, 4, { quote: "誤り", suggestion: "案" });
    const result = makeResult([matched]);
    const metrics = scoreRun(entries, result);
    expect(metrics.afterRecheck.matchedPairs).toEqual([
      { entryId: "e1", findingId: "f1", overlapKind: "exact" },
    ]);

    const report = formatEvaluationReport({
      metrics,
      truth: truthFileOf(entries),
      result,
      source: "result",
    });

    expect(report).toContain("## 1 対 1 で対応した組（再確認後。決定 20）");
    // 最後の列（修正案の妥当性）が空欄（行末が `|  |` になる）。
    expect(report).toContain("| e1 | 誤り | 直した形 | f1 | 誤り | 案 | exact |  |");
  });

  it("位置特定失敗の節に診断変換別の候補取得件数の表と、合計が一致しない旨の注記を出す", () => {
    const entries: ResolvedTruthEntry[] = [];
    const result = makeResult(
      [],
      [
        unlocatedCandidate("u1", {
          candidates: [{ transform: "newline" }, { transform: "newline" }],
        }),
        unlocatedCandidate("u2", { candidates: [{ transform: "nfc" }] }),
      ],
    );
    const metrics = scoreRun(entries, result);
    expect(metrics.unlocated.candidatesByTransform).toEqual({
      newline: 2,
      nfc: 1,
      "newline+nfc": 0,
    });

    const report = formatEvaluationReport({
      metrics,
      truth: truthFileOf(entries),
      result,
      source: "result",
    });

    expect(report).toContain("診断変換別の候補取得件数");
    expect(report).toContain("この合計は失敗候補数と一致するとは限らない");
    expect(report).toContain("| newline | nfc | newline+nfc |");
    expect(report).toContain("| 2 | 1 | 0 |");
  });
});

describe("formatTruthResolveFailureReport（決定4）", () => {
  const TEXT = "一段落目です。\n二段落目です。";

  it("paragraph-out-of-range は段落本文を出さない", () => {
    const failures: readonly TruthResolveFailure[] = [
      {
        entryId: "e1",
        paragraphId: 5,
        reason: { kind: "paragraph-out-of-range", paragraphCount: 2 },
        message: "e1: paragraphId 5 は範囲外です",
      },
    ];

    const report = formatTruthResolveFailureReport({ failures, text: TEXT });

    expect(report).toContain("e1: paragraphId 5 は範囲外です");
    expect(report).toContain("該当する段落が存在しないため、本文は表示しません");
    expect(report).not.toContain("段落本文:");
  });

  it("no-match は段落本文を出す", () => {
    const failures: readonly TruthResolveFailure[] = [
      {
        entryId: "e2",
        paragraphId: 0,
        reason: { kind: "no-match" },
        message: "e2: 一致する箇所が見つかりません",
      },
    ];

    const report = formatTruthResolveFailureReport({ failures, text: TEXT });

    expect(report).toContain("段落本文:");
    expect(report).toContain("一段落目です。");
  });

  it("not-enough-matches は段落本文と一致位置を出す", () => {
    const failures: readonly TruthResolveFailure[] = [
      {
        entryId: "e3",
        paragraphId: 1,
        reason: {
          kind: "not-enough-matches",
          matchCount: 1,
          matchRanges: [{ start: 8, end: 10 }],
        },
        message: "e3: 一致は 1 件で occurrence に届きません",
      },
    ];

    const report = formatTruthResolveFailureReport({ failures, text: TEXT });

    expect(report).toContain("段落本文:");
    expect(report).toContain("二段落目です。");
    expect(report).toContain("見つかった一致の位置:");
    expect(report).toContain("- 8-10");
  });

  it("段落本文に連続するバッククォートが含まれてもコードブロックが壊れない（M-5）", () => {
    const textWithBackticks = "冒頭の段落。\n本文中に```が含まれる段落です。\n末尾の段落。";
    const failures: readonly TruthResolveFailure[] = [
      {
        entryId: "e4",
        paragraphId: 1,
        reason: { kind: "no-match" },
        message: "e4: 一致する箇所が見つかりません",
      },
    ];

    const report = formatTruthResolveFailureReport({ failures, text: textWithBackticks });

    expect(report).toContain("本文中に```が含まれる段落です。");
    // フェンスだけの行（本文全体がバッククォートの行）を数える。本文の3連と区別できるよう、
    // 開始・終了フェンスが本文より1つ長い4連になっていることを確かめる。
    const fenceLines = report.split("\n").filter((line) => /^`{3,}$/.test(line));
    expect(fenceLines).toEqual(["````", "````"]);
  });
});
