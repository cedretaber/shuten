import type { ChunkSettings, Perspective } from "@shuten/shared";
import {
  ALLOWED_WORD_RULE_VERSION,
  buildCheckInput,
  countGraphemes,
  DIAGNOSTIC_TRANSFORM_VERSION,
  PROMPT_VERSION,
  splitParagraphs,
} from "@shuten/shared";
import { describe, expect, it } from "vitest";
import { createLmStudioClient } from "../lmstudio/client.ts";
import { LmStudioError } from "../lmstudio/errors.ts";
import type {
  ChatRequest,
  ChatResult,
  LmStudioClient,
  ModelInfo,
  Usage,
} from "../lmstudio/types.ts";
import { NATURALNESS_SYSTEM_PROMPT } from "../prompts/naturalness.ts";
import type { GenerationSettings } from "../prompts/types.ts";
import { TYPO_SYSTEM_PROMPT } from "../prompts/typo.ts";
import type { PipelineEvent } from "./events.ts";
import type { PipelineArgs } from "./pipeline.ts";
import { runPipeline } from "./pipeline.ts";
import type { CheckUnitResult, PipelineResult, RecheckResult } from "./result.ts";
import { RESULT_VERSION } from "./result.ts";

/** 2 段落・35 UTF-16 コード単位。段落 0 は [0,17)、段落 1 は [17,35)。 */
const TEXT = "吾輩は猫てある。名前はまだ無い。\nどこで生まれたか頓と見当がつかぬ。\n";

/** 参考文脈なし。この設定では検査対象が 2 件（[0,17) と [17,35)）になる。 */
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

const USAGE: Usage = {
  promptTokens: 10,
  completionTokens: 20,
  totalTokens: 30,
  reasoningTokens: null,
};

const MODEL: ModelInfo = {
  id: "test-model",
  type: "llm",
  state: "loaded",
  quantization: null,
  maxContextLength: null,
  loadedContextLength: null,
};

interface WireFinding {
  readonly paragraphId: number;
  readonly quote: string;
  readonly before: string;
  readonly after: string;
  readonly category: string;
  readonly reason: string;
  readonly suggestion: string | null;
  readonly verdict: string;
}

/** 段落 0 の「猫て」を指す誤字の指摘。 */
function typoFinding(overrides: Partial<WireFinding> = {}): WireFinding {
  return {
    paragraphId: 0,
    quote: "猫て",
    before: "吾輩は",
    after: "ある。",
    category: "notation",
    reason: "「猫で」の誤変換",
    suggestion: "猫で",
    verdict: "likely-error",
    ...overrides,
  };
}

function checkBody(...findings: readonly WireFinding[]): string {
  return JSON.stringify({ findings });
}

const EMPTY_CHECK = checkBody();

const RECHECK_BODY = JSON.stringify({
  reason: "実在する誤字である",
  reasonKind: "error-confirmed",
  verdict: "keep",
  suggestionValid: true,
});

function chatResult(content: string, finishReason = "stop"): ChatResult {
  return { content, reasoningContent: null, finishReason, usage: USAGE, raw: {} };
}

interface ChatCall {
  readonly kind: "check" | "recheck";
  readonly perspective: Perspective | null;
  readonly body: string;
}

/** 要求から呼び出しの種類を読む。観点は system プロンプト、初回／再確認は responseFormat で判別する。 */
function describeCall(request: ChatRequest): ChatCall {
  const system = request.messages[0]?.content ?? "";
  const body = request.messages[1]?.content ?? "";
  const kind = request.responseFormat?.name === "shuten_recheck_output" ? "recheck" : "check";
  const perspective: Perspective | null =
    system === TYPO_SYSTEM_PROMPT
      ? "typo"
      : system === NATURALNESS_SYSTEM_PROMPT
        ? "naturalness"
        : null;
  return { kind, perspective, body };
}

/** SETTINGS（参考文脈なし）でのみ使える。要求本文から検査対象を見分ける。 */
function isTarget0(call: ChatCall): boolean {
  return call.body.includes("吾輩");
}

interface MockBehavior {
  /** index は chat の呼び出し回数（0 始まり、再試行を含む）。 */
  readonly chat?: (call: ChatCall, index: number) => ChatResult;
  /** index は ensureLoaded の呼び出し回数（0 始まり）。 */
  readonly ensureLoaded?: (index: number) => ModelInfo;
}

interface MockClient {
  readonly client: LmStudioClient;
  readonly calls: ChatCall[];
  readonly ensureCalls: { count: number };
}

