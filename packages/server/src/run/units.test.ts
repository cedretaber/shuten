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
import type { ExecOutcome, Executor } from "./executor.ts";
import type { UnitFailure } from "./result.ts";
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

/** `executor.execute` を差し替えたフェイク。渡された `timeoutMs` を記録する。 */
function createFakeExecutor<T>(resolve: (timeoutMs: number) => Promise<ExecOutcome<T>>): {
  readonly executor: Executor;
  readonly timeoutCalls: number[];
} {
  const timeoutCalls: number[] = [];
  function execute<U>(
    _request: ChatRequest,
    _parse: (result: ChatResult) => U,
    timeoutMs: number,
  ): Promise<ExecOutcome<U>> {
    timeoutCalls.push(timeoutMs);
    return resolve(timeoutMs) as unknown as Promise<ExecOutcome<U>>;
  }
  return { executor: { execute, requestCount: 0, modelInfo: null }, timeoutCalls };
}

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
