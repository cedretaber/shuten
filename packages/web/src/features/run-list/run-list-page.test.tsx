/**
 * `/runs` — 保存された検査実行の一覧（Task 10、R8）。
 *
 * 並び（`startedAt` 降順・サーバーの順に依存しない）、0 件の文言とホームへのリンク、
 * 行の本体が `/runs/:id` へのリンクであること、取得失敗時にエラーを出すこと（空一覧として
 * 見せない）、行ごとの削除（仕様 8.3：確認・取り消し・成功で行を外す・失敗で行を残す・
 * 処理中は無効）を確認する。
 */

import type { RunSummaryDto } from "@shuten/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiClientProvider } from "../../api/context.tsx";
import { ApiRequestError } from "../../api/errors.ts";
import { ROUTES, runPath } from "../../app/routes.ts";
import controls from "../../styles/controls.module.css";
import { formatDateTime } from "../results/format-date-time.ts";
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
    getRunUnits: notImplemented("getRunUnits"),
    stopRun: notImplemented("stopRun"),
    resumeRun: notImplemented("resumeRun"),
    retryFailedUnits: notImplemented("retryFailedUnits"),
    deleteRun: notImplemented("deleteRun"),
    getRecovery: notImplemented("getRecovery"),
    confirmRecovery: notImplemented("confirmRecovery"),
    getFindings: notImplemented("getFindings"),
    getFinding: notImplemented("getFinding"),
    putJudgment: notImplemented("putJudgment"),
    subscribeRunEvents: notImplemented("subscribeRunEvents"),
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

  it("R8: 行の本体が /runs/:id へのリンクになっている", async () => {
    const run = makeRunSummary({ id: "run-1" });
    const getRuns = vi.fn(() => Promise.resolve([run]));
    const client = makeClient({ getRuns });

    renderPage(client);

    const link = await screen.findByRole("link", { name: /原稿A/ });
    expect(link).toHaveAttribute("href", runPath("run-1"));
  });

  it("PR14c: 取得の失敗はエラーの枠で出る", async () => {
    const getRuns = vi.fn(() => Promise.reject(new Error("実行一覧の取得に失敗しました")));
    renderPage(makeClient({ getRuns }));

    const message = await screen.findByText("実行一覧の取得に失敗しました");
    expect(message.className).toContain(controls.errorBox);
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
    // 時刻表示は裁定によりローカル時刻（実行環境のタイムゾーン依存）になったため、ハードコードした
    // UTC 文字列ではなく、画面と同じ式（`format-date-time.ts` 参照）で期待値を求める。
    // `formatDateTime` 自体の正しさ（オフセットの適用・境界）は format-date-time.test.ts の役割で、
    // ここでは「画面がその関数を正しい引数で呼んでいる」配線だけを見る。
    const expectedStarted = formatDateTime(
      run.startedAt,
      -new Date(run.startedAt).getTimezoneOffset(),
    );
    const expectedFinished = formatDateTime(
      run.finishedAt,
      -new Date(run.finishedAt as string).getTimezoneOffset(),
    );
    expect(expectedStarted).not.toBeNull();
    expect(expectedFinished).not.toBeNull();
    expect(link).toHaveTextContent(expectedStarted as string);
    expect(link).toHaveTextContent(expectedFinished as string);
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

describe("RunListPage の削除（仕様 8.3）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 2 行（削除する行と残る行）を描き、行が出るまで待つ。 */
  async function renderTwoRuns(deleteRun: ApiClient["deleteRun"]) {
    const target = makeRunSummary({
      id: "run-target",
      manuscriptName: "消す原稿",
      startedAt: "2026-09-10T00:00:00.000Z",
    });
    const other = makeRunSummary({
      id: "run-other",
      manuscriptName: "残す原稿",
      startedAt: "2026-09-01T00:00:00.000Z",
    });
    renderPage(makeClient({ getRuns: vi.fn(() => Promise.resolve([target, other])), deleteRun }));
    await screen.findByRole("link", { name: /消す原稿/ });
    return { target };
  }

  function deleteButtonOf(name: RegExp): HTMLElement {
    const link = screen.getByRole("link", { name });
    const item = link.closest("li");
    if (item === null) throw new Error("行が見つからない");
    return within(item).getByRole("button", { name: /削除/ });
  }

  it("削除ボタンはリンクの中に入っていない（兄弟に置く）", async () => {
    await renderTwoRuns(vi.fn(() => Promise.resolve()));

    const link = screen.getByRole("link", { name: /消す原稿/ });
    const button = deleteButtonOf(/消す原稿/);
    expect(link.contains(button)).toBe(false);
    expect(link.parentElement).toBe(button.parentElement);
  });

  it("確認で取り消したら API を呼ばず、行も残る", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const deleteRun = vi.fn(() => Promise.resolve());
    await renderTwoRuns(deleteRun);

    await userEvent.click(deleteButtonOf(/消す原稿/));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteRun).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /消す原稿/ })).toBeInTheDocument();
  });

  it("確認文は原稿名と開始日時を示し、指摘・判断が消えて戻せないことと原稿本文の扱いを伝える", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { target } = await renderTwoRuns(vi.fn(() => Promise.resolve()));

    await userEvent.click(deleteButtonOf(/消す原稿/));

    const message = String(confirm.mock.calls[0]?.[0]);
    const started = formatDateTime(
      target.startedAt,
      -new Date(target.startedAt).getTimezoneOffset(),
    );
    expect(message).toContain("消す原稿");
    expect(message).toContain(started as string);
    expect(message).toContain("指摘");
    expect(message).toContain("元に戻せません");
    expect(message).toContain("原稿の本文も削除されます");
  });

  it("確認で OK したら deleteRun を呼び、成功したらその行だけを外す", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const deleteRun = vi.fn(() => Promise.resolve());
    await renderTwoRuns(deleteRun);

    await userEvent.click(deleteButtonOf(/消す原稿/));

    expect(deleteRun).toHaveBeenCalledWith("run-target");
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /消す原稿/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /残す原稿/ })).toBeInTheDocument();
  });

  it("削除中はその行のボタンを無効にする", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let resolveDelete: () => void = () => undefined;
    const deleteRun = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    await renderTwoRuns(deleteRun);

    await userEvent.click(deleteButtonOf(/消す原稿/));

    expect(deleteButtonOf(/消す原稿/)).toBeDisabled();
    expect(deleteButtonOf(/残す原稿/)).toBeEnabled();
    resolveDelete();
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /消す原稿/ })).not.toBeInTheDocument(),
    );
  });

  it("失敗したら行を残し、サーバーの文言をエラーの枠で出し、ボタンを戻す", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const deleteRun = vi.fn(() =>
      Promise.reject(
        new ApiRequestError(409, "run-active", "処理中の実行は削除できません: run-target"),
      ),
    );
    await renderTwoRuns(deleteRun);

    await userEvent.click(deleteButtonOf(/消す原稿/));

    const message = await screen.findByText("処理中の実行は削除できません: run-target");
    expect(message.className).toContain(controls.errorBox);
    expect(screen.getByRole("link", { name: /消す原稿/ })).toBeInTheDocument();
    expect(deleteButtonOf(/消す原稿/)).toBeEnabled();
  });

  it.each(["running", "recovery-waiting"] as const)(
    "状態が %s の行は削除ボタンが無効",
    async (status) => {
      const run = makeRunSummary({ id: "run-1", status, finishedAt: null });
      const deleteRun = vi.fn(() => Promise.resolve());
      renderPage(makeClient({ getRuns: vi.fn(() => Promise.resolve([run])), deleteRun }));
      await screen.findByRole("link", { name: /原稿A/ });

      expect(deleteButtonOf(/原稿A/)).toBeDisabled();
    },
  );

  it.each(["completed", "partially-failed", "stopped"] as const)(
    "状態が %s の行は削除ボタンが有効",
    async (status) => {
      const run = makeRunSummary({ id: "run-1", status });
      renderPage(makeClient({ getRuns: vi.fn(() => Promise.resolve([run])) }));
      await screen.findByRole("link", { name: /原稿A/ });

      expect(deleteButtonOf(/原稿A/)).toBeEnabled();
    },
  );
});
