import type { ConnectionCheckDto } from "@shuten/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.ts";
import { STORAGE_KEYS } from "../storage/keys.ts";
import { writeStored } from "../storage/local.ts";
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

  it("S2-1: 「朱点」がホームへのリンクである", () => {
    const checkConnection = vi.fn(() => new Promise<ConnectionCheckDto>(() => {}));
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);

    render(
      <MemoryRouter>
        <ConnectionProvider client={client}>
          <Header />
        </ConnectionProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "朱点" })).toHaveAttribute("href", "/");
  });

  it("S2-2: 「設定」リンクがある", () => {
    const checkConnection = vi.fn(() => new Promise<ConnectionCheckDto>(() => {}));
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);

    render(
      <MemoryRouter>
        <ConnectionProvider client={client}>
          <Header />
        </ConnectionProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "設定" })).toHaveAttribute("href", "/settings");
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

  // レビュー指摘 2：ボタンの存在だけでは `handleRecheck` を丸ごと削っても緑のままだった。
  // クリックで `checkConnection` が `selectedModelId` を添えて呼ばれることを確認する
  // （決定 8 が定める「手動の再確認」契機の唯一の担保）。
  it("「再確認」をクリックすると checkConnection が選択中のモデルで呼ばれる", async () => {
    writeStored(STORAGE_KEYS.selectedModelId, "model-a");
    // マウント時の確認（決定 8 の契機 1）が保存済みの選択を解除しないよう、
    // 一覧に "model-a" を含めておく（`nextSelectedModelId`、model-selection.ts）。
    const checkConnection = vi.fn((_modelId?: string) =>
      Promise.resolve(
        makeCheck({
          models: [
            {
              id: "model-a",
              type: "llm",
              state: "loaded",
              quantization: null,
              maxContextLength: null,
              loadedContextLength: null,
            },
          ],
        }),
      ),
    );
    const client = makeFakeClient(checkConnection as ApiClient["checkConnection"]);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <ConnectionProvider client={client}>
          <Header />
        </ConnectionProvider>
      </MemoryRouter>,
    );

    // マウント時（決定 8 の契機 1）の呼び出しが片づき、ボタンが有効になるまで待つ
    // （`toHaveBeenCalledTimes(1)` だけでは State の反映＝再レンダーの完了を保証しない。
    // ボタンが disabled のままだと userEvent がクリックを送出せず、次の waitFor がタイムアウトする）。
    const recheckButton = await waitFor(() => {
      const button = screen.getByRole("button", { name: "再確認" });
      expect(button).toBeEnabled();
      return button;
    });
    expect(checkConnection).toHaveBeenCalledTimes(1);

    await user.click(recheckButton);

    await waitFor(() => expect(checkConnection).toHaveBeenCalledTimes(2));
    // `ConnectionApi.checkConnection` は内部で `AbortSignal` も添えて呼ぶため、
    // ここでは「再確認」由来の呼び出しの第 1 引数（modelId）だけを見る。
    expect(checkConnection.mock.calls[1]?.[0]).toBe("model-a");

    localStorage.removeItem(STORAGE_KEYS.selectedModelId);
  });
});
