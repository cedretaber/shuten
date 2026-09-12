import type { RunConditions } from "@shuten/server/run/result.ts";
import { splitParagraphs } from "@shuten/shared";

import type { EvaluationResultInput } from "./result-schema.ts";
import type {
  EvaluationMetrics,
  FalsePositiveFinding,
  FindingSetMetrics,
  PerformanceMetrics,
  Rate,
  SuppressionMetrics,
  UnlocatedMetrics,
} from "./score.ts";
import type { TruthEntry, TruthFile, TruthResolveFailure } from "./truth.ts";

/**
 * 評価レポート（Markdown）の整形（決定 10・11）。
 *
 * 純粋関数だけを置く。`node:fs` には依存しない（ファイルの書き出しは呼び出し側 `main.ts` の責務）。
 * 決定 11 の「人が判定する指標」の表をそのまま出し、誤検出・対応表には人が埋める空欄の列を
 * 用意する。決定 19 に合わせ、`rate === null` の行は `—（分母 0）` と書く。
 *
 * 見せる指摘の一覧（未検出・誤検出・重複重なり・対応表）は**再確認後**（`afterRecheck`）の
 * 集合を使う。撤回された指摘は利用者に指摘として提示されないため、再確認前の集合を使うと
 * 実際には見えない指摘をレポートに残すことになる。再確認前後の違いは「指標」節の 2 つの表と
 * 「再確認の効果」節で見える。
 */

type FindingInput = EvaluationResultInput["findings"][number];
type MatchedPair = FindingSetMetrics["matchedPairs"][number];

// --- 小さな整形ヘルパー ---------------------------------------------------------------------

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

/** 率の表示（決定 19）。`rate === null` は `—（分母 0）`。 */
function formatRate(rate: Rate): string {
  if (rate.rate === null) {
    return "—（分母 0）";
  }
  return `${(rate.rate * 100).toFixed(1)}%（${String(rate.numerator)}/${String(rate.denominator)}）`;
}

// --- 実行条件・状態 ---------------------------------------------------------------------------

/**
 * `source: "export"`（サーバー経由の実行）のときだけ足す 2 行（決定 28(c)・決定 31）。
 * 文言はブリーフ・決定記録のとおりに固定する。
 */
function formatSourceNotice(source: "result" | "export"): string[] {
  if (source !== "export") {
    return [];
  }
  return [
    "- 入力：エクスポート JSON（サーバー経由の実行）",
    "- timeouts は recoveryConfirmMs を含む実効上限（決定 31）",
  ];
}

function formatConditionsSection(conditions: RunConditions, source: "result" | "export"): string[] {
  const modelId = conditions.model === null ? "(未取得)" : conditions.model.id;
  const seed =
    conditions.generation.seed === undefined ? "(未指定)" : String(conditions.generation.seed);
  const reasoningEffort = conditions.generation.reasoningEffort ?? "(未指定)";
  const c = conditions.chunkSettings;
  const v = conditions.versions;
  return [
    "## 実行条件",
    "",
    `- モデル ID: ${modelId}（生成設定のモデル名: ${conditions.generation.model}）`,
    `- mode: ${conditions.mode}`,
    `- 観点: ${conditions.perspectives.join(", ")}`,
    `- 生成設定: maxTokens=${String(conditions.generation.maxTokens)}, temperature=${String(conditions.generation.temperature)}, seed=${seed}, reasoningEffort=${reasoningEffort}`,
    `- 分割設定: targetGraphemes=${String(c.targetGraphemes)}, contextGraphemes=${String(c.contextGraphemes)}, recheckContextGraphemes=${String(c.recheckContextGraphemes)}, roundingTolerance=${String(c.roundingTolerance)}, maxInputGraphemes=${String(c.maxInputGraphemes)}`,
    `- 版: 結果=${v.result}, プロンプト=${v.prompt}, 許容語規則=${v.allowedWordRule}, 診断変換=${v.diagnosticTransform}`,
    `- 実行時刻: ${conditions.startedAt} 〜 ${conditions.finishedAt}`,
    ...formatSourceNotice(source),
    "",
  ];
}

function formatStatusSection(performance: PerformanceMetrics): string[] {
  return [
    "## 実行の状態",
    "",
    `- status: ${performance.status}`,
    `- stopReason: ${performance.stopReason ?? "(なし)"}`,
    "",
    "止まった実行（`status` が `completed` 以外）の指標は、完走した実行と同じものとして読まないこと。",
    "",
  ];
}

// --- 決定 11 の表（そのまま出す） ---------------------------------------------------------------

