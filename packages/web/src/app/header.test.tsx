import type { ConnectionCheckDto } from "@shuten/shared";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.ts";
import { ConnectionProvider } from "./connection-context.tsx";
import { Header } from "./header.tsx";

/** `checkConnection` 以外は呼ばれない前提の最小 fake。 */
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

function makeCheck(overrides: Partial<ConnectionCheckDto> = {}): ConnectionCheckDto {
  return { reachable: true, error: null, models: [], model: null, ...overrides };
}

describe("Header", () => {
  it("W4-11: 最終確認時刻が出る", async () => {
    const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);

    render(
      <MemoryRouter>
        <ConnectionProvider client={client}>
          <Header />
        </ConnectionProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/最後に確認/)).toBeInTheDocument();
      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument();
    });
  });

  it("未確認のときは「未確認」と出て、時刻の数字は出ない", () => {
    const checkConnection = vi.fn(() => new Promise<ConnectionCheckDto>(() => {}));
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);

    render(
      <MemoryRouter>
        <ConnectionProvider client={client}>
          <Header />
        </ConnectionProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText(/最後に確認/)).toHaveTextContent("未確認");
  });

  // 「接続先 URL を表示しない」という主張は、ここでは型レベルで保証されているためテストにしない：
  // `ConnectionState`（`connection-context.tsx`）は URL のフィールドを一切持たず、ヘッダーが
  // 受け取る `check`（`ConnectionCheckDto`）にも URL は含まれない。よってヘッダーの実装を
  // どう書き換えても URL は描画しえず、そのようなテストは常に緑になり境界を検証しない
  // （このブランチで見つかった「実装を誤っても落ちない」パターンの一種）。
  // 接続先 URL が接続設定画面以外に出ないことのクロスページ検証は W9-7（`leak.test.tsx`、後続タスク）が担う。

  it("接続設定へのリンクがある", () => {
    const checkConnection = vi.fn(() => new Promise<ConnectionCheckDto>(() => {}));
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);

    render(
      <MemoryRouter>
        <ConnectionProvider client={client}>
          <Header />
        </ConnectionProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "接続設定" })).toHaveAttribute(
      "href",
      "/settings/connection",
    );
  });

  it("「再確認」ボタンがある", () => {
    const checkConnection = vi.fn(() => new Promise<ConnectionCheckDto>(() => {}));
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);

    render(
      <MemoryRouter>
        <ConnectionProvider client={client}>
          <Header />
        </ConnectionProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "再確認" })).toBeInTheDocument();
  });
});
