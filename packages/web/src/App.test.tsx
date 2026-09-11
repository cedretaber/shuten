import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import type { ApiClient } from "./api/client.ts";
import { ROUTES } from "./app/routes.ts";

/**
 * テスト内で戻る・進むを操作するための最小コンポーネント。
 * `MemoryRouter` はブラウザの履歴を使わないため `history.back()` は効かない。
 */
function HistoryControls() {
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => navigate(-1)}>
        戻る
      </button>
      <button type="button" onClick={() => navigate(1)}>
        進む
      </button>
    </div>
  );
}

/**
 * `App` に注入する fake クライアント。`ConnectionProvider` はマウント時に必ず
 * `checkConnection` を呼び、`/settings` は `getConnection` を、
 * `/runs/:id` は `getRun` を呼ぶ。このテストはいずれの応答内容も読まないので、
 * 解決しない Promise を返して実 `fetch` を呼ばせないことだけを担保する。
 */
function makeClient(): ApiClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`${name} は呼ばれない想定`);
  };
  const pending = () => new Promise<never>(() => {});
  return {
    getConnection: vi.fn(pending),
    putConnection: notImplemented("putConnection"),
    checkConnection: vi.fn(pending),
    createManuscript: notImplemented("createManuscript"),
    uploadManuscript: notImplemented("uploadManuscript"),
    getManuscript: notImplemented("getManuscript"),
    startRun: notImplemented("startRun"),
    getRun: vi.fn(pending),
    getRuns: notImplemented("getRuns"),
    getFindings: notImplemented("getFindings"),
    getFinding: notImplemented("getFinding"),
    putJudgment: notImplemented("putJudgment"),
  };
}

describe("App", () => {
  // レビュー指摘 1：`App` が既定の `createApiClient()`（＝実 `globalThis.fetch`）を握っていると、
  // `<App />` を直接 render するこのファイルから実 HTTP が出る。ここでは fake クライアントを
  // 注入したうえで `globalThis.fetch` にスパイを立て、テスト中に一度も呼ばれないことを確かめる。
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("W9-1: '/' で原稿画面が描画される", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App client={makeClient()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "原稿と検査設定" })).toBeInTheDocument();
  });

  it("S1-1: '/settings' で設定画面が描画される", () => {
    render(
      <MemoryRouter initialEntries={[ROUTES.settings]}>
        <App client={makeClient()} />
      </MemoryRouter>,
    );

    // 見出しの文言には依存させない。安定した目印（接続先 URL のラベル）で、
    // 設定画面が描かれたことだけを断言する。
    expect(screen.getByLabelText("接続先 URL")).toBeInTheDocument();
  });

  it("S1-2: '/settings/connection' を開くと '/settings' へ置き換え遷移し、履歴に旧パスが残らない", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/", ROUTES.legacyConnectionSettings]} initialIndex={1}>
        <HistoryControls />
        <App client={makeClient()} />
      </MemoryRouter>,
    );

    // 旧パスを開いた直後に設定画面へ置き換え遷移している
    expect(screen.getByLabelText("接続先 URL")).toBeInTheDocument();

    // replace により履歴に旧パスは積まれていないため、「戻る」は 1 回で "/" に着く
    // （旧パスへ戻らない）。`replace` を外すとここが「接続先 URL」のまま変わらず落ちる。
    await user.click(screen.getByRole("button", { name: "戻る" }));
    expect(screen.getByRole("heading", { name: "原稿と検査設定" })).toBeInTheDocument();
  });

  it("W9-1: '/runs/:id' で受付表示画面が描画される", () => {
    render(
      <MemoryRouter initialEntries={["/runs/abc"]}>
        <App client={makeClient()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "検査実行" })).toBeInTheDocument();
    expect(screen.getByText(/abc/)).toBeInTheDocument();
  });

  it("W9-2: 未知のパスで画面内 404 が出る", () => {
    render(
      <MemoryRouter initialEntries={["/nope"]}>
        <App client={makeClient()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "そのページはありません" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /トップ/ })).toBeInTheDocument();
  });

  it("W9-3: Link で遷移し、履歴の戻る・進むが効く", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/nope"]}>
        <HistoryControls />
        <App client={makeClient()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "そのページはありません" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /トップ/ }));
    expect(screen.getByRole("heading", { name: "原稿と検査設定" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "戻る" }));
    expect(screen.getByRole("heading", { name: "そのページはありません" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "進む" }));
    expect(screen.getByRole("heading", { name: "原稿と検査設定" })).toBeInTheDocument();
  });
});
