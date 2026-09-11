import type { ModelInfo } from "@shuten/server/lmstudio/types.ts";
import type { Perspective } from "@shuten/shared";

import type { EvaluationResultInput } from "./result-schema.ts";
import type { EvaluationMetrics, FindingSetMetrics, Rate } from "./score.ts";

/**
 * 複数回実行の集計（仕様書 10 節、決定 12）。
 *
 * 「同じ設定でも非決定性が残るため複数回実行し、結果のぶれを併記する」ための道具。
 * ぶれを測るには条件が同じでなければならないので、条件の一致検査（`checkRunConditions`）を
 * 本体（`aggregateRuns`）の入口で必ず通す。
 *
 * 純粋関数だけを置く。`node:fs` には依存しない。ファイルの読み書き・CLI 配線・Markdown 化は
 * 呼び出し側（`main.ts` / `eval/aggregate-report.ts`）の責務。
 */

// --- 集計の型（Task 7 ブリーフが名前と形を固定したもの） ---------------------------------------

/** 率の集計（決定 12）。`rate` が数値だった実行だけで 3 値を出す。 */
export interface RateAggregate {
  readonly availableRuns: number;
  readonly unavailableRuns: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly max: number | null;
}

/** 数え上げの集計（`null` になりえない指標）。 */
export interface NumberAggregate {
  readonly min: number;
  readonly median: number;
  readonly max: number;
}

/** 正解項目ごとの検出回数（k/N）。 */
export interface EntryDetectionFrequency {
  readonly entryId: string;
  readonly detectedRuns: number;
  readonly totalRuns: number;
}

/** 観点ごとの集計（決定 12 は `detected` だけを求めている。detectedLoose・重複指摘は求めない）。 */
export interface DetectionByPerspectiveAggregate {
  readonly detected: RateAggregate;
}

/** 1 つの指摘集合（再確認前／再確認後）についての集計。 */
export interface FindingSetAggregate {
  readonly detected: RateAggregate;
  readonly detectedLoose: RateAggregate;
  readonly falsePositives: RateAggregate;
  readonly findingCount: NumberAggregate;
  readonly duplicateFindings: NumberAggregate;
  readonly detectionByPerspective: Readonly<Record<Perspective, DetectionByPerspectiveAggregate>>;
}

export interface RecheckEffectAggregate {
  readonly withdrewTruePositive: NumberAggregate;
  readonly keptTruePositive: NumberAggregate;
  readonly withdrewFalsePositive: NumberAggregate;
  readonly keptFalsePositive: NumberAggregate;
}

export interface SuppressionAggregate {
  readonly suppressedTruth: NumberAggregate;
  readonly suppressedNormal: NumberAggregate;
  readonly suppressedOther: NumberAggregate;
}

export interface UnlocatedAggregate {
  readonly failureRate: RateAggregate;
  readonly notFound: NumberAggregate;
  readonly ambiguous: NumberAggregate;
  readonly outsideTarget: NumberAggregate;
  readonly unlocatedQuotingTruth: NumberAggregate;
}

export interface PerformanceAggregate {
  readonly requests: NumberAggregate;
  readonly checkUnitsFailed: NumberAggregate;
  readonly checkUnitsPending: NumberAggregate;
  readonly elapsedMs: NumberAggregate;
}

export interface AggregateMetrics {
  readonly beforeRecheck: FindingSetAggregate;
  readonly afterRecheck: FindingSetAggregate;
  readonly recheckEffect: RecheckEffectAggregate;
  readonly recheckFailed: NumberAggregate;
  readonly recheckPending: NumberAggregate;
  readonly recheckDisabled: NumberAggregate;
  readonly suppression: SuppressionAggregate;
  readonly unlocated: UnlocatedAggregate;
  readonly performance: PerformanceAggregate;
}

