import type {
  Candidate,
  CheckInput,
  ChunkSettings,
  MergedFinding,
  Paragraph,
  TargetRange,
} from "@shuten/shared";
import { splitParagraphs } from "@shuten/shared";
import { describe, expect, it, vi } from "vitest";

import type { ChatRequest, ChatResult } from "../lmstudio/types.ts";
import type { GenerationSettings } from "../prompts/types.ts";
import type { ExecOutcome, ExecuteHooks, Executor } from "./executor.ts";
import type { RunStop, UnitFailure } from "./result.ts";
import type { CheckUnitArgs, RecheckUnitArgs } from "./units.ts";
import { executeCheckUnit, executeRecheckUnit, localFailure } from "./units.ts";

const TEXT = "吾輩は猫である。名前はまだ無い。";
const PARAGRAPHS: readonly Paragraph[] = splitParagraphs(TEXT);
const TARGET: TargetRange = {
  index: 0,
  range: { start: 0, end: TEXT.length },
  paragraphIds: PARAGRAPHS.map((paragraph) => paragraph.id),
};
const INPUT: CheckInput = {
  target: TARGET,
  context: { before: null, after: null },
  inputRange: TARGET.range,
};
const SETTINGS: ChunkSettings = {
  targetGraphemes: 20,
  contextGraphemes: 0,
  recheckContextGraphemes: 0,
  roundingTolerance: 0.2,
  maxInputGraphemes: 200,
};
const GENERATION: GenerationSettings = {
  model: "test-model",
  maxTokens: 1024,
  temperature: 0,
};

const DONE_OUTCOME: ExecOutcome<{ findings: [] }> = {
  ok: true,
  value: { findings: [] },
  attempts: 1,
  usage: null,
  elapsedMs: 0,
};

const CHAT_FAILURE: UnitFailure = {
  reason: "timeout",
  message: "生成要求がタイムアウトした",
  finishReason: null,
  origin: "chat",
};

/** `ensureLoaded`（門で止めた／`chat` を送っていない）由来の失敗。常に pending 扱い（決定 5(b)）。 */
const ENSURE_LOADED_FAILURE: UnitFailure = {
  reason: "model-not-loaded",
  message: "モデルのロード状態を確認できず（未ロード）実行を停止した",
  finishReason: null,
  origin: "ensure-loaded",
};

/** `chat` 由来でも停止操作（aborted）は失敗ではなく pending 扱い（仕様書 7 節・8.2 節）。 */
const ABORTED_CHAT_FAILURE: UnitFailure = {
  reason: "aborted",
  message: "生成要求が中断されたため実行を停止した",
  finishReason: null,
  origin: "chat",
};

/**
 * `executor.execute` を差し替えたフェイク。渡された `timeoutMs` を記録する。
 * キュー待ちなし（`execute` が呼ばれたら即座に送信する）を模して、呼ばれた直後に
 * `hooks.onSend` を、解決したら `hooks.onSettled` を呼ぶ（決定 27）。キュー待ちそのものを
 * 検査したいテストは `createQueueAwareFakeExecutor` を使う。
 */
function createFakeExecutor<T>(resolve: (timeoutMs: number) => Promise<ExecOutcome<T>>): {
  readonly executor: Executor;
  readonly timeoutCalls: number[];
} {
  const timeoutCalls: number[] = [];
  function execute<U>(
    _request: ChatRequest,
    _parse: (result: ChatResult) => U,
    timeoutMs: number,
    hooks?: ExecuteHooks,
  ): Promise<ExecOutcome<U>> {
    timeoutCalls.push(timeoutMs);
    hooks?.onSend?.();
    const result = resolve(timeoutMs) as unknown as Promise<ExecOutcome<U>>;
    void result.finally(() => {
      hooks?.onSettled?.();
    });
    return result;
  }
  return { executor: { execute, requestCount: 0, modelInfo: null }, timeoutCalls };
}

/**
 * 共有キューでの順番待ちを模したフェイク executor（決定 27 の G1・G2 用）。
 * `execute` が呼ばれてから `queueWaitMs` 経ってはじめて `hooks.onSend` を呼び、
 * その直後に `resolve` の結果で解決して `hooks.onSettled` を呼ぶ。
 * 「呼ばれた時点」と「実際に送信した時点」がずれることを、遅延通知のタイマーで確かめられる。
 */
