import type {
  ConnectionCheckDto,
  ConnectionSettingsDto,
  ModelInfoDto,
  PutConnectionRequest,
} from "@shuten/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiClientProvider } from "../../api/context.tsx";
import { ApiRequestError } from "../../api/errors.ts";
import { ConnectionProvider } from "../../app/connection-context.tsx";
import { ConnectionSettingsPage } from "./connection-settings-page.tsx";

/**
 * `/settings/connection` の検証（W5-1〜10、決定 9・18）。
 * API キーの三状態（W5-1〜3・W5-10）と 409 `runs-active`（W5-5）、ロード済みモデルに
 * 注記が出ないこと（W5-8）は、実装を意図的に誤らせてこのテストが実際に赤くなることを
 * 確認した（作業報告に記録する）。
 */

const DEFAULT_URL = "http://127.0.0.1:1234";
const NEW_URL = "http://127.0.0.1:5678";

function makeSettings(overrides: Partial<ConnectionSettingsDto> = {}): ConnectionSettingsDto {
  return { endpointUrl: DEFAULT_URL, hasApiKey: false, ...overrides };
}

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

/** `getConnection` / `putConnection` / `checkConnection` 以外は呼ばれない想定の fake。 */
function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`${name} は呼ばれない想定`);
  };
  return {
    getConnection: vi.fn(() => Promise.resolve(makeSettings())),
    putConnection: vi.fn(() => Promise.resolve(makeSettings())),
    checkConnection: vi.fn(() => Promise.resolve(makeCheck())),
    createManuscript: notImplemented("createManuscript"),
    uploadManuscript: notImplemented("uploadManuscript"),
    getManuscript: notImplemented("getManuscript"),
    startRun: notImplemented("startRun"),
    getRun: notImplemented("getRun"),
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderPage(client: ApiClient) {
  return render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ConnectionProvider client={client}>
          <ConnectionSettingsPage />
        </ConnectionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

async function waitForLoaded() {
  await waitFor(() => expect(screen.getByLabelText("接続先 URL")).toHaveValue(DEFAULT_URL));
}

describe("ConnectionSettingsPage", () => {
  it("W5-1: API キー欄を空のまま保存すると、要求に apiKey を含めない（維持）", async () => {
    const putConnection = vi.fn((_body: PutConnectionRequest) =>
      Promise.resolve(makeSettings({ hasApiKey: true })),
    );
    const client = makeClient({ putConnection });
    renderPage(client);
    await waitForLoaded();

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("接続先 URL"));
    await user.type(screen.getByLabelText("接続先 URL"), "http://localhost:5678");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(putConnection).toHaveBeenCalledTimes(1));
    const body = putConnection.mock.calls[0]?.[0];
    expect(body).toEqual({ endpointUrl: "http://localhost:5678" });
    expect(body && Object.hasOwn(body, "apiKey")).toBe(false);
  });

  it("W5-2: 「API キーを消去」を選んで保存すると、apiKey: null を送る", async () => {
    const putConnection = vi.fn((_body: PutConnectionRequest) =>
      Promise.resolve(makeSettings({ hasApiKey: false })),
    );
    const client = makeClient({ putConnection });
    renderPage(client);
    await waitForLoaded();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("API キーを消去"));
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(putConnection).toHaveBeenCalledTimes(1));
    expect(putConnection.mock.calls[0]?.[0]).toEqual({ endpointUrl: DEFAULT_URL, apiKey: null });
  });

  it("W5-3: API キー欄に文字列を入力して保存すると、その文字列を apiKey として送る", async () => {
    const putConnection = vi.fn((_body: PutConnectionRequest) =>
      Promise.resolve(makeSettings({ hasApiKey: true })),
    );
    const client = makeClient({ putConnection });
    renderPage(client);
    await waitForLoaded();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("API キー"), "sk-secret-value");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(putConnection).toHaveBeenCalledTimes(1));
    expect(putConnection.mock.calls[0]?.[0]).toEqual({
      endpointUrl: DEFAULT_URL,
      apiKey: "sk-secret-value",
    });
  });

  it("W5-4: 初期表示で GET の結果（URL・API キー設定状況）を表示する", async () => {
    const client = makeClient({
      getConnection: vi.fn(() =>
        Promise.resolve(makeSettings({ endpointUrl: "http://192.0.2.1:1111", hasApiKey: true })),
      ),
    });
    renderPage(client);

    await waitFor(() =>
      expect(screen.getByLabelText("接続先 URL")).toHaveValue("http://192.0.2.1:1111"),
    );
    expect(screen.getByText(/設定済み/)).toBeInTheDocument();
    expect(screen.getByLabelText("API キー")).toHaveValue("");
  });

  it("W5-5: 409 runs-active を受けたとき、入力中の URL・API キー欄を消さずにメッセージを出す", async () => {
    const putConnection = vi.fn(() =>
      Promise.reject(
        new ApiRequestError(409, "runs-active", "検査実行が走っているため接続設定を変更できません"),
      ),
    );
    const client = makeClient({ putConnection });
    renderPage(client);
    await waitForLoaded();

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("接続先 URL"));
    await user.type(screen.getByLabelText("接続先 URL"), "http://localhost:9999");
    await user.type(screen.getByLabelText("API キー"), "temp-key-value");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(
        screen.getByText("検査実行が走っているため接続設定を変更できません"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("接続先 URL")).toHaveValue("http://localhost:9999");
    expect(screen.getByLabelText("API キー")).toHaveValue("temp-key-value");
  });

  it("W5-6: 保存成功後、API キー欄が空に戻り、hasApiKey の表示が更新される", async () => {
    const putConnection = vi.fn(() => Promise.resolve(makeSettings({ hasApiKey: true })));
    const client = makeClient({
      getConnection: vi.fn(() => Promise.resolve(makeSettings({ hasApiKey: false }))),
      putConnection,
    });
    renderPage(client);
    await waitForLoaded();
    expect(screen.getByText(/未設定/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("API キー"), "sk-new-value");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByText(/設定済み/)).toBeInTheDocument());
    expect(screen.getByLabelText("API キー")).toHaveValue("");
  });

  it("W5-7: 保存に成功したら接続確認を呼ぶ", async () => {
    const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
    const putConnection = vi.fn(() => Promise.resolve(makeSettings()));
    const client = makeClient({ checkConnection, putConnection });
    renderPage(client);

    // 起動時の 1 回（決定 8 の契機 1、ConnectionProvider が投げる）。
    await waitFor(() => expect(checkConnection).toHaveBeenCalledTimes(1));
    await waitForLoaded();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(putConnection).toHaveBeenCalledTimes(1));
    // 保存直後にもう 1 回（決定 8 の契機 2）。定期ポーリングではないので 2 回で止まる。
    await waitFor(() => expect(checkConnection).toHaveBeenCalledTimes(2));
  });

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
    renderPage(client);

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
    renderPage(client);

    await waitFor(() => expect(screen.getByText("model-cold")).toBeInTheDocument());
    const radio = screen.getByRole("radio", { name: "model-cold" });
    expect(radio).not.toBeDisabled();
    expect(screen.getByText(/LM Studio でロードしてください/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(radio);
    expect(radio).toBeChecked();
  });

  it("W5-10: API キー欄に空白のみを入力して保存すると、要求に apiKey を含めない（維持）", async () => {
    // サーバー側（resolveNextApiKey / parseLmStudioApiKey）は空白のみの文字列を消去（null）として
    // 扱う。「消去」を選んでいないのに気づかず API キーが消える事故を防ぐため、
    // 空白のみは（真の空文字と同じく）「維持」として要求から apiKey を省略しなければならない。
    const putConnection = vi.fn((_body: PutConnectionRequest) =>
      Promise.resolve(makeSettings({ hasApiKey: true })),
    );
    const client = makeClient({ putConnection });
    renderPage(client);
    await waitForLoaded();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("API キー"), "   ");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(putConnection).toHaveBeenCalledTimes(1));
    const body = putConnection.mock.calls[0]?.[0];
    expect(body).toEqual({ endpointUrl: DEFAULT_URL });
    expect(body && Object.hasOwn(body, "apiKey")).toBe(false);
  });

  it("遅れて届いた初回 GET は、編集して保存した後の値を上書きしない（レビュー対応）", async () => {
    // 初回 GET は古い設定を読んだまま応答が遅れている。その間に利用者が接続先を変えて保存する。
    const pending = deferred<ConnectionSettingsDto>();
    const getConnection = vi.fn(() => pending.promise);
    const putConnection = vi.fn((_body: PutConnectionRequest) =>
      Promise.resolve(makeSettings({ endpointUrl: NEW_URL, hasApiKey: true })),
    );
    const client = makeClient({ getConnection, putConnection });
    renderPage(client);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("接続先 URL"), NEW_URL);
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByText("保存しました")).toBeInTheDocument());
    expect(screen.getByLabelText("接続先 URL")).toHaveValue(NEW_URL);
    expect(screen.getByText(/設定済み/)).toBeInTheDocument();

    // ここでようやく、古い設定を読んだ GET が解決する。
    await act(async () => {
      pending.resolve(makeSettings({ endpointUrl: DEFAULT_URL, hasApiKey: false }));
      await pending.promise;
    });

    // 保存後の値のまま。古い値へ戻らない（戻ると、そのまま保存し直して接続先まで元へ戻る）。
    expect(screen.getByLabelText("接続先 URL")).toHaveValue(NEW_URL);
    expect(screen.getByText(/設定済み/)).toBeInTheDocument();
  });
});
