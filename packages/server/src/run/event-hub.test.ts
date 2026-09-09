import { describe, expect, it } from "vitest";
import type { RunEventSubscriber } from "./event-hub.ts";
import { createRunEventHub } from "./event-hub.ts";
import type { RunEvent } from "./events.ts";

/** 記録だけを行う購読者。`onEvent` / `onClose` で例外を投げさせることもできる。 */
function recorder(
  options: { readonly throwOnEvent?: boolean; readonly throwOnClose?: boolean } = {},
) {
  const events: RunEvent[] = [];
  let closeCalls = 0;
  const subscriber: RunEventSubscriber = {
    onEvent: (event) => {
      events.push(event);
      if (options.throwOnEvent === true) {
        throw new Error("購読者の例外");
      }
    },
    onClose: () => {
      closeCalls += 1;
      if (options.throwOnClose === true) {
        throw new Error("購読者の例外");
      }
    },
  };
  return {
    subscriber,
    events,
    get closeCalls(): number {
      return closeCalls;
    },
  };
}

function event(runId: string, type: "stop-requested" | "run-started"): RunEvent {
  return type === "stop-requested"
    ? { runId, event: { type: "stop-requested" } }
    : { runId, event: { type: "run-started", targetCount: 1, unitCount: 1 } };
}

describe("createRunEventHub", () => {
  it("購読した実行のイベントだけを受け取る（別の runId には届かない）", () => {
    const hub = createRunEventHub();
    const a = recorder();
    const b = recorder();
    hub.subscribe("run-a", a.subscriber);
    hub.subscribe("run-b", b.subscriber);

    hub.emit(event("run-a", "stop-requested"));

    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(0);
  });

  it("購読者がいない実行への emit は何も起こさない", () => {
    const hub = createRunEventHub();
    expect(() => hub.emit(event("run-x", "stop-requested"))).not.toThrow();
  });

  it("決定 13: 購読者の例外を握りつぶし、他の購読者への配信を止めない", () => {
    const hub = createRunEventHub();
    const bad = recorder({ throwOnEvent: true });
    const good = recorder();
    hub.subscribe("run-a", bad.subscriber);
    hub.subscribe("run-a", good.subscriber);

    expect(() => hub.emit(event("run-a", "stop-requested"))).not.toThrow();
    expect(good.events).toHaveLength(1);
  });

  it("解除したあとはイベントが届かない。2 回解除しても害はない", () => {
    const hub = createRunEventHub();
    const a = recorder();
    const unsubscribe = hub.subscribe("run-a", a.subscriber);

    hub.emit(event("run-a", "stop-requested"));
    unsubscribe();
    unsubscribe();
    hub.emit(event("run-a", "run-started"));

    expect(a.events).toHaveLength(1);
  });

  it("同じ実行の購読者の 1 つを解除しても、残りには届く", () => {
    const hub = createRunEventHub();
    const a = recorder();
    const b = recorder();
    const unsubscribeA = hub.subscribe("run-a", a.subscriber);
    hub.subscribe("run-a", b.subscriber);

    unsubscribeA();
    hub.emit(event("run-a", "stop-requested"));

    expect(a.events).toHaveLength(0);
    expect(b.events).toHaveLength(1);
  });

  it("配信中に購読を解除しても反復が壊れない（スナップショットに対して反復する）", () => {
    const hub = createRunEventHub();
    const later = recorder();
    let unsubscribeLater: (() => void) | null = null;
    const first: RunEventSubscriber = {
      onEvent: () => {
        unsubscribeLater?.();
      },
      onClose: () => undefined,
    };
    hub.subscribe("run-a", first);
    unsubscribeLater = hub.subscribe("run-a", later.subscriber);

    expect(() => hub.emit(event("run-a", "stop-requested"))).not.toThrow();
    // スナップショットに対して反復するので、この 1 回は解除済みの購読者にも届く。
    expect(later.events).toHaveLength(1);

    hub.emit(event("run-a", "run-started"));
    expect(later.events).toHaveLength(1);
  });

  it("closeAll が全購読者の onClose を 1 回ずつ呼び、以後イベントは届かない", () => {
    const hub = createRunEventHub();
    const a = recorder();
    const b = recorder();
    const c = recorder();
    hub.subscribe("run-a", a.subscriber);
    hub.subscribe("run-a", b.subscriber);
    hub.subscribe("run-b", c.subscriber);

    hub.closeAll();

    expect(a.closeCalls).toBe(1);
    expect(b.closeCalls).toBe(1);
    expect(c.closeCalls).toBe(1);

    hub.emit(event("run-a", "stop-requested"));
    hub.emit(event("run-b", "stop-requested"));
    expect(a.events).toHaveLength(0);
    expect(b.events).toHaveLength(0);
    expect(c.events).toHaveLength(0);
  });

  it("closeAll のあとに解除関数を呼んでも害はない", () => {
    const hub = createRunEventHub();
    const a = recorder();
    const unsubscribe = hub.subscribe("run-a", a.subscriber);

    hub.closeAll();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("決定 13: onClose の例外を握りつぶし、残りの購読者の onClose を呼ぶ", () => {
    const hub = createRunEventHub();
    const bad = recorder({ throwOnClose: true });
    const good = recorder();
    hub.subscribe("run-a", bad.subscriber);
    hub.subscribe("run-b", good.subscriber);

    expect(() => hub.closeAll()).not.toThrow();
    expect(bad.closeCalls).toBe(1);
    expect(good.closeCalls).toBe(1);
  });

  it("onClose の中で購読し直した購読者は消されない", () => {
    const hub = createRunEventHub();
    const again = recorder();
    const resubscribing: RunEventSubscriber = {
      onEvent: () => undefined,
      onClose: () => {
        hub.subscribe("run-a", again.subscriber);
      },
    };
    hub.subscribe("run-a", resubscribing);

    hub.closeAll();
    hub.emit(event("run-a", "stop-requested"));

    expect(again.events).toHaveLength(1);
  });
});
