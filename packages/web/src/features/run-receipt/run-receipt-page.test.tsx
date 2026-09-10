/**
 * `/runs/:id` 受付画面の検証（W8-1、W8-4〜7、決定 1・16）。
 *
 * W8-4（`stopped`/`settings` の特別表示）は、実装を一時的に誤らせて（特別分岐を削り、
 * 普通の状態表示に戻して）実際に赤くなることを確認した（作業報告に記録する）。
 */

import type { RunDetailDto, RunDto } from "@shuten/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiClientProvider } from "../../api/context.tsx";
import { ApiRequestError } from "../../api/errors.ts";
import { ROUTES } from "../../app/routes.ts";
import { RunReceiptPage } from "./run-receipt-page.tsx";

const RUN_ID = "run-abc123";

function makeRunDto(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: RUN_ID,
    manuscriptVersionId: "manuscript-1",
    modelId: "model-a",
    modelInfo: null,
    generationSettings: { maxTokens: 1024, temperature: 0.2 },
    chunkSettings: {
      targetGraphemes: 1500,
      contextGraphemes: 200,
      recheckContextGraphemes: 200,
      roundingTolerance: 100,
      maxInputGraphemes: 8000,
    },
    timeouts: { checkMs: 60000, recheckMs: 60000 },
    perspectives: ["typo"],
    recheckEnabled: true,
    allowedWords: [],
    allowedWordRuleVersion: "v1",
    promptVersion: "v1",
    diagnosticTransformVersion: "v1",
    status: "running",
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    stopRequestedAt: null,
    recoveryConfirmedAt: null,
    recoveryConfirmMs: 60000,
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<RunDto> = {}): RunDetailDto {
  return {
    run: makeRunDto(overrides),
    // 画面はこの 2 つを読まない。存在だけさせておく（実際の応答に合わせる）。
    progress: {
      checkUnits: { pending: 0, running: 0, done: 0, failed: 0, "not-applicable": 0 },
      recheckUnits: { pending: 0, running: 0, done: 0, failed: 0, "not-applicable": 0 },
    },
    targets: [],
  };
}

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
    startRun: notImplemented("startRun"),
    getRun: vi.fn(() => Promise.resolve(makeDetail())),
    ...overrides,
  };
}