export interface AggregateResult {
  readonly formatVersion: "1";
  readonly runCount: number;
  /** 集計を拒否はしないが読み手に伝えるべきこと（量子化を確認できなかった、など）。 */
  readonly notices: readonly string[];
  readonly metrics: AggregateMetrics;
  /**
   * 正解項目ごとの k/N（`afterRecheck` の検出に基づく）。`aggregateRuns` は正解ファイルそのものを
   * 受け取らない（`EvaluationMetrics` / `EvaluationResultInput` だけを受け取る）ので、正解ファイル上の
   * 並び順は再現できない。`entryId` の辞書順（UTF-16 コード単位）で安定させる。
   */
  readonly detectionFrequency: readonly EntryDetectionFrequency[];
}

export type AggregateOutcome =
  | { readonly ok: true; readonly value: AggregateResult }
  | { readonly ok: false; readonly errors: readonly string[] };

/** `checkRunConditions` の戻り値。 */
export interface ConditionCheckResult {
  readonly errors: readonly string[];
  readonly notices: readonly string[];
}

// --- 内部の補助 -------------------------------------------------------------------------------

/** 文字列の辞書順（UTF-16 コード単位）。`localeCompare` はロケールに依存するので使わない。 */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 正規化済みの文字列（`values`）がすべて一致するか確かめる（決定 12）。値そのものを出してよいかは
 * `showValues` で切り替える——`allowedWords` の中身は利用者の原稿由来の語が入りうるため出さない。
 * 不一致が見つかった時点で「実行1」と、最初に食い違った実行の番号・値を報告する
 * （どの項目が食い違ったかを言うため。決定 12）。
 */
function checkSame(
  errors: string[],
  label: string,
  values: readonly string[],
  showValues: boolean,
): void {
  const first = values[0];
  if (first === undefined) return;
  for (let i = 1; i < values.length; i += 1) {
    const value = values[i];
    if (value === undefined) continue;
    if (value !== first) {
      errors.push(
        showValues
          ? `${label}が実行間で一致しません（実行1: ${first}、実行${String(i + 1)}: ${value}）`
          : `${label}が実行間で一致しません`,
      );
      return;
    }
  }
}

/**
 * 条件の一致検査（決定 12）。次が全ファイルで一致しなければエラー（警告で済ませない）：
 * `conditions.manuscript.bodyHash`、`mode`、`perspectives`、`generation`（`model` / `maxTokens` /
 * `temperature` / `seed` / `reasoningEffort`）、`chunkSettings`、`timeouts`、`allowedWords`（順序含む）、
 * `versions` の 4 つすべて。`seed` は未指定どうし（`undefined`）を一致とみなす。
 *
 * `conditions.model`（`ModelInfo | null`）は項目ごとに分ける：
 * - `id`：全実行で `model` が非 null のときだけ比較する（`model` が null なら id も取れていない）。
 * - `quantization`：全実行で `quantization` が非 null のときだけ比較する（`model` は非 null でも
 *   `quantization` 自体が null なことがある。LM Studio が返さなかった場合）。
 *   どちらも「値が取れていなければエラーにせず notices に出す」（取れなかったことを「一致」に丸めない）。
 * - `state` は比較しない。`loadedContextLength` は notices に出すだけ。
 *
 * `aggregateRuns` から内部で呼ばれるほか、`main.ts` が resolveTruthEntries・scoreRun という
 * 重い処理をする前に fail-fast するためにも直接呼ぶ（処理の順序 7）。
 */
