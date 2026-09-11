/**
 * 検査開始の操作とスナップショット（決定 13・15。W7-5〜6、W7-8〜15、W7-18）。
 *
 * `start()` の順序（`checkConnection` → `canStartWithModel` → `StartRunRequest` の組み立てと検証 →
 * `startRun`）と、「結果不明」からの `retry()` が接続確認をやり直さずスナップショットをそのまま
 * 再送することを確認する。
 *
 * W7-11・W7-14・W7-15 は、実装を意図的に誤らせて赤くなることを確認した（作業報告に記録する）。
 * - W7-11：`retry()` に `connection.checkConnection` の呼び出しを足すと、2 回目以降
 *   `checkConnection` の呼び出し回数が増え、落ちる。
 * - W7-14：`send()` の catch で「不明」と「確定」の分岐を入れ替える（確定なのにスナップショットを
 *   保持する）と、4xx のあとの `retry()` で `startRun` が再度呼ばれてしまい、落ちる。
 * - W7-15：スナップショットを `parsed.data`（zod が組み立てた新しいオブジェクト）ではなく
 *   呼び出し元から渡された `candidate` をそのまま保持するよう変えると、`start()` の呼び出し後に
 *   元のオブジェクトを書き換えたときに `retry()` の送信内容が汚染され、落ちる。
 */

import type { ConnectionCheckDto, ModelInfoDto, RunDto, StartRunRequest } from "@shuten/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiRequestError, ApiResponseError, ApiTransportError } from "../../api/errors.ts";
import type { ConnectionApi } from "../../app/connection-context.tsx";
import { useStartRun } from "./use-start-run.ts";

function makeModel(overrides: Partial<ModelInfoDto> = {}): ModelInfoDto {
  return {
    id: "model-a",
    type: "llm",
    state: "loaded",
    quantization: null,
    maxContextLength: null,
    loadedContextLength: null,
    ...overrides,
  };
}

function makeCheck(overrides: Partial<ConnectionCheckDto> = {}): ConnectionCheckDto {
  return {
    reachable: true,
    error: null,
    models: [makeModel()],
    model: { id: "model-a", found: true, state: "loaded", loaded: true },
    ...overrides,
  };
}

function makeConnectionApi(overrides: Partial<ConnectionApi> = {}): ConnectionApi {
  return {
    check: null,
    checkedAt: null,
    selectedModelId: null,
    error: null,
    checking: false,
    checkConnection: vi.fn(() => Promise.resolve(makeCheck())),
    selectModel: vi.fn(),
    ...overrides,
  };
}

/** `startRun` 以外は呼ばれない想定の fake。 */
function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
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
    startRun: vi.fn(() => Promise.reject(new Error("startRun は未設定"))),
    getRun: notImplemented("getRun"),
    getRuns: notImplemented("getRuns"),
    getFindings: notImplemented("getFindings"),
    getFinding: notImplemented("getFinding"),
    putJudgment: notImplemented("putJudgment"),
    ...overrides,
  };
}

function buildRequest(
  overrides: Partial<Omit<StartRunRequest, "startOperationId">> = {},
): Omit<StartRunRequest, "startOperationId"> {
  return {
    manuscriptVersionId: "mv-1",
    modelId: "model-a",
    generation: { maxTokens: 16_000, temperature: 0, reasoningEffort: "none" },
    chunkSettings: {
      targetGraphemes: 1_500,
      contextGraphemes: 1_000,
      recheckContextGraphemes: 3_000,
      roundingTolerance: 0.2,
      maxInputGraphemes: 12_000,
    },
    timeouts: { checkMs: 300_000, recheckMs: 300_000 },
    perspectives: ["typo", "naturalness"],
    recheckEnabled: true,
    allowedWordsRaw: "",
    ...overrides,
  };
}

