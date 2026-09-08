import type {
  Candidate,
  CheckInput,
  ChunkSettings,
  MergedFinding,
  Paragraph,
  Perspective,
} from "@shuten/shared";
import {
  buildRecheckInput,
  countGraphemes,
  InputTooLongError,
  locateQuote,
  sliceRange,
} from "@shuten/shared";

import type { ChatRequest, ChatResult } from "../lmstudio/types.ts";
import { buildCheckRequest, buildRecheckRequest } from "../prompts/build.ts";
import { parseCheckResponse, parseRecheckResponse } from "../prompts/parse.ts";
import type { GenerationSettings } from "../prompts/types.ts";
import type { ExecOutcome, Executor } from "./executor.ts";
import type { CheckUnitResult, RecheckResult, RunStop, UnitFailure } from "./result.ts";

/**
 * 送信前の例外（`origin: "local"`）を `UnitFailure` にする。`pipeline.ts` の
 * 初回検査の入力超過（`buildCheckInput`/`buildFullTextInput` 由来）と、このファイルの
 * 再確認の入力超過（`buildRecheckInput` 由来）の両方が使う。
 */
export function localFailure(reason: UnitFailure["reason"], message: string): UnitFailure {
  return { reason, message, finishReason: null, origin: "local" };
}

/**
 * executor が返した失敗が「未完了（`pending`）」か「失敗（`failed`）」かを決める。
 * `failure.reason` だけでは決められない（門で止めた単位の理由は停止理由によらず `aborted` になる）。
 *
 * - `origin` が `chat` 以外：生成要求を送っていない（門で止めた）か、`ensureLoaded` 由来。
 *   決定 5(b) のとおり当該単位は未完了のまま残す。
 * - `chat` 由来でも `model-not-loaded`（実行中のアンロード）と `aborted`（停止操作）は
 *   失敗ではない（仕様書 7 節・8.2 節）。
 */
function isPendingFailure(failure: UnitFailure): boolean {
  if (failure.origin !== "chat") {
    return true;
  }
  return failure.reason === "model-not-loaded" || failure.reason === "aborted";
}

/**
 * `executor.execute` を、遅延通知（`onSlow`）付きで呼ぶ。
 *
 * `recoveryConfirmMs` が 0 以下（既定）なら、従来どおり `budgetMs` をそのままタイムアウトとして渡す
 * （`onSlow` は使わない）。`recoveryConfirmMs > 0` なら、ハード上限は `budgetMs + recoveryConfirmMs` にし、
 * `budgetMs` 経過時点で `onSlow` を 1 回だけ呼ぶ。応答が返る（成功・失敗を問わない）か例外が出たら、
 * このタイマーは必ず解除する。
 */