export function checkRunConditions(
  resultsList: readonly EvaluationResultInput[],
): ConditionCheckResult {
  const errors: string[] = [];
  const notices: string[] = [];
  const conditionsList = resultsList.map((result) => result.conditions);

  checkSame(
    errors,
    "原稿のハッシュ（bodyHash）",
    conditionsList.map((c) => c.manuscript.bodyHash),
    true,
  );
  checkSame(
    errors,
    "mode",
    conditionsList.map((c) => c.mode),
    true,
  );
  checkSame(
    errors,
    "観点（perspectives）",
    conditionsList.map((c) => c.perspectives.join(",")),
    true,
  );
  checkSame(
    errors,
    "generation.model",
    conditionsList.map((c) => c.generation.model),
    true,
  );
  checkSame(
    errors,
    "generation.maxTokens",
    conditionsList.map((c) => String(c.generation.maxTokens)),
    true,
  );
  checkSame(
    errors,
    "generation.temperature",
    conditionsList.map((c) => String(c.generation.temperature)),
    true,
  );
  checkSame(
    errors,
    "generation.seed",
    conditionsList.map((c) =>
      c.generation.seed === undefined ? "(未指定)" : String(c.generation.seed),
    ),
    true,
  );
  checkSame(
    errors,
    "generation.reasoningEffort",
    conditionsList.map((c) => c.generation.reasoningEffort ?? "(未指定)"),
    true,
  );
  checkSame(
    errors,
    "chunkSettings",
    conditionsList.map((c) => JSON.stringify(c.chunkSettings)),
    true,
  );
  checkSame(
    errors,
    "timeouts",
    conditionsList.map((c) => JSON.stringify(c.timeouts)),
    true,
  );
  // allowedWords の中身は出さない（利用者の原稿由来の語が入りうるため）。順序込みで比較する。
  checkSame(
    errors,
    "許容語（allowedWords）",
    conditionsList.map((c) => JSON.stringify(c.allowedWords)),
    false,
  );
  checkSame(
    errors,
    "versions.result",
    conditionsList.map((c) => c.versions.result),
    true,
  );
  checkSame(
    errors,
    "versions.prompt",
    conditionsList.map((c) => c.versions.prompt),
    true,
  );
  checkSame(
    errors,
    "versions.allowedWordRule",
    conditionsList.map((c) => c.versions.allowedWordRule),
    true,
  );
  checkSame(
    errors,
    "versions.diagnosticTransform",
    conditionsList.map((c) => c.versions.diagnosticTransform),
    true,
  );

  const models = conditionsList.map((c) => c.model);
  const allModelPresent = models.every((m) => m !== null);
  if (allModelPresent) {
    checkSame(
      errors,
      "model.id",
      models.map((m) => (m === null ? "" : m.id)),
      true,
    );
  } else {
    notices.push("モデル情報（id）を取得できなかった実行があります（比較を省略しました）");
  }

  const quantizations = models.map((m) => (m === null ? null : m.quantization));
  const allQuantizationPresent = quantizations.every((q) => q !== null);
  if (allQuantizationPresent) {
    checkSame(
      errors,
      "model.quantization",
      quantizations.map((q) => (q === null ? "" : q)),
      true,
    );
  } else {
    notices.push(
      "量子化を確認できなかった実行があります（quantization が取得できなかったため比較を省略しました）",
    );
  }

  // loadedContextLength は比較しない（実行のたびに変わりうる）。記録上の注意として出すだけ。
  if (models.some((m) => m !== null)) {
    const parts = models.map(
      (m: ModelInfo | null, i) =>
        `実行${String(i + 1)}=${m === null ? "(不明)" : String(m.loadedContextLength)}`,
    );
    notices.push(`loadedContextLength（参考値。比較していません）: ${parts.join(", ")}`);
  }

  return { errors, notices };
}

function firstOf(values: readonly number[]): number {
  const value = values[0];
  if (value === undefined) {
    throw new Error("firstOf: 空の配列です（呼び出し側のバグ）");
  }
  return value;
}

function lastOf(values: readonly number[]): number {
  const value = values[values.length - 1];
  if (value === undefined) {
    throw new Error("lastOf: 空の配列です（呼び出し側のバグ）");
  }
  return value;
}

/** 中央値。本数が偶数なら中央 2 値の算術平均とする（既存の `median` は 5 回測る前提で流用しない）。 */
function median(sortedValues: readonly number[]): number {
  const n = sortedValues.length;
  if (n === 0) {
    throw new Error("median: 空の配列です（呼び出し側のバグ）");
  }
  const midIndex = Math.floor(n / 2);
  if (n % 2 === 1) {
    const value = sortedValues[midIndex];
    if (value === undefined) {
      throw new Error("median: 値の取得に失敗しました（起こりえない）");
    }
    return value;
  }
  const lower = sortedValues[midIndex - 1];
  const upper = sortedValues[midIndex];
  if (lower === undefined || upper === undefined) {
    throw new Error("median: 値の取得に失敗しました（起こりえない）");
  }
  return (lower + upper) / 2;
}

