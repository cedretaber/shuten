/**
 * `/runs/:id` — 結果画面の骨組み（Task 5、決定 1・2・3。R7）。
 *
 * 3 つの取得（`getRun`・`getManuscript`・`getFindings`）がそろうまで部分描画をしないこと、
 * 世代番号による古い応答の破棄、404・取得失敗・`settings` 停止の扱い、指摘 0 件の文言分岐
 * （決定 2）、「最新の状態を取得」での再取得を確認する。
 *
 * 強調・一覧・詳細・採否・絞り込みは Task 6 以降が作る。ここでは `BodyView` が正しい段落数で
 * 描けること、右側は件数だけの仮表示であることまでを見る。
 */

import type { FindingDto, ManuscriptVersionDto, RunDetailDto, RunDto } from "@shuten/shared";
import { splitParagraphs } from "@shuten/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiClientProvider } from "../../api/context.tsx";
import { ApiRequestError } from "../../api/errors.ts";
import { ROUTES, runPath } from "../../app/routes.ts";
import { ResultsPage } from "./results-page.tsx";

const RUN_ID = "run-1";
const MANUSCRIPT_ID = "mv-1";
const BODY = "一段落目\n二段落目\n三段落目";

function makeRun(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: RUN_ID,
    manuscriptVersionId: MANUSCRIPT_ID,
    modelId: "model-a",
    modelInfo: null,
    generationSettings: { maxTokens: 512, temperature: 0 },
    chunkSettings: {
      targetGraphemes: 1500,
      contextGraphemes: 200,
      recheckContextGraphemes: 200,
      roundingTolerance: 0.1,
      maxInputGraphemes: 12000,
    },
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: false,
    allowedWords: [],
    allowedWordRuleVersion: "1",
    promptVersion: "1",
    diagnosticTransformVersion: "1",
    status: "running",
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    stopRequestedAt: null,
    recoveryConfirmedAt: null,
    recoveryConfirmMs: 60_000,
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function makeRunDetail(overrides: Partial<RunDto> = {}): RunDetailDto {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, "not-applicable": 0 } as const;
  return {
    run: makeRun(overrides),
    progress: { checkUnits: { ...counts }, recheckUnits: { ...counts } },
    targets: [],
  };
}

function makeManuscript(overrides: Partial<ManuscriptVersionDto> = {}): ManuscriptVersionDto {
  return {
    id: MANUSCRIPT_ID,
    name: "原稿A",
    body: BODY,
    bodyHash: "hash-1",
    createdAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeFinding(overrides: Partial<FindingDto> = {}): FindingDto {
  return {
    id: "finding-1",
    runId: RUN_ID,
    targetId: "target-1",
    locateStatus: "located",
    range: { start: 0, end: 1 },
    paragraphId: 0,
    quote: "あ",
    suggestion: null,
    category: "notation",
    initialVerdict: "likely-error",
    suppression: null,
    reasons: [],
    recheck: null,
    judgment: {
      findingId: "finding-1",
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
    createdAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

/** `notImplemented` パターン（`use-start-run.test.tsx` と同じ流儀）。呼ばれない口は例外にする。 */
function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
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
    startRun: notImplemented("startRun"),
    getRun: notImplemented("getRun"),
    getRuns: notImplemented("getRuns"),
    getFindings: notImplemented("getFindings"),
    getFinding: notImplemented("getFinding"),
    putJudgment: notImplemented("putJudgment"),
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPage(client: ApiClient, id: string = RUN_ID) {
  return render(
    <MemoryRouter initialEntries={[runPath(id)]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path={ROUTES.run} element={<ResultsPage />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

function paragraphElements() {
  return document.querySelectorAll("[data-paragraph-id]");
}

describe("ResultsPage: R7 3 つの取得がそろうまで", () => {
  it("読み込み中の表示になり、本文が描かれない", async () => {
    const runDeferred = deferred<RunDetailDto>();
    const manuscriptDeferred = deferred<ManuscriptVersionDto>();
    const findingsDeferred = deferred<FindingDto[]>();
    const getRun = vi.fn(() => runDeferred.promise);
    const getManuscript = vi.fn(() => manuscriptDeferred.promise);
    const getFindings = vi.fn(() => findingsDeferred.promise);
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    expect(screen.getByText("読み込み中…")).toBeInTheDocument();
    expect(paragraphElements().length).toBe(0);
    // getRun・getFindings は並行に投げる。getManuscript は getRun の応答待ちなのでまだ呼ばれない。
    expect(getRun).toHaveBeenCalledTimes(1);
    expect(getFindings).toHaveBeenCalledTimes(1);
    expect(getManuscript).not.toHaveBeenCalled();
  });

  it("そろったら getManuscript の本文どおりの段落数で描かれる", async () => {
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([makeFinding()]));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    const expectedParagraphs = splitParagraphs(BODY).length;
    await waitFor(() => expect(paragraphElements().length).toBe(expectedParagraphs));
    expect(screen.queryByText("読み込み中…")).not.toBeInTheDocument();
  });
});

describe("ResultsPage: R7 404・取得失敗", () => {
  it("getRun が 404 のとき「その実行はありません」", async () => {
    const getRun = vi.fn(() => Promise.reject(new ApiRequestError(404, "not-found", "no run")));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText(/その実行はありません/)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "トップへ戻る" })).toBeInTheDocument();
  });

  it("getFindings が失敗したときエラー表示になる（本文だけ描いて黙らない）", async () => {
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail()));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.reject(new Error("指摘の取得に失敗しました")));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("指摘の取得に失敗しました")).toBeInTheDocument());
    expect(paragraphElements().length).toBe(0);
  });

  // レビュー対応（Important 1）：404 の写し方は発生源で分ける。`getRun` 以外が 404 を返しても、
  // 実行自体は取得できているので「その実行はありません」にはしない。常にエラー表示にする。
  it("getManuscript が 404 のときエラー表示になる（『その実行はありません』ではない）", async () => {
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail()));
    const getManuscript = vi.fn(() =>
      Promise.reject(new ApiRequestError(404, "not-found", "manuscript not found")),
    );
    const getFindings = vi.fn(() => Promise.resolve([]));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("manuscript not found")).toBeInTheDocument());
    expect(screen.queryByText(/その実行はありません/)).not.toBeInTheDocument();
    expect(paragraphElements().length).toBe(0);
  });

  it("getFindings が 404 のときエラー表示になる（『その実行はありません』ではない）", async () => {
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail()));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() =>
      Promise.reject(new ApiRequestError(404, "not-found", "findings not found")),
    );
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("findings not found")).toBeInTheDocument());
    expect(screen.queryByText(/その実行はありません/)).not.toBeInTheDocument();
    expect(paragraphElements().length).toBe(0);
  });
});

