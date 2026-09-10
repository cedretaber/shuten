import type { ConnectionCheckDto, ConnectionSettingsDto, ModelInfoDto } from "@shuten/shared";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.ts";
import { ApiClientProvider } from "../api/context.tsx";
import { ConnectionProvider } from "./connection-context.tsx";
import { SettingsPage } from "./settings-page.tsx";

/**
 * 設定画面（`/settings`）の区画の検証（S3-1・S3-2、PR11c 決定 3）。
 *
 * S3-2 は、モデル選択の `fieldset` を「LM Studio への接続」の `<form>` の中へ戻すと
 * 実際に落ちることを確認した（作業報告に記録する）。
 */

const ENDPOINT_URL = "http://127.0.0.1:1234";

function makeSettings(overrides: Partial<ConnectionSettingsDto> = {}): ConnectionSettingsDto {
  return { endpointUrl: ENDPOINT_URL, hasApiKey: false, ...overrides };
}

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
  return { reachable: true, error: null, models: [makeModel()], model: null, ...overrides };
}

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`${name} は呼ばれない想定`);
  };
  return {
    getConnection: vi.fn(() => Promise.resolve(makeSettings())),
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

function renderSettingsPage(client: ApiClient) {
  return render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ConnectionProvider client={client}>
          <SettingsPage />
        </ConnectionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("SettingsPage", () => {
  it("S3-1: 3 つの節の見出しが heading ロールで出る", async () => {
    renderSettingsPage(makeClient());

    expect(screen.getByRole("heading", { name: "LM Studio への接続" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "生成に使うモデル" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "詳細な検査設定" })).toBeInTheDocument();
  });

  it("S3-2: モデル選択の radio が接続の form の外にある", async () => {
    renderSettingsPage(makeClient());

    const radio = await screen.findByRole("radio", { name: "model-a" });
    expect(radio.closest("form")).toBeNull();
  });
});