/** 率の集計（決定 12）。`rate` が数値だった実行だけで min/median/max を出す。 */
function aggregateRate(rates: readonly Rate[]): RateAggregate {
  const available: number[] = [];
  let unavailableRuns = 0;
  for (const rate of rates) {
    if (rate.rate === null) {
      unavailableRuns += 1;
    } else {
      available.push(rate.rate);
    }
  }
  if (available.length === 0) {
    return { availableRuns: 0, unavailableRuns, min: null, median: null, max: null };
  }
  const sorted = [...available].sort((a, b) => a - b);
  return {
    availableRuns: available.length,
    unavailableRuns,
    min: firstOf(sorted),
    median: median(sorted),
    max: lastOf(sorted),
  };
}

/** 数え上げの集計。`values` は空にならない前提（`aggregateRuns` が runCount >= 1 を保証する）。 */
function aggregateNumber(values: readonly number[]): NumberAggregate {
  if (values.length === 0) {
    throw new Error("aggregateNumber: 集計対象がありません（呼び出し側のバグ）");
  }
  const sorted = [...values].sort((a, b) => a - b);
  return { min: firstOf(sorted), median: median(sorted), max: lastOf(sorted) };
}

function aggregateFindingSet(sets: readonly FindingSetMetrics[]): FindingSetAggregate {
  return {
    detected: aggregateRate(sets.map((s) => s.detection.detected)),
    detectedLoose: aggregateRate(sets.map((s) => s.detection.detectedLoose)),
    falsePositives: aggregateRate(sets.map((s) => s.falsePositive.falsePositives)),
    findingCount: aggregateNumber(sets.map((s) => s.findingCount)),
    duplicateFindings: aggregateNumber(sets.map((s) => s.detection.duplicateFindings)),
    detectionByPerspective: {
      typo: { detected: aggregateRate(sets.map((s) => s.detectionByPerspective.typo.detected)) },
      naturalness: {
        detected: aggregateRate(sets.map((s) => s.detectionByPerspective.naturalness.detected)),
      },
    },
  };
}

/**
 * 正解項目ごとの k/N（決定 12）。`afterRecheck` の検出に基づく。母集団（分母 N）は
 * `metricsList.length`（同じ正解ファイルを使っている前提。呼び出し側（`main.ts`）が
 * 単一の `resolveTruthEntries` の結果を全実行の `scoreRun` に渡すことで保証する）。
 */
function computeDetectionFrequency(
  metricsList: readonly EvaluationMetrics[],
): EntryDetectionFrequency[] {
  const detectedCounts = new Map<string, number>();
  const allIds = new Set<string>();
  for (const metrics of metricsList) {
    const detectedIds = new Set(metrics.afterRecheck.matchedPairs.map((pair) => pair.entryId));
    for (const id of detectedIds) {
      allIds.add(id);
      detectedCounts.set(id, (detectedCounts.get(id) ?? 0) + 1);
    }
    for (const id of metrics.afterRecheck.missedEntryIds) {
      allIds.add(id);
    }
  }
  const runCount = metricsList.length;
  return Array.from(allIds)
    .sort(compareIds)
    .map((entryId) => ({
      entryId,
      detectedRuns: detectedCounts.get(entryId) ?? 0,
      totalRuns: runCount,
    }));
}

// --- 本体 -------------------------------------------------------------------------------------

/**
 * 集計の本体。条件の一致検査を含む（決定 12）。
 *
 * `metricsList` と `resultsList` は同じ順序・同じ長さであることを前提にしてよいが、
 * 長さが違えば呼び出し側のバグなので例外を投げる（丸めない）。
 */
