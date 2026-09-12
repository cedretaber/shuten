import type { DiagnosticTransform, InitialVerdict, Perspective, Range } from "@shuten/shared";

import type { MatchEdge } from "./matching.ts";
import { maximumMatching } from "./matching.ts";
import type { EvaluationResultInput } from "./result-schema.ts";
import type { ResolvedTruthEntry, TruthEntry } from "./truth.ts";

/**
 * 正解項目と検査結果の突き合わせ、および指標の算出（仕様書 10 節、決定 5〜8・19・20）。
 *
 * 純粋関数だけを置く。`node:fs` には依存しない。ファイルの読み書き・Markdown 化・複数回の集計は
 * 呼び出し側（Task 6・7）の責務。
 */

// --- 指標の型（Task 6・7 が同じ形を使う） -----------------------------------------------------

/** 率は必ずこの形（決定 19）。`denominator === 0` なら `rate` は `null`。`NaN` を入れない。 */
export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
}

/** 重なり方の内訳（決定 5。どこまで緩めてよいかを人が後から判断するための材料）。 */
export interface OverlapKindCounts {
  readonly exact: number; // 範囲が完全一致
  readonly containsTruth: number; // 指摘が正解項目を含む
  readonly containedInTruth: number; // 指摘が正解項目に含まれる
  readonly partial: number; // どちらでもない部分的な重なり
}

export interface DetectionMetrics {
  /** 1 対 1 対応（決定 20）。これが検出率の正本。 */
  readonly detected: Rate;
  /** 1 対 1 を課さない参考値。重なりが 1 件でもあれば検出とみなす。 */
  readonly detectedLoose: Rate;
  /** 1 つの error 項目に 2 件以上が重なったときの余剰件数（決定 5）。マッチの成否では絞らない。 */
  readonly duplicateFindings: number;
}

export interface FalsePositiveMetrics {
  /** 分子 = 誤検出の指摘数、分母 = 指摘数。 */
  readonly falsePositives: Rate;
  readonly onNormal: number;
  readonly other: number;
  /**
   * 誤検出の初回判定別の内訳（決定 18(b)）。`likelyError + confirmWithAuthor === falsePositives.numerator`
   * が全体・観点別のどちらでも成り立つ。**`confirm-with-author`（確認事項）は誤検出の分子から
   * 除外しない**——再確認前の初回判定にすぎず、誤検出の定義（決定 5：どの error 項目とも重ならない
   * 指摘）を初回判定で変えないため。この内訳は「確認事項が誤検出のうちどれだけを占めるか」を
   * 読み手に見せるための参考情報であり、分子・分母の定義を変えるものではない。
   */
  readonly likelyError: number;
  readonly confirmWithAuthor: number;
}

export interface FalsePositiveFinding {
  readonly findingId: string;
  readonly kind: "on-normal" | "other";
  /** 指摘の初回判定（決定 18(b)）。`toScoredFinding` が `input.finding.verdict` から運ぶ。 */
  readonly verdict: InitialVerdict;
}