function createQueueAwareFakeExecutor<T>(
  resolve: () => Promise<ExecOutcome<T>>,
  queueWaitMs: number,
): { readonly executor: Executor } {
  function execute<U>(
    _request: ChatRequest,
    _parse: (result: ChatResult) => U,
    _timeoutMs: number,
    hooks?: ExecuteHooks,
  ): Promise<ExecOutcome<U>> {
    return new Promise((res) => {
      setTimeout(() => {
        hooks?.onSend?.();
        void (resolve() as unknown as Promise<ExecOutcome<U>>).then((outcome) => {
          hooks?.onSettled?.();
          res(outcome);
        });
      }, queueWaitMs);
    });
  }
  return { executor: { execute, requestCount: 0, modelInfo: null } };
}

/** `execute` に渡された hooks を記録するフェイク executor（決定 27 の G3 用）。 */
function createHookCapturingExecutor<T>(resolve: () => Promise<ExecOutcome<T>>): {
  readonly executor: Executor;
  readonly hooksCalls: (ExecuteHooks | undefined)[];
} {
  const hooksCalls: (ExecuteHooks | undefined)[] = [];
  function execute<U>(
    _request: ChatRequest,
    _parse: (result: ChatResult) => U,
    _timeoutMs: number,
    hooks?: ExecuteHooks,
  ): Promise<ExecOutcome<U>> {
    hooksCalls.push(hooks);
    return resolve() as unknown as Promise<ExecOutcome<U>>;
  }
  return { executor: { execute, requestCount: 0, modelInfo: null }, hooksCalls };
}

const RECHECK_DONE_OUTCOME: ExecOutcome<{
  reason: string;
  reasonKind: string;
  verdict: string;
  suggestionValid: boolean;
}> = {
  ok: true,
  value: {
    reason: "実在する誤字である",
    reasonKind: "error-confirmed",
    verdict: "keep",
    suggestionValid: true,
  },
  attempts: 1,
  usage: null,
  elapsedMs: 0,
};

/** 外から解決できる Promise。フェイクタイマーで応答到着のタイミングを制御する。 */
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolveFn: (value: T) => void = () => {
    throw new Error("resolve が呼ばれる前に参照された");
  };
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
}

function baseCheckArgs(executor: Executor, overrides: Partial<CheckUnitArgs> = {}): CheckUnitArgs {
  return {
    text: TEXT,
    paragraphs: PARAGRAPHS,
    input: INPUT,
    targetIndex: 0,
    perspective: "typo",
    allowedWords: [],
    generation: GENERATION,
    checkMs: 1000,
    executor,
    createCandidateId: (() => {
      let count = 0;
      return () => {
        count += 1;
        return `c${String(count)}`;
      };
    })(),
    ...overrides,
  };
}

const FINDING: MergedFinding = {
  id: "f1",
  range: { start: 0, end: 2 },
  quote: "吾輩",
  category: "notation",
  suggestion: "私",
  verdict: "likely-error",
  sources: [],
};

function baseRecheckArgs(
  executor: Executor,
  overrides: Partial<RecheckUnitArgs> = {},
): RecheckUnitArgs {
  return {
    text: TEXT,
    paragraphs: PARAGRAPHS,
    finding: FINDING,
    initialInput: INPUT,
    suppressed: false,
    chunkSettings: SETTINGS,
    allowedWords: [],
    generation: GENERATION,
    recheckMs: 1000,
    executor,
    ...overrides,
  };
}

