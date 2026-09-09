import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "./App.tsx";

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

describe("App", () => {
  it("W9-1: '/' で原稿画面が描画される", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "原稿と検査設定" })).toBeInTheDocument();
  });

  it("W9-1: '/settings/connection' で接続設定画面が描画される", () => {
    render(
      <MemoryRouter initialEntries={["/settings/connection"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "接続設定" })).toBeInTheDocument();
  });

  it("W9-1: '/runs/:id' で受付表示画面が描画される", () => {
    render(
      <MemoryRouter initialEntries={["/runs/abc"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "実行状況" })).toBeInTheDocument();
    expect(screen.getByText(/abc/)).toBeInTheDocument();
  });

  it("W9-2: 未知のパスで画面内 404 が出る", () => {
    render(
      <MemoryRouter initialEntries={["/nope"]}>
        <App />
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
        <App />
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
