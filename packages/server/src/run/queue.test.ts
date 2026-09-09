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
import { createRequestQueue, QueueCancelledError } from "./queue.ts";

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
 * マイクロタスクを数回流す。キューの連鎖（`tail.then(...)`）と早期取り消しの
 * `Promise.race` が進むのを待つためだけに使う。実時間は 1 ミリ秒も進めない。
 */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

/**
 * Promise の決着を「待たずに」観測する。先行ジョブを未解決に保ったまま
 * 「もう決着しているか」を確かめるために使う（`await` で待つと、実装が壊れているとき
 * テストがタイムアウトするまで固まり、何が失敗したのか分からなくなる）。
 */
function watch<T>(promise: Promise<T>): { settled: () => boolean; error: () => unknown } {
  let settled = false;
  let error: unknown = null;
  void promise.then(
    () => {
      settled = true;
    },
    (caught: unknown) => {
      settled = true;
      error = caught;
    },
  );
  return { settled: () => settled, error: () => error };
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

  it("Q4b: 呼び出し順が A1 → A2 → B1（A・B は別々の executor）のとき、共有キューへの投入・実行順も A1 → A2 → B1 になる", async () => {
    const timeline: string[] = [];
    const queue = createRequestQueue();
    const gateA1 = deferred<void>();
    const gateA2 = deferred<void>();
    const gateB1 = deferred<void>();

    const clientA = createTrackingClient("A", timeline, {
      gates: [gateA1, gateA2],
      outcomes: ["ok", "ok"],
    });
    const clientB = createTrackingClient("B", timeline, {
      gates: [gateB1],
      outcomes: ["ok"],
    });
    const executorA = createExecutor(clientA, { queue });
    const executorB = createExecutor(clientB, { queue });

    // A1 → A2 → B1 の順で、互いの完了を待たずに呼び出す。A2 は同じ executorA からの 2 回目の
    // 呼び出し（executor 固有の tail を経由すると A1 の完了待ちになってしまう箇所）。
    const promiseA1 = executorA.execute(REQUEST, parse, 1000);
    const promiseA2 = executorA.execute(REQUEST, parse, 1000);
    const promiseB1 = executorB.execute(REQUEST, parse, 1000);

    // A1 の chat が保留中の間は、A2 も B1 もまだ ensureLoaded すら呼ばれていないはず
    // （共有キューが同時実行数を 1 に保つ）。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(timeline).toEqual(["A:ensureLoaded1", "A:chat1-start"]);

    gateA1.resolve();
    await promiseA1;
    // キューが次のジョブ（A2）を取り出して開始するまでの数マイクロタスクを流す。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // A1 の次に実行されるのは呼び出し順どおり A2。B1 はまだ始まらない
    // （投入順が呼び出し順とずれていれば、ここで B:ensureLoaded1 が先に来てしまう）。
    expect(timeline).toEqual([
      "A:ensureLoaded1",
      "A:chat1-start",
      "A:chat1-end",
      "A:ensureLoaded2",
      "A:chat2-start",
    ]);

    gateA2.resolve();
    await promiseA2;

    gateB1.resolve();
    await promiseB1;

    expect(timeline).toEqual([
      "A:ensureLoaded1",
      "A:chat1-start",
      "A:chat1-end",
      "A:ensureLoaded2",
      "A:chat2-start",
      "A:chat2-end",
      "B:ensureLoaded1",
      "B:chat1-start",
      "B:chat1-end",
    ]);
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

  /** ---------------------------------------------------------------------- */
  /** Q5〜Q9（45-2：キュー待ち中の停止をただちに決着させる） */
  /** ---------------------------------------------------------------------- */

  it("Q5: キュー待ち中に abort すると、先行ジョブの解決を待たずに QueueCancelledError で決着する", async () => {
    const queue = createRequestQueue();
    const gateA = deferred<void>();
    const controller = new AbortController();

    const jobA = queue.enqueue(async () => {
      await gateA.promise;
      return "A";
    });
    let calledB = false;
    const jobB = queue.enqueue(
      async () => {
        calledB = true;
        return "B";
      },
      { signal: controller.signal },
    );
    const observed = watch(jobB);

    controller.abort();
    await flushMicrotasks();

    // A はまだ未解決。それでも B は決着していなければならない。
    expect(observed.settled()).toBe(true);
    expect(observed.error()).toBeInstanceOf(QueueCancelledError);
    expect(calledB).toBe(false);

    gateA.resolve();
    await expect(jobA).resolves.toBe("A");
    await expect(jobB).rejects.toBeInstanceOf(QueueCancelledError);
  });

  it("Q6: 取り消したジョブは順番が来ても実行されず、後続ジョブは投入順に実行される（連鎖が切れない）", async () => {
    const queue = createRequestQueue();
    const order: string[] = [];
    const gateA = deferred<void>();
    const controller = new AbortController();

    const jobA = queue.enqueue(async () => {
      order.push("A");
      await gateA.promise;
      return "A";
    });
    let calledB = false;
    const jobB = queue.enqueue(
      async () => {
        calledB = true;
        order.push("B");
        return "B";
      },
      { signal: controller.signal },
    );
    const jobC = queue.enqueue(async () => {
      order.push("C");
      return "C";
    });

    controller.abort();
    await flushMicrotasks();

    // A を解決させて B の順番を回す。B のジョブ関数は呼ばれず、C まで連鎖が続く。
    gateA.resolve();
    await expect(jobA).resolves.toBe("A");
    await expect(jobC).resolves.toBe("C");
    await expect(jobB).rejects.toBeInstanceOf(QueueCancelledError);

    expect(calledB).toBe(false);
    expect(order).toEqual(["A", "C"]);
  });

  it("Q7: 取り消したジョブがあっても size は 0 に戻る（二重減算・減算漏れがない）", async () => {
    const queue = createRequestQueue();
    const gateA = deferred<void>();
    const controller = new AbortController();

    const jobA = queue.enqueue(async () => {
      await gateA.promise;
      return "A";
    });
    const jobB = queue.enqueue(async () => "B", { signal: controller.signal });
    const jobC = queue.enqueue(async () => "C");
    expect(queue.size).toBe(3);

    controller.abort();
    await flushMicrotasks();
    // 早期に決着しても、キューの席が空くのは順番が来たときなので A・C はまだ残っている。
    expect(queue.size).toBe(3);

    gateA.resolve();
    await jobA;
    await jobC;
    await expect(jobB).rejects.toBeInstanceOf(QueueCancelledError);
    await flushMicrotasks();

    expect(queue.size).toBe(0);
  });

  it("Q8: ジョブが走り始めた後の abort は取り消しにならず、ジョブ自身の結果で決着する", async () => {
    const queue = createRequestQueue();
    const gate = deferred<void>();
    const controller = new AbortController();

    let started = false;
    const job = queue.enqueue(
      async () => {
        started = true;
        await gate.promise;
        return "done";
      },
      { signal: controller.signal },
    );

    await flushMicrotasks();
    expect(started).toBe(true);

    controller.abort();
    await flushMicrotasks();
    gate.resolve();

    await expect(job).resolves.toBe("done");
  });

  it("Q9: 共有キューで待っている実行を停止すると、先行ジョブを待たずに ok:false の ExecOutcome で決着する", async () => {
    const queue = createRequestQueue();
    const timeline: string[] = [];
    const gateA = deferred<void>();
    // 先行ジョブ（別の実行の生成）が未解決のままキューを占有している状態を作る。
    const jobA = queue.enqueue(async () => {
      await gateA.promise;
      return "A";
    });

    const controller = new AbortController();
    const client = createTrackingClient("B", timeline, { gates: [], outcomes: ["ok"] });
    const executor = createExecutor(client, { queue, signal: controller.signal });
    const promise = executor.execute(REQUEST, parse, 1000);
    const observed = watch(promise);

    controller.abort();
    await flushMicrotasks();

    // 先行ジョブ（A）は未解決のまま。それでも execute は決着していなければならない。
    expect(observed.settled()).toBe(true);
    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("停止したのに成功している");
    }
    expect(outcome.attempts).toBe(0);
    expect(outcome.failure.reason).toBe("aborted");
    expect(outcome.failure.message).toBe("停止要求により生成要求を送らなかった");
    expect(outcome.halt?.reason).toBe("aborted");
    expect(outcome.halt?.generationUnconfirmed).toBe(false);
    // 生成要求は 1 件も送っていない（ensureLoaded も chat も呼ばれていない）。
    expect(timeline).toEqual([]);
    expect(executor.requestCount).toBe(0);

    gateA.resolve();
    await jobA;
  });
});
