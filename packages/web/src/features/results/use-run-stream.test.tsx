/**
 * `useRunStream`（Task 8、決定 1・2・4・10）。
 *
 * この hook が持つのは「購読を張る条件」と「イベント 1 件を何の合図に写すか」だけで、
 * 状態（`streamEnded`・`streamConnection`）も取り直しの実行も `ResultsPage` の責務。
 * ここではその境界だけを検査する。B13 の「`status === "running"` のときだけ購読する」と
 * B14（`run-settled` 後の張り直し条件）は `enabled` の値を決める側＝`ResultsPage` でしか
 * 観測できないので、`results-page.test.tsx` に置く。
 *
 * どの検査がどの壊れ方を判別するか：
 * - 「コールバックの同一性が変わっても購読し直さない」：`useEffect` の依存にコールバックを
 *   入れてしまう実装を赤にする。入れると親が再描画するたびに購読 → `onOpen` → 取り直し →
 *   再描画 → 購読…… の無限ループになるが、jsdom の fake は `onOpen` を自分から鳴らさないので
 *   他の検査ではすべて緑のまま通ってしまう。
 * - 「StrictMode の二重マウントでも生きている購読は 1 本」：cleanup を書き忘れた実装を赤にする。
 * - 「解除した後はハンドラーを呼んでも何も起きない」：cleanup 後に遅れて届くイベントで
 *   取り直しが走る実装を赤にする。
 * - 各イベントの写し方：決定 2 の割り付けを 1 件ずつ固定する。
 *
 * 受信した `data` の中身は扱わない（`RunEventDto` を直接渡すので、テストにも JSON 文字列は
 * 一切現れない）。
 */

import type { RunEventDto } from "@shuten/shared";
import { act, renderHook } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiClientProvider } from "../../api/context.tsx";
import type { RunEventHandlers } from "../../api/events.ts";
import type { RefreshKind, RunStreamOptions, StreamConnectionState } from "./use-run-stream.ts";
import { useRunStream } from "./use-run-stream.ts";

const RUN_ID = "run-1";

/** `subscribeRunEvents` 以外は呼ばれない想定の fake。 */
function makeClient(subscribeRunEvents: ApiClient["subscribeRunEvents"]): ApiClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`${name} は呼ばれない想定`);
  };
  return {
    getConnection: notImplemented("getConnection"),
    putConnection: notImplemented("putConnection"),
    checkConnection: notImplemented("checkConnection"),
    createManuscript: notImplemented("createManuscript"),
    uploadManuscript: notImplemented("uploadManuscript"),
    getManuscript: notImplemented("getManuscript"),
    startRun: notImplemented("startRun"),
    getRun: notImplemented("getRun"),
    getRuns: notImplemented("getRuns"),
    getRunUnits: notImplemented("getRunUnits"),
    stopRun: notImplemented("stopRun"),
    resumeRun: notImplemented("resumeRun"),
    retryFailedUnits: notImplemented("retryFailedUnits"),
    getRecovery: notImplemented("getRecovery"),
    confirmRecovery: notImplemented("confirmRecovery"),
    getFindings: notImplemented("getFindings"),
    getFinding: notImplemented("getFinding"),
    putJudgment: notImplemented("putJudgment"),
    subscribeRunEvents,
  };
}

interface Subscription {
  readonly runId: string;
  readonly handlers: RunEventHandlers;
  closed: boolean;
}

/** 偽の購読。jsdom に `EventSource` は無いので、`ApiClient` の口ごと差し替える。 */
function fakeStream() {
  const subscriptions: Subscription[] = [];
  const subscribeRunEvents = vi.fn((runId: string, handlers: RunEventHandlers) => {
    const entry: Subscription = { runId, handlers, closed: false };
    subscriptions.push(entry);
    return () => {
      entry.closed = true;
    };
  });
  return {
    subscribeRunEvents,
    subscriptions,
    live: () => subscriptions.filter((s) => !s.closed),
    latest: () => {
      const last = subscriptions.at(-1);
      if (last === undefined) throw new Error("購読がまだ 1 本も張られていない");
      return last;
    },
  };
}

