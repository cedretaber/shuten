import type { RunEventDto } from "@shuten/shared";
import { describe, expect, it, vi } from "vitest";
import type { EventSourceConstructor, EventSourceLike, RunEventHandlers } from "./events.ts";
import { subscribeRunEvents } from "./events.ts";

/**
 * `RunEventDto["type"]` の全種別。`events.ts` 本体の網羅表（`satisfies` で担保）とは別に、
 * ここでは「実際に `addEventListener` されたか」を確かめるための固定リストとして持つ。
 */
const RUN_EVENT_TYPE_LIST: readonly RunEventDto["type"][] = [
  "target-planned",
  "check-started",
  "check-finished",
  "target-merged",
  "recheck-started",
  "recheck-finished",
  "generation-slow",
  "save-rolled-back",
  "stop-requested",
  "run-settled",
];

/** fake の `EventSource` インスタンスがテストから見える面。 */
interface FakeEventSource extends EventSourceLike {
  readonly url: string;
  readonly listeners: Map<string, Array<(event: MessageEvent<string>) => void>>;
  closeCallCount: number;
  dispatch(type: string, data: string): void;
}

/**
 * fake の `EventSource`。`addEventListener` の登録を型ごとに記録し、`dispatch` で任意のイベントを
 * 発火できる。`close()` は `order`（渡されていれば）に "close" を積むので、`onEvent` 側が積む
 * "event" との前後関係をテストできる（決定 1 の検証に使う）。
 */
function createFakeEventSource(order?: string[]): {
  Ctor: EventSourceConstructor;
  instances: FakeEventSource[];
} {
  const instances: FakeEventSource[] = [];

  class FakeEventSourceImpl implements FakeEventSource {
    readonly url: string;
    readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    closeCallCount = 0;

    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }

    addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    close(): void {
      this.closeCallCount += 1;
      order?.push("close");
    }

    dispatch(type: string, data: string): void {
      const list = this.listeners.get(type) ?? [];
      for (const listener of list) {
        listener({ data } as MessageEvent<string>);
      }
    }
  }

  return { Ctor: FakeEventSourceImpl, instances };
}

function noopHandlers(overrides: Partial<RunEventHandlers> = {}): RunEventHandlers {
  return {
    onOpen: () => {},
    onEvent: () => {},
    onUnknownEvent: () => {},
    onError: () => {},
    ...overrides,
  };
}