/** 1 つの指摘集合（再確認前／再確認後）についての指標。 */
export interface FindingSetMetrics {
  readonly findingCount: number;
  readonly detection: DetectionMetrics;
  /**
   * 観点ごと。観点が一致する辺だけの部分グラフで解き直したもの（決定 6・20）。
   * `detectedLoose` と `duplicateFindings` も部分グラフの中で数える
   * （その観点を持つ指摘だけを見る）。
   *
   * **観点ごとの `detected.numerator` を足し上げないこと。** `sources[]` に 2 観点を持つ指摘は
   * 両方の部分グラフに入り、それぞれで別の項目にマッチしうるので、**合計は全体の
   * `detection.detected.numerator` を超えうる**（解き直すことの当然の帰結で、誤りではない）。
   */
  readonly detectionByPerspective: Readonly<Record<Perspective, DetectionMetrics>>;
  readonly falsePositive: FalsePositiveMetrics;
  /**
   * 観点ごとの誤検出。**指摘は `sources[]` に現れる観点ごとに 1 回ずつ数える**ので、
   * 2 観点を持つ指摘は両方に数えられ、**観点ごとの分母の合計は指摘件数を超えうる**。
   * 誤検出かどうかの判定そのものは全体と同じ（どの error 項目とも重ならない指摘。決定 5）で、
   * ここでは指摘側の観点で分類しているだけ（決定 6）。
   */
  readonly falsePositiveByPerspective: Readonly<Record<Perspective, FalsePositiveMetrics>>;
  /**
   * 重なり方の内訳（決定 5）。数えるのは **1 対 1 で対応した組だけ**なので、
   * 4 つの合計は必ず `detection.detected.numerator` と等しい。
   */
  readonly overlapKinds: OverlapKindCounts;
  /** 複数の error 項目に重なった指摘の ID（決定 20。現物をレポートに出す）。 */
  readonly findingsOverlappingMultipleErrors: readonly string[];
  /** 検出されなかった error 項目の ID（1 対 1 の結果に基づく）。 */
  readonly missedEntryIds: readonly string[];
  readonly falsePositiveFindings: readonly FalsePositiveFinding[];
  /** 1 対 1 で対応した組（レポートの対応表に使う）。 */
  readonly matchedPairs: readonly {
    readonly entryId: string;
    readonly findingId: string;
    readonly overlapKind: keyof OverlapKindCounts;
  }[];
}

/**
 * 再確認の効き方（決定 7）。母集団は `status === "done"` の再確認だけ
 * （`failed` / `pending` / `disabled` は `kept*` に混ぜない。未完了を成功にも失敗にも丸めないため）。
 *
 * true positive / false positive の分け方は**決定 5 と同じ「重なり」基準**
 * （error 項目に重なるか否か）。1 対 1 のマッチではない。1 つのレポートに誤検出の定義を
 * 2 つ入れないための決まりで、判定は `overlapsAnyErrorEntry` の 1 か所にある。
 *
 * **`withdrewTruePositive` は粗い目安である。** 見逃しの増加の正本は
 * `beforeRecheck.detection.detected` と `afterRecheck.detection.detected` の差で、
 * こちらは再確認後の集合でマッチングを解き直した結果なので、撤回された指摘が拾っていた項目を
 * 別の指摘が拾い直した場合に二重に数えない。
 */
export interface RecheckEffect {
  readonly withdrewTruePositive: number;
  readonly keptTruePositive: number;
  readonly withdrewFalsePositive: number;
  readonly keptFalsePositive: number;
}

export interface SuppressionMetrics {
  readonly suppressedTruth: number;
  readonly suppressedNormal: number;
  readonly suppressedOther: number;
  readonly suppressedFindingIds: readonly string[];
}

export interface UnlocatedMetrics {
  readonly notFound: number;
  readonly ambiguous: number;
  readonly outsideTarget: number;
  /** 失敗候補数 / `totals.candidates`。 */
  readonly failureRate: Rate;
  /** 参考値（近似一致）。**検出率には算入しない**（決定 8）。 */
  readonly unlocatedQuotingTruth: number;
  /**
   * 診断変換別の候補取得件数（仕様書 10 節「位置特定失敗」の指標。決定 8 に追記）。
   *
   * 数え方は「位置特定に失敗した候補（`result.unlocated[]`）が持つ診断候補
   * （`locate.diagnostic.candidates[]`）を、`transform` ごとに数え上げる」。
   * **1 つの失敗候補が複数の診断候補を持ちうるため、この 3 つの合計は失敗候補数と一致するとは
   * 限らない**（超えることも下回ることもある）。`diagnostic` は `reason: "not-found"`（空引用を除く）
   * のときだけ非 null（`packages/shared` の `locateQuote`）。`ambiguous` / `outside-target` の
   * 失敗と、空引用の `not-found` は診断を持たないため何も数えない。
   */
  readonly candidatesByTransform: Readonly<Record<DiagnosticTransform, number>>;
}

