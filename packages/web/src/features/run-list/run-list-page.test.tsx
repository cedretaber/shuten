/**
 * `/runs` — 保存された検査実行の一覧（Task 10、R8）。
 *
 * 並び（`startedAt` 降順・サーバーの順に依存しない）、0 件の文言とホームへのリンク、
 * 行全体が `/runs/:id` へのリンクであること、取得失敗時にエラーを出すこと（空一覧として
 * 見せない）を確認する。
 */

import type { RunSummaryDto } from "@shuten/shared";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiClientProvider } from "../../api/context.tsx";
import { ROUTES, runPath } from "../../app/routes.ts";
import { RunListPage } from "./run-list-page.tsx";

/** `notImplemented` パターン（`results-page.test.tsx` と同じ流儀）。呼ばれない口は例外にする。 */
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
    getRun: notImplemented("getRun"),
    getRuns: notImplemented("getRuns"),
    getFindings: notImplemented("getFindings"),
    getFinding: notImplemented("getFinding"),
    putJudgment: notImplemented("putJudgment"),
    ...overrides,
  };
}

function makeRunSummary(overrides: Partial<RunSummaryDto> = {}): RunSummaryDto {
  return {
    id: "run-1",
    manuscriptVersionId: "mv-1",
    manuscriptName: "原稿A",
    modelId: "model-a",
    status: "completed",
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: "2026-09-10T00:10:00.000Z",
    ...overrides,
  };
}

function renderPage(client: ApiClient) {
  return render(
    <MemoryRouter initialEntries={[ROUTES.runs]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path={ROUTES.runs} element={<RunListPage />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("RunListPage", () => {
  it("R8: startedAt 降順（新しい順）に並ぶ（サーバーの順に依存しない）", async () => {
    const older = makeRunSummary({
      id: "run-old",
      manuscriptName: "古い方",
      startedAt: "2026-09-01T00:00:00.000Z",
    });
    const newer = makeRunSummary({
      id: "run-new",
      manuscriptName: "新しい方",
      startedAt: "2026-09-10T00:00:00.000Z",
    });
    // サーバーの応答順はわざと「古い→新しい」にする（クライアント側の並べ替えを検証するため）。
    const getRuns = vi.fn(() => Promise.resolve([older, newer]));
    const client = makeClient({ getRuns });

    renderPage(client);

    await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(2));
    const names = screen.getAllByRole("link").map((link) => link.textContent);
    expect(names[0]).toContain("新しい方");
    expect(names[1]).toContain("古い方");
  });

  it("R8: 0 件のときは案内とホームへのリンクが出る", async () => {
    const getRuns = vi.fn(() => Promise.resolve([]));
    const client = makeClient({ getRuns });

    renderPage(client);

    await waitFor(() =>
      expect(screen.getByText(/保存された検査実行はありません/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "トップへ戻る" })).toHaveAttribute("href", "/");
  });

  it("R8: 行全体が /runs/:id へのリンクになっている", async () => {
    const run = makeRunSummary({ id: "run-1" });
    const getRuns = vi.fn(() => Promise.resolve([run]));
    const client = makeClient({ getRuns });

    renderPage(client);

    const link = await screen.findByRole("link", { name: /原稿A/ });
    expect(link).toHaveAttribute("href", runPath("run-1"));
  });

  it("R8: 取得に失敗したらエラーを表示する（空一覧として見せない）", async () => {
    const getRuns = vi.fn(() => Promise.reject(new Error("実行一覧の取得に失敗しました")));
    const client = makeClient({ getRuns });

    renderPage(client);

    await waitFor(() =>
      expect(screen.getByText("実行一覧の取得に失敗しました")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/保存された検査実行はありません/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /原稿A/ })).not.toBeInTheDocument();
  });

  it("行に原稿名・モデル ID・状態ラベル・開始/終了時刻が出る", async () => {
    const run = makeRunSummary({
      id: "run-1",
      manuscriptName: "原稿A",
      modelId: "model-a",
      status: "completed",
      startedAt: "2026-09-10T01:02:03.000Z",
      finishedAt: "2026-09-10T02:03:04.000Z",
    });
    const getRuns = vi.fn(() => Promise.resolve([run]));
    const client = makeClient({ getRuns });

    renderPage(client);

    const link = await screen.findByRole("link", { name: /原稿A/ });
    expect(link).toHaveTextContent("原稿A");
    expect(link).toHaveTextContent("model-a");
    expect(link).toHaveTextContent("完了");
    expect(link).toHaveTextContent("2026-09-10 01:02:03");
    expect(link).toHaveTextContent("2026-09-10 02:03:04");
  });

  it("終了していない実行では終了時刻を出さない", async () => {
    const run = makeRunSummary({ id: "run-1", status: "running", finishedAt: null });
    const getRuns = vi.fn(() => Promise.resolve([run]));
    const client = makeClient({ getRuns });

    renderPage(client);

    const link = await screen.findByRole("link", { name: /原稿A/ });
    expect(link).not.toHaveTextContent("終了:");
  });
});