function renderPage(client: ApiClient, options?: { state?: unknown }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: `/runs/${RUN_ID}`, state: options?.state }]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path={ROUTES.run} element={<RunReceiptPage />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("RunReceiptPage", () => {
  it("W8-1: 初回表示で GET /api/runs/:id を 1 回だけ呼び、実行 ID と状態を表示する", async () => {
    // history state（POST /api/runs の応答由来を模す）が残っていても読まないことを
    // 合わせて確かめる：state に本来ありえない値を積んでおき、それが表示に紛れ込まないことを見る。
    const getRun: ApiClient["getRun"] = vi.fn((_id, _options) =>
      Promise.resolve(makeDetail({ status: "running", stopReason: null, stopMessage: null })),
    );
    const client = makeClient({ getRun });
    renderPage(client, { state: { run: makeRunDto({ status: "completed" }) } });

    await waitFor(() => expect(screen.getByText(/実行中/)).toBeInTheDocument());

    expect(getRun).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getRun).mock.calls[0]?.[0]).toBe(RUN_ID);
    expect(screen.getByText(new RegExp(RUN_ID))).toBeInTheDocument();
    // 見出しは常に中立：状態名や「開始しました」のような文言を含まない。
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("検査実行");
    // state 由来の "completed" ではなく、GET の応答どおり "running" 相当の表示になっている。
    expect(screen.queryByText(/完了/)).not.toBeInTheDocument();
  });

  it("W8-4: stopped かつ stopReason が settings のとき、開始失敗の表示に切り替える", async () => {
    const client = makeClient({
      getRun: vi.fn(() =>
        Promise.resolve(
          makeDetail({
            status: "stopped",
            stopReason: "settings",
            stopMessage: "入力が上限を超えています。分割設定を見直してください。",
          }),
        ),
      ),
    });
    renderPage(client);

    await waitFor(() => expect(screen.getByText("検査は開始できませんでした")).toBeInTheDocument());
    expect(
      screen.getByText("入力が上限を超えています。分割設定を見直してください。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /検査設定/ })).toHaveAttribute("href", "/");
    // 「受付成功」に見える通常表示（状態ラベルの「停止中」行）は出ない。
    expect(screen.queryByText(/状態:\s*停止中/)).not.toBeInTheDocument();
  });

  it("W8-4b: stopped でも stopReason が settings 以外なら、通常の状態表示のままにする", async () => {
    const client = makeClient({
      getRun: vi.fn(() =>
        Promise.resolve(
          makeDetail({
            status: "stopped",
            stopReason: "aborted",
            stopMessage: "停止要求により実行を停止した",
          }),
        ),
      ),
    });
    renderPage(client);

    await waitFor(() => expect(screen.getByText(/停止中/)).toBeInTheDocument());
    expect(screen.getByText(/中断/)).toBeInTheDocument();
    expect(screen.getByText("停止要求により実行を停止した")).toBeInTheDocument();
    expect(screen.queryByText("検査は開始できませんでした")).not.toBeInTheDocument();
  });

  it("W8-5: 存在しない実行 ID（404）のとき「その実行はありません」とトップへのリンクを出す", async () => {
    const client = makeClient({
      getRun: vi.fn(() =>
        Promise.reject(new ApiRequestError(404, "not-found", "実行が見つかりません")),
      ),
    });
    renderPage(client);

    await waitFor(() => expect(screen.getByText(/その実行はありません/)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /トップ/ })).toHaveAttribute("href", "/");
  });

  it("W8-6: RunDetailDto の progress と targets を画面に出さない", async () => {
    // 実装が誤って progress / targets の値をどこかに埋め込んだら検出できるよう、
    // 現実にはありえない値（進捗件数・対象数）を仕込んでおく。
    const client = makeClient({
      getRun: vi.fn(() =>
        Promise.resolve({
          run: makeRunDto({ status: "running" }),
          progress: {
            checkUnits: { pending: 0, running: 0, done: 12345, failed: 0, "not-applicable": 0 },
            recheckUnits: { pending: 0, running: 0, done: 0, failed: 0, "not-applicable": 0 },
          },
          targets: [
            {
              id: "target-6789",
              targetIndex: 0,
              target: { start: 0, end: 10 },
              contextBefore: null,
              contextAfter: null,
              input: { start: 0, end: 10 },
              paragraphIds: [0],
            },
          ],
        } satisfies RunDetailDto),
      ),
    });
    renderPage(client);

    await waitFor(() => expect(screen.getByText(/実行中/)).toBeInTheDocument());
    expect(screen.queryByText(/12345/)).not.toBeInTheDocument();
    expect(screen.queryByText(/target-6789/)).not.toBeInTheDocument();
  });

  it("id が無いとき、GET を呼ばずに「読み込み中…」のまま止まらない", async () => {
    // useParams<{ id: string }>() の型は id を string だと言うが、実際には
    // string | undefined になりうる（前タスクからの申し送り）。id を含まないパスで
    // マウントし、その場合に無限ローディングへ落ちないことを確かめる。
    const getRun = vi.fn(() => Promise.resolve(makeDetail()));
    const client = makeClient({ getRun });
    render(
      <MemoryRouter initialEntries={["/runs-without-id"]}>
        <ApiClientProvider client={client}>
          <Routes>
            <Route path="/runs-without-id" element={<RunReceiptPage />} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText(/実行 ID が指定されていません/)).toBeInTheDocument();
    expect(screen.queryByText("読み込み中…")).not.toBeInTheDocument();
    expect(getRun).not.toHaveBeenCalled();
  });

  it("取得に失敗した（404 以外）とき、エラーメッセージを表示する", async () => {
    const client = makeClient({
      getRun: vi.fn(() =>
        Promise.reject(new ApiRequestError(500, "unknown", "サーバーへの要求が失敗しました")),
      ),
    });
    renderPage(client);

    await waitFor(() =>
      expect(screen.getByText("サーバーへの要求が失敗しました")).toBeInTheDocument(),
    );
    expect(screen.queryByText("その実行はありません")).not.toBeInTheDocument();
  });

  it("W8-7: 「最新の状態を取得」ボタンで手動再取得する。自動のポーリングはしない", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const getRun = vi
        .fn()
        .mockResolvedValueOnce(makeDetail({ status: "running" }))
        .mockResolvedValueOnce(makeDetail({ status: "completed" }));
      const client = makeClient({ getRun });
      renderPage(client);

      await waitFor(() => expect(screen.getByText(/実行中/)).toBeInTheDocument());
      expect(getRun).toHaveBeenCalledTimes(1);

      // 時間を進めても、setInterval や EventSource による自動更新は起きない。
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getRun).toHaveBeenCalledTimes(1);

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByRole("button", { name: "最新の状態を取得" }));

      await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByText(/完了/)).toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });
});