function createMockClient(behavior: MockBehavior = {}): MockClient {
  const calls: ChatCall[] = [];
  const ensureCalls = { count: 0 };
  const client: LmStudioClient = {
    listModels: async () => {
      await Promise.resolve();
      return [MODEL];
    },
    ensureLoaded: async () => {
      await Promise.resolve();
      const index = ensureCalls.count;
      ensureCalls.count += 1;
      return behavior.ensureLoaded !== undefined ? behavior.ensureLoaded(index) : MODEL;
    },
    chat: async (request) => {
      await Promise.resolve();
      const call = describeCall(request);
      const index = calls.length;
      calls.push(call);
      if (behavior.chat !== undefined) {
        return behavior.chat(call, index);
      }
      return chatResult(call.kind === "recheck" ? RECHECK_BODY : EMPTY_CHECK);
    },
  };
  return { client, calls, ensureCalls };
}

/** 単調増加する時計。実行ごとに作り直せば 2 回の実行で同じ時刻になる。 */
function createClock(): () => number {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
}

function baseArgs(client: LmStudioClient, overrides: Partial<PipelineArgs> = {}): PipelineArgs {
  return {
    text: TEXT,
    mode: "split",
    perspectives: ["typo"],
    allowedWordsRaw: "",
    generation: GENERATION,
    chunkSettings: SETTINGS,
    timeouts: { checkMs: 1000, recheckMs: 1000 },
    client,
    now: createClock(),
    ...overrides,
  };
}

function unitAt(result: PipelineResult, index: number): CheckUnitResult {
  const unit = result.checkUnits[index];
  if (unit === undefined) {
    throw new Error(`検査単位 ${String(index)} がない`);
  }
  return unit;
}

function expectDone(unit: CheckUnitResult): Extract<CheckUnitResult, { status: "done" }> {
  if (unit.status !== "done") {
    throw new Error(`done を期待したが ${unit.status} だった`);
  }
  return unit;
}

function expectFailed(unit: CheckUnitResult): Extract<CheckUnitResult, { status: "failed" }> {
  if (unit.status !== "failed") {
    throw new Error(`failed を期待したが ${unit.status} だった`);
  }
  return unit;
}

function expectPending(unit: CheckUnitResult): Extract<CheckUnitResult, { status: "pending" }> {
  if (unit.status !== "pending") {
    throw new Error(`pending を期待したが ${unit.status} だった`);
  }
  return unit;
}

function recheckAt(result: PipelineResult, index: number): RecheckResult {
  const finding = result.findings[index];
  if (finding === undefined) {
    throw new Error(`指摘 ${String(index)} がない`);
  }
  return finding.recheck;
}

function expectRecheckFailed(recheck: RecheckResult): Extract<RecheckResult, { status: "failed" }> {
  if (recheck.status !== "failed") {
    throw new Error(`再確認の failed を期待したが ${recheck.status} だった`);
  }
  return recheck;
}

function expectRecheckPending(
  recheck: RecheckResult,
): Extract<RecheckResult, { status: "pending" }> {
  if (recheck.status !== "pending") {
    throw new Error(`再確認の pending を期待したが ${recheck.status} だった`);
  }
  return recheck;
}

/** 検査だけ（再確認を除く）の呼び出しを数える。 */
function countChecks(calls: readonly ChatCall[]): number {
  return calls.filter((call) => call.kind === "check").length;
}

function countRechecks(calls: readonly ChatCall[]): number {
  return calls.filter((call) => call.kind === "recheck").length;
}

const NOT_LOADED = new LmStudioError("model-not-loaded", "モデルがロードされていない");

