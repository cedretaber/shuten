import type { ConnectionCheckDto, ModelInfoDto } from "@shuten/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiClientProvider } from "../../api/context.tsx";
import { ConnectionProvider } from "../../app/connection-context.tsx";
import { ModelSection } from "./model-section.tsx";

/**
 * 設定画面の「生成に使うモデル」節の検証（W5-8・W5-9、決定 9）。
 * `connection-section.test.tsx` から移した（PR11c）。ロード済みモデルに注記が出ないこと
 * （W5-8）は、実装を意図的に誤らせてこのテストが実際に赤くなることを確認した
 * （作業報告に記録する）。
 */

function makeCheck(overrides: Partial<ConnectionCheckDto> = {}): ConnectionCheckDto {
  return { reachable: true, error: null, models: [], model: null, ...overrides };
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

/** `checkConnection` 以外は呼ばれない想定の fake（`ConnectionProvider` が起動時に呼ぶ）。 */
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
    getRuns: notImplemented("getRuns"),
    getRunUnits: notImplemented("getRunUnits"),
    stopRun: notImplemented("stopRun"),
    resumeRun: notImplemented("resumeRun"),
    retryFailedUnits: notImplemented("retryFailedUnits"),
    getRecovery: notImplemented("getRecovery"),
    confirmRecovery: notImplemented("confirmRecovery"),
    getFindings: notImplemented("getFindings"),
    getFinding: notImplemented("getFinding"),
    putJudgment: notImplemented("putJudgment"),
    subscribeRunEvents: notImplemented("subscribeRunEvents"),
    ...overrides,
  };
}

function renderSection(client: ApiClient) {
  return render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ConnectionProvider client={client}>
          <ModelSection />
        </ConnectionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("ModelSection", () => {
  it("W5-8: モデル一覧は type が llm/vlm のものだけを出す（embeddings・null は出ない）", async () => {
    const checkConnection = vi.fn(() =>
      Promise.resolve(
        makeCheck({
          models: [
            makeModel({ id: "model-llm", type: "llm" }),
            makeModel({ id: "model-vlm", type: "vlm" }),
            makeModel({ id: "model-embed", type: "embeddings" }),
            makeModel({ id: "model-untyped", type: null }),
          ],
        }),
      ),
    );
    const client = makeClient({ checkConnection });
    renderSection(client);

    await waitFor(() => expect(screen.getByText("model-llm")).toBeInTheDocument());
    expect(screen.getByText("model-vlm")).toBeInTheDocument();
    expect(screen.queryByText("model-embed")).not.toBeInTheDocument();
    expect(screen.queryByText("model-untyped")).not.toBeInTheDocument();
    // ここに並ぶモデルは既定でロード済み（`makeModel` の既定値）：注記を出してはいけない。
    expect(screen.queryByText(/LM Studio でロードしてください/)).not.toBeInTheDocument();
  });

  it("W5-9: 未ロードのモデルは選べるが「LM Studio でロードしてください」を添える", async () => {
    const checkConnection = vi.fn(() =>
      Promise.resolve(
        makeCheck({
          models: [makeModel({ id: "model-cold", type: "llm", state: "not-loaded" })],
        }),
      ),
    );
    const client = makeClient({ checkConnection });
    renderSection(client);

    await waitFor(() => expect(screen.getByText("model-cold")).toBeInTheDocument());
    const radio = screen.getByRole("radio", { name: "model-cold" });
    expect(radio).not.toBeDisabled();
    expect(screen.getByText(/LM Studio でロードしてください/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(radio);
    expect(radio).toBeChecked();
  });
});