const RUN_DTO = { id: "run-1" } as RunDto;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** `mock.calls[index][0]` を安全に取り出す（`noUncheckedIndexedAccess` 対策）。 */
function nthStartRunBody(
  startRun: { mock: { calls: unknown[][] } },
  index: number,
): StartRunRequest {
  const call = startRun.mock.calls[index];
  if (call === undefined) {
    throw new Error(`startRun は ${index + 1} 回以上呼ばれていません`);
  }
  return call[0] as StartRunRequest;
}

describe("useStartRun: start()", () => {
  it("W7-8: 開始で checkConnection → startRun の順に呼ばれる", async () => {
    const calls: string[] = [];
    const checkConnection = vi.fn(() => {
      calls.push("checkConnection");
      return Promise.resolve(makeCheck());
    });
    const startRun = vi.fn(() => {
      calls.push("startRun");
      return Promise.resolve(RUN_DTO);
    });
    const connection = makeConnectionApi({ checkConnection });
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    await act(async () => {
      await result.current.start(buildRequest());
    });

    expect(calls).toEqual(["checkConnection", "startRun"]);
  });

  it("W7-9: 成功すると outcome が started(runId) になる", async () => {
    const connection = makeConnectionApi();
    const startRun = vi.fn(() => Promise.resolve({ id: "run-42" } as RunDto));
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    await act(async () => {
      await result.current.start(buildRequest());
    });

    expect(result.current.outcome).toEqual({ kind: "started", runId: "run-42" });
  });

  it("W7-10: 送信中は outcome が sending になる", async () => {
    const pending = deferred<RunDto>();
    const connection = makeConnectionApi();
    const startRun = vi.fn(() => pending.promise);
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start(buildRequest());
    });

    await waitFor(() => expect(result.current.outcome.kind).toBe("sending"));

    await act(async () => {
      pending.resolve(RUN_DTO);
      await startPromise;
    });

    expect(result.current.outcome.kind).toBe("started");
  });

  it("W7-5: 未ロードのモデルでは startRun を投げない（checkConnection だけが呼ばれる）", async () => {
    const checkConnection = vi.fn(() =>
      Promise.resolve(
        makeCheck({
          models: [makeModel({ state: "not-loaded" })],
          model: { id: "model-a", found: true, state: "not-loaded", loaded: false },
        }),
      ),
    );
    const startRun = vi.fn(() => Promise.resolve(RUN_DTO));
    const connection = makeConnectionApi({ checkConnection });
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    await act(async () => {
      await result.current.start(buildRequest());
    });

    expect(checkConnection).toHaveBeenCalledTimes(1);
    expect(startRun).not.toHaveBeenCalled();
    expect(result.current.outcome.kind).toBe("failed");
  });

  it("W7-6: embeddings では startRun を投げない", async () => {
    const checkConnection = vi.fn(() =>
      Promise.resolve(
        makeCheck({
          models: [makeModel({ type: "embeddings" })],
          model: { id: "model-a", found: true, state: "loaded", loaded: true },
        }),
      ),
    );
    const startRun = vi.fn(() => Promise.resolve(RUN_DTO));
    const connection = makeConnectionApi({ checkConnection });
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    await act(async () => {
      await result.current.start(buildRequest());
    });

    expect(checkConnection).toHaveBeenCalledTimes(1);
    expect(startRun).not.toHaveBeenCalled();
    expect(result.current.outcome.kind).toBe("failed");
  });

  it("checkConnection が中断でない失敗で例外を投げたら startRun を呼ばず失敗にする", async () => {
    const checkConnection = vi.fn(() => Promise.reject(new Error("接続できません")));
    const startRun = vi.fn(() => Promise.resolve(RUN_DTO));
    const connection = makeConnectionApi({ checkConnection });
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    await act(async () => {
      await result.current.start(buildRequest());
    });

    expect(startRun).not.toHaveBeenCalled();
    expect(result.current.outcome).toEqual({
      kind: "failed",
      message: "接続できません",
      hint: "settings",
    });
    expect(result.current.canRetry).toBe(false);
  });

  it("不正な chunkSettings では startRun を呼ばず、フォーム全体のエラーにする（validateChunkSettings）", async () => {
    const connection = makeConnectionApi();
    const startRun = vi.fn(() => Promise.resolve(RUN_DTO));
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    await act(async () => {
      await result.current.start(
        buildRequest({ chunkSettings: { ...buildRequest().chunkSettings, roundingTolerance: 1 } }),
      );
    });

    expect(startRun).not.toHaveBeenCalled();
    expect(result.current.outcome.kind).toBe("failed");
    if (result.current.outcome.kind === "failed") {
      expect(result.current.outcome.message).toContain("roundingTolerance");
    }
    expect(result.current.canRetry).toBe(false);
  });

  it("W7-18: 開始前の確認が中断された（null）とき、startRun を呼ばずエラーも出さない", async () => {
    const checkConnection = vi.fn(() => Promise.resolve(null));
    const startRun = vi.fn(() => Promise.resolve(RUN_DTO));
    const connection = makeConnectionApi({ checkConnection });
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    await act(async () => {
      await result.current.start(buildRequest());
    });

    expect(startRun).not.toHaveBeenCalled();
    // "sending" のまま残ると開始ボタンが永久に disabled になる。idle に戻ることを厳密に見る
    // （`.kind).not.toBe("failed")` だけだと "sending" のままでも通ってしまい、レビューで
    // 指摘された：実装で `updateOutcome(outcomeBeforeStart)` を消し忘れても赤にならない）。
    expect(result.current.outcome).toEqual({ kind: "idle" });
  });
});