describe("subscribeRunEvents", () => {
  it("購読先 URL は runId を encodeURIComponent して組み立てる", () => {
    const { Ctor, instances } = createFakeEventSource();

    const unsubscribe = subscribeRunEvents("run 1/あ", noopHandlers(), { EventSource: Ctor });

    expect(instances).toHaveLength(1);
    expect(instances[0]?.url).toBe(`/api/runs/${encodeURIComponent("run 1/あ")}/events`);
    unsubscribe();
  });

  it("B1: 既知の全イベント種別を addEventListener で購読し、受信を検証して onEvent に渡す", () => {
    const { Ctor, instances } = createFakeEventSource();
    const onEvent = vi.fn();

    const unsubscribe = subscribeRunEvents("run-1", noopHandlers({ onEvent }), {
      EventSource: Ctor,
    });
    const source = instances[0];
    if (source === undefined) throw new Error("source が生成されていません");

    for (const type of RUN_EVENT_TYPE_LIST) {
      expect(source.listeners.has(type)).toBe(true);
    }

    const dto: RunEventDto = { type: "stop-requested" };
    source.dispatch("stop-requested", JSON.stringify(dto));

    expect(onEvent).toHaveBeenCalledExactlyOnceWith(dto);
    unsubscribe();
  });

  it("B2: run-settled を受け取ったら onEvent を呼ぶ前に接続を閉じる（決定1）", () => {
    const order: string[] = [];
    const { Ctor, instances } = createFakeEventSource(order);
    const handlers = noopHandlers({
      onEvent: () => {
        order.push("event");
      },
    });

    subscribeRunEvents("run-1", handlers, { EventSource: Ctor });
    const source = instances[0];
    if (source === undefined) throw new Error("source が生成されていません");

    const dto: RunEventDto = { type: "run-settled", status: "stopped", stopReason: "aborted" };
    source.dispatch("run-settled", JSON.stringify(dto));

    expect(order).toEqual(["close", "event"]);
    expect(source.closeCallCount).toBe(1);
  });

  it("B3: JSON として解析できない受信は onUnknownEvent を呼び、onEvent は呼ばない。値はログに出さない", () => {
    const { Ctor, instances } = createFakeEventSource();
    const onEvent = vi.fn();
    const onUnknownEvent = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    subscribeRunEvents("run-1", noopHandlers({ onEvent, onUnknownEvent }), { EventSource: Ctor });
    const source = instances[0];
    if (source === undefined) throw new Error("source が生成されていません");

    source.dispatch("check-started", "{ not json");

    expect(onUnknownEvent).toHaveBeenCalledExactlyOnceWith();
    expect(onEvent).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("B4: JSON としては解析できてもスキーマに合わない受信は onUnknownEvent を呼び、onEvent は呼ばない。値はログに出さない", () => {
    const { Ctor, instances } = createFakeEventSource();
    const onEvent = vi.fn();
    const onUnknownEvent = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    subscribeRunEvents("run-1", noopHandlers({ onEvent, onUnknownEvent }), { EventSource: Ctor });
    const source = instances[0];
    if (source === undefined) throw new Error("source が生成されていません");

    // "check-started" のイベント名で受け取ったが、中身が check-started のスキーマに合わない。
    source.dispatch("check-started", JSON.stringify({ type: "check-started" }));

    expect(onUnknownEvent).toHaveBeenCalledExactlyOnceWith();
    expect(onEvent).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("onopen は onOpen に、onerror は onError にそのまま転送する", () => {
    const { Ctor, instances } = createFakeEventSource();
    const onOpen = vi.fn();
    const onError = vi.fn();

    subscribeRunEvents("run-1", noopHandlers({ onOpen, onError }), { EventSource: Ctor });
    const source = instances[0];
    if (source === undefined) throw new Error("source が生成されていません");

    source.onopen?.(new Event("open"));
    source.onerror?.(new Event("error"));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
    expect(onError).toHaveBeenCalledExactlyOnceWith();
  });

  it("unsubscribe は接続を閉じ、冪等で、以後はハンドラーを呼ばない", () => {
    const { Ctor, instances } = createFakeEventSource();
    const onEvent = vi.fn();

    const unsubscribe = subscribeRunEvents("run-1", noopHandlers({ onEvent }), {
      EventSource: Ctor,
    });
    const source = instances[0];
    if (source === undefined) throw new Error("source が生成されていません");

    unsubscribe();
    unsubscribe();
    expect(source.closeCallCount).toBe(1);

    const dto: RunEventDto = { type: "stop-requested" };
    source.dispatch("stop-requested", JSON.stringify(dto));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("run-settled で自動的に閉じた後に unsubscribe を呼んでも close() は 1 回だけ", () => {
    const { Ctor, instances } = createFakeEventSource();
    const unsubscribe = subscribeRunEvents("run-1", noopHandlers(), { EventSource: Ctor });
    const source = instances[0];
    if (source === undefined) throw new Error("source が生成されていません");

    const dto: RunEventDto = { type: "run-settled", status: "completed", stopReason: null };
    source.dispatch("run-settled", JSON.stringify(dto));
    expect(source.closeCallCount).toBe(1);

    unsubscribe();
    expect(source.closeCallCount).toBe(1);
  });

  it("deps.EventSource も globalThis.EventSource も無ければ購読せず、何もしない unsubscribe を返す（jsdom 対策）", () => {
    expect(globalThis.EventSource).toBeUndefined();

    const unsubscribe = subscribeRunEvents("run-1", noopHandlers());

    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });
});
