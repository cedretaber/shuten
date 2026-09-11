import { describe, expect, it } from "vitest";
import { subscribeRunEvents } from "./events.ts";

/**
 * `subscribeRunEvents` の中身は Task 2 が実装する。ここでは Task 1 時点の仮実装
 * （購読せず、何もしない unsubscribe を返すだけ）が例外を投げず、関数を返すことだけを確認する。
 */
describe("subscribeRunEvents（Task 1 時点の仮実装）", () => {
  it("呼び出しても例外にならず、呼んでも安全な unsubscribe 関数を返す", () => {
    const unsubscribe = subscribeRunEvents("run-1", {
      onOpen: () => {},
      onEvent: () => {},
      onUnknownEvent: () => {},
      onError: () => {},
    });

    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });
});
