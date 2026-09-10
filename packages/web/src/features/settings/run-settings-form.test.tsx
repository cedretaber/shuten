/**
 * 検査設定フォーム（決定 7・12。W7-1、W7-4、W7-7、W7-16、W7-17、W7-19）。
 *
 * W7-1・W7-16・W7-19 は fake の `StartRunApi`（`start`/`retry` を呼ばれたことだけ確認できればよい）
 * で足りるが、W7-7（`validateChunkSettings` の失敗がフォーム全体のエラーとして出て `startRun` が
 * 呼ばれないこと）は、実際に `use-start-run.ts` の検証ロジックを通す必要があるため、
 * `useStartRun` を実際に呼ぶ最小の Harness コンポーネントで検証する（fake の `start` にバリデーションを
 * 肩代わりさせると、フォームが検証を呼び忘れても緑のままになってしまう）。
 *
 * W7-4（観点を両方は外せない）は、最後の 1 つを外す操作をしても選択状態が変わらないことを見る：
 * ガードを外すと 0 件になり、落ちる。
 */

import type { ConnectionCheckDto, ModelInfoDto, RunDto, StartRunRequest } from "@shuten/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiRequestError } from "../../api/errors.ts";
import type { ConnectionApi } from "../../app/connection-context.tsx";
import { STORAGE_KEYS } from "../../storage/keys.ts";
import { writeStored } from "../../storage/local.ts";
import { RunSettingsForm } from "./run-settings-form.tsx";
import type { StartRunApi } from "./use-start-run.ts";
import { useStartRun } from "./use-start-run.ts";