export function aggregateRuns(
  metricsList: readonly EvaluationMetrics[],
  resultsList: readonly EvaluationResultInput[],
): AggregateOutcome {
  if (metricsList.length !== resultsList.length) {
    throw new Error(
      "aggregateRuns: metricsList と resultsList の長さが一致しません（呼び出し側のバグ）",
    );
  }
  const runCount = metricsList.length;
  if (runCount === 0) {
    throw new Error("aggregateRuns: 集計対象の実行がありません（呼び出し側のバグ）");
  }

  const conditionCheck = checkRunConditions(resultsList);
  if (conditionCheck.errors.length > 0) {
    return { ok: false, errors: conditionCheck.errors };
  }

  const notices: string[] = [...conditionCheck.notices];
  // completed でない実行が1本でもあれば、集計は行うが notices に明示する（私の裁定。決定12に無い追加）。
  // 決定12が一致を求めているのは設定であって結果の状態ではないため拒否はしないが、途中で止まった
  // 実行は本文の一部しか検査しておらず検出率が低く出るため、読み手に知らせずに中央値だけ見せない。
  metricsList.forEach((metrics, index) => {
    if (metrics.performance.status !== "completed") {
      notices.push(
        `実行${String(index + 1)}は完走していません（status: ${metrics.performance.status}）`,
      );
    }
  });

  const metrics: AggregateMetrics = {
    beforeRecheck: aggregateFindingSet(metricsList.map((m) => m.beforeRecheck)),
    afterRecheck: aggregateFindingSet(metricsList.map((m) => m.afterRecheck)),
    recheckEffect: {
      withdrewTruePositive: aggregateNumber(
        metricsList.map((m) => m.recheckEffect.withdrewTruePositive),
      ),
      keptTruePositive: aggregateNumber(metricsList.map((m) => m.recheckEffect.keptTruePositive)),
      withdrewFalsePositive: aggregateNumber(
        metricsList.map((m) => m.recheckEffect.withdrewFalsePositive),
      ),
      keptFalsePositive: aggregateNumber(metricsList.map((m) => m.recheckEffect.keptFalsePositive)),
    },
    recheckFailed: aggregateNumber(metricsList.map((m) => m.recheckFailed)),
    recheckPending: aggregateNumber(metricsList.map((m) => m.recheckPending)),
    recheckDisabled: aggregateNumber(metricsList.map((m) => m.recheckDisabled)),
    suppression: {
      suppressedTruth: aggregateNumber(metricsList.map((m) => m.suppression.suppressedTruth)),
      suppressedNormal: aggregateNumber(metricsList.map((m) => m.suppression.suppressedNormal)),
      suppressedOther: aggregateNumber(metricsList.map((m) => m.suppression.suppressedOther)),
    },
    unlocated: {
      failureRate: aggregateRate(metricsList.map((m) => m.unlocated.failureRate)),
      notFound: aggregateNumber(metricsList.map((m) => m.unlocated.notFound)),
      ambiguous: aggregateNumber(metricsList.map((m) => m.unlocated.ambiguous)),
      outsideTarget: aggregateNumber(metricsList.map((m) => m.unlocated.outsideTarget)),
      unlocatedQuotingTruth: aggregateNumber(
        metricsList.map((m) => m.unlocated.unlocatedQuotingTruth),
      ),
    },
    performance: {
      requests: aggregateNumber(metricsList.map((m) => m.performance.requests)),
      checkUnitsFailed: aggregateNumber(metricsList.map((m) => m.performance.checkUnitsFailed)),
      checkUnitsPending: aggregateNumber(metricsList.map((m) => m.performance.checkUnitsPending)),
      elapsedMs: aggregateNumber(metricsList.map((m) => m.performance.elapsedMs)),
    },
  };

  return {
    ok: true,
    value: {
      formatVersion: "1",
      runCount,
      notices,
      metrics,
      detectionFrequency: computeDetectionFrequency(metricsList),
    },
  };
}
