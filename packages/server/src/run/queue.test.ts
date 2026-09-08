import { describe, expect, it } from "vitest";

import { LmStudioError } from "../lmstudio/errors.ts";
import type {
  ChatRequest,
  ChatResult,
  LmStudioClient,
  ModelInfo,
  Usage,
} from "../lmstudio/types.ts";
import { createExecutor } from "./executor.ts";
import { createRequestQueue } from "./queue.ts";

const REQUEST: ChatRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "本文" }],
  maxTokens: 1024,
  temperature: 0,
};

const USAGE: Usage = {
  promptTokens: 10,
  completionTokens: 20,
  totalTokens: 30,
  reasoningTokens: null,
};

function model(id = "test-model"): ModelInfo {
  return {
    id,
    type: "llm",
    state: "loaded",
    quantization: null,
    maxContextLength: null,
    loadedContextLength: null,
  };
}

function chatResult(content: string): ChatResult {
  return { content, reasoningContent: null, finishReason: "stop", usage: USAGE, raw: {} };
}

const parse = (result: ChatResult): string => result.content;

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * 呼び出しごとに timeline へ「ラベル:出来事」を push するモッククライアント。
 * ensureLoaded は即座に解決し、chat は渡された gate が解決するまで待つ。
 * 開始と終了の両方を記録するので、他のジョブが割り込んでいれば timeline の並びで分かる。
 */
function createTrackingClient(
  label: string,
  timeline: string[],
  chatBehavior: {
    gates: Array<{ promise: Promise<void> }>;
    /** 各 chat 呼び出しの結果。malformed を投げるなら null を返す代わりに throw する。 */
    outcomes: Array<"ok" | "malformed">;
  },
): LmStudioClient {
  let ensureLoadedCalls = 0;
  let chatCalls = 0;
  return {
    listModels: async () => [],
    ensureLoaded: async () => {
      ensureLoadedCalls += 1;
      timeline.push(`${label}:ensureLoaded${ensureLoadedCalls}`);
      return model();
    },
    chat: async () => {
      chatCalls += 1;
      const index = chatCalls - 1;
      timeline.push(`${label}:chat${chatCalls}-start`);
      const gate = chatBehavior.gates[index];
      if (gate !== undefined) {
        await gate.promise;
      }
      const outcome = chatBehavior.outcomes[index] ?? "ok";
      if (outcome === "malformed") {
        timeline.push(`${label}:chat${chatCalls}-fail`);
        throw new LmStudioError("malformed", "解析できなかった");
      }
      timeline.push(`${label}:chat${chatCalls}-end`);
      return chatResult("ok");
    },
  };
}

describe("createRequestQueue", () => {
  it("Q1: 2 つの executor に同じキューを渡すと、要求が交互に並ばず投入順に直列化される", async () => {
    const timeline: string[] = [];
    const queue = createRequestQueue();
    const gateA = deferred<void>();
    const gateB = deferred<void>();

    const clientA = createTrackingClient("A", timeline, {
      gates: [gateA],
      outcomes: ["ok"],
    });
    const clientB = createTrackingClient("B", timeline, {
      gates: [gateB],
      outcomes: ["ok"],
    });
    const executorA = createExecutor(clientA, { queue });
    const executorB = createExecutor(clientB, { queue });

    const promiseA = executorA.execute(REQUEST, parse, 1000);
    const promiseB = executorB.execute(REQUEST, parse, 1000);

    // A の chat がまだ解決していない間は、B は ensureLoaded すら呼ばれていないはず。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(timeline).toEqual(["A:ensureLoaded1", "A:chat1-start"]);

    gateA.resolve();
    await promiseA;
    gateB.resolve();
    await promiseB;

    expect(timeline).toEqual([
      "A:ensureLoaded1",
      "A:chat1-start",
      "A:chat1-end",
      "B:ensureLoaded1",
      "B:chat1-start",
      "B:chat1-end",
    ]);
  });

  it("Q2: 1 ジョブ（再試行を含む）の途中に別ジョブの呼び出しが割り込まない", async () => {
    const timeline: string[] = [];
    const queue = createRequestQueue();
    const gateA1 = deferred<void>();
    const gateA2 = deferred<void>();

    // A は 1 回目 malformed で再試行し、2 回目で成功する。
    const gateB = deferred<void>();
    const clientA = createTrackingClient("A", timeline, {
      gates: [gateA1, gateA2],
      outcomes: ["malformed", "ok"],
    });
    const clientB = createTrackingClient("B", timeline, {
      gates: [gateB],
      outcomes: ["ok"],
    });
    const executorA = createExecutor(clientA, { queue });
    const executorB = createExecutor(clientB, { queue });

    const promiseA = executorA.execute(REQUEST, parse, 1000);
    const promiseB = executorB.execute(REQUEST, parse, 1000);

    // A の 1 回目の chat が保留中。B はまだ何も呼ばれていないはず。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(timeline).toEqual(["A:ensureLoaded1", "A:chat1-start"]);

    // 1 回目を malformed で失敗させ、再試行の ensureLoaded/chat が始まっても B は割り込まない。
    gateA1.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(timeline).toEqual([
      "A:ensureLoaded1",
      "A:chat1-start",
      "A:chat1-fail",
      "A:ensureLoaded2",
      "A:chat2-start",
    ]);

    gateA2.resolve();
    const outcomeA = await promiseA;
    expect(outcomeA.ok).toBe(true);

    gateB.resolve();
    const outcomeB = await promiseB;
    expect(outcomeB.ok).toBe(true);

    expect(timeline).toEqual([
      "A:ensureLoaded1",
      "A:chat1-start",
      "A:chat1-fail",
      "A:ensureLoaded2",
      "A:chat2-start",
      "A:chat2-end",
      "B:ensureLoaded1",
      "B:chat1-start",
      "B:chat1-end",
    ]);
  });

  it("Q3: ジョブが例外を投げても後続のジョブは実行され、例外は投入元に返る", async () => {
    const queue = createRequestQueue();
    const timeline: string[] = [];
    const boom = new Error("boom");

    const first = queue.enqueue(async () => {
      timeline.push("first-start");
      timeline.push("first-throw");
      throw boom;
    });
    const second = queue.enqueue(async () => {
      timeline.push("second-start");
      timeline.push("second-end");
      return "second-result";
    });

    await expect(first).rejects.toBe(boom);
    await expect(second).resolves.toBe("second-result");
    expect(timeline).toEqual(["first-start", "first-throw", "second-start", "second-end"]);
  });

  it("Q3b: size は投入時に増え、ジョブの成功・失敗どちらでも解決後に減る", async () => {
    const queue = createRequestQueue();
    const gate = deferred<void>();

    expect(queue.size).toBe(0);
    const ok = queue.enqueue(async () => {
      await gate.promise;
      return "ok";
    });
    expect(queue.size).toBe(1);
    const fails = queue.enqueue(async () => {
      throw new Error("boom");
    });
    expect(queue.size).toBe(2);

    gate.resolve();
    await ok;
    await expect(fails).rejects.toThrow("boom");

    expect(queue.size).toBe(0);
  });

  it("Q4: queue を渡さない createExecutor は従来どおり同時実行が重ならない", async () => {
    let active = 0;
    let maxActive = 0;
    const client: LmStudioClient = {
      listModels: async () => [],
      ensureLoaded: async () => model(),
      chat: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return chatResult("ok");
      },
    };
    const executor = createExecutor(client, {});

    await Promise.all([
      executor.execute(REQUEST, parse, 1000),
      executor.execute(REQUEST, parse, 1000),
    ]);

    expect(maxActive).toBe(1);
  });
});
