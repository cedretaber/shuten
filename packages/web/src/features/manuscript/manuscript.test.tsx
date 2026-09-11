import type { ManuscriptVersionDto } from "@shuten/shared";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApiClient } from "../../api/client.ts";
import { createApiClient } from "../../api/client.ts";
import { ApiRequestError, ApiTransportError } from "../../api/errors.ts";
import { STORAGE_KEYS } from "../../storage/keys.ts";
import { readStored, writeStored } from "../../storage/local.ts";
import { ManuscriptConfirmed } from "./manuscript-confirmed.tsx";
import { ManuscriptEditor } from "./manuscript-editor.tsx";
import type { ManuscriptApi } from "./use-manuscript.ts";
import { useManuscript } from "./use-manuscript.ts";

/**
 * 原稿の検証（W6-1〜5、W6-8〜12、決定 6・11・17）。W6-6〜7 は `preview.test.ts`。
 *
 * 空白だけの本文が確定できること（W6-2、trim() を入れると落ちる）、プレビューが
 * 書記素境界で切れること（W6-8、`<details>` に全文を入れっぱなしにすると落ちる）、
 * `File.text()` を呼んでいないこと（W6-4、呼ぶようにすると落ちる）、`restoreError` の表示
 * （削除すると落ちる）は、実装を意図的に誤らせてこのテストが実際に赤くなることを確認した
 * （作業報告に記録する）。
 *
 * レビュー Important 1（復元 GET と確定操作／reset のレース）を受けて、復元中に確定・reset した
 * ときの 3 つの筋道（遅い復元の成功で上書きしない／遅い復元の 404 で新しいキーを消さない／
 * reset 後に遅い復元の成功で confirmed に戻さない）を `describe("useManuscript のレース")` に足した。
 */

const manuscriptVersionIdSchema = z.string().nullable();

function readStoredManuscriptVersionId(): string | null {
  return readStored(STORAGE_KEYS.manuscriptVersionId, manuscriptVersionIdSchema, null);
}

/** resolve/reject を外から呼べる Promise（復元 GET を任意のタイミングで完了させるためのテスト用）。 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** マイクロタスクキューだけでなくタイマーも 1 tick 進め、非同期の後始末を確実に反映させる。 */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeVersion(overrides: Partial<ManuscriptVersionDto> = {}): ManuscriptVersionDto {
  return {
    id: "ms-1",
    name: "原稿A",
    body: "本文",
    bodyHash: "hash",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

/** `getManuscript` / `createManuscript` / `uploadManuscript` 以外は呼ばれない想定の fake。 */
function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`${name} は呼ばれない想定`);
  };
  return {
    getConnection: notImplemented("getConnection"),
    putConnection: notImplemented("putConnection"),
    checkConnection: notImplemented("checkConnection"),
    createManuscript: vi.fn(() => Promise.reject(new Error("createManuscript は未設定"))),
    uploadManuscript: vi.fn(() => Promise.reject(new Error("uploadManuscript は未設定"))),
    getManuscript: vi.fn(() => Promise.reject(new Error("getManuscript は未設定"))),
    startRun: notImplemented("startRun"),
    getRun: notImplemented("getRun"),
    getRuns: notImplemented("getRuns"),
    getFindings: notImplemented("getFindings"),
    getFinding: notImplemented("getFinding"),
    putJudgment: notImplemented("putJudgment"),
    ...overrides,
  };
}

function makeManuscriptApi(overrides: Partial<ManuscriptApi> = {}): ManuscriptApi {
  return {
    state: { kind: "editing" },
    restoreError: null,
    restoring: false,
    confirmPaste: vi.fn(() => Promise.resolve()),
    confirmFile: vi.fn(() => Promise.resolve()),
    reset: vi.fn(),
    ...overrides,
  };
}

function renderEditor(api: ManuscriptApi) {
  return render(
    <MemoryRouter>
      <ManuscriptEditor api={api} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks(); // W6-4 の Blob.prototype.text spy などを次のテストへ持ち越さない
});