function formatHumanJudgedTable(): string[] {
  return [
    "## 人が判定する指標（決定 11）",
    "",
    "仕様 10 節の 8 指標を、自動・人手で分ける。**人手の欄は本ツールが埋めない。**",
    "",
    "| 指標（仕様 10 節） | 誰が | 出し方 |",
    "| --- | --- | --- |",
    "| 誤りの検出率 | 自動 | 決定 5・6 |",
    "| 誤検出 | 自動 | 決定 5（`on-normal` と `other` に分ける） |",
    "| 位置特定失敗 | 自動（内訳まで） | 決定 8 |",
    "| 許容語の抑制 | 自動 | 決定 8 |",
    "| 実行性能 | 自動（転記） | 決定 8 |",
    "| 位置の正確さ | 自動（重なりの関係のみ） | 決定 5 の `exact` / `partial` などの内訳。最終判断は人 |",
    "| **修正案の妥当性** | **人** | レポートの誤検出・検出一覧に空欄の列を置く |",
    "| **人間の確認負担** | **人** | ツールは測らない（`docs/experiments/` に記録する） |",
    "| **診断候補の正誤** | **人** | 参考値のみ自動（決定 8）。正誤は `docs/experiments/` に記録する |",
    "",
    "人が付けた判定をツールに読み戻す経路は作らない（決定 22 の持ち越し）。",
    "",
    "**全文チャット方式（`pnpm eval full-chat`）の結果は、この表のどの指標も自動では出ない**" +
      "（決定 15）。自由形式の応答から指摘を機械的に取り出せないため自動採点せず、" +
      "`evaluate` / `aggregate` に渡すと拒否される。応答は人が読んで正解ファイルと突き合わせる。",
    "",
  ];
}

// --- 指標（beforeRecheck / afterRecheck 共通） ------------------------------------------------

const PERSPECTIVE_LABELS = ["typo", "naturalness"] as const;

function formatFindingSetSection(title: string, set: FindingSetMetrics): string[] {
  const lines: string[] = [];
  lines.push(`### ${title}`);
  lines.push("");
  lines.push(`- 指摘数: ${String(set.findingCount)}`);
  lines.push(`- 検出率（1 対 1。**正本**。決定 20）: ${formatRate(set.detection.detected)}`);
  lines.push(
    `- 検出率（参考値。1 対 1 を課さず重なりが 1 件でもあれば検出とみなす）: ${formatRate(set.detection.detectedLoose)}`,
  );
  lines.push(
    `- 重複指摘（1 つの error 項目に 2 件以上が重なったときの余剰件数）: ${String(set.detection.duplicateFindings)}`,
  );
  lines.push("");
  lines.push(
    "観点別の検出率（部分グラフで解き直したもの。**`detected.numerator` を観点間で足し上げないこと**。2 観点を持つ指摘は両方の部分グラフに入るため、合計は全体を超えうる）:",
  );
  lines.push("");
  lines.push(
    ...mdTable(
      ["観点", "検出率（1 対 1）", "検出率（参考値）", "重複指摘"],
      PERSPECTIVE_LABELS.map((p) => [
        p,
        formatRate(set.detectionByPerspective[p].detected),
        formatRate(set.detectionByPerspective[p].detectedLoose),
        String(set.detectionByPerspective[p].duplicateFindings),
      ]),
    ),
  );
  lines.push("");
  lines.push(
    `- 誤検出率: ${formatRate(set.falsePositive.falsePositives)}（on-normal: ${String(set.falsePositive.onNormal)}、other: ${String(set.falsePositive.other)}）`,
  );
  lines.push("");
  lines.push(
    "観点別の誤検出（指摘は `sources[]` に現れる観点ごとに 1 回ずつ数えるため、分母の合計は指摘件数を超えうる）:",
  );
  lines.push("");
  lines.push(
    ...mdTable(
      ["観点", "誤検出率", "on-normal", "other"],
      PERSPECTIVE_LABELS.map((p) => [
        p,
        formatRate(set.falsePositiveByPerspective[p].falsePositives),
        String(set.falsePositiveByPerspective[p].onNormal),
        String(set.falsePositiveByPerspective[p].other),
      ]),
    ),
  );
  lines.push("");
  lines.push("位置の正確さ（1 対 1 で対応した組の重なり方の内訳。決定 5。**最終判断は人**）:");
  lines.push("");
  lines.push(
    ...mdTable(
      ["exact", "containsTruth", "containedInTruth", "partial"],
      [
        [
          String(set.overlapKinds.exact),
          String(set.overlapKinds.containsTruth),
          String(set.overlapKinds.containedInTruth),
          String(set.overlapKinds.partial),
        ],
      ],
    ),
  );
  lines.push("");
  return lines;
}