describe("runPipeline", () => {
  it("P1: 誤字を含む本文が分割・検査・位置確定・統合・再確認まで通り completed になる", async () => {
    const mock = createMockClient({
      chat: (call) => {
        if (call.kind === "recheck") {
          return chatResult(RECHECK_BODY);
        }
        return chatResult(isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK);
      },
    });

    const result = await runPipeline(baseArgs(mock.client, { mode: "split-recheck" }));

    expect(result.status).toBe("completed");
    expect(result.stop).toBeNull();
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding?.finding.range).toEqual({ start: 3, end: 5 });
    expect(finding?.finding.quote).toBe("猫て");
    expect(finding?.recheck.status).toBe("done");
    expect(result.unlocated).toHaveLength(0);
  });

  it("P2: 検査対象の昇順・対象内では観点の指定順に要求が送られる", async () => {
    const mock = createMockClient();

    await runPipeline(baseArgs(mock.client, { perspectives: ["typo", "naturalness"] }));

    expect(
      mock.calls.map((call) => `${isTarget0(call) ? "t0" : "t1"}:${call.perspective ?? "-"}`),
    ).toEqual(["t0:typo", "t0:naturalness", "t1:typo", "t1:naturalness"]);
  });

  it("P3: 1 対象の全観点が終わってから統合が走る", async () => {
    const events: PipelineEvent[] = [];
    const mock = createMockClient();

    await runPipeline(
      baseArgs(mock.client, {
        perspectives: ["typo", "naturalness"],
        onEvent: (event) => events.push(event),
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "run-started",
      "check-started",
      "check-finished",
      "check-started",
      "check-finished",
      "target-merged",
      "check-started",
      "check-finished",
      "check-started",
      "check-finished",
      "target-merged",
      "run-finished",
    ]);
  });

  it("P4: 同じ引用・修正案を 2 観点が返すと 1 件に統合され sources が 2 件になる", async () => {
    const mock = createMockClient({
      chat: (call) =>
        chatResult(
          call.kind === "check" && isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK,
        ),
    });

    const result = await runPipeline(
      baseArgs(mock.client, { perspectives: ["typo", "naturalness"] }),
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.finding.sources).toHaveLength(2);
    expect(result.totals.candidates).toBe(2);
  });

  it("P5: 修正案が null の候補は統合されず別々に残る", async () => {
    const mock = createMockClient({
      chat: (call) =>
        chatResult(
          call.kind === "check" && isTarget0(call)
            ? checkBody(typoFinding({ suggestion: null }))
            : EMPTY_CHECK,
        ),
    });

    const result = await runPipeline(
      baseArgs(mock.client, { perspectives: ["typo", "naturalness"] }),
    );

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.finding.sources).toHaveLength(1);
    expect(result.findings[1]?.finding.sources).toHaveLength(1);
  });

  it("P6: 存在しない引用は not-found として unlocated に入り、再確認要求が送られない", async () => {
    const mock = createMockClient({
      chat: (call) =>
        chatResult(
          call.kind === "check" && isTarget0(call)
            ? checkBody(typoFinding({ quote: "存在しない引用", before: "", after: "" }))
            : EMPTY_CHECK,
        ),
    });

    const result = await runPipeline(baseArgs(mock.client, { mode: "split-recheck" }));

    expect(result.findings).toHaveLength(0);
    expect(result.unlocated).toHaveLength(1);
    expect(result.unlocated[0]?.candidate.locate.reason).toBe("not-found");
    expect(countRechecks(mock.calls)).toBe(0);
  });

  it("P7: 参考文脈内から始まる引用は outside-target として unlocated に入る", async () => {
    // 参考文脈を広げると、検査対象 1 の入力範囲に段落 0 が入る。
    const settings: ChunkSettings = { ...SETTINGS, contextGraphemes: 20, maxInputGraphemes: 200 };
    const mock = createMockClient({
      // 検査対象 1（2 回目の検査要求）だけ、参考文脈側の引用を返す。
      chat: (_call, index) => chatResult(index === 1 ? checkBody(typoFinding()) : EMPTY_CHECK),
    });

    const result = await runPipeline(baseArgs(mock.client, { chunkSettings: settings }));

    expect(result.findings).toHaveLength(0);
    expect(result.unlocated).toHaveLength(1);
    expect(result.unlocated[0]?.candidate.locate.reason).toBe("outside-target");
    expect(result.totals.unlocated.outsideTarget).toBe(1);
  });

  it("P8: 許容語に一致する表記訂正は抑制され、再確認要求が送られない", async () => {
    const mock = createMockClient({
      chat: (call) =>
        chatResult(
          call.kind === "check" && isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK,
        ),
    });

    const result = await runPipeline(
      baseArgs(mock.client, { mode: "split-recheck", allowedWordsRaw: "猫て\n\n猫て\n" }),
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.suppression?.word).toBe("猫て");
    expect(result.findings[0]?.recheck.status).toBe("suppressed");
    expect(countRechecks(mock.calls)).toBe(0);
    expect(result.conditions.allowedWords).toEqual(["猫て"]);
  });

  it("P9: mode split では再確認要求が 0 件で、各 recheck が disabled になる", async () => {
    const mock = createMockClient({
      chat: (call) =>
        chatResult(
          call.kind === "check" && isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK,
        ),
    });

    const result = await runPipeline(baseArgs(mock.client));

    expect(countRechecks(mock.calls)).toBe(0);
    expect(result.findings.map((entry) => entry.recheck.status)).toEqual(["disabled"]);
    expect(result.totals.rechecks.disabled).toBe(1);
  });

  it("P10: 指摘なしの応答は done・findingCount 0 で、実行は completed になる", async () => {
    const mock = createMockClient();

    const result = await runPipeline(baseArgs(mock.client));

    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(0);
    expect(expectDone(unitAt(result, 0)).findingCount).toBe(0);
    expect(result.totals.checkUnits).toEqual({ done: 2, failed: 0, pending: 0 });
  });

  it("P11: 1 観点だけ malformed が続いても、もう一方の観点の指摘で統合が進み partially-failed になる", async () => {
    const mock = createMockClient({
      chat: (call) => {
        if (call.perspective === "typo") {
          return chatResult("これは JSON ではない");
        }
        return chatResult(isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK);
      },
    });

    const result = await runPipeline(
      baseArgs(mock.client, { perspectives: ["typo", "naturalness"] }),
    );

    expect(result.status).toBe("partially-failed");
    expect(result.stop).toBeNull();
    expect(result.findings).toHaveLength(1);
    const failed = expectFailed(unitAt(result, 0));
    expect(failed.failure.reason).toBe("malformed");
    expect(failed.attempts).toBe(2);
  });

  it("P12: 全観点が失敗した対象があっても他の対象の結果は残り、指摘ゼロと区別できる", async () => {
    const mock = createMockClient({
      chat: (call) => {
        if (call.kind === "check" && isTarget0(call)) {
          return chatResult("これは JSON ではない");
        }
        return chatResult(EMPTY_CHECK);
      },
    });

    const result = await runPipeline(
      baseArgs(mock.client, { perspectives: ["typo", "naturalness"] }),
    );

    expect(result.status).toBe("partially-failed");
    expect(result.checkUnits.map((unit) => `${String(unit.targetIndex)}:${unit.status}`)).toEqual([
      "0:failed",
      "0:failed",
      "1:done",
      "1:done",
    ]);
    expect(result.totals.checkUnits).toEqual({ done: 2, failed: 2, pending: 0 });
  });

  it("P13: finish_reason が length の応答は truncated として failed になり、指摘が空にならない", async () => {
    const mock = createMockClient({
      chat: (call) => {
        if (call.perspective === "typo") {
          return chatResult(EMPTY_CHECK, "length");
        }
        return chatResult(isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK);
      },
    });

    const result = await runPipeline(
      baseArgs(mock.client, { perspectives: ["typo", "naturalness"] }),
    );

    const failed = expectFailed(unitAt(result, 0));
    expect(failed.failure.reason).toBe("truncated");
    expect(failed.failure.finishReason).toBe("length");
    expect(result.findings).toHaveLength(1);
    expect(result.status).toBe("partially-failed");
  });

  it("P14: timeout の後は chat が呼ばれず、残りの単位が pending で stop が recovery-needed になる", async () => {
    const mock = createMockClient({
      chat: () => {
        throw new LmStudioError("timeout", "要求がタイムアウトした");
      },
    });

    const result = await runPipeline(baseArgs(mock.client));

    expect(countChecks(mock.calls)).toBe(1);
    expect(result.status).toBe("stopped");
    expect(result.stop?.reason).toBe("recovery-needed");
    expect(result.stop?.generationUnconfirmed).toBe(true);
    expect(expectFailed(unitAt(result, 0)).failure.reason).toBe("timeout");
    expect(expectPending(unitAt(result, 1)).attempts).toBe(0);
  });

  it("P14b: 停止した対象でも成功済みの観点の指摘は統合まで進み、再確認は pending になる", async () => {
    const mock = createMockClient({
      chat: (call) => {
        if (call.perspective === "naturalness") {
          throw new LmStudioError("timeout", "要求がタイムアウトした");
        }
        return chatResult(isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK);
      },
    });

    const result = await runPipeline(
      baseArgs(mock.client, {
        mode: "split-recheck",
        perspectives: ["typo", "naturalness"],
      }),
    );

    expect(result.status).toBe("stopped");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.finding.quote).toBe("猫て");
    expect(result.findings[0]?.suppression).toBeNull();
    const recheck = expectRecheckPending(recheckAt(result, 0));
    expect(recheck.attempts).toBe(0);
    expect(recheck.inputRange).toBeNull();
    expect(countRechecks(mock.calls)).toBe(0);
  });

  it("P15: k 番目の ensureLoaded が model-not-loaded なら、それ以前は done・以降は pending になる", async () => {
    const mock = createMockClient({
      ensureLoaded: (index) => {
        if (index === 1) {
          throw NOT_LOADED;
        }
        return MODEL;
      },
    });

    const result = await runPipeline(baseArgs(mock.client));

    expect(unitAt(result, 0).status).toBe("done");
    expect(expectPending(unitAt(result, 1)).attempts).toBe(0);
    expect(result.status).toBe("stopped");
    expect(result.stop?.reason).toBe("model-not-loaded");
    expect(result.stop?.generationUnconfirmed).toBe(false);
    expect(result.stop?.failure?.origin).toBe("ensure-loaded");
    expect(countChecks(mock.calls)).toBe(1);
  });

  it("P15b: chat の途中でアンロードされた単位は failed ではなく pending（attempts 1）になる", async () => {
    const mock = createMockClient({
      chat: () => {
        throw NOT_LOADED;
      },
    });

    const result = await runPipeline(baseArgs(mock.client));

    const pending = expectPending(unitAt(result, 0));
    expect(pending.attempts).toBe(1);
    expect(result.stop?.reason).toBe("model-not-loaded");
    expect(result.totals.checkUnits.failed).toBe(0);
  });

  it("P15c: 初回が malformed で再試行前の ensureLoaded が未ロードなら pending・attempts 1 になる", async () => {
    const mock = createMockClient({
      chat: () => chatResult("これは JSON ではない"),
      ensureLoaded: (index) => {
        if (index === 1) {
          throw NOT_LOADED;
        }
        return MODEL;
      },
    });

    const result = await runPipeline(baseArgs(mock.client));

    const pending = expectPending(unitAt(result, 0));
    expect(pending.attempts).toBe(1);
    expect(result.stop?.reason).toBe("model-not-loaded");
  });

  it("P16: 途中で signal を中断すると stopped（aborted）になり、以後の要求が送られない", async () => {
    const controller = new AbortController();
    const mock = createMockClient({
      chat: () => {
        // 1 件目の応答を返した直後に停止操作が入る。
        controller.abort();
        return chatResult(EMPTY_CHECK);
      },
    });

    const result = await runPipeline(baseArgs(mock.client, { signal: controller.signal }));

    expect(countChecks(mock.calls)).toBe(1);
    expect(result.status).toBe("stopped");
    expect(result.stop?.reason).toBe("aborted");
    // signal だけが真で生成要求を送っていないので、生成は走っていない（決定 5）。
    expect(result.stop?.generationUnconfirmed).toBe(false);
    expect(expectPending(unitAt(result, 1)).attempts).toBe(0);
  });

  it("P16b: 生成要求の送信中に停止操作が入った単位は failed ではなく pending（attempts 1）になる", async () => {
    const controller = new AbortController();
    const mock = createMockClient({
      chat: () => {
        // 送信中に停止操作が入り、クライアントが aborted を投げる。
        controller.abort();
        throw new LmStudioError("aborted", "呼び出し元によって要求が中断された");
      },
    });

    const result = await runPipeline(baseArgs(mock.client, { signal: controller.signal }));

    // 停止操作は失敗ではない（仕様書 8.2 節）。送った回数は残す。
    const pending = expectPending(unitAt(result, 0));
    expect(pending.attempts).toBe(1);
    expect(result.totals.checkUnits.failed).toBe(0);
    expect(result.status).toBe("stopped");
    expect(result.stop?.reason).toBe("aborted");
    // 送信中の中断なので、LM Studio 側で生成が走り続けている可能性がある。
    expect(result.stop?.generationUnconfirmed).toBe(true);
    expect(result.stop?.failure?.origin).toBe("chat");
    expect(countChecks(mock.calls)).toBe(1);
  });

  it("P17: 初回検査の InputTooLongError で stopped（settings）になり、本文は縮まない", async () => {
    const settings: ChunkSettings = {
      targetGraphemes: 20,
      contextGraphemes: 20,
      recheckContextGraphemes: 20,
      roundingTolerance: 0.2,
      maxInputGraphemes: 24,
    };
    const mock = createMockClient();

    const result = await runPipeline(baseArgs(mock.client, { chunkSettings: settings }));

    expect(result.status).toBe("stopped");
    expect(result.stop?.reason).toBe("settings");
    expect(result.stop?.failure?.reason).toBe("input-too-long");
    expect(result.stop?.failure?.origin).toBe("local");
    expect(mock.calls).toHaveLength(0);
    expect(result.conditions.manuscript.utf16Length).toBe(TEXT.length);
    expect(result.conditions.manuscript.graphemeCount).toBe(countGraphemes(TEXT));
    expect(expectFailed(unitAt(result, 0)).failure.reason).toBe("input-too-long");
  });

  it("P17b: 初回検査の chat が input-too-long を返すと stopped（settings）で以後の要求が送られない", async () => {
    const mock = createMockClient({
      chat: () => {
        throw new LmStudioError("input-too-long", "LM Studio: 入力が文脈長の上限を超えた", {
          status: 400,
        });
      },
    });

    const result = await runPipeline(baseArgs(mock.client));

    expect(countChecks(mock.calls)).toBe(1);
    expect(result.status).toBe("stopped");
    expect(result.stop?.reason).toBe("settings");
    expect(result.stop?.failure?.reason).toBe("input-too-long");
    expect(result.stop?.failure?.origin).toBe("chat");
    expect(expectFailed(unitAt(result, 0)).failure.reason).toBe("input-too-long");
    expect(expectPending(unitAt(result, 1)).attempts).toBe(0);
  });

  it("P18: 再確認の InputTooLongError はその再確認だけ failed にし、実行は続く", async () => {
    // 検査入力（17・18 字）は上限内、再確認入力（35 字）は上限超えになる設定。
    const settings: ChunkSettings = {
      ...SETTINGS,
      recheckContextGraphemes: 20,
      maxInputGraphemes: 30,
    };
    const mock = createMockClient({
      chat: (call) =>
        chatResult(
          call.kind === "check" && isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK,
        ),
    });

    const result = await runPipeline(
      baseArgs(mock.client, { mode: "split-recheck", chunkSettings: settings }),
    );

    expect(result.status).toBe("partially-failed");
    expect(result.stop).toBeNull();
    const recheck = expectRecheckFailed(recheckAt(result, 0));
    expect(recheck.failure.reason).toBe("input-too-long");
    expect(recheck.failure.origin).toBe("local");
    expect(recheck.inputRange).toBeNull();
    expect(recheck.elapsedMs).toBeNull();
    expect(countChecks(mock.calls)).toBe(2);
  });

  it("P18b: 再確認の chat が input-too-long を返してもその再確認だけ failed で実行は続く", async () => {
    const mock = createMockClient({
      chat: (call) => {
        if (call.kind === "recheck") {
          throw new LmStudioError("input-too-long", "LM Studio: 入力が文脈長の上限を超えた", {
            status: 400,
          });
        }
        return chatResult(isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK);
      },
    });

    const result = await runPipeline(baseArgs(mock.client, { mode: "split-recheck" }));

    expect(result.status).toBe("partially-failed");
    expect(result.stop).toBeNull();
    const recheck = expectRecheckFailed(recheckAt(result, 0));
    expect(recheck.failure.reason).toBe("input-too-long");
    expect(recheck.failure.origin).toBe("chat");
    expect(recheck.inputRange).not.toBeNull();
    // 停止していないので検査対象 1 の検査も送られる。
    expect(countChecks(mock.calls)).toBe(2);
  });

  it("P18c: 再確認の chat が timeout でもその再確認は failed のまま（CLI は treatUnconfirmedAsPending を渡さない。決定 45-3）", async () => {
    const mock = createMockClient({
      chat: (call) => {
        if (call.kind === "recheck") {
          throw new LmStudioError("timeout", "要求がタイムアウトした");
        }
        return chatResult(isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK);
      },
    });

    const result = await runPipeline(baseArgs(mock.client, { mode: "split-recheck" }));

    // オーケストレーター経路（run/loop.ts）だけが打ち切りを pending にする。CLI は E1 のとおり failed。
    const recheck = expectRecheckFailed(recheckAt(result, 0));
    expect(recheck.failure.reason).toBe("timeout");
    expect(recheck.failure.origin).toBe("chat");
  });

  it("P19: InvalidChunkSettingsError で stopped（settings）になり、targets と checkUnits が空になる", async () => {
    const events: PipelineEvent[] = [];
    const mock = createMockClient();

    const result = await runPipeline(
      baseArgs(mock.client, {
        chunkSettings: { ...SETTINGS, targetGraphemes: 0 },
        onEvent: (event) => events.push(event),
      }),
    );

    expect(result.status).toBe("stopped");
    expect(result.stop?.reason).toBe("settings");
    expect(result.stop?.failure).toBeNull();
    expect(result.targets).toHaveLength(0);
    expect(result.checkUnits).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(["run-started", "run-finished"]);
  });

  it("P20: 再確認が malformed を 2 回返すと recheck が failed になり、実行は partially-failed になる", async () => {
    const mock = createMockClient({
      chat: (call) => {
        if (call.kind === "recheck") {
          return chatResult("これは JSON ではない");
        }
        return chatResult(isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK);
      },
    });

    const result = await runPipeline(baseArgs(mock.client, { mode: "split-recheck" }));

    const recheck = expectRecheckFailed(recheckAt(result, 0));
    expect(recheck.failure.reason).toBe("malformed");
    expect(recheck.attempts).toBe(2);
    expect(result.status).toBe("partially-failed");
    expect(result.totals.rechecks.failed).toBe(1);
  });

  it("P20b: 再確認の生成中にアンロードされると pending・attempts 1・inputRange 非 null になる", async () => {
    const mock = createMockClient({
      chat: (call) => {
        if (call.kind === "recheck") {
          throw NOT_LOADED;
        }
        return chatResult(isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK);
      },
    });

    const result = await runPipeline(baseArgs(mock.client, { mode: "split-recheck" }));

    const recheck = expectRecheckPending(recheckAt(result, 0));
    expect(recheck.attempts).toBe(1);
    expect(recheck.inputRange).toEqual({ start: 0, end: 17 });
    expect(result.status).toBe("stopped");
    expect(result.stop?.reason).toBe("model-not-loaded");
  });

  it("P20c: 再確認を送る前に実行が終わると pending・attempts 0 になる", async () => {
    const controller = new AbortController();
    const mock = createMockClient({
      chat: (call) => {
        // 検査の応答を返した直後に停止操作が入るので、再確認は 1 度も送られない。
        controller.abort();
        return chatResult(isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK);
      },
    });

    const result = await runPipeline(
      baseArgs(mock.client, { mode: "split-recheck", signal: controller.signal }),
    );

    expect(countRechecks(mock.calls)).toBe(0);
    const recheck = expectRecheckPending(recheckAt(result, 0));
    expect(recheck.attempts).toBe(0);
    expect(result.status).toBe("stopped");
    expect(result.stop?.reason).toBe("aborted");
  });

  it("P20d: 再確認の初回が malformed で再試行前の ensureLoaded が未ロードなら pending・attempts 1 になる", async () => {
    const mock = createMockClient({
      chat: (call) => {
        if (call.kind === "recheck") {
          return chatResult("これは JSON ではない");
        }
        return chatResult(isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK);
      },
      // ensureLoaded の 3 回目＝再確認の再試行の直前。
      ensureLoaded: (index) => {
        if (index === 2) {
          throw NOT_LOADED;
        }
        return MODEL;
      },
    });

    const result = await runPipeline(baseArgs(mock.client, { mode: "split-recheck" }));

    const recheck = expectRecheckPending(recheckAt(result, 0));
    expect(recheck.attempts).toBe(1);
    expect(result.stop?.reason).toBe("model-not-loaded");
  });

  it("P21: mode full-text では観点ごとに要求が 1 件ずつ、targets が 1 件で再確認がない", async () => {
    const mock = createMockClient({
      chat: () => chatResult(checkBody(typoFinding())),
    });

    const result = await runPipeline(
      baseArgs(mock.client, { mode: "full-text", perspectives: ["typo", "naturalness"] }),
    );

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.input.context).toEqual({ before: null, after: null });
    expect(result.targets[0]?.input.inputRange).toEqual({ start: 0, end: TEXT.length });
    expect(countChecks(mock.calls)).toBe(2);
    expect(countRechecks(mock.calls)).toBe(0);
    expect(result.findings.map((entry) => entry.recheck.status)).toEqual(["disabled"]);
  });

  it("P22: mode full-text で本文が maxInputGraphemes を超えると stopped（settings）になる", async () => {
    const mock = createMockClient();

    const result = await runPipeline(
      baseArgs(mock.client, {
        mode: "full-text",
        chunkSettings: { ...SETTINGS, maxInputGraphemes: 30 },
      }),
    );

    expect(result.status).toBe("stopped");
    expect(result.stop?.reason).toBe("settings");
    expect(result.stop?.failure?.reason).toBe("input-too-long");
    expect(mock.calls).toHaveLength(0);
  });

  it("P23: 同じ入力・同じモック応答で 2 回実行すると ID と結果が一致する", async () => {
    const behavior: MockBehavior = {
      chat: (call) => {
        if (call.kind === "recheck") {
          return chatResult(RECHECK_BODY);
        }
        return chatResult(isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK);
      },
    };
    const first = await runPipeline(
      baseArgs(createMockClient(behavior).client, { mode: "split-recheck" }),
    );
    const second = await runPipeline(
      baseArgs(createMockClient(behavior).client, { mode: "split-recheck" }),
    );

    expect(first.findings[0]?.finding.id).toBe("f1");
    expect(first.findings[0]?.finding.sources[0]?.id).toBe("c1");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("P24: 結果 JSON に API キーと接続先 URL が現れない", async () => {
    const apiKey = "secret-api-key-1234";
    const baseUrl = "http://lm-studio.example.invalid:65001";
    const fetchMock: typeof globalThis.fetch = async (input) => {
      await Promise.resolve();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v0/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "test-model", type: "llm", state: "loaded" }] }),
          {
            status: 200,
          },
        );
      }
      // 生成は接続失敗にして、失敗記録にも URL・API キーが残らないことを確かめる。
      throw new TypeError(`fetch failed: ${url}`);
    };
    const client = createLmStudioClient({ baseUrl, apiKey, fetch: fetchMock });

    const result = await runPipeline(baseArgs(client));

    const json = JSON.stringify(result);
    expect(json).not.toContain(apiKey);
    expect(json).not.toContain("lm-studio.example.invalid");
    expect(result.status).toBe("stopped");
  });

  it("P25: conditions.versions が実際の版で、targets[i].input が要求に使った CheckInput と一致する", async () => {
    const mock = createMockClient();

    const result = await runPipeline(baseArgs(mock.client));

    expect(result.conditions.versions).toEqual({
      result: RESULT_VERSION,
      prompt: PROMPT_VERSION,
      allowedWordRule: ALLOWED_WORD_RULE_VERSION,
      diagnosticTransform: DIAGNOSTIC_TRANSFORM_VERSION,
    });
    const paragraphs = splitParagraphs(TEXT);
    expect(result.targets).toHaveLength(2);
    for (const plan of result.targets) {
      expect(plan.input).toEqual(buildCheckInput(TEXT, paragraphs, plan.target, SETTINGS));
    }
    expect(result.conditions.model).toEqual(MODEL);
    expect(result.conditions.mode).toBe("split");
  });

  it("P26: onEvent が例外を投げても実行が続き、結果が変わらない", async () => {
    const behavior: MockBehavior = {
      chat: (call) => {
        if (call.kind === "recheck") {
          return chatResult(RECHECK_BODY);
        }
        return chatResult(isTarget0(call) ? checkBody(typoFinding()) : EMPTY_CHECK);
      },
    };
    const withThrow = await runPipeline(
      baseArgs(createMockClient(behavior).client, {
        mode: "split-recheck",
        onEvent: () => {
          throw new Error("イベント処理の失敗");
        },
      }),
    );
    const without = await runPipeline(
      baseArgs(createMockClient(behavior).client, { mode: "split-recheck" }),
    );

    expect(withThrow.status).toBe("completed");
    expect(JSON.stringify(withThrow)).toBe(JSON.stringify(without));
  });

  it("P27: イベントは run-started で始まり run-finished で終わる（停止時も）", async () => {
    const events: PipelineEvent[] = [];
    const mock = createMockClient({
      chat: () => {
        throw new LmStudioError("timeout", "要求がタイムアウトした");
      },
    });

    const result = await runPipeline(
      baseArgs(mock.client, { onEvent: (event) => events.push(event) }),
    );

    expect(events[0]?.type).toBe("run-started");
    const last = events[events.length - 1];
    expect(last?.type).toBe("run-finished");
    expect(last?.type === "run-finished" ? last.status : null).toBe("stopped");
    expect(result.status).toBe("stopped");
  });

  it("P28: inputGraphemes が要求に載せた本文の書記素数と一致する（CRLF・絵文字を含む）", async () => {
    const text = "第一段落👨‍👩‍👦です。\r\n第二段落です。";
    const mock = createMockClient();

    const result = await runPipeline(
      baseArgs(mock.client, {
        text,
        mode: "full-text",
        chunkSettings: { ...SETTINGS, maxInputGraphemes: 200 },
      }),
    );

    const done = expectDone(unitAt(result, 0));
    expect(done.inputGraphemes).toBe(countGraphemes(text));
    expect(done.inputGraphemes).toBeLessThan(text.length);
    expect(result.conditions.manuscript.paragraphCount).toBe(2);
  });

  it("P29: totals の各件数が checkUnits・findings・unlocated の実際の内訳と一致する", async () => {
    const mock = createMockClient({
      chat: (call) => {
        if (call.kind === "recheck") {
          return chatResult(RECHECK_BODY);
        }
        if (isTarget0(call)) {
          // 2 観点が同じ指摘を返し、typo だけ位置特定に失敗する引用も返す。
          return call.perspective === "typo"
            ? chatResult(
                checkBody(
                  typoFinding(),
                  typoFinding({ quote: "存在しない引用", before: "", after: "" }),
                ),
              )
            : chatResult(checkBody(typoFinding()));
        }
        return call.perspective === "typo"
          ? chatResult("これは JSON ではない")
          : chatResult(EMPTY_CHECK);
      },
    });

    const result = await runPipeline(
      baseArgs(mock.client, { mode: "split-recheck", perspectives: ["typo", "naturalness"] }),
    );

    expect(result.status).toBe("partially-failed");
    expect(result.totals).toEqual({
      targets: 2,
      checkUnits: { done: 3, failed: 1, pending: 0 },
      requests: 6,
      candidates: 3,
      located: 2,
      unlocated: { notFound: 1, ambiguous: 0, outsideTarget: 0 },
      findings: 1,
      suppressed: 0,
      rechecks: { done: 1, failed: 0, pending: 0, suppressed: 0, disabled: 0 },
      elapsedMs: result.totals.elapsedMs,
    });
    expect(result.totals.checkUnits.done).toBe(
      result.checkUnits.filter((unit) => unit.status === "done").length,
    );
    expect(result.totals.findings).toBe(result.findings.length);
    expect(result.totals.unlocated.notFound).toBe(result.unlocated.length);
  });
});