describe("ResultsPage: R7 settings 停止", () => {
  it("本文・右側を描かず、検査設定へのリンクだけを出す", async () => {
    const getRun = vi.fn(() =>
      Promise.resolve(makeRunDetail({ status: "stopped", stopReason: "settings" })),
    );
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([makeFinding()]));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("検査は開始できませんでした")).toBeInTheDocument());
    expect(paragraphElements().length).toBe(0);
    expect(screen.queryByText(/件/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "検査設定に戻る" })).toBeInTheDocument();
  });
});

describe("ResultsPage: R7 指摘 0 件の文言（決定 2）", () => {
  it("completed で 0 件のとき「指摘はありません」", async () => {
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("指摘はありません")).toBeInTheDocument());
  });

  it("stopped（settings 以外）で 0 件のとき「指摘はありません」は出ない", async () => {
    const getRun = vi.fn(() =>
      Promise.resolve(makeRunDetail({ status: "stopped", stopReason: "aborted" })),
    );
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText(/まだ指摘がありません/)).toBeInTheDocument());
    expect(screen.queryByText("指摘はありません")).not.toBeInTheDocument();
  });
});

// 旧 run-receipt-page.test.tsx の W8-6 相当（削除に伴うカバレッジの穴埋め、Minor 3）。
// 実装が誤って progress / targets の値をどこかに埋め込んだら検出できるよう、
// 現実にはありえない値（進捗件数・対象 ID）を仕込んでおく。`progress` は PR12b の担当、
// `targets` は Task 9 が使うため、本タスクではどちらも読み捨てるだけで画面に出さない。
describe("ResultsPage: RunDetailDto の progress と targets を画面に出さない", () => {
  it("進捗件数・対象 ID が document.body.textContent に出ない", async () => {
    const detail: RunDetailDto = {
      run: makeRun({ status: "completed" }),
      progress: {
        checkUnits: { pending: 0, running: 0, done: 12345, failed: 0, "not-applicable": 0 },
        recheckUnits: { pending: 0, running: 0, done: 0, failed: 0, "not-applicable": 0 },
      },
      targets: [
        {
          id: "target-6789",
          targetIndex: 0,
          target: { start: 0, end: 10 },
          contextBefore: null,
          contextAfter: null,
          input: { start: 0, end: 10 },
          paragraphIds: [0],
        },
      ],
    };
    const getRun = vi.fn(() => Promise.resolve(detail));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("指摘はありません")).toBeInTheDocument());
    expect(document.body.textContent ?? "").not.toContain("12345");
    expect(document.body.textContent ?? "").not.toContain("target-6789");
  });
});

describe("ResultsPage: R7 最新の状態を取得", () => {
  it("クリックで 3 つとも再取得される", async () => {
    const user = userEvent.setup();
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("指摘はありません")).toBeInTheDocument());
    expect(getRun).toHaveBeenCalledTimes(1);
    expect(getManuscript).toHaveBeenCalledTimes(1);
    expect(getFindings).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "最新の状態を取得" }));

    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    expect(getManuscript).toHaveBeenCalledTimes(2);
    expect(getFindings).toHaveBeenCalledTimes(2);
  });
});