/** 呼び出しの順序まで見たいので、1 本の配列に記録する。 */
function makeRecorder() {
  const calls: string[] = [];
  const options = {
    onRefresh: (kind: RefreshKind) => calls.push(`refresh:${kind}`),
    onSettled: () => calls.push("settled"),
    onConnectionStateChange: (state: StreamConnectionState) => calls.push(`connection:${state}`),
    onGenerationSlow: (unitId: string) => calls.push(`slow:${unitId}`),
  } satisfies Omit<RunStreamOptions, "runId" | "enabled">;
  return { calls, options };
}

function renderStream(
  client: ApiClient,
  initial: { runId: string; enabled: boolean },
  recorded: ReturnType<typeof makeRecorder>,
  options: { strict?: boolean } = {},
) {
  const wrapper = ({ children }: { children: ReactNode }) => {
    const tree = <ApiClientProvider client={client}>{children}</ApiClientProvider>;
    return options.strict === true ? <StrictMode>{tree}</StrictMode> : tree;
  };
  return renderHook(
    (props: { runId: string; enabled: boolean }) => useRunStream({ ...props, ...recorded.options }),
    { initialProps: initial, wrapper },
  );
}

describe("useRunStream: 購読を張る条件（決定 1）", () => {
  it("enabled が偽の間は購読しない", () => {
    const stream = fakeStream();
    const recorded = makeRecorder();
    renderStream(
      makeClient(stream.subscribeRunEvents),
      { runId: RUN_ID, enabled: false },
      recorded,
    );

    expect(stream.subscribeRunEvents).not.toHaveBeenCalled();
  });

  it("enabled が真になったら 1 本だけ張り、偽に戻したら解除する", () => {
    const stream = fakeStream();
    const recorded = makeRecorder();
    const { rerender } = renderStream(
      makeClient(stream.subscribeRunEvents),
      { runId: RUN_ID, enabled: false },
      recorded,
    );

    rerender({ runId: RUN_ID, enabled: true });
    expect(stream.subscribeRunEvents).toHaveBeenCalledTimes(1);
    expect(stream.latest().runId).toBe(RUN_ID);
    expect(stream.live().length).toBe(1);

    rerender({ runId: RUN_ID, enabled: false });
    expect(stream.subscribeRunEvents).toHaveBeenCalledTimes(1);
    expect(stream.live().length).toBe(0);
  });

  it("runId が変わったら前の購読を解除して張り直す", () => {
    const stream = fakeStream();
    const recorded = makeRecorder();
    const { rerender } = renderStream(
      makeClient(stream.subscribeRunEvents),
      { runId: RUN_ID, enabled: true },
      recorded,
    );

    rerender({ runId: "run-2", enabled: true });

    expect(stream.subscribeRunEvents).toHaveBeenCalledTimes(2);
    expect(stream.live().length).toBe(1);
    expect(stream.latest().runId).toBe("run-2");
  });

  // 依存にコールバックを入れた実装を赤にする検査。入れると親の再描画のたびに購読し直し、
  // `onOpen` → 取り直し → 再描画 → 購読…… の無限ループになる。
  it("コールバックの同一性が変わっても購読し直さない", () => {
    const stream = fakeStream();
    const client = makeClient(stream.subscribeRunEvents);
    const { rerender } = renderHook(
      (props: { runId: string; enabled: boolean }) =>
        useRunStream({
          ...props,
          // 毎レンダー新しい関数を渡す（`useCallback` を外した親と同じ状況）。
          onRefresh: () => {},
          onSettled: () => {},
          onConnectionStateChange: () => {},
          onGenerationSlow: () => {},
        }),
      {
        initialProps: { runId: RUN_ID, enabled: true },
        wrapper: ({ children }: { children: ReactNode }) => (
          <ApiClientProvider client={client}>{children}</ApiClientProvider>
        ),
      },
    );

    rerender({ runId: RUN_ID, enabled: true });
    rerender({ runId: RUN_ID, enabled: true });

    expect(stream.subscribeRunEvents).toHaveBeenCalledTimes(1);
    expect(stream.live().length).toBe(1);
  });

  it("StrictMode の二重マウントでも生きている購読は 1 本だけ", () => {
    const stream = fakeStream();
    const recorded = makeRecorder();
    renderStream(
      makeClient(stream.subscribeRunEvents),
      { runId: RUN_ID, enabled: true },
      recorded,
      { strict: true },
    );

    expect(stream.live().length).toBe(1);
  });

  it("解除した後に届いたイベントでは何も起きない", () => {
    const stream = fakeStream();
    const recorded = makeRecorder();
    const { unmount } = renderStream(
      makeClient(stream.subscribeRunEvents),
      { runId: RUN_ID, enabled: true },
      recorded,
    );
    const subscription = stream.latest();

    unmount();
    act(() => {
      subscription.handlers.onOpen();
      subscription.handlers.onEvent({ type: "stop-requested" });
      subscription.handlers.onError("reconnecting");
    });

    expect(recorded.calls).toEqual([]);
  });
});