function formatRecheckEffectSection(metrics: EvaluationMetrics): string[] {
  const e = metrics.recheckEffect;
  return [
    "### 再確認の効果（決定 7）",
    "",
    '母集団は `status === "done"` の再確認だけ（`failed` / `pending` / `disabled` は含まない）。',
    "",
    ...mdTable(
      ["撤回された正しい指摘", "維持された正しい指摘", "撤回された誤検出", "維持された誤検出"],
      [
        [
          String(e.withdrewTruePositive),
          String(e.keptTruePositive),
          String(e.withdrewFalsePositive),
          String(e.keptFalsePositive),
        ],
      ],
    ),
    "",
    `- 再確認失敗（\`failed\`）: ${String(metrics.recheckFailed)}`,
    `- 再確認未完了（\`pending\`）: ${String(metrics.recheckPending)}`,
    `- 再確認無効（\`disabled\`）: ${String(metrics.recheckDisabled)}`,
    "",
    "**この表は粗い目安である。** 見逃しの増加の正本は、上の「再確認前」と「再確認後」の検出率の差である。",
    "",
  ];
}

function formatSuppressionSection(s: SuppressionMetrics): string[] {
  return [
    "### 許容語の抑制（決定 8）",
    "",
    `- 正解の誤りを抑制: ${String(s.suppressedTruth)}`,
    `- 正常な文章への指摘を抑制: ${String(s.suppressedNormal)}`,
    `- その他を抑制: ${String(s.suppressedOther)}`,
    "",
    "抑制の適否と、正しい指摘を抑制していないかの最終判断は人（決定 11）。下の「抑制された指摘の一覧」を参照。",
    "",
  ];
}

function formatUnlocatedSection(u: UnlocatedMetrics): string[] {
  return [
    "### 位置特定失敗（決定 8）",
    "",
    ...mdTable(
      ["not-found", "ambiguous", "outside-target", "失敗率"],
      [
        [
          String(u.notFound),
          String(u.ambiguous),
          String(u.outsideTarget),
          formatRate(u.failureRate),
        ],
      ],
    ),
    "",
    "診断変換別の候補取得件数（位置特定に失敗した候補が持つ診断候補を `transform` ごとに数えたもの。" +
      "**この合計は失敗候補数と一致するとは限らない**——1 つの失敗候補が複数の診断候補を持つことも、" +
      "診断自体を持たない失敗候補（ambiguous・outside-target・空引用の not-found）があることも" +
      "あるため、合計は失敗候補数を超えることも下回ることもある）:",
    "",
    ...mdTable(
      ["newline", "nfc", "newline+nfc"],
      [
        [
          String(u.candidatesByTransform.newline),
          String(u.candidatesByTransform.nfc),
          String(u.candidatesByTransform["newline+nfc"]),
        ],
      ],
    ),
    "",
    `- 参考値（近似一致。**検出率には算入しない**）: ${String(u.unlocatedQuotingTruth)}`,
    "",
  ];
}

function formatPerformanceSection(p: PerformanceMetrics): string[] {
  return [
    "### 実行性能（決定 8。転記）",
    "",
    ...mdTable(
      [
        "status",
        "stopReason",
        "開始",
        "終了",
        "要求数",
        "失敗した検査単位",
        "未完了の検査単位",
        "所要時間(ms)",
      ],
      [
        [
          p.status,
          p.stopReason ?? "(なし)",
          p.startedAt,
          p.finishedAt,
          String(p.requests),
          String(p.checkUnitsFailed),
          String(p.checkUnitsPending),
          String(p.elapsedMs),
        ],
      ],
    ),
    "",
  ];
}

// --- 一覧（未検出・誤検出・抑制・重複重なり・対応表） -------------------------------------------

function buildTruthEntryIndex(truth: TruthFile): ReadonlyMap<string, TruthEntry> {
  const map = new Map<string, TruthEntry>();
  for (const entry of truth.entries) {
    map.set(entry.id, entry);
  }
  return map;
}

function buildFindingIndex(result: EvaluationResultInput): ReadonlyMap<string, FindingInput> {
  const map = new Map<string, FindingInput>();
  for (const f of result.findings) {
    map.set(f.finding.id, f);
  }
  return map;
}

