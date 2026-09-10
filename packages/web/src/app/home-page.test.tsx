/**
 * `/` の画面（`HomePage`）。検査開始に成功したら `/runs/:id` へ遷移すること（W7-9）。
 *
 * レビュー指摘 4：この検証がどこにも無かった（「検査は始まったのにフォームに留まったまま」は
 * 利用者から見て一番分かりにくい壊れ方のため）。`navigate(runPath(runId))` の `runId` の
 * 付け忘れや `outcome.kind` の条件間違いを直接検出する。
 */

import type {
  ConnectionCheckDto,
  ManuscriptVersionDto,
  ModelInfoDto,
  RunDto,
} from "@shuten/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.ts";
import { ApiClientProvider } from "../api/context.tsx";
import { STORAGE_KEYS } from "../storage/keys.ts";
import { writeStored } from "../storage/local.ts";
import { ConnectionProvider } from "./connection-context.tsx";
import { HomePage } from "./home-page.tsx";

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

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`${name} は呼ばれない想定`);
  };
  return {
    getConnection: notImplemented("getConnection"),
    putConnection: notImplemented("putConnection"),
    checkConnection: vi.fn(() => Promise.resolve(makeCheck())),
    createManuscript: notImplemented("createManuscript"),
    uploadManuscript: notImplemented("uploadManuscript"),
    getManuscript: notImplemented("getManuscript"),
    startRun: notImplemented("startRun"),
    getRun: notImplemented("getRun"),
    ...overrides,
  };
}

/** 現在地を画面に出すだけの検査用コンポーネント。`<Routes>` は無くても `navigate()` は効く。 */
function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

beforeEach(() => {
  localStorage.clear();
});

describe("HomePage", () => {
  it("W7-9: 検査開始に成功すると /runs/:id へ遷移する", async () => {
    // 起動時に接続確認が「model-a はロード済みの llm」を返すようにし、保存済みの選択を維持させる。
    writeStored(STORAGE_KEYS.selectedModelId, "model-a");

    const version: ManuscriptVersionDto = {
      id: "mv-1",
      name: "原稿A",
      body: "本文",
      bodyHash: "hash",
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    const client = makeClient({
      createManuscript: vi.fn(() => Promise.resolve(version)),
      startRun: vi.fn(() => Promise.resolve({ id: "run-1" } as RunDto)),
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <ApiClientProvider client={client}>
          <ConnectionProvider client={client}>
            <LocationProbe />
            <HomePage />
          </ConnectionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("原稿名"), { target: { value: "原稿A" } });
    fireEvent.change(screen.getByLabelText("本文"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "この原稿を確定する" }));

    // 原稿確定とモデル選択（起動時の接続確認）が終わるまで待つ。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "検査を開始する" })).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "検査を開始する" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/runs/run-1"));
  });
});