describe("ManuscriptEditor", () => {
  it("W6-1: 本文が空だと「この原稿を確定する」が disabled", async () => {
    const api = makeManuscriptApi();
    renderEditor(api);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("原稿名"), "テスト原稿");

    expect(screen.getByRole("button", { name: "この原稿を確定する" })).toBeDisabled();
  });

  it("W6-2: 空白だけの本文は確定できる（trim() しない）", async () => {
    const confirmPaste = vi.fn(() => Promise.resolve());
    const api = makeManuscriptApi({ confirmPaste });
    renderEditor(api);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("原稿名"), "テスト原稿");
    await user.type(screen.getByLabelText("本文"), "   ");

    const button = screen.getByRole("button", { name: "この原稿を確定する" });
    expect(button).not.toBeDisabled();

    await user.click(button);

    await waitFor(() => expect(confirmPaste).toHaveBeenCalledTimes(1));
    // 空白がそのまま送られること（trim() されていないこと）を厳密に確認する。
    expect(confirmPaste).toHaveBeenCalledWith({ name: "テスト原稿", body: "   " });
  });

  it("W6-3: 原稿名が空、または 201 文字だと disabled（200 文字は disabled にならない）", async () => {
    const api = makeManuscriptApi();
    renderEditor(api);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("本文"), "本文あり");

    // 原稿名が空
    expect(screen.getByRole("button", { name: "この原稿を確定する" })).toBeDisabled();

    // 200 文字（有効な最大値）。`user.type` は 1 文字ずつのため、長い文字列は `fireEvent.change` で
    // 直接値を設定する（内容は「何文字か」だけが重要で、貼り付け経路の検証はここでは不要）。
    const nameInput = screen.getByLabelText("原稿名");
    fireEvent.change(nameInput, { target: { value: "a".repeat(200) } });
    expect(screen.getByRole("button", { name: "この原稿を確定する" })).not.toBeDisabled();

    // 201 文字（無効）
    fireEvent.change(nameInput, { target: { value: "a".repeat(201) } });
    expect(screen.getByRole("button", { name: "この原稿を確定する" })).toBeDisabled();
  });

  it("W6-4: ファイル経路は選んだ File をそのまま渡し、File.text() を呼ばない", async () => {
    const confirmFile = vi.fn((_input: { name: string; file: File }) => Promise.resolve());
    const api = makeManuscriptApi({ confirmFile });
    renderEditor(api);

    const textSpy = vi.spyOn(Blob.prototype, "text");

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("ファイル"));

    const file = new File(["原稿の中身\r\nCRLF を含む"], "manuscript.txt", {
      type: "text/plain",
    });
    const fileInput = screen.getByLabelText("ファイル（UTF-8 のテキストファイル）");
    await user.upload(fileInput, file);

    // ファイル選択時にファイル名が原稿名の初期値として入る。
    expect(screen.getByLabelText("原稿名")).toHaveValue("manuscript.txt");

    const button = screen.getByRole("button", { name: "この原稿を確定する" });
    expect(button).not.toBeDisabled();
    await user.click(button);

    await waitFor(() => expect(confirmFile).toHaveBeenCalledTimes(1));
    const call = confirmFile.mock.calls[0]?.[0];
    expect(call?.file).toBe(file); // 同一インスタンスをそのまま渡す
    expect(call?.name).toBe("manuscript.txt");
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("W6-5: 400 invalid-utf8 は文字コードの問題として表示する", async () => {
    const confirmFile = vi.fn(() =>
      Promise.reject(new ApiRequestError(400, "invalid-utf8", "UTF-8 として読み込めません")),
    );
    const api = makeManuscriptApi({ confirmFile });
    renderEditor(api);

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("ファイル"));
    const file = new File(["dummy"], "broken.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("ファイル（UTF-8 のテキストファイル）"), file);
    await user.click(screen.getByRole("button", { name: "この原稿を確定する" }));

    await waitFor(() => expect(screen.getByText(/UTF-8 ではありません/)).toBeInTheDocument());
  });

  it("W6-10: restoreError があれば編集画面に再試行できるエラーとして表示する", () => {
    const api = makeManuscriptApi({ restoreError: "確定済みの原稿を読み込めませんでした。" });
    renderEditor(api);

    expect(screen.getByText("確定済みの原稿を読み込めませんでした。")).toBeInTheDocument();
  });
});