describe("executeCheckUnit", () => {
  it("U1: recoveryConfirmMs 省略時、executor.execute に渡るタイムアウトが checkMs と等しい", async () => {
    const { executor, timeoutCalls } = createFakeExecutor(() => Promise.resolve(DONE_OUTCOME));

    const outcome = await executeCheckUnit(baseCheckArgs(executor, { checkMs: 1234 }));

    expect(timeoutCalls).toEqual([1234]);
    expect(outcome.unit.status).toBe("done");
    expect(outcome.halt).toBeNull();
  });

  it("U2: recoveryConfirmMs > 0 のとき、渡るタイムアウトが checkMs + recoveryConfirmMs になる", async () => {
    const { executor, timeoutCalls } = createFakeExecutor(() => Promise.resolve(DONE_OUTCOME));

    await executeCheckUnit(baseCheckArgs(executor, { checkMs: 1000, recoveryConfirmMs: 500 }));

    expect(timeoutCalls).toEqual([1500]);
  });

  it("U3: checkMs 経過で onSlow がちょうど 1 回呼ばれる（フェイクタイマー）", async () => {
    vi.useFakeTimers();
    try {
      const onSlow = vi.fn();
      const pending = deferred<ExecOutcome<{ findings: [] }>>();
      const { executor } = createFakeExecutor(() => pending.promise);

      const outcomePromise = executeCheckUnit(
        baseCheckArgs(executor, { checkMs: 1000, recoveryConfirmMs: 500, onSlow }),
      );

      await vi.advanceTimersByTimeAsync(1000);
      expect(onSlow).toHaveBeenCalledTimes(1);
      expect(onSlow).toHaveBeenCalledWith(1000);

      pending.resolve(DONE_OUTCOME);
      await outcomePromise;
      // ハード上限（1500ms）まで進めても、onSlow は増えない（1 回だけ）。
      await vi.advanceTimersByTimeAsync(500);
      expect(onSlow).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("U4: checkMs 超過後・ハード上限前に応答が届けば unit.status が done になる", async () => {
    vi.useFakeTimers();
    try {
      const onSlow = vi.fn();
      const pending = deferred<ExecOutcome<{ findings: [] }>>();
      const { executor } = createFakeExecutor(() => pending.promise);

      const outcomePromise = executeCheckUnit(
        baseCheckArgs(executor, { checkMs: 1000, recoveryConfirmMs: 500, onSlow }),
      );

      // checkMs は超えたが、ハード上限（1500ms）にはまだ達していない時点で応答が届く。
      await vi.advanceTimersByTimeAsync(1200);
      expect(onSlow).toHaveBeenCalledTimes(1);
      pending.resolve(DONE_OUTCOME);

      const outcome = await outcomePromise;
      expect(outcome.unit.status).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("U5: checkMs より前に応答が返れば onSlow は呼ばれず、タイマーも残らない", async () => {
    vi.useFakeTimers();
    try {
      const onSlow = vi.fn();
      const { executor } = createFakeExecutor(() => Promise.resolve(DONE_OUTCOME));

      const outcome = await executeCheckUnit(
        baseCheckArgs(executor, { checkMs: 1000, recoveryConfirmMs: 500, onSlow }),
      );

      expect(outcome.unit.status).toBe("done");
      expect(onSlow).not.toHaveBeenCalled();

      // ハード上限を過ぎても呼ばれないなら、応答到着時にタイマーが解除された証拠になる。
      await vi.advanceTimersByTimeAsync(2000);
      expect(onSlow).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("G1: 共有キューでの順番待ちは checkMs の計測に含まれない（起点は実際の送信時点。決定 27）", async () => {
    vi.useFakeTimers();
    try {
      const onSlow = vi.fn();
      // checkMs（1000ms）を超えるキュー待ち（1500ms）をさせてから送信させる。
      const { executor } = createQueueAwareFakeExecutor(() => Promise.resolve(DONE_OUTCOME), 1500);

      const outcomePromise = executeCheckUnit(
        baseCheckArgs(executor, { checkMs: 1000, recoveryConfirmMs: 500, onSlow }),
      );

      // キュー待ち（1500ms）が checkMs（1000ms）を超えて進んでも、まだ送信していないので
      // onSlow は呼ばれない（起点が executor.execute の呼び出し時点のままだと、ここで
      // すでに 1 回呼ばれてしまう）。
      await vi.advanceTimersByTimeAsync(1500);
      expect(onSlow).not.toHaveBeenCalled();
      // 送信後の生成自体は速い（フェイク executor がすぐ解決する）ので、そのあと
      // checkMs 分進めても onSlow は呼ばれない。
      await vi.advanceTimersByTimeAsync(1000);

      const outcome = await outcomePromise;
      expect(outcome.unit.status).toBe("done");
      expect(onSlow).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("G3: 再試行（2 回目の送信）では、2 回目の onSend から改めて checkMs を測り直す（決定 27）", async () => {
    vi.useFakeTimers();
    try {
      const onSlow = vi.fn();
      const pending = deferred<ExecOutcome<{ findings: [] }>>();
      // 1 回目の送信は t=0 で始まり、800ms（checkMs=1000ms 未満）で終わって
      // 2 回目の送信に切り替わる。2 回目は pending のまま待たせる。
      //
      // 「onSend のたびに前のタイマーを解除してから張り直す」実装でないと区別できない
      // 変異が 3 通りある。
      //   (a) 呼び出し時（t=0）に一度だけ張って、以降 onSend で張り直さない
      //       → 1 回目の onSend（t=0）由来のタイマーが t=1000 で発火してしまう。
      //   (b) onSettled で解除はするが、次の onSend で張り直さない
      //       → t=1800 になっても一切発火しない。
      //   (c) onSend のたびに張るが、前のタイマーを解除しない
      //       → 1 回目由来（t=1000 発火）と 2 回目由来（t=1800 発火）の両方が生き残り、
      //         t=1000 で（本来鳴ってはいけないのに）1 回鳴ってしまう。
      // 正しい実装では、2 回目の onSend（t=800）で 1 回目のタイマーを解除してから
      // 新しいタイマー（t=800+1000=1800 発火）を張るので、t=1000 では鳴らず、
      // t=1800 でちょうど 1 回だけ鳴る。
      function execute<U>(
        _request: ChatRequest,
        _parse: (result: ChatResult) => U,
        _timeoutMs: number,
        hooks?: ExecuteHooks,
      ): Promise<ExecOutcome<U>> {
        hooks?.onSend?.();
        return new Promise((res) => {
          setTimeout(() => {
            hooks?.onSettled?.();
            hooks?.onSend?.();
            void pending.promise.then((outcome) => {
              hooks?.onSettled?.();
              res(outcome as unknown as ExecOutcome<U>);
            });
          }, 800);
        });
      }
      const executor: Executor = { execute, requestCount: 0, modelInfo: null };

      const outcomePromise = executeCheckUnit(
        baseCheckArgs(executor, { checkMs: 1000, recoveryConfirmMs: 500, onSlow }),
      );

      // t=800：1 回目が終わり、2 回目の onSend でタイマーが張り直された直後。
      await vi.advanceTimersByTimeAsync(800);
      expect(onSlow).not.toHaveBeenCalled();
      // t=1000（1 回目由来のタイマーが張ったままなら、ここで鳴ってしまう）。
      await vi.advanceTimersByTimeAsync(200);
      expect(onSlow).not.toHaveBeenCalled();
      // t=1800（2 回目の onSend から checkMs 経過。ここで初めて 1 回だけ鳴る）。
      await vi.advanceTimersByTimeAsync(800);
      expect(onSlow).toHaveBeenCalledTimes(1);

      pending.resolve(DONE_OUTCOME);
      await outcomePromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("応答の指摘は位置確定され、候補として返る", async () => {
    const wireFinding = {
      paragraphId: 0,
      quote: "吾輩",
      before: "",
      after: "は猫である。",
      category: "notation" as const,
      reason: "誤字",
      suggestion: "私",
      verdict: "likely-error" as const,
    };
    const { executor } = createFakeExecutor(() =>
      Promise.resolve({
        ok: true as const,
        value: { findings: [wireFinding] },
        attempts: 1,
        usage: null,
        elapsedMs: 5,
      }),
    );

    const outcome = await executeCheckUnit(baseCheckArgs(executor));

    expect(outcome.candidates).toHaveLength(1);
    const candidate: Candidate | undefined = outcome.candidates[0];
    expect(candidate?.id).toBe("c1");
    expect(outcome.unit.status).toBe("done");
    if (outcome.unit.status === "done") {
      expect(outcome.unit.findingCount).toBe(1);
    }
  });

  it("失敗が chat 由来で aborted/model-not-loaded 以外なら unit.status は failed になり、failure が残る", async () => {
    const { executor } = createFakeExecutor(() =>
      Promise.resolve<ExecOutcome<{ findings: [] }>>({
        ok: false,
        attempts: 1,
        failure: CHAT_FAILURE,
        usage: null,
        elapsedMs: 10,
        halt: {
          reason: "recovery-needed",
          message: "生成要求がタイムアウトしたため実行を停止した",
          failure: CHAT_FAILURE,
          generationUnconfirmed: true,
        },
      }),
    );

    const outcome = await executeCheckUnit(baseCheckArgs(executor));

    expect(outcome.unit.status).toBe("failed");
    expect(outcome.failure).toEqual(CHAT_FAILURE);
    expect(outcome.halt?.reason).toBe("recovery-needed");
  });

  it("failure.reason が input-too-long（chat 由来）なら halt が settings で作られる", async () => {
    const failure: UnitFailure = {
      reason: "input-too-long",
      message: "LM Studio: 入力が文脈長の上限を超えた",
      finishReason: null,
      origin: "chat",
    };
    const { executor } = createFakeExecutor(() =>
      Promise.resolve<ExecOutcome<{ findings: [] }>>({
        ok: false,
        attempts: 1,
        failure,
        usage: null,
        elapsedMs: 10,
        halt: null,
      }),
    );

    const outcome = await executeCheckUnit(baseCheckArgs(executor));

    expect(outcome.unit.status).toBe("failed");
    expect(outcome.halt?.reason).toBe("settings");
    expect(outcome.halt?.failure?.reason).toBe("input-too-long");
  });

  it("origin: ensure-loaded 由来の失敗は unit.status が pending になり、failure は非 null で残る（決定 20）", async () => {
    const halt: RunStop = {
      reason: "model-not-loaded",
      message: ENSURE_LOADED_FAILURE.message,
      failure: ENSURE_LOADED_FAILURE,
      generationUnconfirmed: false,
    };
    const { executor } = createFakeExecutor(() =>
      Promise.resolve<ExecOutcome<{ findings: [] }>>({
        ok: false,
        attempts: 0,
        failure: ENSURE_LOADED_FAILURE,
        usage: null,
        elapsedMs: 5,
        halt,
      }),
    );

    const outcome = await executeCheckUnit(baseCheckArgs(executor));

    expect(outcome.unit.status).toBe("pending");
    if (outcome.unit.status === "pending") {
      expect(outcome.unit.note).toBe(ENSURE_LOADED_FAILURE.message);
    }
    expect(outcome.failure).toEqual(ENSURE_LOADED_FAILURE);
    expect(outcome.failure?.reason).toBe("model-not-loaded");
    expect(outcome.failure?.origin).toBe("ensure-loaded");
    expect(outcome.halt).toEqual(halt);
    // unit.status が pending でも elapsedMs は数値として残る（PR9b の決定 20 が使う）。
    expect(outcome.elapsedMs).toBe(5);
    expect(outcome.usage).toBeNull();
  });

  it("chat 由来の aborted（停止操作）は unit.status が pending になり、failure は非 null で残る（決定 20）", async () => {
    const halt: RunStop = {
      reason: "aborted",
      message: ABORTED_CHAT_FAILURE.message,
      failure: ABORTED_CHAT_FAILURE,
      generationUnconfirmed: true,
    };
    const { executor } = createFakeExecutor(() =>
      Promise.resolve<ExecOutcome<{ findings: [] }>>({
        ok: false,
        attempts: 1,
        failure: ABORTED_CHAT_FAILURE,
        usage: null,
        elapsedMs: 5,
        halt,
      }),
    );

    const outcome = await executeCheckUnit(baseCheckArgs(executor));

    expect(outcome.unit.status).toBe("pending");
    if (outcome.unit.status === "pending") {
      expect(outcome.unit.note).toBe(ABORTED_CHAT_FAILURE.message);
    }
    expect(outcome.failure).toEqual(ABORTED_CHAT_FAILURE);
    expect(outcome.failure?.reason).toBe("aborted");
    expect(outcome.failure?.origin).toBe("chat");
    expect(outcome.halt).toEqual(halt);
    // unit.status が pending でも elapsedMs は数値として残る（PR9b の決定 20 が使う）。
    expect(outcome.elapsedMs).toBe(5);
    expect(outcome.usage).toBeNull();
  });

  it("U6: treatUnconfirmedAsPending を渡さなければ chat 由来の timeout は failed のまま（CLI・runPipeline の非退行。決定 45-3）", async () => {
    const { executor } = createFakeExecutor(() =>
      Promise.resolve<ExecOutcome<{ findings: [] }>>({
        ok: false,
        attempts: 1,
        failure: CHAT_FAILURE,
        usage: null,
        elapsedMs: 10,
        halt: {
          reason: "recovery-needed",
          message: "生成要求がタイムアウトしたため実行を停止した",
          failure: CHAT_FAILURE,
          generationUnconfirmed: true,
        },
      }),
    );

    // 待機時間を設定していても、判別子（treatUnconfirmedAsPending）を渡さない限り failed。
    const outcome = await executeCheckUnit(
      baseCheckArgs(executor, { checkMs: 1000, recoveryConfirmMs: 500 }),
    );

    expect(outcome.unit.status).toBe("failed");
    if (outcome.unit.status === "failed") {
      expect(outcome.unit.failure).toEqual(CHAT_FAILURE);
      expect(outcome.unit.attempts).toBe(1);
    }
    expect(outcome.failure).toEqual(CHAT_FAILURE);
    expect(outcome.elapsedMs).toBe(10);
    expect(outcome.usage).toBeNull();
  });

  it("U7: treatUnconfirmedAsPending が true なら chat 由来の timeout は pending になり、失敗の事実は残る（決定 20・45-3）", async () => {
    const halt: RunStop = {
      reason: "recovery-needed",
      message: "生成要求がタイムアウトしたため実行を停止した",
      failure: CHAT_FAILURE,
      generationUnconfirmed: true,
    };
    const { executor } = createFakeExecutor(() =>
      Promise.resolve<ExecOutcome<{ findings: [] }>>({
        ok: false,
        attempts: 1,
        failure: CHAT_FAILURE,
        usage: null,
        elapsedMs: 1500,
        halt,
      }),
    );

    // 待機時間が 0 でも、判別子が true なら pending にする（決定 43 の 0 は正規の設定値）。
    const outcome = await executeCheckUnit(
      baseCheckArgs(executor, {
        checkMs: 1000,
        recoveryConfirmMs: 0,
        treatUnconfirmedAsPending: true,
      }),
    );

    expect(outcome.unit.status).toBe("pending");
    if (outcome.unit.status === "pending") {
      expect(outcome.unit.attempts).toBe(1);
      expect(outcome.unit.note).toBe("応答が上限内に届かなかった。生成終了は未確認");
    }
    // status を pending にしても失敗の事実は捨てない（決定 20）。
    expect(outcome.failure).toEqual(CHAT_FAILURE);
    expect(outcome.failure?.reason).toBe("timeout");
    expect(outcome.halt).toEqual(halt);
    expect(outcome.elapsedMs).toBe(1500);
    expect(outcome.usage).toBeNull();
  });

  it("recoveryConfirmMs の値によらず、引数の onSend/onSettled が executor に届く（決定 27）", async () => {
    for (const recoveryConfirmMs of [0, 500]) {
      const onSend = vi.fn();
      const onSettled = vi.fn();
      const { executor, hooksCalls } = createHookCapturingExecutor(() =>
        Promise.resolve(DONE_OUTCOME),
      );

      await executeCheckUnit(baseCheckArgs(executor, { recoveryConfirmMs, onSend, onSettled }));

      expect(hooksCalls).toHaveLength(1);
      const hooks = hooksCalls[0];
      expect(hooks).not.toBeUndefined();
      // recoveryConfirmMs <= 0 の早期 return でも、recoveryConfirmMs > 0 の合成でも、
      // 呼び出し元の onSend/onSettled は最終的に executor まで届く。
      hooks?.onSend?.();
      hooks?.onSettled?.();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledTimes(1);
    }
  });
});

describe("executeRecheckUnit", () => {
  it("suppressed なら生成要求を送らず suppressed を返す", async () => {
    const { executor, timeoutCalls } = createFakeExecutor(() => Promise.resolve(DONE_OUTCOME));

    const outcome = await executeRecheckUnit(baseRecheckArgs(executor, { suppressed: true }));

    expect(outcome.result).toEqual({ status: "suppressed" });
    expect(outcome.failure).toBeNull();
    expect(outcome.halt).toBeNull();
    expect(timeoutCalls).toEqual([]);
  });

  it("recoveryConfirmMs 省略時、渡るタイムアウトが recheckMs と等しい", async () => {
    const { executor, timeoutCalls } = createFakeExecutor(() =>
      Promise.resolve<
        ExecOutcome<{
          reason: string;
          reasonKind: string;
          verdict: string;
          suggestionValid: boolean;
        }>
      >({
        ok: true,
        value: {
          reason: "実在する誤字である",
          reasonKind: "error-confirmed",
          verdict: "keep",
          suggestionValid: true,
        },
        attempts: 1,
        usage: null,
        elapsedMs: 0,
      }),
    );

    const outcome = await executeRecheckUnit(baseRecheckArgs(executor, { recheckMs: 777 }));

    expect(timeoutCalls).toEqual([777]);
    expect(outcome.result.status).toBe("done");
  });

  it("recoveryConfirmMs > 0 のとき、渡るタイムアウトが recheckMs + recoveryConfirmMs になる", async () => {
    const { executor, timeoutCalls } = createFakeExecutor(() =>
      Promise.resolve<
        ExecOutcome<{
          reason: string;
          reasonKind: string;
          verdict: string;
          suggestionValid: boolean;
        }>
      >({
        ok: true,
        value: {
          reason: "実在する誤字である",
          reasonKind: "error-confirmed",
          verdict: "keep",
          suggestionValid: true,
        },
        attempts: 1,
        usage: null,
        elapsedMs: 0,
      }),
    );

    await executeRecheckUnit(
      baseRecheckArgs(executor, { recheckMs: 1000, recoveryConfirmMs: 250 }),
    );

    expect(timeoutCalls).toEqual([1250]);
  });

  it("buildRecheckInput が InputTooLongError を投げたら、その単位だけ failed になり halt は null。onStarted は呼ばれない", async () => {
    const narrowSettings: ChunkSettings = {
      ...SETTINGS,
      targetGraphemes: 1,
      roundingTolerance: 0,
      maxInputGraphemes: 1,
    };
    const onStarted = vi.fn();
    const { executor, timeoutCalls } = createFakeExecutor(() => Promise.resolve(DONE_OUTCOME));

    const outcome = await executeRecheckUnit(
      baseRecheckArgs(executor, { chunkSettings: narrowSettings, onStarted }),
    );

    expect(timeoutCalls).toEqual([]);
    expect(outcome.result.status).toBe("failed");
    if (outcome.result.status === "failed") {
      expect(outcome.result.failure.reason).toBe("input-too-long");
      expect(outcome.result.failure.origin).toBe("local");
      expect(outcome.result.inputRange).toBeNull();
    }
    expect(outcome.halt).toBeNull();
    // buildRecheckInput が失敗して生成要求を送らなかったので、onStarted は呼ばれない
    // （pipeline.ts はこれを使って recheck-started イベントの発火を判断する）。
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("正常系では生成要求を送る直前に onStarted がちょうど 1 回呼ばれる", async () => {
    const calls: string[] = [];
    const onStarted = vi.fn(() => {
      calls.push("onStarted");
    });
    const { executor } = createFakeExecutor(() => {
      calls.push("execute");
      return Promise.resolve<
        ExecOutcome<{
          reason: string;
          reasonKind: string;
          verdict: string;
          suggestionValid: boolean;
        }>
      >({
        ok: true,
        value: {
          reason: "実在する誤字である",
          reasonKind: "error-confirmed",
          verdict: "keep",
          suggestionValid: true,
        },
        attempts: 1,
        usage: null,
        elapsedMs: 0,
      });
    });

    const outcome = await executeRecheckUnit(baseRecheckArgs(executor, { onStarted }));

    expect(outcome.result.status).toBe("done");
    expect(onStarted).toHaveBeenCalledTimes(1);
    // 要求を送る（executor.execute を呼ぶ）よりも前に onStarted が呼ばれている。
    expect(calls).toEqual(["onStarted", "execute"]);
  });

  it("suppressed なら onStarted も呼ばれない", async () => {
    const onStarted = vi.fn();
    const { executor } = createFakeExecutor(() => Promise.resolve(DONE_OUTCOME));

    await executeRecheckUnit(baseRecheckArgs(executor, { suppressed: true, onStarted }));

    expect(onStarted).not.toHaveBeenCalled();
  });

  it("origin: ensure-loaded 由来の失敗は result.status が pending になり、failure は非 null で残る（決定 20）", async () => {
    const halt: RunStop = {
      reason: "model-not-loaded",
      message: ENSURE_LOADED_FAILURE.message,
      failure: ENSURE_LOADED_FAILURE,
      generationUnconfirmed: false,
    };
    const { executor } = createFakeExecutor(() =>
      Promise.resolve<
        ExecOutcome<{
          reason: string;
          reasonKind: string;
          verdict: string;
          suggestionValid: boolean;
        }>
      >({
        ok: false,
        attempts: 0,
        failure: ENSURE_LOADED_FAILURE,
        usage: null,
        elapsedMs: 5,
        halt,
      }),
    );

    const outcome = await executeRecheckUnit(baseRecheckArgs(executor));

    expect(outcome.result.status).toBe("pending");
    if (outcome.result.status === "pending") {
      expect(outcome.result.note).toBe(ENSURE_LOADED_FAILURE.message);
    }
    expect(outcome.failure).toEqual(ENSURE_LOADED_FAILURE);
    expect(outcome.failure?.reason).toBe("model-not-loaded");
    expect(outcome.failure?.origin).toBe("ensure-loaded");
    expect(outcome.halt).toEqual(halt);
    // result.status が pending でも elapsedMs は数値として残る（PR9b の決定 20 が使う）。
    expect(outcome.elapsedMs).toBe(5);
    expect(outcome.usage).toBeNull();
  });

  it("chat 由来の aborted（停止操作）は result.status が pending になり、failure は非 null で残る（決定 20）", async () => {
    const halt: RunStop = {
      reason: "aborted",
      message: ABORTED_CHAT_FAILURE.message,
      failure: ABORTED_CHAT_FAILURE,
      generationUnconfirmed: true,
    };
    const { executor } = createFakeExecutor(() =>
      Promise.resolve<
        ExecOutcome<{
          reason: string;
          reasonKind: string;
          verdict: string;
          suggestionValid: boolean;
        }>
      >({
        ok: false,
        attempts: 1,
        failure: ABORTED_CHAT_FAILURE,
        usage: null,
        elapsedMs: 5,
        halt,
      }),
    );

    const outcome = await executeRecheckUnit(baseRecheckArgs(executor));

    expect(outcome.result.status).toBe("pending");
    if (outcome.result.status === "pending") {
      expect(outcome.result.note).toBe(ABORTED_CHAT_FAILURE.message);
    }
    expect(outcome.failure).toEqual(ABORTED_CHAT_FAILURE);
    expect(outcome.failure?.reason).toBe("aborted");
    expect(outcome.failure?.origin).toBe("chat");
    expect(outcome.halt).toEqual(halt);
    // result.status が pending でも elapsedMs は数値として残る（PR9b の決定 20 が使う）。
    expect(outcome.elapsedMs).toBe(5);
    expect(outcome.usage).toBeNull();
  });

  it("treatUnconfirmedAsPending を渡さなければ chat 由来の timeout は failed のまま（CLI・runPipeline の非退行。決定 45-3）", async () => {
    const { executor } = createFakeExecutor(() =>
      Promise.resolve<
        ExecOutcome<{
          reason: string;
          reasonKind: string;
          verdict: string;
          suggestionValid: boolean;
        }>
      >({
        ok: false,
        attempts: 1,
        failure: CHAT_FAILURE,
        usage: null,
        elapsedMs: 10,
        halt: {
          reason: "recovery-needed",
          message: "生成要求がタイムアウトしたため実行を停止した",
          failure: CHAT_FAILURE,
          generationUnconfirmed: true,
        },
      }),
    );

    const outcome = await executeRecheckUnit(
      baseRecheckArgs(executor, { recheckMs: 1000, recoveryConfirmMs: 250 }),
    );

    expect(outcome.result.status).toBe("failed");
    if (outcome.result.status === "failed") {
      expect(outcome.result.failure).toEqual(CHAT_FAILURE);
      expect(outcome.result.attempts).toBe(1);
    }
    expect(outcome.failure).toEqual(CHAT_FAILURE);
    expect(outcome.elapsedMs).toBe(10);
    expect(outcome.usage).toBeNull();
  });

  it("treatUnconfirmedAsPending が true なら chat 由来の timeout は pending になり、失敗の事実は残る（決定 20・45-3）", async () => {
    const halt: RunStop = {
      reason: "recovery-needed",
      message: "生成要求がタイムアウトしたため実行を停止した",
      failure: CHAT_FAILURE,
      generationUnconfirmed: true,
    };
    const { executor } = createFakeExecutor(() =>
      Promise.resolve<
        ExecOutcome<{
          reason: string;
          reasonKind: string;
          verdict: string;
          suggestionValid: boolean;
        }>
      >({
        ok: false,
        attempts: 1,
        failure: CHAT_FAILURE,
        usage: null,
        elapsedMs: 1250,
        halt,
      }),
    );

    const outcome = await executeRecheckUnit(
      baseRecheckArgs(executor, {
        recheckMs: 1000,
        recoveryConfirmMs: 0,
        treatUnconfirmedAsPending: true,
      }),
    );

    expect(outcome.result.status).toBe("pending");
    if (outcome.result.status === "pending") {
      expect(outcome.result.attempts).toBe(1);
      expect(outcome.result.note).toBe("応答が上限内に届かなかった。生成終了は未確認");
    }
    // status を pending にしても失敗の事実は捨てない（決定 20）。
    expect(outcome.failure).toEqual(CHAT_FAILURE);
    expect(outcome.failure?.reason).toBe("timeout");
    expect(outcome.halt).toEqual(halt);
    expect(outcome.elapsedMs).toBe(1250);
    expect(outcome.usage).toBeNull();
  });

  it("G1 相当（recheck 版）: executeRecheckUnit でも、共有キューでの順番待ちは recheckMs の計測に含まれない（決定 27）", async () => {
    vi.useFakeTimers();
    try {
      const onSlow = vi.fn();
      const { executor } = createQueueAwareFakeExecutor(
        () => Promise.resolve(RECHECK_DONE_OUTCOME),
        1500,
      );

      const outcomePromise = executeRecheckUnit(
        baseRecheckArgs(executor, { recheckMs: 1000, recoveryConfirmMs: 500, onSlow }),
      );

      await vi.advanceTimersByTimeAsync(1500);
      expect(onSlow).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);

      const outcome = await outcomePromise;
      expect(outcome.result.status).toBe("done");
      expect(onSlow).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("localFailure は origin: local の UnitFailure を作る", () => {
    const failure = localFailure("input-too-long", "テスト用の理由");
    expect(failure).toEqual({
      reason: "input-too-long",
      message: "テスト用の理由",
      finishReason: null,
      origin: "local",
    });
  });
});
