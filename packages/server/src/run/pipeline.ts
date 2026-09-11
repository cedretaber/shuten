import type {
  Candidate,
  CheckInput,
  ChunkSettings,
  MergedFinding,
  Paragraph,
  Perspective,
  TargetRange,
} from "@shuten/shared";
import {
  ALLOWED_WORD_RULE_VERSION,
  buildCheckInput,
  countGraphemes,
  DIAGNOSTIC_TRANSFORM_VERSION,
  findSuppression,
  InputTooLongError,
  InvalidChunkSettingsError,
  mergeCandidates,
  PROMPT_VERSION,
  partitionCandidates,
  planTargets,
  sliceRange,
  splitParagraphs,
  validateChunkSettings,
} from "@shuten/shared";

import { hashBody } from "../hash.ts";
import type { LmStudioClient } from "../lmstudio/types.ts";
import type { GenerationSettings } from "../prompts/types.ts";
import { splitAllowedWords } from "./allowed-words.ts";
import type { PipelineEvent } from "./events.ts";
import { createExecutor } from "./executor.ts";
import type {
  CheckUnitResult,
  FindingResult,
  PipelineMode,
  PipelineResult,
  PipelineRunStatus,
  RecheckResult,
  RunStop,
  TargetPlan,
  UnlocatedResult,
} from "./result.ts";
import { RESULT_VERSION } from "./result.ts";
import { executeCheckUnit, executeRecheckUnit, localFailure } from "./units.ts";

export interface PipelineArgs {
  /** 保存本文（BOM 除外済み）。段落はここから splitParagraphs で導く。 */
  readonly text: string;
  readonly mode: PipelineMode;
  readonly perspectives: readonly Perspective[];
  /** 改行区切りの生の文字列。分割・trim・重複除去はパイプラインが行う（決定 7）。 */
  readonly allowedWordsRaw: string;
  readonly generation: GenerationSettings;
  readonly chunkSettings: ChunkSettings;
  readonly timeouts: { readonly checkMs: number; readonly recheckMs: number };
  readonly client: LmStudioClient;
  /** 候補の ID 生成。既定は実行全体で 1 本の連番 c1, c2, …（決定 9）。 */
  readonly createCandidateId?: (() => string) | undefined;
  /** 統合後の指摘の ID 生成。既定は実行全体で 1 本の連番 f1, f2, …。 */
  readonly createFindingId?: (() => string) | undefined;
  /** 時刻。既定は Date.now。 */
  readonly now?: (() => number) | undefined;
  readonly onEvent?: ((event: PipelineEvent) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** 既定の ID 採番器。実行全体で 1 本だけ作る（決定 9）。 */
function createSequentialId(prefix: string): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `${prefix}${String(count)}`;
  };
}

/** `full-text` 方式の検査対象（決定 8）。本文が空なら planTargets と同じく 0 件。 */
function planFullTextTargets(text: string, paragraphs: readonly Paragraph[]): TargetRange[] {
  if (text.length === 0) {
    return [];
  }
  return [
    {
      index: 0,
      range: { start: 0, end: text.length },
      paragraphIds: paragraphs.map((paragraph) => paragraph.id),
    },
  ];
}

/**
 * `full-text` 方式の `CheckInput`（決定 8）。参考文脈は持たず、入力範囲は本文全体。
 * `shared` の非公開関数を使えないので、上限検査はここで行う（本文は縮めない）。
 */
function buildFullTextInput(
  text: string,
  target: TargetRange,
  settings: ChunkSettings,
): CheckInput {
  const required = countGraphemes(sliceRange(text, target.range));
  if (required > settings.maxInputGraphemes) {
    throw new InputTooLongError(required, settings.maxInputGraphemes);
  }
  return { target, context: { before: null, after: null }, inputRange: target.range };
}

