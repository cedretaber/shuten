import { describe, expect, it, vi } from "vitest";

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
import { createRecoveryGate, type RecoveryGate } from "./recovery-gate.ts";

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

function model(type: string | null, id = "test-model"): ModelInfo {
  return {
    id,
    type,
    state: "loaded",
    quantization: null,
    maxContextLength: null,
    loadedContextLength: null,
  };
}

function chatResult(
  content: string,
  finishReason = "stop",
  usage: Usage | null = USAGE,
): ChatResult {
  return { content, reasoningContent: null, finishReason, usage, raw: {} };
}

/** 呼び出し順を記録するモック。ensureLoaded と chat の挙動だけ差し替える。 */
function createMockClient(behavior: {
  ensureLoaded?: (modelId: string) => Promise<ModelInfo>;
  chat?: (request: ChatRequest) => Promise<ChatResult>;
  calls?: string[];
}): LmStudioClient {
  const calls = behavior.calls ?? [];
  return {
    listModels: vi.fn(async () => []),
    ensureLoaded: vi.fn(async (modelId: string) => {
      calls.push("ensureLoaded");
      return behavior.ensureLoaded !== undefined
        ? await behavior.ensureLoaded(modelId)
        : model("llm");
    }),
    chat: vi.fn(async (request: ChatRequest) => {
      calls.push("chat");
      return behavior.chat !== undefined ? await behavior.chat(request) : chatResult("ok");
    }),
    close: vi.fn(async () => {}),
  };
}

/** 単調増加する時計。now() が呼ばれるたびに 1 進む（elapsedMs を必ず正にする）。 */
function createClock(): () => number {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
}

const parse = (result: ChatResult): string => result.content;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** `blocked` を差し替えられる最小限の RecoveryGate スタブ。block/unblock は使わない。 */
function stubRecoveryGate(blocked: boolean): RecoveryGate {
  return {
    blockedRunIds: new Set(blocked ? ["other-run"] : []),
    blocked,
    block: vi.fn(),
    unblock: vi.fn(),
  };
}

