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

import type { ChatRequest, ChatResult, Usage } from "../lmstudio/types.ts";
import { buildCheckRequest, buildRecheckRequest } from "../prompts/build.ts";
import { parseCheckResponse, parseRecheckResponse } from "../prompts/parse.ts";
import type { GenerationSettings } from "../prompts/types.ts";
import type { ExecOutcome, ExecuteHooks, Executor } from "./executor.ts";
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
 * - `chat` 由来の `timeout` は、`treatUnconfirmedAsPending` が true のときだけ `pending` にする
 *   （決定 20）。ハード上限に達しても「生成終了を確認できない」だけで、応答が実際に来ないと
 *   決まったわけではないため、停止からの打ち切り（`aborted`）と同じ扱いにする。
 *
 * `treatUnconfirmedAsPending` は**呼び出し元が経路を明示するフラグ**である（決定 45-3）。
 * オーケストレーター（`run/loop.ts`）は常に true を渡し、CLI（`run/pipeline.ts`）は渡さない
 * （既定 false で従来どおり `failed`）。待機時間（`recoveryConfirmMs`）を判別子に使ってはならない：
 * 決定 43 は `SHUTEN_RECOVERY_CONFIRM_MS = 0` を正規の設定値として認めており、0 のときに
 * タイムアウトすると実行は `recovery-waiting` になるのに単位は `failed` になって、
 * 手動再開がその単位を拾えなくなる。
 */
function isPendingFailure(failure: UnitFailure, treatUnconfirmedAsPending: boolean): boolean {
  if (failure.origin !== "chat") {
    return true;
  }
  if (failure.reason === "model-not-loaded" || failure.reason === "aborted") {
    return true;
  }
  return treatUnconfirmedAsPending && failure.reason === "timeout";
}

/**
 * `pending` にする失敗の `note`（DB では `pending_note`）に入れる文言（決定 20・32）。
 *
 * 「生成要求を送った後に打ち切られた」2 つの経路だけは、既存の失敗メッセージ（「生成要求が
 * タイムアウトした」等）ではなく、決定 20 が定める「生成終了は未確認」の趣旨の文言に差し替える。
 *
 * - ハード上限超過（`timeout`）→「応答が上限内に届かなかった。生成終了は未確認」
 * - 停止操作による打ち切り（`aborted`）→「停止操作により打ち切った。生成終了は未確認」（決定 32）
 *
 * どちらも `origin === "chat"`（実際に送った）に限る。送信前に止めた `origin: "local"` の
 * `aborted`（キュー待ち・`ensureLoaded` 中の停止、門で止めた単位）は生成終了が未確認では
 * ないので、従来どおり失敗メッセージそのものを使う。`treatUnconfirmedAsPending` を条件に
 * 含めるのは、`runPipeline`（CLI）が `signal` を渡して中断したときの文言を変えないため（E1）。
 * `isPendingFailure` と同じく、判別子は待機時間ではなく呼び出し元が渡すフラグである（決定 45-3）。
 */
function pendingNote(failure: UnitFailure, treatUnconfirmedAsPending: boolean): string {
  if (treatUnconfirmedAsPending && failure.origin === "chat") {
    if (failure.reason === "timeout") {
      return "応答が上限内に届かなかった。生成終了は未確認";
    }
    if (failure.reason === "aborted") {
      return "停止操作により打ち切った。生成終了は未確認";
    }
  }
  return failure.message;
}

/**
 * `executor.execute` を、遅延通知（`onSlow`）付きで呼ぶ（決定 27）。
 *
 * 起点は「実際に生成要求を送った時点」（executor が `client.chat` を呼ぶ直前に呼ぶ `onSend`）。
 * `executor.execute` を呼んだ時点で張ると、共有キュー（`run/queue.ts`）での順番待ちの時間が
 * `checkMs`／`recheckMs` の計測に食い込んでしまうため。
 *
 * `recoveryConfirmMs` が 0 以下（既定）なら、従来どおり `budgetMs` をそのままタイムアウトとして渡す
 * （`onSlow` 用のタイマーは張らない）。`recoveryConfirmMs > 0` なら、ハード上限は
 * `budgetMs + recoveryConfirmMs` にし、送信のたびに（再試行を含む）タイマーを張り直して、
 * `budgetMs` 経過時点で `onSlow` を呼ぶ。応答が返る（成功・失敗を問わない）か例外が出たら、
 * そのタイマーは必ず解除する。
 *
 * `onSend` / `onSettled` は呼び出し元（ループの停止ゲート。決定 26）から渡される任意のフックで、
 * 自分の遅延通知タイマーと合成して executor に渡す。`recoveryConfirmMs` の値によらず、
 * 渡されていれば必ず executor に届ける（停止ゲートは CLI 経路では使われないが、
 * 渡す・渡さないの分岐を `recoveryConfirmMs` に結び付けると、停止ゲートを持たない
 * オーケストレーター経路が増えたときに破綻するため）。
 */