describe("useStartRun: failed の hint（決定 8。S6）", () => {
  /**
   * 規則は「送信前に止まったか、送信後に決まったか」の 1 本だけ。
   * S6-1 は送信前に止まる 4 経路すべてが `hint: "settings"` になることを、1 つのテストの
   * 中で確かめる：4 経路のどれか 1 つでも実装で `hint: "none"` に変えると、この 1 テストが
   * 落ちる（4 つを別テストに分けると、直したい経路だけを個別に赤くできず確認しにくい）。
   */
  it("S6-1: 送信前に止まった 4 経路の hint が settings になる", async () => {
    // 経路 1：checkConnection が中断でない例外で失敗する。
    {
      const checkConnection = vi.fn(() => Promise.reject(new Error("接続できません")));
      const connection = makeConnectionApi({ checkConnection });
      const client = makeClient();
      const { result } = renderHook(() => useStartRun({ client, connection }));
      await act(async () => {
        await result.current.start(buildRequest());
      });
      expect(result.current.outcome).toEqual({
        kind: "failed",
        message: "接続できません",
        hint: "settings",
      });
    }

    // 経路 2：canStartWithModel が false（モデルが未ロード）。
    {
      const checkConnection = vi.fn(() =>
        Promise.resolve(
          makeCheck({
            models: [makeModel({ state: "not-loaded" })],
            model: { id: "model-a", found: true, state: "not-loaded", loaded: false },
          }),
        ),
      );
      const connection = makeConnectionApi({ checkConnection });
      const client = makeClient();
      const { result } = renderHook(() => useStartRun({ client, connection }));
      await act(async () => {
        await result.current.start(buildRequest());
      });
      expect(result.current.outcome.kind).toBe("failed");
      if (result.current.outcome.kind === "failed") {
        expect(result.current.outcome.hint).toBe("settings");
      }
    }

    // 経路 3：startRunRequestSchema.safeParse が失敗する（checkMs が 1 未満）。
    {
      const connection = makeConnectionApi();
      const client = makeClient();
      const { result } = renderHook(() => useStartRun({ client, connection }));
      await act(async () => {
        await result.current.start(buildRequest({ timeouts: { checkMs: 0, recheckMs: 300_000 } }));
      });
      expect(result.current.outcome.kind).toBe("failed");
      if (result.current.outcome.kind === "failed") {
        expect(result.current.outcome.hint).toBe("settings");
      }
    }

    // 経路 4：InvalidChunkSettingsError（validateChunkSettings が拒否する）。
    {
      const connection = makeConnectionApi();
      const client = makeClient();
      const { result } = renderHook(() => useStartRun({ client, connection }));
      await act(async () => {
        await result.current.start(
          buildRequest({
            chunkSettings: { ...buildRequest().chunkSettings, roundingTolerance: 1 },
          }),
        );
      });
      expect(result.current.outcome.kind).toBe("failed");
      if (result.current.outcome.kind === "failed") {
        expect(result.current.outcome.hint).toBe("settings");
      }
    }
  });

  it("S6-2: 送信後に決まった失敗（確定した 4xx、結果不明）の hint が none になる", async () => {
    // 経路 1：確定した 4xx。
    {
      const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
      const startRun = vi.fn(() =>
        Promise.reject(new ApiRequestError(400, "validation", "不正な要求です")),
      );
      const connection = makeConnectionApi({ checkConnection });
      const client = makeClient({ startRun });
      const { result } = renderHook(() => useStartRun({ client, connection }));
      await act(async () => {
        await result.current.start(buildRequest());
      });
      expect(result.current.outcome).toEqual({
        kind: "failed",
        message: "不正な要求です",
        hint: "none",
      });
    }

    // 経路 2：結果不明（5xx）。
    {
      const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
      const startRun = vi.fn(() =>
        Promise.reject(new ApiRequestError(500, "unknown", "サーバー内部エラー")),
      );
      const connection = makeConnectionApi({ checkConnection });
      const client = makeClient({ startRun });
      const { result } = renderHook(() => useStartRun({ client, connection }));
      await act(async () => {
        await result.current.start(buildRequest());
      });
      expect(result.current.outcome.kind).toBe("failed");
      if (result.current.outcome.kind === "failed") {
        expect(result.current.outcome.hint).toBe("none");
      }
    }
  });

  /**
   * PR #18 レビュー対応：サーバーだけが検証できる設定エラー（`validateHardTimeouts` の失敗など）は
   * 送信後に決まった 4xx でも `hint: "settings"` にする。判定は `code` で行い、`status` だけを
   * 見ないことを、同じ 400 で別の code のケースと対比して確かめる。
   */
  it("S6-5: 確定した 4xx でも invalid-run-settings なら hint が settings になる（同じ 400 でも別 code なら none）", async () => {
    // 経路 1：code が "invalid-run-settings" のとき、settings に案内する。
    {
      const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
      const startRun = vi.fn(() =>
        Promise.reject(
          new ApiRequestError(
            400,
            "invalid-run-settings",
            "タイムアウトの合計が上限を超えています",
          ),
        ),
      );
      const connection = makeConnectionApi({ checkConnection });
      const client = makeClient({ startRun });
      const { result } = renderHook(() => useStartRun({ client, connection }));
      await act(async () => {
        await result.current.start(buildRequest());
      });
      expect(result.current.outcome).toEqual({
        kind: "failed",
        message: "タイムアウトの合計が上限を超えています",
        hint: "settings",
      });
    }

    // 経路 2：同じ 400 でも code が別（"validation"）なら none のまま。
    {
      const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
      const startRun = vi.fn(() =>
        Promise.reject(new ApiRequestError(400, "validation", "不正な要求です")),
      );
      const connection = makeConnectionApi({ checkConnection });
      const client = makeClient({ startRun });
      const { result } = renderHook(() => useStartRun({ client, connection }));
      await act(async () => {
        await result.current.start(buildRequest());
      });
      expect(result.current.outcome.kind).toBe("failed");
      if (result.current.outcome.kind === "failed") {
        expect(result.current.outcome.hint).toBe("none");
      }
    }
  });
});