function formatMissedEntriesSection(
  missedEntryIds: readonly string[],
  truthIndex: ReadonlyMap<string, TruthEntry>,
): string[] {
  const rows = missedEntryIds.map((id) => {
    const entry = truthIndex.get(id);
    const note = entry === undefined ? "" : (entry.note ?? "");
    const expected = entry !== undefined && entry.kind === "error" ? (entry.expected ?? "") : "";
    return [id, note, expected];
  });
  return [
    "## 検出されなかった誤り項目（再確認後）",
    "",
    ...mdTable(["id", "note", "expected"], rows),
    "",
  ];
}

function formatFalsePositiveRow(
  fp: FalsePositiveFinding,
  findingIndex: ReadonlyMap<string, FindingInput>,
): readonly string[] {
  const finding = findingIndex.get(fp.findingId);
  const quote = finding === undefined ? "" : finding.finding.quote;
  const suggestion = finding === undefined ? "" : (finding.finding.suggestion ?? "");
  const reasons =
    finding === undefined
      ? ""
      : finding.finding.sources.map((s) => `[${s.perspective}] ${s.llm.reason}`).join("; ");
  // 最後の空欄は「修正案の妥当性」（決定 11。人が埋める列）。
  return [fp.findingId, quote, suggestion, reasons, ""];
}

function formatFalsePositivesSection(
  findings: readonly FalsePositiveFinding[],
  findingIndex: ReadonlyMap<string, FindingInput>,
): string[] {
  const onNormal = findings.filter((f) => f.kind === "on-normal");
  const other = findings.filter((f) => f.kind === "other");
  const headers = ["id", "引用", "修正案", "理由", "修正案の妥当性（人）"];
  return [
    "## 誤検出の指摘（再確認後）",
    "",
    "### 正常な文章への誤検出（on-normal）",
    "",
    ...mdTable(
      headers,
      onNormal.map((f) => formatFalsePositiveRow(f, findingIndex)),
    ),
    "",
    "### その他の誤検出（other）",
    "",
    ...mdTable(
      headers,
      other.map((f) => formatFalsePositiveRow(f, findingIndex)),
    ),
    "",
  ];
}

function formatSuppressedSection(
  ids: readonly string[],
  findingIndex: ReadonlyMap<string, FindingInput>,
): string[] {
  const rows = ids.map((id) => {
    const f = findingIndex.get(id);
    if (f === undefined) {
      return [id, "", "", "", ""];
    }
    const word = f.suppression === null ? "" : f.suppression.word;
    const ruleVersion = f.suppression === null ? "" : f.suppression.ruleVersion;
    return [id, f.finding.quote, f.finding.category, word, ruleVersion];
  });
  return [
    "## 抑制された指摘の一覧（決定 8）",
    "",
    ...mdTable(["id", "引用", "category", "抑制語", "規則版"], rows),
    "",
  ];
}

function formatOverlappingSection(
  ids: readonly string[],
  findingIndex: ReadonlyMap<string, FindingInput>,
): string[] {
  const rows = ids.map((id) => {
    const f = findingIndex.get(id);
    return [id, f === undefined ? "" : f.finding.quote];
  });
  return [
    "## 複数の error 項目に重なった指摘（再確認後。決定 20）",
    "",
    ...mdTable(["id", "引用"], rows),
    "",
  ];
}

function formatMatchedPairsSection(
  pairs: readonly MatchedPair[],
  truthIndex: ReadonlyMap<string, TruthEntry>,
  findingIndex: ReadonlyMap<string, FindingInput>,
): string[] {
  const rows = pairs.map((pair) => {
    const entry = truthIndex.get(pair.entryId);
    const finding = findingIndex.get(pair.findingId);
    const truthQuote = entry === undefined ? "" : entry.quote;
    const expected = entry !== undefined && entry.kind === "error" ? (entry.expected ?? "") : "";
    const findingQuote = finding === undefined ? "" : finding.finding.quote;
    const suggestion = finding === undefined ? "" : (finding.finding.suggestion ?? "");
    // 最後の空欄は「修正案の妥当性」（決定 11。人が埋める列）。
    return [
      pair.entryId,
      truthQuote,
      expected,
      pair.findingId,
      findingQuote,
      suggestion,
      pair.overlapKind,
      "",
    ];
  });
  return [
    "## 1 対 1 で対応した組（再確認後。決定 20）",
    "",
    ...mdTable(
      [
        "entryId",
        "正解の引用",
        "expected",
        "findingId",
        "指摘の引用",
        "修正案",
        "重なり方",
        "修正案の妥当性（人）",
      ],
      rows,
    ),
    "",
  ];
}

// --- 本体 -------------------------------------------------------------------------------------