async function executeWithSlowNotice<T>(
  executor: Executor,
  request: ChatRequest,
  parse: (result: ChatResult) => T,
  budgetMs: number,
  recoveryConfirmMs: number,
  onSlow: ((elapsedMs: number) => void) | undefined,
  onSend: (() => void) | undefined,
  onSettled: (() => void) | undefined,
): Promise<ExecOutcome<T>> {
  if (recoveryConfirmMs <= 0) {
    // タイマーは張らないが、呼び出し元の onSend/onSettled はそのまま executor に渡す。
    return executor.execute(request, parse, budgetMs, { onSend, onSettled });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clearSlowTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }
  const hooks: ExecuteHooks = {
    onSend: () => {
      // 送信のたびに（再試行を含め、1 回の execute で最大 2 回）測り直す。前のタイマーが
      // 残っていれば解除してから張り直す。
      clearSlowTimer();
      if (onSlow !== undefined) {
        timer = setTimeout(() => {
          onSlow(budgetMs);
        }, budgetMs);
      }
      onSend?.();
    },
    onSettled: () => {
      clearSlowTimer();
      onSettled?.();
    },
  };
  try {
    return await executor.execute(request, parse, budgetMs + recoveryConfirmMs, hooks);
  } finally {
    // onSend が一度も呼ばれなかった（門で止まった等）場合の保険。
    clearSlowTimer();
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
  /**
   * 上限まで待つ時間。既定 0。0 ならハード上限は checkMs そのもの（決定 43 が認める正規の設定値）。
   * **経路の判別には使わない**（決定 45-3。それは treatUnconfirmedAsPending の役目）。
   */
  readonly recoveryConfirmMs?: number | undefined;
  /**
   * 打ち切られた単位を `pending` にするか（決定 20・45-3）。既定 false。
   * オーケストレーター（`run/loop.ts`）は常に true を渡し、CLI（`run/pipeline.ts`）は渡さない。
   */
  readonly treatUnconfirmedAsPending?: boolean | undefined;
  readonly executor: Executor;
  readonly createCandidateId: () => string;
  /**
   * checkMs を超えたときに呼ぶ。省略可。送信のたび（再試行を含め、1 回の execute で
   * 最大 2 回）に測り直すので、1 回目の送信も 2 回目の送信も checkMs を超えれば、
   * この execute で最大 2 回呼ばれうる（決定 27）。
   */
  readonly onSlow?: ((elapsedMs: number) => void) | undefined;
  /**
   * 停止ゲートの beginRequest 相当。executor が実際に生成要求を送る直前に呼ぶ（決定 27）。
   * 再試行のたびに呼ぶ。省略可（PR9b Task 7 でループが渡す）。
   */
  readonly onSend?: (() => void) | undefined;
  /** 停止ゲートの endRequest 相当。onSend と同数呼ばれる。省略可（PR9b Task 7 でループが渡す）。 */
  readonly onSettled?: (() => void) | undefined;
}

export interface CheckUnitOutcome {
  readonly unit: CheckUnitResult;
  readonly candidates: readonly Candidate[];
  /** unit.status が pending でも非 null になりうる（PR9b の決定 20 が使う）。 */
  readonly failure: UnitFailure | null;
  readonly halt: RunStop | null;
  /** executor.execute が計測した所要時間。unit.status が pending でも入る（PR9b の決定 20 が使う）。 */
  readonly elapsedMs: number;
  /** unit.status が pending でも取れたときは入る（PR9b の決定 20 が使う）。 */
  readonly usage: Usage | null;
}

/**
 * 1 検査単位（1 検査対象 × 1 観点）を実行する。生成要求 → 解析 → 位置確定 → 候補化までを行う。
 * DB も結果 JSON も知らない。`input` はすでに組み立て済みのものを受け取る
 * （入力超過の判定は呼び出し元の責務。決定は `pipeline.ts` を参照）。
 */
export async function executeCheckUnit(args: CheckUnitArgs): Promise<CheckUnitOutcome> {
  const recoveryConfirmMs = args.recoveryConfirmMs ?? 0;
  const treatUnconfirmedAsPending = args.treatUnconfirmedAsPending ?? false;
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
    recoveryConfirmMs,
    args.onSlow,
    args.onSend,
    args.onSettled,
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
    return {
      unit,
      candidates,
      failure: null,
      halt: null,
      elapsedMs: outcome.elapsedMs,
      usage: outcome.usage,
    };
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
  const unit: CheckUnitResult = isPendingFailure(outcome.failure, treatUnconfirmedAsPending)
    ? {
        status: "pending",
        targetIndex: args.targetIndex,
        perspective: args.perspective,
        attempts: outcome.attempts,
        note: pendingNote(outcome.failure, treatUnconfirmedAsPending),
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
  return {
    unit,
    candidates: [],
    failure: outcome.failure,
    halt,
    elapsedMs: outcome.elapsedMs,
    usage: outcome.usage,
  };
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
  /**
   * 上限まで待つ時間。既定 0。0 ならハード上限は recheckMs そのもの（決定 43 が認める正規の設定値）。
   * **経路の判別には使わない**（決定 45-3。それは treatUnconfirmedAsPending の役目）。
   */
  readonly recoveryConfirmMs?: number | undefined;
  /**
   * 打ち切られた単位を `pending` にするか（決定 20・45-3）。既定 false。
   * オーケストレーター（`run/loop.ts`）は常に true を渡し、CLI（`run/pipeline.ts`）は渡さない。
   */
  readonly treatUnconfirmedAsPending?: boolean | undefined;
  readonly executor: Executor;
  /**
   * recheckMs を超えたときに呼ぶ。省略可。送信のたび（再試行を含め、1 回の execute で
   * 最大 2 回）に測り直すので、1 回目の送信も 2 回目の送信も recheckMs を超えれば、
   * この execute で最大 2 回呼ばれうる（決定 27）。
   */
  readonly onSlow?: ((elapsedMs: number) => void) | undefined;
  /**
   * 停止ゲートの beginRequest 相当。executor が実際に生成要求を送る直前に呼ぶ（決定 27）。
   * 再試行のたびに呼ぶ。省略可（PR9b Task 7 でループが渡す）。
   */
  readonly onSend?: (() => void) | undefined;
  /** 停止ゲートの endRequest 相当。onSend と同数呼ばれる。省略可（PR9b Task 7 でループが渡す）。 */
  readonly onSettled?: (() => void) | undefined;
  /**
   * `buildRecheckInput` が成功し、実際に生成要求を送る直前に 1 回だけ呼ぶ。省略可。
   * `suppressed` で短絡したときや、`buildRecheckInput` が `InputTooLongError` を投げたときは呼ばない
   * （`pipeline.ts` がこれを使って `recheck-started` イベントを、要求を送るときだけ出す）。
   */
  readonly onStarted?: (() => void) | undefined;
}

export interface RecheckUnitOutcome {
  readonly result: RecheckResult;
  /** result.status が pending でも非 null になりうる（CheckUnitOutcome と同じ理由）。 */
  readonly failure: UnitFailure | null;
  readonly halt: RunStop | null;
  /**
   * executor.execute が計測した所要時間。result.status が pending でも入る
   * （CheckUnitOutcome と同じ理由）。suppressed で短絡したとき、および
   * buildRecheckInput が InputTooLongError を投げて生成要求を送らなかったときは 0。
   */
  readonly elapsedMs: number;
  /** result.status が pending でも取れたときは入る（CheckUnitOutcome と同じ理由）。 */
  readonly usage: Usage | null;
}

/**
 * 1 件の指摘の再確認単位を実行する。`mode !== "split-recheck"`（decision: disabled）と
 * 実行の停止判定（`stop !== null`）は呼び出し元（`pipeline.ts`）の責務で、この関数は呼ばれない。
 * `suppressed` だけはこの関数が短絡する（ブリーフの推奨どおり）。
 */
export async function executeRecheckUnit(args: RecheckUnitArgs): Promise<RecheckUnitOutcome> {
  const recoveryConfirmMs = args.recoveryConfirmMs ?? 0;
  const treatUnconfirmedAsPending = args.treatUnconfirmedAsPending ?? false;
  if (args.suppressed) {
    return {
      result: { status: "suppressed" },
      failure: null,
      halt: null,
      elapsedMs: 0,
      usage: null,
    };
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
      elapsedMs: 0,
      usage: null,
    };
  }

  args.onStarted?.();
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
    recoveryConfirmMs,
    args.onSlow,
    args.onSend,
    args.onSettled,
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
      elapsedMs: outcome.elapsedMs,
      usage: outcome.usage,
    };
  }

  // LM Studio 由来の input-too-long（HTTP 400）も再確認では実行を止めない（決定 5(c)）。
  const halt = outcome.halt;
  if (isPendingFailure(outcome.failure, treatUnconfirmedAsPending)) {
    return {
      result: {
        status: "pending",
        attempts: outcome.attempts,
        inputRange: input.inputRange,
        note: pendingNote(outcome.failure, treatUnconfirmedAsPending),
      },
      failure: outcome.failure,
      halt,
      elapsedMs: outcome.elapsedMs,
      usage: outcome.usage,
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
    elapsedMs: outcome.elapsedMs,
    usage: outcome.usage,
  };
}
