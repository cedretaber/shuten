import type { FindingDetailDto } from "@shuten/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFindingDetails } from "./use-finding-details.ts";

/**
 * まとめた指摘の詳細の取得（PR14b）。`results-page.tsx` の配線は results-page.test.tsx が見る。
 * ここでは取り直しの規則（選び直し・増減・取り直し・古い応答の破棄）だけを見る。
 */

function detailOf(id: string, mark = ""): FindingDetailDto {
  return {
    id,
    runId: "run-1",
    targetId: "target-1",
    locateStatus: "located",
    range: { start: 0, end: 1 },
    paragraphId: 0,
    quote: `あ${mark}`,
    suggestion: null,
    category: "notation",
    initialVerdict: "likely-error",
    suppression: null,
    reasons: [],
    recheck: null,
    judgment: {
      findingId: id,
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
    createdAt: "2026-09-10T00:00:00.000Z",
    candidates: [],
    diagnostics: [],
  };
}

interface Pending {
  readonly id: string;
  resolve(value: FindingDetailDto): void;
  reject(cause: unknown): void;
}

function controlledLoad() {
  const calls: Pending[] = [];
  const load = vi.fn(
    (id: string) =>
      new Promise<FindingDetailDto>((resolve, reject) => {
        calls.push({ id, resolve, reject });
      }),
  );
  return { load, calls };
}

const toMessage = (cause: unknown) => (cause instanceof Error ? cause.message : "失敗");

function renderDetails(load: (id: string) => Promise<FindingDetailDto>, ids: readonly string[]) {
  return renderHook(({ memberIds }) => useFindingDetails(load, toMessage, memberIds), {
    initialProps: { memberIds: ids },
  });
}

describe("useFindingDetails", () => {
  it("空なら何も取らない", () => {
    const { load } = controlledLoad();
    const { result } = renderDetails(load, []);
    expect(load).not.toHaveBeenCalled();
    expect(result.current.entries.size).toBe(0);
  });

  it("まとめた指摘を 1 件ずつ取り、届いた分から入る", async () => {
    const { load, calls } = controlledLoad();
    const { result } = renderDetails(load, ["a", "b"]);
    expect(load.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);

    await act(async () => calls[1]?.resolve(detailOf("b")));
    expect(result.current.entries.get("a")).toBeUndefined();
    expect(result.current.entries.get("b")?.detail?.id).toBe("b");
  });

  it("別のまとめを選んだら（選び直し）、前の値を捨てて取り直し、前の応答は捨てる", async () => {
    const { load, calls } = controlledLoad();
    const { result, rerender } = renderDetails(load, ["a"]);
    await act(async () => calls[0]?.resolve(detailOf("a")));
    expect(result.current.entries.get("a")?.detail?.id).toBe("a");

    rerender({ memberIds: ["c"] });
    expect(result.current.entries.size).toBe(0);
    expect(load).toHaveBeenLastCalledWith("c");

    // 先頭を a に戻して取り直し中に、前の要求（c）が遅れて届いても反映しない。
    rerender({ memberIds: ["a"] });
    await act(async () => calls[1]?.resolve(detailOf("c")));
    expect(result.current.entries.get("c")).toBeUndefined();
  });

  it("先頭が外れて 2 件目が先頭になったら（同じまとめ）、2 件目の値を残し取り直さない", async () => {
    const { load, calls } = controlledLoad();
    const { result, rerender } = renderDetails(load, ["a", "b"]);
    await act(async () => {
      calls[0]?.resolve(detailOf("a"));
      calls[1]?.resolve(detailOf("b"));
    });

    rerender({ memberIds: ["b"] });
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.entries.get("b")?.detail?.id).toBe("b");
    expect(result.current.entries.has("a")).toBe(false);
  });

  it("選択を外したら、値を捨てる", async () => {
    const { load, calls } = controlledLoad();
    const { result, rerender } = renderDetails(load, ["a"]);
    await act(async () => calls[0]?.resolve(detailOf("a")));

    rerender({ memberIds: [] });
    expect(result.current.entries.size).toBe(0);
  });

  it("先頭が同じまま増えたら、増えた分だけ取り、すでにある値は残す", async () => {
    const { load, calls } = controlledLoad();
    const { result, rerender } = renderDetails(load, ["a"]);
    await act(async () => calls[0]?.resolve(detailOf("a")));

    rerender({ memberIds: ["a", "b"] });
    expect(load.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    expect(result.current.entries.get("a")?.detail?.id).toBe("a");
  });

  it("先頭が同じまま減ったら、減った分の値を捨て、遅れて届いた応答も捨てる", async () => {
    const { load, calls } = controlledLoad();
    const { result, rerender } = renderDetails(load, ["a", "b"]);
    await act(async () => calls[0]?.resolve(detailOf("a")));

    rerender({ memberIds: ["a"] });
    await act(async () => calls[1]?.resolve(detailOf("b")));
    expect(result.current.entries.has("b")).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("refresh は全員分を取り直し、届くまで前の値を残す", async () => {
    const { load, calls } = controlledLoad();
    const { result } = renderDetails(load, ["a", "b"]);
    await act(async () => {
      calls[0]?.resolve(detailOf("a", "1"));
      calls[1]?.resolve(detailOf("b", "1"));
    });

    act(() => result.current.refresh());
    expect(load).toHaveBeenCalledTimes(4);
    expect(result.current.entries.get("a")?.detail?.quote).toBe("あ1");

    await act(async () => calls[2]?.resolve(detailOf("a", "2")));
    expect(result.current.entries.get("a")?.detail?.quote).toBe("あ2");
  });

  it("refresh が失敗したら、前の値を残してエラーを入れる。次に成功したらエラーを消す", async () => {
    const { load, calls } = controlledLoad();
    const { result } = renderDetails(load, ["a"]);
    await act(async () => calls[0]?.resolve(detailOf("a", "1")));

    act(() => result.current.refresh());
    await act(async () => calls[1]?.reject(new Error("取り直しに失敗")));
    expect(result.current.entries.get("a")).toEqual({
      detail: detailOf("a", "1"),
      error: "取り直しに失敗",
    });

    act(() => result.current.refresh());
    await act(async () => calls[2]?.resolve(detailOf("a", "3")));
    expect(result.current.entries.get("a")?.error).toBeNull();
  });

  it("同じ指摘で、古い要求の応答が新しい要求の後に届いても反映しない", async () => {
    const { load, calls } = controlledLoad();
    const { result } = renderDetails(load, ["a"]);
    act(() => result.current.refresh());

    await act(async () => calls[1]?.resolve(detailOf("a", "新")));
    await act(async () => calls[0]?.resolve(detailOf("a", "旧")));
    expect(result.current.entries.get("a")?.detail?.quote).toBe("あ新");
  });

  it("選び直しで最初の取得が失敗したら、値なしでエラーを入れる", async () => {
    const { load, calls } = controlledLoad();
    const { result } = renderDetails(load, ["a"]);
    await act(async () => calls[0]?.reject(new Error("取得に失敗")));
    expect(result.current.entries.get("a")).toEqual({ detail: null, error: "取得に失敗" });
  });

  it("load が同期的に例外を投げても、エラーとして入る", async () => {
    const load = vi.fn(() => {
      throw new Error("同期の失敗");
    });
    const { result } = renderDetails(load, ["a"]);
    await waitFor(() =>
      expect(result.current.entries.get("a")).toEqual({ detail: null, error: "同期の失敗" }),
    );
  });
});