async function executeWithSlowNotice<T>(
  executor: Executor,
  request: ChatRequest,
  parse: (result: ChatResult) => T,
  budgetMs: number,
  recoveryConfirmMs: number,
  onSlow: ((elapsedMs: number) => void) | undefined,
): Promise<ExecOutcome<T>> {
  if (recoveryConfirmMs <= 0) {
    return executor.execute(request, parse, budgetMs);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (onSlow !== undefined) {
    timer = setTimeout(() => {
      onSlow(budgetMs);
    }, budgetMs);
  }
  try {
    return await executor.execute(request, parse, budgetMs + recoveryConfirmMs);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export interface CheckUnitArgs {
  readonly text: string;
  readonly paragraphs: readonly Paragraph[];
  readonly input: CheckInput;
  readonly targetIndex: number;
  readonly perspective: Perspective;
  readonly allowedWords: readonly string[];
  readonly generation: GenerationSettings;
  /** 遅延通知の閾値。ハード上限は checkMs + recoveryConfirmMs。 */
  readonly checkMs: number;
  /** 既定 0。0 ならハード上限は checkMs そのもの（従来の挙動）。 */
  readonly recoveryConfirmMs?: number | undefined;
  readonly executor: Executor;
  readonly createCandidateId: () => string;
  /** checkMs を超えたときに 1 回だけ呼ぶ。省略可。 */
  readonly onSlow?: ((elapsedMs: number) => void) | undefined;
}

export interface CheckUnitOutcome {
  readonly unit: CheckUnitResult;
  readonly candidates: readonly Candidate[];
  /** unit.status が pending でも非 null になりうる（PR9b の決定 20 が使う）。 */
  readonly failure: UnitFailure | null;
  readonly halt: RunStop | null;
}

/**
 * 1 検査単位（1 検査対象 × 1 観点）を実行する。生成要求 → 解析 → 位置確定 → 候補化までを行う。
 * DB も結果 JSON も知らない。`input` はすでに組み立て済みのものを受け取る
 * （入力超過の判定は呼び出し元の責務。決定は `pipeline.ts` を参照）。
 */
export async function executeCheckUnit(args: CheckUnitArgs): Promise<CheckUnitOutcome> {
  const inputGraphemes = countGraphemes(sliceRange(args.text, args.input.inputRange));
  const request = buildCheckRequest({
    text: args.text,
    paragraphs: args.paragraphs,
    input: args.input,
    perspective: args.perspective,
    allowedWords: args.allowedWords,
    generation: args.generation,
  });
  const outcome = await executeWithSlowNotice(
    args.executor,
    request,
    parseCheckResponse,
    args.checkMs,
    args.recoveryConfirmMs ?? 0,
    args.onSlow,
  );

  if (outcome.ok) {
    const candidates: Candidate[] = [];
    for (const llm of outcome.value.findings) {
      // 位置確定は、その指摘を生んだ要求と同じ CheckInput で行う（決定 3）。
      const locate = locateQuote(args.text, args.input, args.paragraphs, llm);
      const id = args.createCandidateId();
      // 分岐は冗長に見えるが必要。TypeScript は Candidate のネストした locate.status を
      // 自動で絞り込めないので、分岐ごとに locate を絞ってから組み立てる
      // （shared/src/merge/candidate.ts の isLocated と同じ理由）。
      candidates.push(
        locate.status === "located"
          ? { id, perspective: args.perspective, llm, locate }
          : { id, perspective: args.perspective, llm, locate },
      );
    }
    const unit: CheckUnitResult = {
      status: "done",
      targetIndex: args.targetIndex,
      perspective: args.perspective,
      attempts: outcome.attempts,
      usage: outcome.usage,
      inputGraphemes,
      elapsedMs: outcome.elapsedMs,
      findingCount: outcome.value.findings.length,
    };
    return { unit, candidates, failure: null, halt: null };
  }

  let halt = outcome.halt;
  if (halt === null && outcome.failure.reason === "input-too-long") {
    // executor は初回検査か再確認かを知らないので、停止の判断はここで行う（決定 5(a)）。
    halt = {
      reason: "settings",
      message: "初回検査の入力が LM Studio の上限を超えたため実行を停止した",
      failure: outcome.failure,
      generationUnconfirmed: false,
    };
  }
  const unit: CheckUnitResult = isPendingFailure(outcome.failure)
    ? {
        status: "pending",
        targetIndex: args.targetIndex,
        perspective: args.perspective,
        attempts: outcome.attempts,
        note: outcome.failure.message,
      }
    : {
        status: "failed",
        targetIndex: args.targetIndex,
        perspective: args.perspective,
        attempts: outcome.attempts,
        failure: outcome.failure,
        usage: outcome.usage,
        inputGraphemes,
        elapsedMs: outcome.elapsedMs,
      };
  return { unit, candidates: [], failure: outcome.failure, halt };
}

export interface RecheckUnitArgs {
  readonly text: string;
  readonly paragraphs: readonly Paragraph[];
  readonly finding: MergedFinding;
  /** その指摘を生んだ初回検査の CheckInput。buildRecheckInput の起点になる。 */
  readonly initialInput: CheckInput;
  /** 許容語で抑制済みか。true なら生成要求を送らず {status: "suppressed"} を返す。 */
  readonly suppressed: boolean;
  readonly chunkSettings: ChunkSettings;
  readonly allowedWords: readonly string[];
  readonly generation: GenerationSettings;
  /** 遅延通知の閾値。ハード上限は recheckMs + recoveryConfirmMs。 */
  readonly recheckMs: number;
  /** 既定 0。0 ならハード上限は recheckMs そのもの（従来の挙動）。 */
  readonly recoveryConfirmMs?: number | undefined;
  readonly executor: Executor;
  /** recheckMs を超えたときに 1 回だけ呼ぶ。省略可。 */
  readonly onSlow?: ((elapsedMs: number) => void) | undefined;
}

export interface RecheckUnitOutcome {
  readonly result: RecheckResult;
  /** result.status が pending でも非 null になりうる（CheckUnitOutcome と同じ理由）。 */
  readonly failure: UnitFailure | null;
  readonly halt: RunStop | null;
}

/**
 * 1 件の指摘の再確認単位を実行する。`mode !== "split-recheck"`（decision: disabled）と
 * 実行の停止判定（`stop !== null`）は呼び出し元（`pipeline.ts`）の責務で、この関数は呼ばれない。
 * `suppressed` だけはこの関数が短絡する（ブリーフの推奨どおり）。
 */
export async function executeRecheckUnit(args: RecheckUnitArgs): Promise<RecheckUnitOutcome> {
  if (args.suppressed) {
    return { result: { status: "suppressed" }, failure: null, halt: null };
  }

  let input: CheckInput;
  try {
    input = buildRecheckInput(args.text, args.paragraphs, args.initialInput, args.chunkSettings);
  } catch (error) {
    if (!(error instanceof InputTooLongError)) {
      throw error;
    }
    // 再確認は指摘 1 件ごとに独立しているので、この再確認だけ失敗にして実行は続ける（決定 5(c)）。
    const failure = localFailure("input-too-long", error.message);
    return {
      result: {
        status: "failed",
        attempts: 0,
        failure,
        usage: null,
        inputRange: null,
        elapsedMs: null,
      },
      failure,
      halt: null,
    };
  }

  const request = buildRecheckRequest({
    text: args.text,
    paragraphs: args.paragraphs,
    input,
    finding: args.finding,
    allowedWords: args.allowedWords,
    generation: args.generation,
  });
  const outcome = await executeWithSlowNotice(
    args.executor,
    request,
    parseRecheckResponse,
    args.recheckMs,
    args.recoveryConfirmMs ?? 0,
    args.onSlow,
  );

  if (outcome.ok) {
    return {
      result: {
        status: "done",
        attempts: outcome.attempts,
        output: outcome.value,
        usage: outcome.usage,
        inputRange: input.inputRange,
        inputGraphemes: countGraphemes(sliceRange(args.text, input.inputRange)),
        elapsedMs: outcome.elapsedMs,
      },
      failure: null,
      halt: null,
    };
  }

  // LM Studio 由来の input-too-long（HTTP 400）も再確認では実行を止めない（決定 5(c)）。
  const halt = outcome.halt;
  if (isPendingFailure(outcome.failure)) {
    return {
      result: {
        status: "pending",
        attempts: outcome.attempts,
        inputRange: input.inputRange,
        note: outcome.failure.message,
      },
      failure: outcome.failure,
      halt,
    };
  }
  return {
    result: {
      status: "failed",
      attempts: outcome.attempts,
      failure: outcome.failure,
      usage: outcome.usage,
      inputRange: input.inputRange,
      elapsedMs: outcome.elapsedMs,
    },
    failure: outcome.failure,
    halt,
  };
}