describe("useStartRun: 結果不明のあと、次の開始操作が送信前に失敗しても回収経路を失わない（レビュー対応）", () => {
  /**
   * 5xx で「結果不明」になった開始操作は、同じ `startOperationId` の再送だけが正しい回収経路である。
   * 利用者がもう一度「検査を開始する」を押し、その開始操作が送信前（接続確認・モデル判定・入力検証）で
   * 失敗すると、`outcome` は新しい失敗で上書きされる。再試行できるかどうかを `outcome` に持たせると
   * 再試行の手段がここで画面から消え、最初の POST が実際には成功していた場合に重複実行を作りうる。
   * 以下の 3 経路すべてで `canRetry` が残ることと、元の本文をそのまま再送できることを見る。
   */
  async function startUnknown(deps: {
    checkConnection: ConnectionApi["checkConnection"];
    startRun: ApiClient["startRun"];
  }) {
    const connection = makeConnectionApi({ checkConnection: deps.checkConnection });
    const client = makeClient({ startRun: deps.startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    await act(async () => {
      await result.current.start(buildRequest());
    });
    expect(result.current.canRetry).toBe(true);
    return result;
  }

  it("押し直しの接続確認が例外になっても、再試行の手段が残る", async () => {
    const checkConnection = vi
      .fn<ConnectionApi["checkConnection"]>()
      .mockResolvedValueOnce(makeCheck())
      .mockRejectedValueOnce(new Error("接続できません"));
    const startRun = vi
      .fn<ApiClient["startRun"]>()
      .mockRejectedValueOnce(new ApiRequestError(500, "unknown", "サーバー内部エラー"))
      .mockResolvedValueOnce(RUN_DTO);
    const result = await startUnknown({ checkConnection, startRun });
    const originalBody = nthStartRunBody(startRun, 0);

    await act(async () => {
      await result.current.start(buildRequest());
    });

    // 新しい失敗のメッセージは出るが、前回の不明な実行を回収する手段は消えない。
    expect(result.current.outcome).toEqual({
      kind: "failed",
      message: "接続できません",
      hint: "settings",
    });
    expect(result.current.canRetry).toBe(true);
    expect(startRun).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.retry();
    });
    expect(startRun).toHaveBeenCalledTimes(2);
    expect(nthStartRunBody(startRun, 1)).toEqual(originalBody); // 同じ startOperationId
  });

  it("押し直しでモデルが未ロードでも、再試行の手段が残る", async () => {
    const checkConnection = vi
      .fn<ConnectionApi["checkConnection"]>()
      .mockResolvedValueOnce(makeCheck())
      .mockResolvedValueOnce(
        makeCheck({
          models: [makeModel({ state: "not-loaded" })],
          model: { id: "model-a", found: true, state: "not-loaded", loaded: false },
        }),
      );
    const startRun = vi
      .fn<ApiClient["startRun"]>()
      .mockRejectedValueOnce(new ApiRequestError(500, "unknown", "サーバー内部エラー"))
      .mockResolvedValueOnce(RUN_DTO);
    const result = await startUnknown({ checkConnection, startRun });
    const originalBody = nthStartRunBody(startRun, 0);

    await act(async () => {
      await result.current.start(buildRequest());
    });

    expect(result.current.outcome.kind).toBe("failed");
    expect(result.current.canRetry).toBe(true);
    expect(startRun).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.retry();
    });
    expect(nthStartRunBody(startRun, 1)).toEqual(originalBody);
  });

  it("押し直しが入力検証で止まっても、再試行の手段が残る", async () => {
    const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
    const startRun = vi
      .fn<ApiClient["startRun"]>()
      .mockRejectedValueOnce(new ApiRequestError(500, "unknown", "サーバー内部エラー"))
      .mockResolvedValueOnce(RUN_DTO);
    const result = await startUnknown({
      checkConnection: checkConnection as ConnectionApi["checkConnection"],
      startRun,
    });
    const originalBody = nthStartRunBody(startRun, 0);

    await act(async () => {
      await result.current.start(
        buildRequest({ chunkSettings: { ...buildRequest().chunkSettings, roundingTolerance: 1 } }),
      );
    });

    expect(result.current.outcome.kind).toBe("failed");
    expect(result.current.canRetry).toBe(true);
    expect(startRun).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.retry();
    });
    expect(nthStartRunBody(startRun, 1)).toEqual(originalBody);
  });

  it("5xx で結果不明のあと、押し直しの接続確認が中断されても元の実行を retry() で回収できる", async () => {
    const checkConnection = vi
      .fn<ConnectionApi["checkConnection"]>()
      .mockResolvedValueOnce(makeCheck()) // 1 回目の start(): 接続確認は成功する
      .mockResolvedValueOnce(null); // 2 回目の start(): 接続確認が中断される
    const startRun = vi
      .fn<ApiClient["startRun"]>()
      .mockRejectedValueOnce(new ApiRequestError(500, "unknown", "サーバー内部エラー"))
      .mockResolvedValueOnce(RUN_DTO);
    const connection = makeConnectionApi({ checkConnection });
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    // 1 回目：5xx で「結果不明・再試行できる」になる。
    await act(async () => {
      await result.current.start(buildRequest());
    });
    expect(result.current.outcome).toEqual({
      kind: "failed",
      message: expect.any(String),
      hint: "none",
    });
    expect(result.current.canRetry).toBe(true);
    expect(startRun).toHaveBeenCalledTimes(1);
    const originalBody = nthStartRunBody(startRun, 0);

    // 利用者が「検査を開始する」を押し直す。その接続確認が（何らかの理由で）中断される。
    await act(async () => {
      await result.current.start(buildRequest());
    });
    // この開始操作は何も起きなかったものとして扱う：直前の「結果不明・再試行できる」状態が
    // そのまま残る（再試行ボタンが画面から消えない）。新しい送信もしていない。
    expect(result.current.outcome).toEqual({
      kind: "failed",
      message: expect.any(String),
      hint: "none",
    });
    expect(result.current.canRetry).toBe(true);
    expect(startRun).toHaveBeenCalledTimes(1);

    // 中断のあとも、元の不明な実行を retry() で回収できる（同じ本文で再送される）。
    await act(async () => {
      await result.current.retry();
    });
    expect(startRun).toHaveBeenCalledTimes(2);
    expect(nthStartRunBody(startRun, 1)).toEqual(originalBody);
    expect(result.current.outcome).toEqual({ kind: "started", runId: RUN_DTO.id });
  });
});