describe("useRunStream: イベントの写し方（決定 2・4・10）", () => {
  function subscribed() {
    const stream = fakeStream();
    const recorded = makeRecorder();
    renderStream(makeClient(stream.subscribeRunEvents), { runId: RUN_ID, enabled: true }, recorded);
    return { handlers: stream.latest().handlers, calls: recorded.calls };
  }

  it("開通したら接続状態を open にしてから重い取り直しを求める", () => {
    const { handlers, calls } = subscribed();

    act(() => handlers.onOpen());

    expect(calls).toEqual(["connection:open", "refresh:heavy"]);
  });

  it("接続が切れたら切断を知らせるだけで、取り直しは求めない", () => {
    const { handlers, calls } = subscribed();

    act(() => handlers.onError("reconnecting"));

    expect(calls).toEqual(["connection:reconnecting"]);
  });

  // 最終レビュー Important 1：恒久的に閉じた（`readyState === CLOSED`）ときは、`EventSource` が
  // もう再接続しない。再接続中と同じ合図に潰す実装だと、画面が「再接続を試みています」と
  // 言い続ける（`results-page.tsx` 側の案内が嘘になる）ので、ここで区別を固定する。
  it("恒久的に閉じたときは closed をそのまま伝える（再接続中と同じにしない）", () => {
    const { handlers, calls } = subscribed();

    act(() => handlers.onError("closed"));

    expect(calls).toEqual(["connection:closed"]);
  });

  it.each<[string, RunEventDto]>([
    [
      "target-planned",
      {
        type: "target-planned",
        targetIndex: 0,
        target: { start: 0, end: 1 },
        input: { start: 0, end: 1 },
      },
    ],
    ["check-started", { type: "check-started", targetIndex: 0, perspective: "typo" }],
    ["recheck-started", { type: "recheck-started", findingId: "finding-1" }],
    ["stop-requested", { type: "stop-requested" }],
  ])("%s は軽い取り直し", (_name, event) => {
    const { handlers, calls } = subscribed();

    act(() => handlers.onEvent(event));

    expect(calls).toEqual(["refresh:light"]);
  });

  it.each<[string, RunEventDto]>([
    [
      "check-finished",
      { type: "check-finished", targetIndex: 0, perspective: "typo", status: "done" },
    ],
    ["target-merged", { type: "target-merged", targetIndex: 0, findingCount: 2 }],
    [
      "recheck-finished",
      {
        type: "recheck-finished",
        findingId: "finding-1",
        status: "done",
        notApplicableReason: null,
      },
    ],
    ["save-rolled-back", { type: "save-rolled-back", unitId: "check-1", kind: "check" }],
  ])("%s は重い取り直し", (_name, event) => {
    const { handlers, calls } = subscribed();

    act(() => handlers.onEvent(event));

    expect(calls).toEqual(["refresh:heavy"]);
  });

  it("generation-slow は通知だけで取り直さない（決定 10）", () => {
    const { handlers, calls } = subscribed();

    act(() => handlers.onEvent({ type: "generation-slow", unitId: "check-1", elapsedMs: 1000 }));

    expect(calls).toEqual(["slow:check-1"]);
  });

  it("run-settled は決着を知らせてから重い取り直しを求める（購読は既に閉じている）", () => {
    const { handlers, calls } = subscribed();

    act(() => handlers.onEvent({ type: "run-settled", status: "completed", stopReason: null }));

    expect(calls).toEqual(["settled", "refresh:heavy"]);
  });

  it("読めなかったイベントは安全側に倒して重い取り直し", () => {
    const { handlers, calls } = subscribed();

    act(() => handlers.onUnknownEvent());

    expect(calls).toEqual(["refresh:heavy"]);
  });
});
