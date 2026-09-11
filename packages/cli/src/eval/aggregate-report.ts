import type { Perspective } from "@shuten/shared";

import type {
  AggregateResult,
  FindingSetAggregate,
  NumberAggregate,
  RateAggregate,
} from "./aggregate.ts";

/**
 * 集計レポート（Markdown）の整形（決定 10・11・12）。
 *
 * 純粋関数だけを置く。`node:fs` には依存しない（ファイルの書き出しは呼び出し側 `main.ts` の責務）。
 * `eval/report.ts` は 1 回の実行の詳細（誤検出・対応表などの現物一覧）を出す 544 行のファイルで、
 * これ以上増やすと読みにくくなるためファイルを分ける（Task 7 ブリーフの指示）。集計レポートは
 * 現物一覧を持たない（複数実行の指摘 ID は実行ごとに別物で、1 つの表に並べても意味がないため）。
 */

const PERSPECTIVE_LABELS = ["typo", "naturalness"] as const satisfies readonly Perspective[];

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function mdTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) {
    return ["（該当なし）"];
  }
  const lines: string[] = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    lines.push(`| ${row.map(escapeCell).join(" | ")} |`);
  }
  return lines;
}

/** 率の集計の表示。`availableRuns === 0`（全実行が分母 0）なら 3 値を出さない。 */
function formatRateAggregate(r: RateAggregate): string {
  if (r.min === null || r.median === null || r.max === null) {
    return `—（有効な実行なし。unavailableRuns=${String(r.unavailableRuns)}）`;
  }
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  return `中央値 ${pct(r.median)}（min ${pct(r.min)} / max ${pct(r.max)}、availableRuns=${String(r.availableRuns)}, unavailableRuns=${String(r.unavailableRuns)}）`;
}

function formatNumberAggregate(n: NumberAggregate): string {
  return `中央値 ${String(n.median)}（min ${String(n.min)} / max ${String(n.max)}）`;
}

function formatFindingSetAggregateSection(title: string, set: FindingSetAggregate): string[] {
  const lines: string[] = [];
  lines.push(`### ${title}`);
  lines.push("");
  lines.push(`- 指摘数: ${formatNumberAggregate(set.findingCount)}`);
  lines.push(`- 検出率（1 対 1。**正本**）: ${formatRateAggregate(set.detected)}`);
  lines.push(
    `- 検出率（参考値。重なりが 1 件でもあれば検出とみなす）: ${formatRateAggregate(set.detectedLoose)}`,
  );
  lines.push(`- 誤検出率: ${formatRateAggregate(set.falsePositives)}`);
  lines.push(`- 重複指摘: ${formatNumberAggregate(set.duplicateFindings)}`);
  lines.push("");
  lines.push("観点別の検出率（1 対 1）:");
  lines.push("");
  lines.push(
    ...mdTable(
      ["観点", "検出率（1 対 1）"],
      PERSPECTIVE_LABELS.map((p) => [
        p,
        formatRateAggregate(set.detectionByPerspective[p].detected),
      ]),
    ),
  );
  lines.push("");
  return lines;
}

/** 集計レポート（Markdown）を組み立てる。純粋関数。 */
export function formatAggregateReport(result: AggregateResult): string {
  const m = result.metrics;
  const lines: string[] = [
    "# 集計レポート（複数回実行。決定 12）",
    "",
    `formatVersion: ${result.formatVersion}`,
    `実行回数: ${String(result.runCount)}`,
    "",
    "## 注意",
    "",
  ];

  // 実行の状態（completed でない実行がある等）を含む notices は先頭に警告として出す
  // （Task 7 ブリーフの裁定：読み手が気付かずに中央値だけ読むことを防ぐため）。
  if (result.notices.length === 0) {
    lines.push("（なし）");
  } else {
    for (const notice of result.notices) {
      lines.push(`- ${notice}`);
    }
  }
  lines.push("");

  lines.push("## 指標");
  lines.push("");
  lines.push(...formatFindingSetAggregateSection("再確認前", m.beforeRecheck));
  lines.push(...formatFindingSetAggregateSection("再確認後", m.afterRecheck));

  lines.push("### 再確認の効果");
  lines.push("");
  lines.push(
    ...mdTable(
      ["撤回された正しい指摘", "維持された正しい指摘", "撤回された誤検出", "維持された誤検出"],
      [
        [
          formatNumberAggregate(m.recheckEffect.withdrewTruePositive),
          formatNumberAggregate(m.recheckEffect.keptTruePositive),
          formatNumberAggregate(m.recheckEffect.withdrewFalsePositive),
          formatNumberAggregate(m.recheckEffect.keptFalsePositive),
        ],
      ],
    ),
  );
  lines.push("");
  lines.push(`- 再確認失敗: ${formatNumberAggregate(m.recheckFailed)}`);
  lines.push(`- 再確認未完了: ${formatNumberAggregate(m.recheckPending)}`);
  lines.push(`- 再確認無効: ${formatNumberAggregate(m.recheckDisabled)}`);
  lines.push("");

  lines.push("### 許容語の抑制");
  lines.push("");
  lines.push(`- 正解の誤りを抑制: ${formatNumberAggregate(m.suppression.suppressedTruth)}`);
  lines.push(
    `- 正常な文章への指摘を抑制: ${formatNumberAggregate(m.suppression.suppressedNormal)}`,
  );
  lines.push(`- その他を抑制: ${formatNumberAggregate(m.suppression.suppressedOther)}`);
  lines.push("");

  lines.push("### 位置特定失敗");
  lines.push("");
  lines.push(
    ...mdTable(
      ["not-found", "ambiguous", "outside-target", "失敗率"],
      [
        [
          formatNumberAggregate(m.unlocated.notFound),
          formatNumberAggregate(m.unlocated.ambiguous),
          formatNumberAggregate(m.unlocated.outsideTarget),
          formatRateAggregate(m.unlocated.failureRate),
        ],
      ],
    ),
  );
  lines.push("");
  lines.push(
    `- 参考値（近似一致。検出率には算入しない）: ${formatNumberAggregate(m.unlocated.unlocatedQuotingTruth)}`,
  );
  lines.push("");

  lines.push("### 実行性能");
  lines.push("");
  lines.push(
    ...mdTable(
      ["要求数", "失敗した検査単位", "未完了の検査単位", "所要時間(ms)"],
      [
        [
          formatNumberAggregate(m.performance.requests),
          formatNumberAggregate(m.performance.checkUnitsFailed),
          formatNumberAggregate(m.performance.checkUnitsPending),
          formatNumberAggregate(m.performance.elapsedMs),
        ],
      ],
    ),
  );
  lines.push("");

  lines.push("## 正解項目ごとの検出頻度（k/N。決定 12）");
  lines.push("");
  lines.push(
    "「たまたま拾えた誤り」と「安定して拾える誤り」を分ける材料。entryId は辞書順（正解ファイル上の並び順ではない）。",
  );
  lines.push("");
  lines.push(
    ...mdTable(
      ["entryId", "検出回数 (k/N)"],
      result.detectionFrequency.map((f) => [
        f.entryId,
        `${String(f.detectedRuns)}/${String(f.totalRuns)}`,
      ]),
    ),
  );
  lines.push("");

  return lines.join("\n");
}