describe("useStartRun: 結果不明からの retry()（決定 15）", () => {
  it("W7-11: 5xx は不明。同じ本文で再送でき、checkConnection の呼び出しは増えない", async () => {
    const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
    const startRun = vi
      .fn<ApiClient["startRun"]>()
      .mockRejectedValueOnce(new ApiRequestError(500, "unknown", "サーバー内部エラー"))
      .mockResolvedValueOnce(RUN_DTO);
    const connection = makeConnectionApi({ checkConnection });
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    await act(async () => {
      await result.current.start(buildRequest());
    });
    expect(result.current.outcome.kind).toBe("failed");
    expect(result.current.canRetry).toBe(true);
    expect(startRun).toHaveBeenCalledTimes(1);
    const firstBody = nthStartRunBody(startRun, 0);

    await act(async () => {
      await result.current.retry();
    });

    expect(startRun).toHaveBeenCalledTimes(2);
    const secondBody = nthStartRunBody(startRun, 1);
    expect(secondBody).toEqual(firstBody); // 同じ startOperationId・同じ本文
    expect(checkConnection).toHaveBeenCalledTimes(1); // 再送で増えない（決定 15）
    expect(result.current.outcome).toEqual({ kind: "started", runId: RUN_DTO.id });
  });

  it("W7-12: 2xx の契約違反（ApiResponseError）も不明。retry() で再送できる", async () => {
    const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
    const startRun = vi
      .fn<ApiClient["startRun"]>()
      .mockRejectedValueOnce(new ApiResponseError())
      .mockResolvedValueOnce(RUN_DTO);
    const connection = makeConnectionApi({ checkConnection });
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    await act(async () => {
      await result.current.start(buildRequest());
    });
    await act(async () => {
      await result.current.retry();
    });

    expect(startRun).toHaveBeenCalledTimes(2);
    expect(checkConnection).toHaveBeenCalledTimes(1);
    expect(result.current.outcome).toEqual({ kind: "started", runId: RUN_DTO.id });
  });

  it("W7-13: 本文の読み取り失敗（ApiTransportError）も不明。retry() で再送できる", async () => {
    const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
    const startRun = vi
      .fn<ApiClient["startRun"]>()
      .mockRejectedValueOnce(new ApiTransportError())
      .mockResolvedValueOnce(RUN_DTO);
    const connection = makeConnectionApi({ checkConnection });
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    await act(async () => {
      await result.current.start(buildRequest());
    });
    await act(async () => {
      await result.current.retry();
    });

    expect(startRun).toHaveBeenCalledTimes(2);
    expect(checkConnection).toHaveBeenCalledTimes(1);
    expect(result.current.outcome).toEqual({ kind: "started", runId: RUN_DTO.id });
  });

  it("W7-14: 4xx は確定。retry() は何もせず、押し直すと新しい startOperationId になる", async () => {
    const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
    const startRun = vi
      .fn<ApiClient["startRun"]>()
      .mockRejectedValueOnce(new ApiRequestError(400, "validation", "不正な要求です"))
      .mockResolvedValueOnce(RUN_DTO);
    const connection = makeConnectionApi({ checkConnection });
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    await act(async () => {
      await result.current.start(buildRequest());
    });
    expect(result.current.outcome.kind).toBe("failed");
    expect(result.current.canRetry).toBe(false);
    expect(startRun).toHaveBeenCalledTimes(1);
    const firstId = nthStartRunBody(startRun, 0).startOperationId;

    // スナップショットは破棄済み：retry() は何もしない。
    await act(async () => {
      await result.current.retry();
    });
    expect(startRun).toHaveBeenCalledTimes(1);

    // 押し直すと新しい ID で送信する。
    await act(async () => {
      await result.current.start(buildRequest());
    });
    expect(startRun).toHaveBeenCalledTimes(2);
    const secondId = nthStartRunBody(startRun, 1).startOperationId;
    expect(secondId).not.toBe(firstId);
  });

  it("W7-15: retry() は開始時のスナップショットを送る。呼び出し後に元のオブジェクトを変えても影響しない", async () => {
    const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
    const startRun = vi
      .fn<ApiClient["startRun"]>()
      .mockRejectedValueOnce(new ApiRequestError(500, "unknown", "サーバー内部エラー"))
      .mockResolvedValueOnce(RUN_DTO);
    const connection = makeConnectionApi({ checkConnection });
    const client = makeClient({ startRun });
    const { result } = renderHook(() => useStartRun({ client, connection }));

    const request = buildRequest();
    await act(async () => {
      await result.current.start(request);
    });
    const firstBody = nthStartRunBody(startRun, 0);
    expect(firstBody.chunkSettings.targetGraphemes).toBe(1_500);

    // start() が返った後に、呼び出し元が持っていた元のオブジェクトを書き換える
    // （フォームの現在値が変わる状況を模す）。retry() はこれを送ってはならない。
    request.chunkSettings.targetGraphemes = 9_999;

    await act(async () => {
      await result.current.retry();
    });
    const secondBody = nthStartRunBody(startRun, 1);

    expect(secondBody).toEqual(firstBody);
    expect(secondBody.chunkSettings.targetGraphemes).toBe(1_500);
  });
});