export interface EvaluationReportInput {
  readonly metrics: EvaluationMetrics;
  readonly truth: TruthFile;
  readonly result: EvaluationResultInput;
  /** 入力の出どころ。既定は "result"（CLI が書いた結果 JSON）。決定 28(c)。 */
  readonly source: "result" | "export";
}

/** 評価レポート（Markdown）を組み立てる。純粋関数。 */
export function formatEvaluationReport(input: EvaluationReportInput): string {
  const { metrics, truth, result, source } = input;
  const truthIndex = buildTruthEntryIndex(truth);
  const findingIndex = buildFindingIndex(result);

  const lines: string[] = [
    "# 評価レポート",
    "",
    `formatVersion: ${metrics.formatVersion}`,
    "",
    ...formatConditionsSection(result.conditions, source),
    ...formatStatusSection(metrics.performance),
    ...formatHumanJudgedTable(),
    "## 指標",
    "",
    ...formatFindingSetSection("再確認前", metrics.beforeRecheck),
    ...formatFindingSetSection("再確認後", metrics.afterRecheck),
    ...formatRecheckEffectSection(metrics),
    ...formatSuppressionSection(metrics.suppression),
    ...formatUnlocatedSection(metrics.unlocated),
    ...formatPerformanceSection(metrics.performance),
    ...formatMissedEntriesSection(metrics.afterRecheck.missedEntryIds, truthIndex),
    ...formatFalsePositivesSection(metrics.afterRecheck.falsePositiveFindings, findingIndex),
    ...formatSuppressedSection(metrics.suppression.suppressedFindingIds, findingIndex),
    ...formatOverlappingSection(
      metrics.afterRecheck.findingsOverlappingMultipleErrors,
      findingIndex,
    ),
    ...formatMatchedPairsSection(metrics.afterRecheck.matchedPairs, truthIndex, findingIndex),
  ];

  return lines.join("\n");
}

/**
 * 本文をコードブロックで囲むためのフェンスを作る（M-5 修正）。本文中に連続するバッククォートが
 * 出ると（原稿にまれに含まれうる）、3 連固定のフェンスではコードブロックが途中で終わってしまう。
 * 本文中の最長のバッククォート連より 1 つ長く、かつ最低 3 連のフェンスを返す。
 */
function codeFenceFor(body: string): string {
  const runs = body.match(/`+/g);
  const longestRun = runs === null ? 0 : Math.max(...runs.map((run) => run.length));
  return "`".repeat(Math.max(longestRun + 1, 3));
}

// --- 正解の解決に失敗したときのレポート（決定 4） -----------------------------------------------

export interface TruthResolveFailureReportInput {
  readonly failures: readonly TruthResolveFailure[];
  readonly text: string;
}

/**
 * 正解の解決（`resolveTruthEntries`）が失敗したときの詳細レポート（決定 4）。
 *
 * 標準エラーには `TruthResolveFailure.message`（安全な 1 行）だけを出すが、`--report` が
 * あるときだけ、失敗した段落の本文と一致位置（`not-enough-matches` のとき）を書く。
 * `paragraph-out-of-range` は段落自体が存在しないので本文を出さない。
 */
export function formatTruthResolveFailureReport(input: TruthResolveFailureReportInput): string {
  const paragraphs = splitParagraphs(input.text);
  const lines: string[] = [
    "# 正解の解決に失敗した項目",
    "",
    "評価を実行できませんでした（決定 4）。次の項目が本文中で解決できなかったため、正解ファイルを見直してください。",
    "",
  ];

  for (const failure of input.failures) {
    lines.push(`## ${failure.entryId}`);
    lines.push("");
    lines.push(`- paragraphId: ${String(failure.paragraphId)}`);
    lines.push(`- 理由: ${failure.message}`);
    lines.push("");

    if (failure.reason.kind === "paragraph-out-of-range") {
      lines.push("（該当する段落が存在しないため、本文は表示しません）");
      lines.push("");
      continue;
    }

    const paragraph = paragraphs[failure.paragraphId];
    if (paragraph !== undefined) {
      const paragraphText = input.text.slice(paragraph.range.start, paragraph.range.end);
      const fence = codeFenceFor(paragraphText);
      lines.push("段落本文:");
      lines.push("");
      lines.push(fence);
      lines.push(paragraphText);
      lines.push(fence);
      lines.push("");
    }

    if (failure.reason.kind === "not-enough-matches") {
      lines.push("見つかった一致の位置:");
      for (const range of failure.reason.matchRanges) {
        lines.push(`- ${String(range.start)}-${String(range.end)}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