function makeStartApi(overrides: Partial<StartRunApi> = {}): StartRunApi {
  return {
    outcome: { kind: "idle" },
    canRetry: false,
    start: vi.fn(() => Promise.resolve()),
    retry: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function renderForm(props: {
  manuscriptVersionId: string | null;
  modelId: string | null;
  restoring: boolean;
  startApi: StartRunApi;
}) {
  return render(
    <MemoryRouter>
      <RunSettingsForm {...props} />
    </MemoryRouter>,
  );
}

function openAdvanced() {
  fireEvent.click(screen.getByText("詳細設定"));
}

beforeEach(() => {
  localStorage.clear();
});

describe("RunSettingsForm: 初期値と単位表示（W7-1）", () => {
  it("初期値が RUN_SETTINGS_DEFAULTS と一致する（タイムアウトは秒、丸め許容はパーセントで表示）", () => {
    renderForm({
      manuscriptVersionId: null,
      modelId: null,
      restoring: false,
      startApi: makeStartApi(),
    });

    expect(screen.getByLabelText("検査対象の分割長（字）")).toHaveValue(1_500);
    expect(screen.getByLabelText("初回の参考文脈（字）")).toHaveValue(1_000);
    expect(screen.getByLabelText("再確認の参考文脈（字）")).toHaveValue(3_000);
    expect(screen.getByLabelText("再確認を行う")).toBeChecked();
    expect(screen.getByLabelText("誤字・脱字")).toBeChecked();
    expect(screen.getByLabelText("日本語の自然さ")).toBeChecked();
    expect(screen.getByLabelText("許容語（改行区切り）")).toHaveValue("");

    openAdvanced();

    expect(screen.getByLabelText("初回検査のタイムアウト（秒）")).toHaveValue(300); // 秒表示
    expect(screen.getByLabelText("再確認のタイムアウト（秒）")).toHaveValue(300);
    expect(screen.getByLabelText("段落境界への丸め許容（%）")).toHaveValue(20); // パーセント表示
    expect(screen.getByLabelText("最大トークン数")).toHaveValue(16_000);
    expect(screen.getByLabelText("温度")).toHaveValue(0);
    expect(screen.getByLabelText("入力上限（字）")).toHaveValue(12_000);
    // type="number" の空欄は jest-dom の toHaveValue では null になる。
    expect(screen.getByLabelText("シード（空欄で省略）")).toHaveValue(null);
    expect(screen.getByLabelText("思考の強さ")).toHaveValue("none");
  });
});

describe("RunSettingsForm: 検査観点（W7-4）", () => {
  it("両方の観点は外せない（最後の 1 つのチェックを外そうとしても変わらない）", () => {
    renderForm({
      manuscriptVersionId: null,
      modelId: null,
      restoring: false,
      startApi: makeStartApi(),
    });

    const typoCheckbox = screen.getByLabelText("誤字・脱字");
    const naturalnessCheckbox = screen.getByLabelText("日本語の自然さ");

    fireEvent.click(naturalnessCheckbox); // 1 つ外す：問題ない
    expect(typoCheckbox).toBeChecked();
    expect(naturalnessCheckbox).not.toBeChecked();

    fireEvent.click(typoCheckbox); // 残り最後の 1 つを外そうとする：変わらない
    expect(typoCheckbox).toBeChecked();
    expect(naturalnessCheckbox).not.toBeChecked();
  });
});

describe("RunSettingsForm: 許容語は原稿版と組で復元する（W7-16、決定 7）", () => {
  it("同じ原稿版でだけ復元され、別の原稿版では空になる", () => {
    writeStored(STORAGE_KEYS.allowedWords, {
      manuscriptVersionId: "mv-1",
      allowedWordsRaw: "猫又\n付喪神",
    });

    const { rerender } = render(
      <MemoryRouter>
        <RunSettingsForm
          manuscriptVersionId="mv-1"
          modelId={null}
          restoring={false}
          startApi={makeStartApi()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("許容語（改行区切り）")).toHaveValue("猫又\n付喪神");

    rerender(
      <MemoryRouter>
        <RunSettingsForm
          manuscriptVersionId="mv-2"
          modelId={null}
          restoring={false}
          startApi={makeStartApi()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("許容語（改行区切り）")).toHaveValue("");
  });

  it("原稿確定前は許容語欄が disabled（確定時の復元 effect による黙った上書きを避ける）", () => {
    const { rerender } = render(
      <MemoryRouter>
        <RunSettingsForm
          manuscriptVersionId={null}
          modelId={null}
          restoring={false}
          startApi={makeStartApi()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("許容語（改行区切り）")).toBeDisabled();

    rerender(
      <MemoryRouter>
        <RunSettingsForm
          manuscriptVersionId="mv-1"
          modelId={null}
          restoring={false}
          startApi={makeStartApi()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("許容語（改行区切り）")).not.toBeDisabled();
  });
});

describe("RunSettingsForm: 開始ボタンの無効化（W7-17）", () => {
  it("原稿が未確定のとき disabled", () => {
    renderForm({
      manuscriptVersionId: null,
      modelId: "model-a",
      restoring: false,
      startApi: makeStartApi(),
    });

    expect(screen.getByRole("button", { name: "検査を開始する" })).toBeDisabled();
  });

  it("モデル未選択のとき disabled で、接続設定へのリンクが出る", () => {
    renderForm({
      manuscriptVersionId: "mv-1",
      modelId: null,
      restoring: false,
      startApi: makeStartApi(),
    });

    expect(screen.getByRole("button", { name: "検査を開始する" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "接続設定" })).toBeInTheDocument();
  });

  it("原稿の復元中は disabled", () => {
    renderForm({
      manuscriptVersionId: "mv-1", // 復元中でも version が入りうる想定に依存しない：restoring を見る
      modelId: "model-a",
      restoring: true,
      startApi: makeStartApi(),
    });

    expect(screen.getByRole("button", { name: "検査を開始する" })).toBeDisabled();
  });

  it("原稿確定済み・モデル選択済み・復元中でなければ有効", () => {
    renderForm({
      manuscriptVersionId: "mv-1",
      modelId: "model-a",
      restoring: false,
      startApi: makeStartApi(),
    });

    expect(screen.getByRole("button", { name: "検査を開始する" })).not.toBeDisabled();
  });

  it('送信中（outcome.kind === "sending"）は disabled（連打防止）', () => {
    renderForm({
      manuscriptVersionId: "mv-1",
      modelId: "model-a",
      restoring: false,
      startApi: makeStartApi({ outcome: { kind: "sending" } }),
    });

    expect(screen.getByRole("button", { name: "検査を開始する" })).toBeDisabled();
  });
});

describe("RunSettingsForm: 設定の保存と復元（W7-19）", () => {
  it("変更した検査設定が runSettings に保存され、再マウントで復元される", () => {
    const { unmount } = renderForm({
      manuscriptVersionId: null,
      modelId: null,
      restoring: false,
      startApi: makeStartApi(),
    });

    fireEvent.change(screen.getByLabelText("検査対象の分割長（字）"), {
      target: { value: "2000" },
    });
    unmount();

    renderForm({
      manuscriptVersionId: null,
      modelId: null,
      restoring: false,
      startApi: makeStartApi(),
    });

    expect(screen.getByLabelText("検査対象の分割長（字）")).toHaveValue(2_000);
  });
});

// --- W7-7 と単位変換の配線確認は、実際の useStartRun を通す Harness で検証する ---

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

function makeConnectionApi(overrides: Partial<ConnectionApi> = {}): ConnectionApi {
  return {
    check: null,
    checkedAt: null,
    selectedModelId: null,
    error: null,
    checking: false,
    checkConnection: vi.fn(() => Promise.resolve(makeCheck())),
    selectModel: vi.fn(),
    ...overrides,
  };
}

function makeFakeClient(startRun: ApiClient["startRun"]): ApiClient {
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
    startRun,
    getRun: notImplemented("getRun"),
  };
}

function Harness(props: {
  client: ApiClient;
  connection: ConnectionApi;
  manuscriptVersionId: string | null;
  modelId: string | null;
}) {
  const startApi = useStartRun({ client: props.client, connection: props.connection });
  return (
    <RunSettingsForm
      manuscriptVersionId={props.manuscriptVersionId}
      modelId={props.modelId}
      restoring={false}
      startApi={startApi}
    />
  );
}

function renderHarness(client: ApiClient, connection: ConnectionApi) {
  return render(
    <MemoryRouter>
      <Harness
        client={client}
        connection={connection}
        manuscriptVersionId="mv-1"
        modelId="model-a"
      />
    </MemoryRouter>,
  );
}

describe("RunSettingsForm × useStartRun: クライアント検証（W7-7）", () => {
  it("validateChunkSettings に反する値ではフォーム全体のエラーを出し、startRun を呼ばない", async () => {
    const startRun = vi.fn((_body: StartRunRequest) => Promise.resolve({ id: "run-1" } as RunDto));
    const client = makeFakeClient(startRun);
    const connection = makeConnectionApi();
    renderHarness(client, connection);

    openAdvanced();
    // 100% → roundingTolerance 1.0（1 未満でなければならない、という不変条件に反する）。
    fireEvent.change(screen.getByLabelText("段落境界への丸め許容（%）"), {
      target: { value: "100" },
    });

    fireEvent.click(screen.getByRole("button", { name: "検査を開始する" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("roundingTolerance");
    expect(startRun).not.toHaveBeenCalled();
  });
});

describe("RunSettingsForm × useStartRun: 単位変換の配線（決定 12）", () => {
  it("既定値のまま開始すると、秒とパーセントが API の単位に変換されて送信される", async () => {
    const startRun = vi.fn((_body: StartRunRequest) => Promise.resolve({ id: "run-1" } as RunDto));
    const client = makeFakeClient(startRun);
    const connection = makeConnectionApi();
    renderHarness(client, connection);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "検査を開始する" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
    const body = startRun.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      timeouts: { checkMs: 300_000, recheckMs: 300_000 },
      chunkSettings: expect.objectContaining({ roundingTolerance: 0.2 }),
    });
  });
});

describe("RunSettingsForm × useStartRun: 再試行ボタン（決定 15、W7-15 のフォーム側）", () => {
  it("「再試行」はフォームの現在値ではなく開始時のスナップショットを送り、checkConnection をやり直さない", async () => {
    const startRun = vi
      .fn((_body: StartRunRequest) => Promise.resolve({ id: "run-1" } as RunDto))
      .mockRejectedValueOnce(new ApiRequestError(500, "unknown", "サーバー内部エラー"));
    const checkConnection = vi.fn(() => Promise.resolve(makeCheck()));
    const client = makeFakeClient(startRun);
    const connection = makeConnectionApi({ checkConnection });
    renderHarness(client, connection);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "検査を開始する" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "再試行" })).toBeInTheDocument());

    // 再試行の前にフォームの値を変える。送る内容には影響しないはず（決定 15）。
    fireEvent.change(screen.getByLabelText("検査対象の分割長（字）"), {
      target: { value: "9999" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "再試行" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(2));

    const firstBody = startRun.mock.calls[0]?.[0] as StartRunRequest;
    const secondBody = startRun.mock.calls[1]?.[0] as StartRunRequest;
    expect(secondBody).toEqual(firstBody); // 同じ startOperationId・同じ本文
    expect(secondBody.chunkSettings.targetGraphemes).toBe(1_500); // 9999 に汚染されていない
    expect(checkConnection).toHaveBeenCalledTimes(1); // 再送で増えない（決定 15）
  });

  it("押し直しが送信前に失敗しても「再試行」は画面に残り、元の startOperationId で再送する（レビュー対応）", async () => {
    const startRun = vi
      .fn((_body: StartRunRequest) => Promise.resolve({ id: "run-1" } as RunDto))
      .mockRejectedValueOnce(new ApiRequestError(500, "unknown", "サーバー内部エラー"));
    // 1 回目の開始は接続確認に成功し、POST が 5xx になる。2 回目は接続確認自体が失敗する。
    const checkConnection = vi
      .fn<ConnectionApi["checkConnection"]>()
      .mockResolvedValueOnce(makeCheck())
      .mockRejectedValueOnce(new Error("接続できません"));
    const client = makeFakeClient(startRun);
    const connection = makeConnectionApi({ checkConnection });
    renderHarness(client, connection);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "検査を開始する" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "再試行" })).toBeInTheDocument());

    // 利用者が「検査を開始する」を押し直し、その接続確認が失敗する。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "検査を開始する" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText("接続できません")).toBeInTheDocument());

    // 新しい失敗のメッセージが出ても、「再試行」は画面から消えない。
    expect(screen.getByRole("button", { name: "再試行" })).toBeInTheDocument();
    expect(startRun).toHaveBeenCalledTimes(1); // 新しい POST は出ていない

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "再試行" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(2));

    const firstBody = startRun.mock.calls[0]?.[0] as StartRunRequest;
    const secondBody = startRun.mock.calls[1]?.[0] as StartRunRequest;
    expect(secondBody.startOperationId).toBe(firstBody.startOperationId);
  });
});