export async function runPipeline(args: PipelineArgs): Promise<PipelineResult> {
  const now = args.now ?? Date.now;
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();

  /** コールバックの例外はパイプラインを壊さない（決定 10）。 */
  const emit = (event: PipelineEvent): void => {
    const onEvent = args.onEvent;
    if (onEvent === undefined) {
      return;
    }
    try {
      onEvent(event);
    } catch {
      // 進捗通知の失敗で実行を止めない。
    }
  };

  const allowedWords = splitAllowedWords(args.allowedWordsRaw);
  const paragraphs = splitParagraphs(args.text);
  const createCandidateId = args.createCandidateId ?? createSequentialId("c");
  const createFindingId = args.createFindingId ?? createSequentialId("f");
  const executor = createExecutor(args.client, {
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
    now,
  });

  const targetPlans: TargetPlan[] = [];
  const checkUnits: CheckUnitResult[] = [];
  const findings: FindingResult[] = [];
  const unlocated: UnlocatedResult[] = [];
  let candidateCount = 0;
  let stop: RunStop | null = null;

  /** 結果を組み立てる。停止・正常終了のどちらもここを通る。 */
  const finish = (targetCount: number): PipelineResult => {
    const finishedAtMs = now();
    const status: PipelineRunStatus =
      stop !== null
        ? "stopped"
        : checkUnits.some((unit) => unit.status === "failed") ||
            findings.some((finding) => finding.recheck.status === "failed")
          ? "partially-failed"
          : "completed";
    const result: PipelineResult = {
      status,
      stop,
      conditions: {
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        mode: args.mode,
        perspectives: args.perspectives,
        generation: args.generation,
        model: executor.modelInfo,
        chunkSettings: args.chunkSettings,
        timeouts: args.timeouts,
        allowedWords,
        versions: {
          result: RESULT_VERSION,
          prompt: PROMPT_VERSION,
          allowedWordRule: ALLOWED_WORD_RULE_VERSION,
          diagnosticTransform: DIAGNOSTIC_TRANSFORM_VERSION,
        },
        manuscript: {
          utf16Length: args.text.length,
          graphemeCount: countGraphemes(args.text),
          paragraphCount: paragraphs.length,
          targetCount,
          bodyHash: hashBody(args.text),
        },
      },
      targets: targetPlans,
      checkUnits,
      findings,
      unlocated,
      totals: {
        targets: targetCount,
        checkUnits: {
          done: checkUnits.filter((unit) => unit.status === "done").length,
          failed: checkUnits.filter((unit) => unit.status === "failed").length,
          pending: checkUnits.filter((unit) => unit.status === "pending").length,
        },
        requests: executor.requestCount,
        candidates: candidateCount,
        located: findings.reduce((sum, entry) => sum + entry.finding.sources.length, 0),
        unlocated: {
          notFound: unlocated.filter((entry) => entry.candidate.locate.reason === "not-found")
            .length,
          ambiguous: unlocated.filter((entry) => entry.candidate.locate.reason === "ambiguous")
            .length,
          outsideTarget: unlocated.filter(
            (entry) => entry.candidate.locate.reason === "outside-target",
          ).length,
        },
        findings: findings.length,
        suppressed: findings.filter((entry) => entry.suppression !== null).length,
        rechecks: {
          done: findings.filter((entry) => entry.recheck.status === "done").length,
          failed: findings.filter((entry) => entry.recheck.status === "failed").length,
          pending: findings.filter((entry) => entry.recheck.status === "pending").length,
          suppressed: findings.filter((entry) => entry.recheck.status === "suppressed").length,
          disabled: findings.filter((entry) => entry.recheck.status === "disabled").length,
        },
        elapsedMs: finishedAtMs - startedAtMs,
      },
    };
    emit({ type: "run-finished", status: result.status, stop: result.stop });
    return result;
  };

  // 設定値の検証は最初に行う（決定 5(c)）。targets も checkUnits も空のまま停止する。
  let targets: readonly TargetRange[];
  try {
    validateChunkSettings(args.chunkSettings);
    targets =
      args.mode === "full-text"
        ? planFullTextTargets(args.text, paragraphs)
        : planTargets(args.text, paragraphs, args.chunkSettings);
  } catch (error) {
    if (!(error instanceof InvalidChunkSettingsError)) {
      throw error;
    }
    emit({ type: "run-started", targetCount: 0, unitCount: 0 });
    stop = {
      reason: "settings",
      message: `分割設定が不正なため実行を開始できなかった: ${error.message}`,
      failure: null,
      generationUnconfirmed: false,
    };
    return finish(0);
  }

  emit({
    type: "run-started",
    targetCount: targets.length,
    unitCount: targets.length * args.perspectives.length,
  });

  /** 停止済みで送信しなかった検査単位。 */
  const pendingUnit = (
    targetIndex: number,
    perspective: Perspective,
    note: string,
  ): CheckUnitResult => ({ status: "pending", targetIndex, perspective, attempts: 0, note });

  /**
   * 1 件の指摘の再確認（決定 2 の手順 7）。disabled / suppressed / 停止済みの判定はここで行い、
   * 実際に要求を送る場合だけ `executeRecheckUnit`（`run/units.ts`）を呼ぶ。
   */
  const runRecheck = async (
    finding: MergedFinding,
    initialInput: CheckInput,
    suppressed: boolean,
  ): Promise<RecheckResult> => {
    if (args.mode !== "split-recheck") {
      return { status: "disabled" };
    }
    if (suppressed) {
      return { status: "suppressed" };
    }
    if (stop !== null) {
      return {
        status: "pending",
        attempts: 0,
        inputRange: null,
        note: "実行が停止したため再確認の要求を送らなかった",
      };
    }

    const outcome = await executeRecheckUnit({
      text: args.text,
      paragraphs,
      finding,
      initialInput,
      suppressed: false,
      chunkSettings: args.chunkSettings,
      allowedWords,
      generation: args.generation,
      recheckMs: args.timeouts.recheckMs,
      executor,
      // buildRecheckInput が成功し、実際に要求を送る直前にだけ recheck-started を出す
      // （InputTooLongError で送らずに終わるときは出さない。抽出前と同じ挙動）。
      onStarted: () => {
        emit({ type: "recheck-started", findingId: finding.id });
      },
    });
    if (outcome.halt !== null) {
      stop ??= outcome.halt;
    }
    return outcome.result;
  };

  // 検査対象は index 昇順、対象内は perspectives の指定順（決定 2）。
  for (const target of targets) {
    if (stop !== null) {
      for (const perspective of args.perspectives) {
        const unit = pendingUnit(
          target.index,
          perspective,
          "実行が停止したため生成要求を送らなかった",
        );
        checkUnits.push(unit);
        emit({ type: "check-finished", result: unit });
      }
      continue;
    }

    let input: CheckInput;
    try {
      input =
        args.mode === "full-text"
          ? buildFullTextInput(args.text, target, args.chunkSettings)
          : buildCheckInput(args.text, paragraphs, target, args.chunkSettings);
    } catch (error) {
      if (!(error instanceof InputTooLongError)) {
        throw error;
      }
      // 初回検査の入力が上限を超えたら設定を直してもらう（決定 5(c)）。本文は縮めない。
      const failure = localFailure("input-too-long", error.message);
      stop = {
        reason: "settings",
        message: "初回検査の入力が上限を超えたため実行を停止した",
        failure,
        generationUnconfirmed: false,
      };
      for (const perspective of args.perspectives) {
        const unit: CheckUnitResult = {
          status: "failed",
          targetIndex: target.index,
          perspective,
          attempts: 0,
          failure,
          usage: null,
          inputGraphemes: error.required,
          elapsedMs: 0,
        };
        checkUnits.push(unit);
        emit({ type: "check-finished", result: unit });
      }
      continue;
    }

    targetPlans.push({ target, input });
    const candidates: Candidate[] = [];

    for (const perspective of args.perspectives) {
      if (stop !== null) {
        const unit = pendingUnit(
          target.index,
          perspective,
          "実行が停止したため生成要求を送らなかった",
        );
        checkUnits.push(unit);
        emit({ type: "check-finished", result: unit });
        continue;
      }

      emit({ type: "check-started", targetIndex: target.index, perspective });
      const outcome = await executeCheckUnit({
        text: args.text,
        paragraphs,
        input,
        targetIndex: target.index,
        perspective,
        allowedWords,
        generation: args.generation,
        checkMs: args.timeouts.checkMs,
        executor,
        createCandidateId,
      });
      if (outcome.halt !== null) {
        stop ??= outcome.halt;
      }
      candidateCount += outcome.candidates.length;
      candidates.push(...outcome.candidates);
      checkUnits.push(outcome.unit);
      emit({ type: "check-finished", result: outcome.unit });
    }

    // 停止していても、その対象ですでに成功した観点の応答は捨てない（決定 5「停止した対象の後処理」）。
    const partitioned = partitionCandidates(candidates);
    for (const candidate of partitioned.unlocated) {
      unlocated.push({ targetIndex: target.index, candidate });
    }
    const merged = mergeCandidates(partitioned.located, createFindingId);
    emit({ type: "target-merged", targetIndex: target.index, findingCount: merged.length });

    for (const finding of merged) {
      const suppression = findSuppression(finding, allowedWords);
      const recheck = await runRecheck(finding, input, suppression !== null);
      findings.push({ targetIndex: target.index, finding, suppression, recheck });
      if (recheck.status !== "disabled" && recheck.status !== "suppressed") {
        emit({ type: "recheck-finished", findingId: finding.id, result: recheck });
      }
    }
  }

  return finish(targets.length);
}