describe("createExecutor", () => {
  it("E1: chat の直前に必ず ensureLoaded が呼ばれる", async () => {
    const calls: string[] = [];
    const client = createMockClient({ calls });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(["ensureLoaded", "chat"]);
  });

  it("E2: 同時に 2 つ execute しても chat が重ならない", async () => {
    let active = 0;
    let maxActive = 0;
    const client = createMockClient({
      chat: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return chatResult("ok");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    await Promise.all([
      executor.execute(REQUEST, parse, 1000),
      executor.execute(REQUEST, parse, 1000),
    ]);

    expect(maxActive).toBe(1);
    expect(executor.requestCount).toBe(2);
  });

  it("E3: malformed は 1 回だけ再試行し、2 回目も失敗なら attempts 2・halt なし", async () => {
    const client = createMockClient({
      chat: async () => {
        throw new LmStudioError("malformed", "解析できなかった");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.attempts).toBe(2);
    expect(outcome.failure.reason).toBe("malformed");
    expect(outcome.failure.origin).toBe("chat");
    expect(outcome.halt).toBeNull();
  });

  it("E4: truncated も 1 回再試行し、maxTokens を変えずに送る", async () => {
    const sent: number[] = [];
    let count = 0;
    const client = createMockClient({
      chat: async (request) => {
        sent.push(request.maxTokens);
        count += 1;
        if (count === 1) {
          throw new LmStudioError("truncated", "打ち切られた", { usage: USAGE });
        }
        return chatResult("ok");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(2);
    expect(sent).toEqual([1024, 1024]);
  });

  it("E5: stop 以外の finishReason は truncated にし、実際の値を failure に残す", async () => {
    const client = createMockClient({
      chat: async () => chatResult("{}", "tool_calls"),
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.reason).toBe("truncated");
    expect(outcome.failure.finishReason).toBe("tool_calls");
    expect(outcome.attempts).toBe(2);
    expect(outcome.halt).toBeNull();
  });

  it("E6: HTTP 応答ありの connection が 2 回続くと connection-lost で停止する", async () => {
    const client = createMockClient({
      chat: async () => {
        throw new LmStudioError("connection", "拒否された", { status: 500 });
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.attempts).toBe(2);
    expect(outcome.halt?.reason).toBe("connection-lost");
    expect(outcome.halt?.generationUnconfirmed).toBe(false);
    expect(outcome.halt?.failure?.origin).toBe("chat");
  });

  it("E7: chat の model-not-loaded は再試行せず model-not-loaded で停止する", async () => {
    const client = createMockClient({
      chat: async () => {
        throw new LmStudioError("model-not-loaded", "アンロードされた");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.halt?.reason).toBe("model-not-loaded");
    expect(outcome.halt?.generationUnconfirmed).toBe(false);
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it("E8: ensureLoaded の model-not-loaded では chat を呼ばず attempts 0", async () => {
    const client = createMockClient({
      ensureLoaded: async () => {
        throw new LmStudioError("model-not-loaded", "未ロード");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(client.chat).not.toHaveBeenCalled();
    expect(outcome.attempts).toBe(0);
    expect(outcome.failure.origin).toBe("ensure-loaded");
    expect(outcome.halt?.reason).toBe("model-not-loaded");
  });

  it("E9: ensureLoaded の timeout は connection-lost（recovery-needed にしない）", async () => {
    const client = createMockClient({
      ensureLoaded: async () => {
        throw new LmStudioError("timeout", "一覧取得がタイムアウトした");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.halt?.reason).toBe("connection-lost");
    expect(outcome.halt?.generationUnconfirmed).toBe(false);
    expect(outcome.failure.reason).toBe("timeout");
  });

  it("E10: chat の timeout は recovery-needed かつ generationUnconfirmed", async () => {
    const client = createMockClient({
      chat: async () => {
        throw new LmStudioError("timeout", "生成がタイムアウトした");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.halt?.reason).toBe("recovery-needed");
    expect(outcome.halt?.generationUnconfirmed).toBe(true);
  });

  it("E11: chat 中の中断は aborted かつ generationUnconfirmed", async () => {
    const controller = new AbortController();
    const client = createMockClient({
      chat: async () => {
        controller.abort();
        throw new LmStudioError("aborted", "呼び出し元によって要求が中断された");
      },
    });
    const executor = createExecutor(client, { signal: controller.signal, now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.halt?.reason).toBe("aborted");
    expect(outcome.halt?.generationUnconfirmed).toBe(true);
  });

  it("E11b: 呼び出し前から中断されていれば ensureLoaded も chat も呼ばない", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createMockClient({});
    const executor = createExecutor(client, { signal: controller.signal, now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(client.ensureLoaded).not.toHaveBeenCalled();
    expect(client.chat).not.toHaveBeenCalled();
    expect(outcome.attempts).toBe(0);
    expect(outcome.halt?.reason).toBe("aborted");
    expect(outcome.halt?.generationUnconfirmed).toBe(false);
    expect(outcome.halt?.failure).toBeNull();
  });

  it("E11c: ensureLoaded の途中で中断されると chat を送らず generationUnconfirmed にしない", async () => {
    const controller = new AbortController();
    const client = createMockClient({
      ensureLoaded: async () => {
        // 一覧は取れたが、その待ち時間の間に停止要求が来た状況。
        controller.abort();
        return model("llm");
      },
    });
    const executor = createExecutor(client, { signal: controller.signal, now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(client.chat).not.toHaveBeenCalled();
    expect(outcome.attempts).toBe(0);
    expect(outcome.failure.origin).toBe("local");
    expect(outcome.halt?.reason).toBe("aborted");
    expect(outcome.halt?.generationUnconfirmed).toBe(false);
  });

  it("E12: 最初の ensureLoaded の ModelInfo が modelInfo に残る", async () => {
    let count = 0;
    const client = createMockClient({
      ensureLoaded: async () => {
        count += 1;
        return model("llm", count === 1 ? "first" : "second");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    expect(executor.modelInfo).toBeNull();
    await executor.execute(REQUEST, parse, 1000);
    await executor.execute(REQUEST, parse, 1000);

    expect(executor.modelInfo?.id).toBe("first");
  });

  it("E13: 失敗しても usage と elapsedMs が載る（truncated で usage が非 null）", async () => {
    const client = createMockClient({
      chat: async () => {
        throw new LmStudioError("truncated", "打ち切られた", { usage: USAGE });
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.usage).toEqual(USAGE);
    expect(outcome.elapsedMs).toBeGreaterThan(0);
  });

  it("E14: requestCount が再試行を含む送信回数と一致する", async () => {
    let count = 0;
    const client = createMockClient({
      chat: async () => {
        count += 1;
        if (count === 1) {
          throw new LmStudioError("malformed", "解析できなかった");
        }
        return chatResult("ok");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    await executor.execute(REQUEST, parse, 1000);
    await executor.execute(REQUEST, parse, 1000);

    expect(executor.requestCount).toBe(3);
  });

  it("E15: HTTP 応答を受け取った connection は 1 回再試行する", async () => {
    let count = 0;
    const client = createMockClient({
      chat: async () => {
        count += 1;
        if (count === 1) {
          throw new LmStudioError("connection", "500 が返った", { status: 500 });
        }
        return chatResult("ok");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(2);
  });

  it("E16: 応答を受け取れなかった connection は再試行せず generationUnconfirmed", async () => {
    const client = createMockClient({
      chat: async () => {
        throw new LmStudioError("connection", "接続に失敗した");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.attempts).toBe(1);
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(outcome.halt?.reason).toBe("connection-lost");
    expect(outcome.halt?.generationUnconfirmed).toBe(true);
  });

  it("E17: ensureLoaded 中の aborted は chat を呼ばず aborted で停止する", async () => {
    const client = createMockClient({
      ensureLoaded: async () => {
        throw new LmStudioError("aborted", "一覧取得が中断された");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(client.chat).not.toHaveBeenCalled();
    expect(outcome.attempts).toBe(0);
    expect(outcome.halt?.reason).toBe("aborted");
    expect(outcome.halt?.generationUnconfirmed).toBe(false);
  });

  it("E18: 生成に使えない種別では chat を呼ばず settings で停止する", async () => {
    for (const type of ["embeddings", "unknown-type", null]) {
      const client = createMockClient({ ensureLoaded: async () => model(type) });
      const executor = createExecutor(client, { now: createClock() });

      const outcome = await executor.execute(REQUEST, parse, 1000);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(client.chat).not.toHaveBeenCalled();
      expect(outcome.attempts).toBe(0);
      expect(outcome.failure.reason).toBe("model-not-loaded");
      expect(outcome.failure.origin).toBe("ensure-loaded");
      expect(outcome.halt?.reason).toBe("settings");
      expect(outcome.halt?.generationUnconfirmed).toBe(false);
    }

    for (const type of ["llm", "vlm"]) {
      const client = createMockClient({ ensureLoaded: async () => model(type) });
      const executor = createExecutor(client, { now: createClock() });

      const outcome = await executor.execute(REQUEST, parse, 1000);

      expect(outcome.ok).toBe(true);
      expect(client.chat).toHaveBeenCalledTimes(1);
    }
  });

  it("E19: 直列待ちの間に中断されると、順番が回った要求は何も呼ばない", async () => {
    const controller = new AbortController();
    const gate = deferred<ChatResult>();
    const entered = deferred<void>();
    const client = createMockClient({
      chat: async () => {
        entered.resolve(undefined);
        return await gate.promise;
      },
    });
    const executor = createExecutor(client, { signal: controller.signal, now: createClock() });

    const first = executor.execute(REQUEST, parse, 1000);
    const second = executor.execute(REQUEST, parse, 1000);
    // 1 つ目が chat に入って（＝2 つ目が待ち行列にいる）から中断する。
    await entered.promise;
    controller.abort();
    gate.resolve(chatResult("ok"));

    expect((await first).ok).toBe(true);
    const outcome = await second;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(client.ensureLoaded).toHaveBeenCalledTimes(1);
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(outcome.attempts).toBe(0);
    expect(outcome.halt?.reason).toBe("aborted");
  });

  it("E20: 1 つ目のタイムアウトで停止すると、2 つ目は同じ halt を送信せずに返す", async () => {
    const client = createMockClient({
      chat: async () => {
        throw new LmStudioError("timeout", "生成がタイムアウトした");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const [first, second] = await Promise.all([
      executor.execute(REQUEST, parse, 1000),
      executor.execute(REQUEST, parse, 1000),
    ]);

    expect(client.ensureLoaded).toHaveBeenCalledTimes(1);
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) return;
    expect(second.attempts).toBe(0);
    expect(second.halt).toBe(first.halt);
    expect(second.halt?.generationUnconfirmed).toBe(true);
  });

  it("E21: 停止後の execute は保持している halt を上書きしない", async () => {
    const controller = new AbortController();
    const client = createMockClient({
      chat: async () => {
        throw new LmStudioError("connection", "接続に失敗した");
      },
    });
    const executor = createExecutor(client, { signal: controller.signal, now: createClock() });

    const first = await executor.execute(REQUEST, parse, 1000);
    controller.abort();
    const second = await executor.execute(REQUEST, parse, 1000);

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) return;
    expect(second.halt).toBe(first.halt);
    expect(second.halt?.reason).toBe("connection-lost");
    expect(second.halt?.generationUnconfirmed).toBe(true);
    expect(client.ensureLoaded).toHaveBeenCalledTimes(1);
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it("E23: onSend/onSettled は client.chat 呼び出しのたびに 1 往復ずつ呼ばれる", async () => {
    let count = 0;
    const client = createMockClient({
      chat: async () => {
        count += 1;
        if (count === 1) {
          throw new LmStudioError("malformed", "解析できなかった");
        }
        return chatResult("ok");
      },
    });
    const executor = createExecutor(client, { now: createClock() });
    const order: string[] = [];
    const onSend = vi.fn(() => order.push("onSend"));
    const onSettled = vi.fn(() => order.push("onSettled"));

    const outcome = await executor.execute(REQUEST, parse, 1000, { onSend, onSettled });

    expect(outcome.ok).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["onSend", "onSettled", "onSend", "onSettled"]);
  });

  it("E24: client.chat が例外を投げても onSettled は onSend と同数呼ばれる", async () => {
    const client = createMockClient({
      chat: async () => {
        throw new Error("想定外の例外");
      },
    });
    const executor = createExecutor(client, { now: createClock() });
    const onSend = vi.fn();
    const onSettled = vi.fn();

    await expect(executor.execute(REQUEST, parse, 1000, { onSend, onSettled })).rejects.toThrow(
      "想定外の例外",
    );
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("E25: hooks を渡さなくても（既存の 3 引数のモックと同じ形でも）従来どおり動く", async () => {
    const client = createMockClient({});
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(true);
  });

  it("E26: signal が中断されていたら再試行の chat を送らず、届いていた失敗内容を残す", async () => {
    const controller = new AbortController();
    const client = createMockClient({
      chat: async () => {
        // 1 回目の応答が届いた直後（malformed の解析中）に停止要求が来た状況を模す。
        controller.abort();
        throw new LmStudioError("malformed", "解析できなかった");
      },
    });
    const executor = createExecutor(client, { signal: controller.signal, now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // chat が 1 回しか呼ばれない点は、signal 未確認のままでも ensureLoaded 経由の
    // isAborted チェックで結局止まるので変わらない。ここで確かめたいのは、
    // 届いた応答の失敗内容（malformed）が ensure-loaded 由来の aborted に
    // 置き換わらずに残ること（failure.reason・halt.message が本質）。
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(outcome.attempts).toBe(1);
    expect(outcome.failure.reason).toBe("malformed");
    expect(outcome.failure.origin).toBe("chat");
    expect(outcome.halt?.reason).toBe("aborted");
    expect(outcome.halt?.message).toBe("停止要求により再試行を送らなかった");
    expect(outcome.halt?.generationUnconfirmed).toBe(false);
    expect(outcome.halt?.failure?.reason).toBe("malformed");
  });

  it("E22: 再試行前の ensureLoaded が model-not-loaded でも attempts は 1 のまま", async () => {
    let loads = 0;
    const client = createMockClient({
      ensureLoaded: async () => {
        loads += 1;
        if (loads === 1) {
          return model("llm");
        }
        throw new LmStudioError("model-not-loaded", "アンロードされた");
      },
      chat: async () => {
        throw new LmStudioError("malformed", "解析できなかった");
      },
    });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.attempts).toBe(1);
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(outcome.failure.origin).toBe("ensure-loaded");
    expect(outcome.halt?.reason).toBe("model-not-loaded");
  });

  it("E27: ensureLoaded が失敗して chat を送らなければ、onSend/onSettled は 0 回のまま（フックは ensureLoaded の周りでは呼ばない）", async () => {
    const client = createMockClient({
      ensureLoaded: async () => {
        throw new LmStudioError("model-not-loaded", "未ロード");
      },
    });
    const executor = createExecutor(client, { now: createClock() });
    const onSend = vi.fn();
    const onSettled = vi.fn();

    const outcome = await executor.execute(REQUEST, parse, 1000, { onSend, onSettled });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(client.chat).not.toHaveBeenCalled();
    expect(outcome.attempts).toBe(0);
    // onSend/onSettled を ensureLoaded の前後（あるいは execute 全体）に張ってしまう変異は、
    // ここで onSend/onSettled が呼ばれてしまうため落ちる。
    expect(onSend).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("R8: recoveryGate.blocked が真なら、ensureLoaded も chat も呼ばず recovery-blocked で止める（決定 39）", async () => {
    const client = createMockClient({});
    const recoveryGate = stubRecoveryGate(true);
    const executor = createExecutor(client, { now: createClock(), recoveryGate });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(client.ensureLoaded).not.toHaveBeenCalled();
    expect(client.chat).not.toHaveBeenCalled();
    expect(outcome.attempts).toBe(0);
    expect(outcome.halt?.reason).toBe("recovery-blocked");
    expect(outcome.halt?.generationUnconfirmed).toBe(false);
    // RunStop.failure はこの実行自身の失敗ではないので null（result.ts のコメントに倣う。
    // 停止要求＝aborted の halt.failure と同じ扱い）。単位側の outcome.failure は
    // 「送らなかった」という単位の事実として非 null（notSentFailure、origin: "local"）で
    // pending に写るための材料になる。
    expect(outcome.halt?.failure).toBeNull();
    expect(outcome.failure.origin).toBe("local");
  });

  it("R9: recoveryGate を渡しても blocked が偽なら、従来どおり ensureLoaded → chat の順で呼ぶ", async () => {
    const calls: string[] = [];
    const client = createMockClient({ calls });
    const recoveryGate = stubRecoveryGate(false);
    const executor = createExecutor(client, { now: createClock(), recoveryGate });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(["ensureLoaded", "chat"]);
  });

  it("R13: recoveryGate.blocked は「投入時」ではなく「共有キューで順番が回ってきた時点」で見る（決定 39 の本題）", async () => {
    // 本物の RequestQueue と RecoveryGate を使う。R8/R9 は blocked を定数で固定したスタブ
    // だったため、「execute() を呼んだ時点（queue.enqueue の手前）で recoveryGate.blocked を
    // 読んでしまう」という決定 39 が禁じている実装でも通ってしまっていた。ここでは A が
    // まだ未確認になっていない時点（B の execute() を呼んだ直後）ではゲートは開いており、
    // A の実行が recovery-waiting に決着してはじめて（＝共有キューで B の順番が回ってきた
    // 時点までに）閉じることを、実際のキュー・ゲートの組み合わせで固定する。
    const queue = createRequestQueue();
    const gate = createRecoveryGate();

    const clientA = createMockClient({
      chat: async () => {
        throw new LmStudioError("timeout", "生成がタイムアウトした");
      },
    });
    const executorA = createExecutor(clientA, {
      now: createClock(),
      queue,
      recoveryGate: gate,
      onRecoveryRequired: () => {
        gate.block("run-a");
      },
    });

    const clientB = createMockClient({});
    const executorB = createExecutor(clientB, {
      now: createClock(),
      queue,
      recoveryGate: gate,
    });

    // A と B の execute() を同期的に続けて呼ぶ。この時点では A の chat はまだ 1 ステップも
    // 進んでいない（Promise が作られただけ）ので、gate.blocked は依然として false。
    // B がここで「投入時」に blocked を読んでしまう実装なら、B は素通りしてしまう。
    const promiseA = executorA.execute(REQUEST, parse, 1000);
    expect(gate.blocked).toBe(false);
    const promiseB = executorB.execute(REQUEST, parse, 1000);

    const [outcomeA, outcomeB] = await Promise.all([promiseA, promiseB]);

    expect(outcomeA.ok).toBe(false);
    if (outcomeA.ok) return;
    expect(outcomeA.halt?.reason).toBe("recovery-needed");
    expect(outcomeA.halt?.generationUnconfirmed).toBe(true);
    expect(gate.blocked).toBe(true);

    expect(outcomeB.ok).toBe(false);
    if (outcomeB.ok) return;
    // B は共有キューで自分の番が回ってきた時点でゲートを見るので、A が未確認になった
    // あとに送信しようとした B は、ensureLoaded すら呼ばずに recovery-blocked で止まる。
    expect(clientB.ensureLoaded).not.toHaveBeenCalled();
    expect(clientB.chat).not.toHaveBeenCalled();
    expect(outcomeB.halt?.reason).toBe("recovery-blocked");
  });

  it("R13b: 同じ executor でキュー待ちの単位を取り消しても、送信中だった単位の生成未確認が消えない（決定 45-2 × 39）", async () => {
    // 45-2 の取り消しは**キューの直列化の外**（execute の catch）で走る。ここで共有の halt を
    // 書いてしまうと、先に決着した取り消し（generationUnconfirmed: false）が halt を占領し、
    // 後から中断を処理する送信中の単位が `halt ??= stop` で自分の halt を反映できなくなる。
    // 結果、finish() が onRecoveryRequired を呼ばず、復旧ゲートが開いたままになる。
    const queue = createRequestQueue();
    const gate = createRecoveryGate();
    const controller = new AbortController();

    // A1 の chat は abort で自動的に落とさず、テストが握る deferred で落とす。
    // 自動 reject にすると A1 と A2 の決着順がマイクロタスクの深さで揺れ、変異を当てても
    // 落ちたり落ちなかったりする。順序をテスト側で決め切る。
    let rejectChatA: (error: unknown) => void = () => undefined;
    const chatA = new Promise<ChatResult>((_, reject) => {
      rejectChatA = reject;
    });
    const clientA = createMockClient({ chat: async () => await chatA });
    const executorA = createExecutor(clientA, {
      now: createClock(),
      queue,
      signal: controller.signal,
      recoveryGate: gate,
      onRecoveryRequired: () => {
        gate.block("run-a");
      },
    });
    // 別の実行 B。ゲートが閉じていれば ensureLoaded も chat も呼ばれない。
    const clientB = createMockClient({});
    const executorB = createExecutor(clientB, {
      now: createClock(),
      queue,
      recoveryGate: gate,
    });

    // 呼び出し順 A1 → A2 → B（Q4b と同じ、同一 executor への複数 enqueue）。
    const promiseA1 = executorA.execute(REQUEST, parse, 1000);
    const promiseA2 = executorA.execute(REQUEST, parse, 1000);
    const promiseB = executorB.execute(REQUEST, parse, 1000);

    // A1 が chat を送るまで進める。
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
    expect(clientA.chat).toHaveBeenCalledTimes(1);

    // 停止。A2 はキュー待ちなので、先行の A1 を待たずにその場で決着する。
    controller.abort();
    const outcomeA2 = await promiseA2;
    expect(outcomeA2.ok).toBe(false);
    if (outcomeA2.ok) return;
    expect(outcomeA2.attempts).toBe(0);

    // A2 が決着した**後**で、送信中だった A1 の chat を中断で落とす。
    rejectChatA(new LmStudioError("aborted", "生成要求が中断された"));

    const outcomeA1 = await promiseA1;
    expect(outcomeA1.ok).toBe(false);
    if (outcomeA1.ok) return;
    // 送信済みの要求が中断された＝生成が走ったかどうか分からない（決定 39）。
    expect(outcomeA1.failure.origin).toBe("chat");
    expect(outcomeA1.attempts).toBe(1);
    expect(outcomeA1.halt?.generationUnconfirmed).toBe(true);
    expect(gate.blocked).toBe(true);

    // ゲートが閉じているので、後続の実行 B は 1 件も送らない。
    const outcomeB = await promiseB;
    expect(outcomeB.ok).toBe(false);
    expect(clientB.chat).not.toHaveBeenCalled();
  });

  it("R10: generationUnconfirmed: true の halt を返す直前に onRecoveryRequired が同期的に呼ばれる（決定 39）", async () => {
    const client = createMockClient({
      chat: async () => {
        throw new LmStudioError("timeout", "生成がタイムアウトした");
      },
    });
    const events: string[] = [];
    const onRecoveryRequired = vi.fn(() => {
      events.push("onRecoveryRequired");
    });
    const executor = createExecutor(client, { now: createClock(), onRecoveryRequired });

    // execute() が返す Promise の resolve 側 .then() で 'resolved' を記録する。この .then() の
    // コールバックは、execute() 内部（executor 側）の処理がすべて終わって Promise が解決した
    // "あとで" マイクロタスクとして実行されるので、onRecoveryRequired が同期的に（return の
    // 直前に）呼ばれていれば、必ず 'onRecoveryRequired' → 'resolved' の順になる。
    // 非同期（setTimeout などマクロタスク）で呼ぶ実装に変異させると、この順序が崩れて落ちる。
    const outcome = await executor.execute(REQUEST, parse, 1000).then((result) => {
      events.push("resolved");
      return result;
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.halt?.generationUnconfirmed).toBe(true);
    expect(onRecoveryRequired).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["onRecoveryRequired", "resolved"]);
  });

  it("R11: generationUnconfirmed: false の halt では onRecoveryRequired を呼ばない", async () => {
    const client = createMockClient({
      chat: async () => {
        throw new LmStudioError("model-not-loaded", "アンロードされた");
      },
    });
    const onRecoveryRequired = vi.fn();
    const executor = createExecutor(client, { now: createClock(), onRecoveryRequired });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.halt?.generationUnconfirmed).toBe(false);
    expect(onRecoveryRequired).not.toHaveBeenCalled();
  });

  it("R12: recoveryGate も onRecoveryRequired も渡さなければ従来どおり動く（E1 の非退行）", async () => {
    const calls: string[] = [];
    const client = createMockClient({ calls });
    const executor = createExecutor(client, { now: createClock() });

    const outcome = await executor.execute(REQUEST, parse, 1000);

    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(["ensureLoaded", "chat"]);
  });
});