export interface PerformanceMetrics {
  /** 実行の状態。止まった実行の数字を完走と同じものとして読ませないために運ぶ。 */
  readonly status: EvaluationResultInput["status"];
  /** 止まった理由。`stop === null` なら null。`stop.message` は運ばない（接続先の断片が入りうる）。 */
  readonly stopReason: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly requests: number;
  readonly checkUnitsFailed: number;
  readonly checkUnitsPending: number;
  readonly elapsedMs: number;
}

export interface EvaluationMetrics {
  readonly formatVersion: "1";
  readonly truthEntryCounts: { readonly error: number; readonly normal: number };
  readonly beforeRecheck: FindingSetMetrics;
  readonly afterRecheck: FindingSetMetrics;
  readonly recheckEffect: RecheckEffect;
  readonly recheckFailed: number;
  readonly recheckPending: number;
  readonly recheckDisabled: number;
  readonly suppression: SuppressionMetrics;
  readonly unlocated: UnlocatedMetrics;
  readonly performance: PerformanceMetrics;
}

// --- 内部の補助 -------------------------------------------------------------------------------

type ErrorTruthEntry = Extract<TruthEntry, { kind: "error" }>;
type ResolvedErrorEntry = ResolvedTruthEntry & { readonly entry: ErrorTruthEntry };

/** 評価に使う指摘の最小形（`sources[]` の観点は重複を除いて出現順に畳んだもの）。 */
interface ScoredFinding {
  readonly id: string;
  readonly range: Range;
  readonly perspectives: readonly Perspective[];
  /** 初回判定（決定 18(b)）。誤検出の内訳（`FalsePositiveFinding.verdict`）に使う。 */
  readonly verdict: InitialVerdict;
}

/**
 * 率を作る（決定 19）。分母が 0 のとき `rate` は `null`。
 * `0 / 0` の `NaN` を入れない——`JSON.stringify(NaN)` は黙って `null` になり、
 * 「1 件も拾えなかった」と「数える対象が無かった」の区別が JSON に書いた時点で消えるため。
 */
function makeRate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}

/** 半開区間の重なり（決定 5）。`e.end === f.start` は重ならない。 */
function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