describe("ManuscriptConfirmed", () => {
  const MARKER = "【後半の印】";

  function renderConfirmed(version: ManuscriptVersionDto, onReset = vi.fn()) {
    render(
      <MemoryRouter>
        <ManuscriptConfirmed version={version} onReset={onReset} />
      </MemoryRouter>,
    );
    return { onReset };
  }

  it("W6-8: 折りたたみを開く前は 501 書記素目以降が DOM に無く、開くと出てくる", async () => {
    const body = "あ".repeat(500) + MARKER + "い".repeat(50);
    renderConfirmed(makeVersion({ body }));

    expect(document.body.textContent).not.toContain(MARKER);

    const user = userEvent.setup();
    await user.click(screen.getByText("全文を表示する"));

    expect(document.body.textContent).toContain(MARKER);
  });

  it("本文が 500 書記素以下なら全文展開の操作を出さない", () => {
    renderConfirmed(makeVersion({ body: "あ".repeat(500) }));
    expect(screen.queryByText("全文を表示する")).not.toBeInTheDocument();
  });

  it("原稿名・書記素数・確定日時・「確定後の本文は変更できない」旨を表示する（決定 11）", () => {
    const createdAt = "2026-09-01T00:00:00.000Z";
    renderConfirmed(makeVersion({ name: "私の原稿", body: "あいう", createdAt }));

    expect(screen.getByText("私の原稿")).toBeInTheDocument();
    expect(screen.getByText("3 字")).toBeInTheDocument();
    expect(screen.getByText(new Date(createdAt).toLocaleString("ja-JP"))).toBeInTheDocument();
    expect(screen.getByText("確定後の本文は変更できません。")).toBeInTheDocument();
  });

  it("書記素数は UTF-16 長ではなく書記素クラスタ数で数える（ZWJ 絵文字は 1 字）", () => {
    // "👨‍👩‍👧" は UTF-16 で 8 コード単位（.length === 8）だが、書記素クラスタとしては 1 つ。
    // `countGraphemes` の代わりに `version.body.length` を使う誤りをここで検出する。
    renderConfirmed(makeVersion({ body: "👨‍👩‍👧" }));
    expect(screen.getByText("1 字")).toBeInTheDocument();
  });

  it("「別の原稿を選ぶ」を押すと onReset が呼ばれる", async () => {
    const { onReset } = renderConfirmed(makeVersion());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "別の原稿を選ぶ" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe("useManuscript", () => {
  it("W6-9: 起動時の復元：404 → キーを消し、編集中に戻る", async () => {
    writeStored(STORAGE_KEYS.manuscriptVersionId, "ms-1");
    const getManuscript = vi.fn(() =>
      Promise.reject(new ApiRequestError(404, "not-found", "原稿版が見つかりません: ms-1")),
    );
    const client = makeClient({ getManuscript });

    const { result } = renderHook(() => useManuscript(client));

    await waitFor(() => expect(getManuscript).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readStoredManuscriptVersionId()).toBeNull());
    expect(result.current.state.kind).toBe("editing");
    expect(result.current.restoreError).toBeNull();
  });

  it("W6-10: 起動時の復元：500 → キーを残し、再試行できるエラーを出す", async () => {
    writeStored(STORAGE_KEYS.manuscriptVersionId, "ms-1");
    const getManuscript = vi.fn(() =>
      Promise.reject(new ApiRequestError(500, "unknown", "サーバーへの要求が失敗しました")),
    );
    const client = makeClient({ getManuscript });

    const { result } = renderHook(() => useManuscript(client));

    await waitFor(() => expect(result.current.restoreError).not.toBeNull());
    expect(result.current.state.kind).toBe("editing");
    expect(readStoredManuscriptVersionId()).toBe("ms-1"); // 消えていない
  });

  it("W6-10: 起動時の復元：通信失敗（ApiTransportError） → キーを残し、再試行できるエラーを出す", async () => {
    writeStored(STORAGE_KEYS.manuscriptVersionId, "ms-1");
    const getManuscript = vi.fn(() => Promise.reject(new ApiTransportError()));
    const client = makeClient({ getManuscript });

    const { result } = renderHook(() => useManuscript(client));

    await waitFor(() => expect(result.current.restoreError).not.toBeNull());
    expect(result.current.state.kind).toBe("editing");
    expect(readStoredManuscriptVersionId()).toBe("ms-1"); // 消えていない
  });

  it("W6-12: 確定すると manuscriptVersionId が localStorage に保存される", async () => {
    const version = makeVersion({ id: "ms-new" });
    const createManuscript = vi.fn(() => Promise.resolve(version));
    const client = makeClient({ createManuscript });

    const { result } = renderHook(() => useManuscript(client));

    await act(async () => {
      await result.current.confirmPaste({ name: "原稿A", body: "本文" });
    });

    expect(result.current.state).toEqual({ kind: "confirmed", version });
    expect(readStoredManuscriptVersionId()).toBe("ms-new");
  });

  it("W6-11: 「別の原稿を選ぶ」で編集中に戻り、キーが消える。fetch は増えない（削除要求を出さない）", async () => {
    // `ApiClient` インターフェースに削除の口が無いことに頼らず、実際の `fetch` の呼び出し回数で
    // 「削除相当の要求を一切出さない」ことを確かめる（トートロジー回避のため fake ではなく実
    // `createApiClient` を使い、`fetch` だけ差し替える）。
    const responseJson = JSON.stringify({
      id: "ms-new",
      name: "原稿A",
      body: "本文",
      bodyHash: "hash",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(responseJson, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = createApiClient({ fetch: fetchMock as unknown as typeof fetch });

    const { result } = renderHook(() => useManuscript(client));

    await act(async () => {
      await result.current.confirmPaste({ name: "原稿A", body: "本文" });
    });
    expect(result.current.state.kind).toBe("confirmed");
    expect(fetchMock).toHaveBeenCalledTimes(1); // createManuscript の POST だけ

    act(() => {
      result.current.reset();
    });

    expect(result.current.state).toEqual({ kind: "editing" });
    expect(readStoredManuscriptVersionId()).toBeNull();
    // reset() の前後で fetch の呼び出し回数が増えていない。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restoring は復元中だけ true になる", async () => {
    writeStored(STORAGE_KEYS.manuscriptVersionId, "ms-1");
    const restore = deferred<ManuscriptVersionDto>();
    const getManuscript = vi.fn(() => restore.promise);
    const client = makeClient({ getManuscript });

    const { result } = renderHook(() => useManuscript(client));

    await waitFor(() => expect(result.current.restoring).toBe(true));

    await act(async () => {
      restore.resolve(makeVersion({ id: "ms-1" }));
      await flushAsync();
    });

    expect(result.current.restoring).toBe(false);
    expect(result.current.state).toEqual({
      kind: "confirmed",
      version: makeVersion({ id: "ms-1" }),
    });
  });
});

describe("useManuscript のレース（レビュー Important 1）", () => {
  it("復元中に確定すると、遅れて届いた復元の成功で新しい確定状態を上書きしない", async () => {
    writeStored(STORAGE_KEYS.manuscriptVersionId, "old-id");
    const restore = deferred<ManuscriptVersionDto>();
    const getManuscript = vi.fn(() => restore.promise);
    const newVersion = makeVersion({ id: "new-id", name: "新原稿" });
    const createManuscript = vi.fn(() => Promise.resolve(newVersion));
    const client = makeClient({ getManuscript, createManuscript });

    const { result } = renderHook(() => useManuscript(client));
    await waitFor(() => expect(getManuscript).toHaveBeenCalledTimes(1));
    expect(result.current.restoring).toBe(true);

    await act(async () => {
      await result.current.confirmPaste({ name: "新原稿", body: "本文" });
    });
    expect(result.current.state).toEqual({ kind: "confirmed", version: newVersion });
    expect(result.current.restoring).toBe(false); // confirmPaste が復元を中断した

    // 遅れて古い復元の応答が成功で返ってくる。
    await act(async () => {
      restore.resolve(makeVersion({ id: "old-id", name: "旧原稿" }));
      await flushAsync();
    });

    // 新しい確定状態のまま（上書きされない）。
    expect(result.current.state).toEqual({ kind: "confirmed", version: newVersion });
    expect(readStoredManuscriptVersionId()).toBe("new-id");
  });

  it("復元中に確定した後、遅れて届いた復元の 404 で新しいキーを消さない", async () => {
    writeStored(STORAGE_KEYS.manuscriptVersionId, "old-id");
    const restore = deferred<ManuscriptVersionDto>();
    const getManuscript = vi.fn(() => restore.promise);
    const newVersion = makeVersion({ id: "new-id" });
    const createManuscript = vi.fn(() => Promise.resolve(newVersion));
    const client = makeClient({ getManuscript, createManuscript });

    const { result } = renderHook(() => useManuscript(client));
    await waitFor(() => expect(getManuscript).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.confirmPaste({ name: "新原稿", body: "本文" });
    });
    expect(readStoredManuscriptVersionId()).toBe("new-id");

    // 遅れて古い復元の応答が 404 で返ってくる。
    await act(async () => {
      restore.reject(new ApiRequestError(404, "not-found", "原稿版が見つかりません: old-id"));
      await flushAsync();
    });

    // 直前に書いたばかりの新しいキーが消えていない。
    expect(readStoredManuscriptVersionId()).toBe("new-id");
    expect(result.current.state).toEqual({ kind: "confirmed", version: newVersion });
  });

  it("復元中に reset() を呼ぶと、遅れて届いた復元の成功で confirmed に戻らない", async () => {
    writeStored(STORAGE_KEYS.manuscriptVersionId, "old-id");
    const restore = deferred<ManuscriptVersionDto>();
    const getManuscript = vi.fn(() => restore.promise);
    const client = makeClient({ getManuscript });

    const { result } = renderHook(() => useManuscript(client));
    await waitFor(() => expect(getManuscript).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.reset();
    });
    expect(result.current.state).toEqual({ kind: "editing" });
    expect(readStoredManuscriptVersionId()).toBeNull();
    expect(result.current.restoring).toBe(false); // reset が復元を中断した

    // 遅れて古い復元の応答が成功で返ってくる。
    await act(async () => {
      restore.resolve(makeVersion({ id: "old-id" }));
      await flushAsync();
    });

    // confirmed に戻っていない（reset の意図と矛盾しない）。
    expect(result.current.state).toEqual({ kind: "editing" });
    expect(readStoredManuscriptVersionId()).toBeNull();
  });
});
