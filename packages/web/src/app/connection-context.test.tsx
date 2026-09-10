import type { ConnectionCheckDto } from "@shuten/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.ts";
import { ApiTransportError } from "../api/errors.ts";
import { STORAGE_KEYS } from "../storage/keys.ts";
import { ConnectionProvider, useConnection } from "./connection-context.tsx";

/**
 * 接続 context の競合防止（決定 10）と、意図した中断／中断していない通信エラーの切り分け
 * （W4-1〜4、W4-12）、モデル選択の永続化（W4-13）を検証する。
 */

function makeCheck(overrides: Partial<ConnectionCheckDto> = {}): ConnectionCheckDto {
  return { reachable: true, error: null, models: [], model: null, ...overrides };
}

/** `checkConnection` 以外は呼ばれない前提の最小 fake。呼ばれたら失敗させる。 */
function makeFakeClient(checkConnection: ApiClient["checkConnection"]): ApiClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`${name} は呼ばれない想定`);
  };
  return {
    getConnection: notImplemented("getConnection"),
    putConnection: notImplemented("putConnection"),
    checkConnection,
    createManuscript: notImplemented("createManuscript"),
    uploadManuscript: notImplemented("uploadManuscript"),
    getManuscript: notImplemented("getManuscript"),
    startRun: notImplemented("startRun"),
    getRun: notImplemented("getRun"),
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** context の中身を画面へ出すだけの検査用コンポーネント。 */
function Probe() {
  const conn = useConnection();
  return (
    <div>
      <p data-testid="model-id">{conn.check?.model?.id ?? "none"}</p>
      <p data-testid="error">{conn.error ?? "none"}</p>
      <p data-testid="checking">{String(conn.checking)}</p>
      <p data-testid="selected">{conn.selectedModelId ?? "none"}</p>
      <button type="button" onClick={() => conn.selectModel("model-x")}>
        選択
      </button>
      <button
        type="button"
        onClick={() => {
          void conn.checkConnection("model-b");
        }}
      >
        再確認
      </button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("ConnectionProvider", () => {
  it("W4-1: 確認 A → B の順に送り、B が先に解決したとき、後から来た A の結果で状態を上書きしない", async () => {
    const deferredA = deferred<ConnectionCheckDto>();
    const deferredB = deferred<ConnectionCheckDto>();
    let callCount = 0;
    const checkConnection = vi.fn((): Promise<ConnectionCheckDto> => {
      callCount += 1;
      return callCount === 1 ? deferredA.promise : deferredB.promise;
    });
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);

    render(
      <ConnectionProvider client={client}>
        <Probe />
      </ConnectionProvider>,
    );

    // 起動時の確認（A）が走った直後に、再確認（B）を送る。
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "再確認" }));
    expect(callCount).toBe(2);

    // B が先に解決する。
    await act(async () => {
      deferredB.resolve(
        makeCheck({ model: { id: "b-result", found: true, state: "loaded", loaded: true } }),
      );
      await deferredB.promise;
    });
    await waitFor(() => expect(screen.getByTestId("model-id")).toHaveTextContent("b-result"));

    // A が後から解決しても、B の結果を上書きしない。
    await act(async () => {
      deferredA.resolve(
        makeCheck({ model: { id: "a-result", found: true, state: "loaded", loaded: true } }),
      );
      await deferredA.promise.catch(() => {});
    });
    expect(screen.getByTestId("model-id")).toHaveTextContent("b-result");
  });

  it("W4-2: 新しい確認を始めると、前の要求に渡した signal が aborted になる", async () => {
    const deferredA = deferred<ConnectionCheckDto>();
    const signals: AbortSignal[] = [];
    const checkConnection = vi.fn((_modelId, options) => {
      if (options?.signal !== undefined) signals.push(options.signal);
      return signals.length === 1 ? deferredA.promise : new Promise<ConnectionCheckDto>(() => {});
    });
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);

    render(
      <ConnectionProvider client={client}>
        <Probe />
      </ConnectionProvider>,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "再確認" }));

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("W4-3: アンマウントで進行中の要求の signal が aborted になる", async () => {
    const signals: AbortSignal[] = [];
    const checkConnection = vi.fn((_modelId, options) => {
      if (options?.signal !== undefined) signals.push(options.signal);
      return new Promise<ConnectionCheckDto>(() => {}); // 解決しないまま保持
    });
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);

    const { unmount } = render(
      <ConnectionProvider client={client}>
        <Probe />
      </ConnectionProvider>,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    unmount();

    expect(signals[0]?.aborted).toBe(true);
  });

  it("W4-4: 中断されていない ApiTransportError はエラーとして表示する", async () => {
    const checkConnection = vi.fn(() =>
      Promise.reject(new ApiTransportError("サーバーとの通信に失敗しました")),
    );
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);

    render(
      <ConnectionProvider client={client}>
        <Probe />
      </ConnectionProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent("サーバーとの通信に失敗しました"),
    );
  });

  it("W4-12: 中断された確認は null を返し、error に入らない", async () => {
    const deferredA = deferred<ConnectionCheckDto>();
    let callCount = 0;
    const checkConnection = vi.fn((_modelId, options) => {
      callCount += 1;
      if (callCount === 1) {
        // 1 回目は起動時の自動確認。即座に解決させ、A・B の検証に影響させない。
        return Promise.resolve(makeCheck());
      }
      if (callCount === 2) {
        // A：中断されたら AbortError 相当の ApiTransportError で reject する（本物の fetch を模す）。
        options?.signal?.addEventListener("abort", () => {
          deferredA.reject(new ApiTransportError("サーバーとの通信に失敗しました"));
        });
        return deferredA.promise;
      }
      return Promise.resolve(makeCheck()); // B
    });
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);

    let capturedPromise: Promise<ConnectionCheckDto | null> | null = null;
    function ProbeWithCapture() {
      const conn = useConnection();
      return (
        <div>
          <p data-testid="error">{conn.error ?? "none"}</p>
          <button
            type="button"
            onClick={() => {
              capturedPromise = conn.checkConnection("model-a");
            }}
          >
            確認A
          </button>
          <button
            type="button"
            onClick={() => {
              void conn.checkConnection("model-b");
            }}
          >
            確認B
          </button>
        </div>
      );
    }

    render(
      <ConnectionProvider client={client}>
        <ProbeWithCapture />
      </ConnectionProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "確認A" }));
    const promiseA = capturedPromise;
    expect(promiseA).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "確認B" }));

    const resultA = await promiseA;
    expect(resultA).toBeNull();
    expect(screen.getByTestId("error")).toHaveTextContent("none");
  });

  it("W4-13: モデルを選ぶと selectedModelId が localStorage に保存され、再マウントで復元される", async () => {
    const checkConnection = vi.fn(() => new Promise<ConnectionCheckDto>(() => {}));
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);

    const { unmount } = render(
      <ConnectionProvider client={client}>
        <Probe />
      </ConnectionProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "選択" }));

    expect(screen.getByTestId("selected")).toHaveTextContent("model-x");
    expect(localStorage.getItem(STORAGE_KEYS.selectedModelId)).toBe(JSON.stringify("model-x"));

    unmount();

    render(
      <ConnectionProvider client={client}>
        <Probe />
      </ConnectionProvider>,
    );

    expect(screen.getByTestId("selected")).toHaveTextContent("model-x");
  });
});