/** 重なりの長さ。辺の並べ替えにだけ使う。 */
function overlapLength(a: Range, b: Range): number {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

/** 指摘の範囲 `finding` と正解項目の範囲 `truth` の関係（決定 5）。 */
function overlapKindOf(finding: Range, truth: Range): keyof OverlapKindCounts {
  if (finding.start === truth.start && finding.end === truth.end) {
    return "exact";
  }
  if (finding.start <= truth.start && finding.end >= truth.end) {
    return "containsTruth";
  }
  if (finding.start >= truth.start && finding.end <= truth.end) {
    return "containedInTruth";
  }
  return "partial";
}

/** 文字列の辞書順（UTF-16 コード単位）。`localeCompare` はロケールに依存するので使わない。 */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 各観点について値を作り、`Record<Perspective, T>` として組み立てる。
 * 観点を書き並べるのは、`Perspective` に観点が増えたときに型検査で落とすため
 * （配列を回して組み立てると欠けたキーが実行時まで分からない）。
 */
function byPerspective<T>(
  build: (perspective: Perspective) => T,
): Readonly<Record<Perspective, T>> {
  return { typo: build("typo"), naturalness: build("naturalness") };
}

/**
 * 診断変換別の候補取得件数（`UnlocatedMetrics.candidatesByTransform`）。位置特定に失敗した候補
 * （`unlocated[]`）が持つ診断候補を `transform` ごとに数え上げる。`diagnostic` が `null` の候補
 * （`ambiguous` / `outside-target` の失敗、空引用の `not-found`）は数えない。1 つの失敗候補が
 * 複数の診断候補を持ちうる一方で診断自体を持たない失敗候補もあるため、戻り値の 3 つの合計は
 * `unlocated.length` と一致するとは限らない（超えることも下回ることもある）。
 *
 * キーをベタ書きした形にして、`DiagnosticTransform` に変換が増えたら型検査で落ちるようにする
 * （`byPerspective` と同じ考え方）。
 */
function countCandidatesByTransform(
  unlocated: EvaluationResultInput["unlocated"],
): Readonly<Record<DiagnosticTransform, number>> {
  const counts: Record<DiagnosticTransform, number> = { newline: 0, nfc: 0, "newline+nfc": 0 };
  for (const item of unlocated) {
    const diagnostic = item.candidate.locate.diagnostic;
    if (diagnostic === null) {
      continue;
    }
    for (const candidate of diagnostic.candidates) {
      counts[candidate.transform] += 1;
    }
  }
  return counts;
}

// --- 検出（決定 5・20） -----------------------------------------------------------------------

interface DetectionSolution {
  readonly metrics: DetectionMetrics;
  /** 正解項目の添字 → 指摘の添字（渡された配列の中の添字）。 */
  readonly matched: ReadonlyMap<number, number>;
  /** 正解項目の添字 → 重なった指摘の添字（指摘の出現順）。すべての項目について作る。 */
  readonly overlappingFindings: readonly (readonly number[])[];
}

/**
 * 渡された error 項目と指摘の組で検出を解く。観点別の指標は、観点が一致する項目と指摘だけに
 * 絞った配列でこの関数を**もう一度**呼ぶ（決定 6・20）。全体のマッチ結果から観点違いの組を
 * 後で取り除くと、「観点一致の相手がいたのに全体用のマッチで別の指摘に取られていた」項目を
 * 数え落とすため、必ず解き直す。
 */
function solveDetection(
  errorEntries: readonly ResolvedErrorEntry[],
  findings: readonly ScoredFinding[],
): DetectionSolution {
  const overlappingFindings: number[][] = errorEntries.map(() => []);
  const edges: MatchEdge[] = [];

  findings.forEach((finding, findingIndex) => {
    errorEntries.forEach((entry, entryIndex) => {
      if (!overlaps(finding.range, entry.range)) {
        return;
      }
      overlappingFindings[entryIndex]?.push(findingIndex);
      edges.push({
        leftIndex: findingIndex,
        rightIndex: entryIndex,
        weight: overlapLength(finding.range, entry.range),
      });
    });
  });

  // 決定 20 の同点の割り方：重なりの長さの降順 → 項目 range.start の昇順 → 項目 id の辞書順 →
  // 指摘の出現順。ここで一意に並べたうえで増加路を探すので、同じ入力なら必ず同じ対応になる。
  edges.sort((a, b) => {
    if (a.weight !== b.weight) return b.weight - a.weight;
    const entryA = errorEntries[a.rightIndex];
    const entryB = errorEntries[b.rightIndex];
    if (entryA === undefined || entryB === undefined) return a.rightIndex - b.rightIndex;
    if (entryA.range.start !== entryB.range.start) return entryA.range.start - entryB.range.start;
    const byId = compareIds(entryA.entry.id, entryB.entry.id);
    if (byId !== 0) return byId;
    return a.leftIndex - b.leftIndex;
  });

  const findingToEntry = maximumMatching(edges, findings.length, errorEntries.length);
  const matched = new Map<number, number>();
  for (const [findingIndex, entryIndex] of findingToEntry) {
    matched.set(entryIndex, findingIndex);
  }

  const looseDetected = overlappingFindings.filter((list) => list.length > 0).length;
  // 重複指摘：1 つの error 項目に 2 件以上が重なったときの余剰件数（決定 5）。**マッチの成否では
  // 絞らない。** 絞ると、どの項目が未マッチになるかは辺の並べ替え次第なので、この指標だけが
  // 同点の割り方に依存してしまう（決定 20 は「同点の割り方で変わるのは対応表の見え方だけ」と
  // 保証している）。
  let duplicateFindings = 0;
  for (const list of overlappingFindings) {
    duplicateFindings += Math.max(list.length - 1, 0);
  }

  return {
    metrics: {
      detected: makeRate(matched.size, errorEntries.length),
      detectedLoose: makeRate(looseDetected, errorEntries.length),
      duplicateFindings,
    },
    matched,
    overlappingFindings,
  };
}

// --- 指摘集合 1 つぶんの指標 ------------------------------------------------------------------

/**
 * 決定 5・7 に共通の「正しい指摘か」の判定。error 項目に**重なる**かどうかだけで決める
 * （1 対 1 のマッチではない）。誤検出の定義を 1 つに保つため、判定はこの関数に集約する。
 */
function overlapsAnyErrorEntry(range: Range, errorEntries: readonly ResolvedErrorEntry[]): boolean {
  return errorEntries.some((entry) => overlaps(range, entry.range));
}

function scoreFindingSet(
  errorEntries: readonly ResolvedErrorEntry[],
  normalEntries: readonly ResolvedTruthEntry[],
  findings: readonly ScoredFinding[],
): FindingSetMetrics {
  const overall = solveDetection(errorEntries, findings);

  // 対応表は正解項目の並び順で出す（マッチの内部順に依存させない）。
  const matchedPairs = errorEntries.flatMap((entry, entryIndex) => {
    const findingIndex = overall.matched.get(entryIndex);
    if (findingIndex === undefined) return [];
    const finding = findings[findingIndex];
    if (finding === undefined) return [];
    return [
      {
        entryId: entry.entry.id,
        findingId: finding.id,
        overlapKind: overlapKindOf(finding.range, entry.range),
      },
    ];
  });

  const overlapKinds: OverlapKindCounts = {
    exact: matchedPairs.filter((pair) => pair.overlapKind === "exact").length,
    containsTruth: matchedPairs.filter((pair) => pair.overlapKind === "containsTruth").length,
    containedInTruth: matchedPairs.filter((pair) => pair.overlapKind === "containedInTruth").length,
    partial: matchedPairs.filter((pair) => pair.overlapKind === "partial").length,
  };

  const missedEntryIds = errorEntries
    .filter((_entry, entryIndex) => !overall.matched.has(entryIndex))
    .map((entry) => entry.entry.id);

  // 1 件の指摘が重なった error 項目の数（`findingsOverlappingMultipleErrors` と誤検出の判定に使う）。
  const errorOverlapCount = findings.map(() => 0);
  overall.overlappingFindings.forEach((list) => {
    for (const findingIndex of list) {
      errorOverlapCount[findingIndex] = (errorOverlapCount[findingIndex] ?? 0) + 1;
    }
  });

  const findingsOverlappingMultipleErrors = findings
    .filter((_finding, index) => (errorOverlapCount[index] ?? 0) >= 2)
    .map((finding) => finding.id);

  // 誤検出＝どの error 項目とも重ならない指摘（決定 5）。error と normal の両方に重なる指摘は
  // 検出として数え、誤検出には数えない（誤りの隣に意図した口語があるだけで誤検出が増えないように）。
  const falsePositiveFindings: FalsePositiveFinding[] = [];
  const falsePositiveInfoByIndex = new Map<
    number,
    { readonly kind: "on-normal" | "other"; readonly verdict: InitialVerdict }
  >();
  findings.forEach((finding, index) => {
    // 判定は `overlapsAnyErrorEntry` だけを通す（`errorOverlapCount` を使っても同じ結果になるが、
    // 「正しい指摘か」の定義をこのファイルで 1 か所に保つため。決定 5・7 で共通の定義）。
    if (overlapsAnyErrorEntry(finding.range, errorEntries)) {
      return;
    }
    const kind = normalEntries.some((entry) => overlaps(finding.range, entry.range))
      ? "on-normal"
      : "other";
    falsePositiveFindings.push({ findingId: finding.id, kind, verdict: finding.verdict });
    falsePositiveInfoByIndex.set(index, { kind, verdict: finding.verdict });
  });

  const falsePositive: FalsePositiveMetrics = {
    falsePositives: makeRate(falsePositiveFindings.length, findings.length),
    onNormal: falsePositiveFindings.filter((item) => item.kind === "on-normal").length,
    other: falsePositiveFindings.filter((item) => item.kind === "other").length,
    likelyError: falsePositiveFindings.filter((item) => item.verdict === "likely-error").length,
    confirmWithAuthor: falsePositiveFindings.filter(
      (item) => item.verdict === "confirm-with-author",
    ).length,
  };

  return {
    findingCount: findings.length,
    detection: overall.metrics,
    detectionByPerspective: byPerspective((perspective) => {
      // 観点が一致する辺だけを残した部分グラフで解き直す（決定 6・20）。項目と指摘の両方を
      // その観点に絞るので、残った組み合わせはすべて観点が一致している。
      const entriesOfPerspective = errorEntries.filter(
        (entry) => entry.entry.perspective === perspective,
      );
      const findingsOfPerspective = findings.filter((finding) =>
        finding.perspectives.includes(perspective),
      );
      return solveDetection(entriesOfPerspective, findingsOfPerspective).metrics;
    }),
    falsePositive,
    falsePositiveByPerspective: byPerspective((perspective) => {
      const indexes = findings.flatMap((finding, index) =>
        finding.perspectives.includes(perspective) ? [index] : [],
      );
      // その観点を持つ指摘だけに絞ってから内訳を数える（決定 6 と同じ考え方）。
      const infos = indexes.flatMap((index) => {
        const info = falsePositiveInfoByIndex.get(index);
        return info === undefined ? [] : [info];
      });
      return {
        falsePositives: makeRate(infos.length, indexes.length),
        onNormal: infos.filter((info) => info.kind === "on-normal").length,
        other: infos.filter((info) => info.kind === "other").length,
        likelyError: infos.filter((info) => info.verdict === "likely-error").length,
        confirmWithAuthor: infos.filter((info) => info.verdict === "confirm-with-author").length,
      };
    }),
    overlapKinds,
    findingsOverlappingMultipleErrors,
    missedEntryIds,
    falsePositiveFindings,
    matchedPairs,
  };
}

// --- 本体 -------------------------------------------------------------------------------------

function isErrorEntry(resolved: ResolvedTruthEntry): resolved is ResolvedErrorEntry {
  return resolved.entry.kind === "error";
}

/** `sources[]` の観点を重複を除いて出現順に畳む。1 件の指摘が 2 観点を持ちうる（統合の結果）。 */
function toScoredFinding(input: EvaluationResultInput["findings"][number]): ScoredFinding {
  const perspectives: Perspective[] = [];
  for (const source of input.finding.sources) {
    if (!perspectives.includes(source.perspective)) {
      perspectives.push(source.perspective);
    }
  }
  return {
    id: input.finding.id,
    range: input.finding.range,
    perspectives,
    verdict: input.finding.verdict,
  };
}

/** 再確認が撤回したか（決定 7）。`confirm-with-author` は撤回ではない。 */
function isWithdrawn(input: EvaluationResultInput["findings"][number]): boolean {
  return input.recheck.status === "done" && input.recheck.output.verdict === "withdraw";
}

/** 突き合わせの本体。純粋関数。 */
export function scoreRun(
  entries: readonly ResolvedTruthEntry[],
  result: EvaluationResultInput,
): EvaluationMetrics {
  const errorEntries = entries.filter(isErrorEntry);
  const normalEntries = entries.filter((entry) => entry.entry.kind === "normal");

  // 抑制された指摘は利用者に指摘として出ないため、検出・誤検出・再確認の 4 区分の
  // どの集合にも入れない（決定 8）。`suppression` の 3 つの数にだけ現れる。
  const suppressedInputs = result.findings.filter((input) => input.suppression !== null);
  const evaluatedInputs = result.findings.filter((input) => input.suppression === null);

  // 再確認後の集合からは `done` かつ `withdraw` の指摘**だけ**を除く。`failed` / `pending` /
  // `disabled` は未検証の初回指摘として残す（再確認できなかったことは、その指摘が消えることを
  // 意味しない。決定 7）。
  const beforeFindings = evaluatedInputs.map(toScoredFinding);
  const afterFindings = evaluatedInputs.filter((input) => !isWithdrawn(input)).map(toScoredFinding);

  const beforeRecheck = scoreFindingSet(errorEntries, normalEntries, beforeFindings);
  const afterRecheck = scoreFindingSet(errorEntries, normalEntries, afterFindings);

  // 4 区分の母集団は `status === "done"` の再確認だけ。`failed` / `pending` / `disabled` は
  // `kept*` に混ぜず、`recheckFailed` / `recheckPending` / `recheckDisabled` として別に出す。
  let withdrewTruePositive = 0;
  let keptTruePositive = 0;
  let withdrewFalsePositive = 0;
  let keptFalsePositive = 0;
  for (const input of evaluatedInputs) {
    if (input.recheck.status !== "done") {
      continue;
    }
    const truePositive = overlapsAnyErrorEntry(input.finding.range, errorEntries);
    const withdrew = input.recheck.output.verdict === "withdraw";
    if (truePositive) {
      if (withdrew) withdrewTruePositive += 1;
      else keptTruePositive += 1;
    } else if (withdrew) {
      withdrewFalsePositive += 1;
    } else {
      keptFalsePositive += 1;
    }
  }

  const countStatus = (status: "failed" | "pending" | "disabled"): number =>
    evaluatedInputs.filter((input) => input.recheck.status === status).length;

  const suppressedTruth = suppressedInputs.filter((input) =>
    overlapsAnyErrorEntry(input.finding.range, errorEntries),
  );
  const suppressedNotTruth = suppressedInputs.filter(
    (input) => !overlapsAnyErrorEntry(input.finding.range, errorEntries),
  );
  const suppressedNormal = suppressedNotTruth.filter((input) =>
    normalEntries.some((entry) => overlaps(input.finding.range, entry.range)),
  );

  const unlocatedTotals = result.totals.unlocated;
  const unlocatedFailures =
    unlocatedTotals.notFound + unlocatedTotals.ambiguous + unlocatedTotals.outsideTarget;

  // 参考値（近似一致）。位置が確定しない指摘は利用者に位置として提示されないので、
  // **検出率には一切算入しない**（決定 8）。引用が空文字のときは判定しない。空の候補引用は
  // `truthQuote.includes("")` がつねに true になるため、全 error 項目に一致して参考値が
  // 膨らむ（決定 8 に空文字の規定が無いので「照合しない」と解釈した）。
  const unlocatedQuotingTruth = result.unlocated.filter((item) => {
    const quote = item.candidate.llm.quote;
    if (quote === "") return false;
    return errorEntries.some((entry) => {
      const truthQuote = entry.entry.quote;
      if (truthQuote === "") return false;
      return quote.includes(truthQuote) || truthQuote.includes(quote);
    });
  }).length;

  return {
    formatVersion: "1",
    truthEntryCounts: { error: errorEntries.length, normal: normalEntries.length },
    beforeRecheck,
    afterRecheck,
    recheckEffect: {
      withdrewTruePositive,
      keptTruePositive,
      withdrewFalsePositive,
      keptFalsePositive,
    },
    recheckFailed: countStatus("failed"),
    recheckPending: countStatus("pending"),
    recheckDisabled: countStatus("disabled"),
    suppression: {
      suppressedTruth: suppressedTruth.length,
      suppressedNormal: suppressedNormal.length,
      suppressedOther: suppressedNotTruth.length - suppressedNormal.length,
      suppressedFindingIds: suppressedInputs.map((input) => input.finding.id),
    },
    unlocated: {
      notFound: unlocatedTotals.notFound,
      ambiguous: unlocatedTotals.ambiguous,
      outsideTarget: unlocatedTotals.outsideTarget,
      failureRate: makeRate(unlocatedFailures, result.totals.candidates),
      unlocatedQuotingTruth,
      candidatesByTransform: countCandidatesByTransform(result.unlocated),
    },
    performance: {
      status: result.status,
      stopReason: result.stop === null ? null : result.stop.reason,
      startedAt: result.conditions.startedAt,
      finishedAt: result.conditions.finishedAt,
      requests: result.totals.requests,
      checkUnitsFailed: result.totals.checkUnits.failed,
      checkUnitsPending: result.totals.checkUnits.pending,
      elapsedMs: result.totals.elapsedMs,
    },
  };
}
