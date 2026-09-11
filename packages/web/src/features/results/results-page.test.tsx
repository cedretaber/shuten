/**
 * `/runs/:id` — 結果画面の骨組み（Task 5、決定 1・2・3。R7）。
 *
 * 4 つの取得（`getRun`・`getManuscript`・`getFindings`・`getRunUnits`。`getRunUnits` は
 * PR12b Task 5 で追加）がそろうまで部分描画をしないこと、世代番号による古い応答の破棄、
 * 404・取得失敗・`settings` 停止の扱い、指摘 0 件の文言分岐（決定 2）、
 * 「最新の状態を取得」での再取得を確認する。
 *
 * 採否の操作は Task 8 が作る。ここでは `BodyView` が正しい段落数で描けること、右側の
 * 指摘一覧と絞り込み（決定 7・8・10。`finding-filter.ts`・`finding-filter.tsx`・
 * `finding-list.tsx` の連携。単体の検査は `finding-filter.test.ts`・`finding-list.test.tsx`）が
 * `ResultsPage` に正しく組み込まれていることまでを見る。
 *
 * 指摘詳細（Task 7、決定 3・9・12）の表示規則そのもの（`describeRecheck`・`relatedFindings`・
 * 決定 9 の `paragraphId` 非表示など）は `finding-detail.test.ts`・`finding-detail.test.tsx` の役割。
 * ここでは選択と `getFinding` の配線（1 回だけ呼ばれること、取得前でも一覧が持つ情報から
 * 引用・理由が出ること、関連する他の指摘のリンクで選択が移ること）だけを見る。
 *
 * 実行制御（停止・再開・失敗単位の再試行・復旧確認。PR12b Task 5、決定 6・7・8）の配線
 * （操作後に必ず取り直すこと、`pending` の間ボタンが disabled になること、409 の `code` ごとに
 * 案内が変わり `error.message` が画面に出ないこと）は末尾の `describe` ブロックで見る。
 */

import type {
  CandidateDto,
  CheckUnitDto,
  FindingDetailDto,
  FindingDto,
  JudgmentDto,
  ManuscriptVersionDto,
  RunDetailDto,
  RunDto,
  RunEventDto,
  RunUnitsDto,
} from "@shuten/shared";
import { splitParagraphs } from "@shuten/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiClientProvider } from "../../api/context.tsx";
import { ApiRequestError } from "../../api/errors.ts";
import type { RunEventHandlers } from "../../api/events.ts";
import { ROUTES, runPath } from "../../app/routes.ts";
import findingListStyles from "./results-page.module.css";
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

function makeCheckUnit(overrides: Partial<CheckUnitDto> = {}): CheckUnitDto {
  return {
    id: "check-1",
    targetId: "target-1",
    targetIndex: 0,
    perspective: "typo",
    status: "pending",
    attempts: 0,
    failure: null,
    pendingNote: null,
    elapsedMs: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

/** `GET /api/runs/:id/units` の応答（PR12b Task 5 で追加）。既定は空（失敗単位なし）。 */
function makeUnits(overrides: Partial<RunUnitsDto> = {}): RunUnitsDto {
  return { checkUnits: [], recheckUnits: [], ...overrides };
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

/** `getFinding` の応答（Task 7）。`makeFinding` に候補・診断を足しただけの最小構成。 */
function makeFindingDetail(overrides: Partial<FindingDetailDto> = {}): FindingDetailDto {
  return {
    ...makeFinding(),
    candidates: [],
    diagnostics: [],
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
    // 既定は空の units を即座に返す（PR12b Task 5 で `fetchAll` に足した第 4 の取得）。
    // 呼ばれ方そのものを検査するテストは明示的に上書きする。
    getRunUnits: () => Promise.resolve(makeUnits()),
    stopRun: notImplemented("stopRun"),
    resumeRun: notImplemented("resumeRun"),
    retryFailedUnits: notImplemented("retryFailedUnits"),
    getRecovery: notImplemented("getRecovery"),
    confirmRecovery: notImplemented("confirmRecovery"),
    getFindings: notImplemented("getFindings"),
    getFinding: notImplemented("getFinding"),
    putJudgment: notImplemented("putJudgment"),
    // 既定は「張れるが何も鳴らない」購読（Task 8）。`status === "running"` の実行を描く検査は
    // 多く、そのすべてが購読を張るため、ここを例外にすると無関係な検査が落ちる。
    // 購読そのものを検査するときは `fakeStream()` を明示的に渡す。
    subscribeRunEvents: () => () => {},
    ...overrides,
  };
}

interface FakeSubscription {
  readonly runId: string;
  readonly handlers: RunEventHandlers;
  closed: boolean;
}

/**
 * 偽の SSE 購読（Task 8）。jsdom に `EventSource` は無いので、`ApiClient` の口ごと差し替える。
 * イベントは `RunEventDto` をそのまま渡す——テストに JSON の `data` 文字列を一切登場させない
 * （受信した値を画面にもログにも出さない、という規律をテスト側でも守る）。
 */
function fakeStream() {
  const subscriptions: FakeSubscription[] = [];
  const subscribeRunEvents = vi.fn((runId: string, handlers: RunEventHandlers) => {
    const entry: FakeSubscription = { runId, handlers, closed: false };
    subscriptions.push(entry);
    return () => {
      entry.closed = true;
    };
  });
  return {
    subscribeRunEvents,
    subscriptions,
    live: () => subscriptions.filter((s) => !s.closed),
    handlers: () => {
      const last = subscriptions.at(-1);
      if (last === undefined) throw new Error("購読がまだ 1 本も張られていない");
      return last.handlers;
    },
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
// PR12b Task 5 より前は `progress`・`targets` をどちらも読み捨てるだけだったため、このテストは
// 「どちらも画面に出ない」ことを検査していた。Task 5 で `progress` は `RunHeader`（実体は
// `RunProgress`）へ渡して意図的に表示するようになったため、`targets`（`RunTargetDto.id` などの
// 内部 ID）だけが「出ない」対象として残る——進捗件数はむしろ「出ること」を検査する。
describe("ResultsPage: RunDetailDto の progress を表示し、targets の内部 ID は出さない", () => {
  it("進捗件数（run.progress）は表示され、対象 ID（targets）は document.body.textContent に出ない", async () => {
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
    // 進捗件数は `RunHeader`（`RunProgress`）が意図して表示する（Task 5）。
    expect(screen.getByText(/完了 12345 \/ 全 12345 件/)).toBeInTheDocument();
    // `targets`（`RunTargetDto.id` などの内部 ID）はどこにも出さない。
    expect(document.body.textContent ?? "").not.toContain("target-6789");
  });
});

describe("ResultsPage: R7 最新の状態を取得", () => {
  // PR12b Task 8：取り直し（手動・自動とも）は `getManuscript` を呼ばない。原稿の版は不変で
  // （`run.manuscriptVersionId` は実行中に変わらない）、取り直す理由が無いため（決定 2 の
  // `light` / `heavy` の定義にも `getManuscript` は含まれない）。
  it("クリックで状態・単位・指摘が再取得される（原稿は取り直さない）", async () => {
    const user = userEvent.setup();
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const getRunUnits = vi.fn(() => Promise.resolve(makeUnits()));
    const client = makeClient({ getRun, getManuscript, getFindings, getRunUnits });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("指摘はありません")).toBeInTheDocument());
    expect(getRun).toHaveBeenCalledTimes(1);
    expect(getManuscript).toHaveBeenCalledTimes(1);
    expect(getFindings).toHaveBeenCalledTimes(1);
    expect(getRunUnits).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "最新の状態を取得" }));

    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    expect(getFindings).toHaveBeenCalledTimes(2);
    expect(getRunUnits).toHaveBeenCalledTimes(2);
    expect(getManuscript).toHaveBeenCalledTimes(1);
  });
});

// 最終レビュー Important 1：更新（再取得）の失敗で、表示中の結果が全部消える回帰の再発防止。
describe("ResultsPage: 最終レビュー Important 1 更新の失敗", () => {
  it("読み込み済みの状態で更新に失敗しても本文と一覧が残り、エラーが出る", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({ id: "finding-1", quote: "あ" });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi
      .fn<() => Promise<FindingDto[]>>()
      .mockResolvedValueOnce([finding1])
      .mockRejectedValueOnce(new Error("指摘の再取得に失敗しました"));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    const expectedParagraphs = splitParagraphs(BODY).length;
    expect(paragraphElements().length).toBe(expectedParagraphs);

    await user.click(screen.getByRole("button", { name: "最新の状態を取得" }));

    await waitFor(() => expect(screen.getByText("指摘の再取得に失敗しました")).toBeInTheDocument());
    // 本文・一覧は消えずに残る。
    expect(paragraphElements().length).toBe(expectedParagraphs);
    expect(screen.getByText("1 / 1 件")).toBeInTheDocument();
    // 更新ボタンも押せる状態のまま（再試行できる）。
    const refreshButton = screen.getByRole("button", { name: "最新の状態を取得" });
    expect(refreshButton).not.toBeDisabled();
  });

  it("初回の取得に失敗すると再試行の操作子が出て、押すと再取得される", async () => {
    const user = userEvent.setup();
    // フォールバック文言（`errorMessageFrom` の既定値）と区別できるよう、意図的に異なる文言にする
    // （「メッセージが実際に伝播した」ことと「フォールバックが発火した」ことを取り違えないため）。
    const getRun = vi
      .fn<() => Promise<RunDetailDto>>()
      .mockRejectedValueOnce(new Error("初回取得の失敗（テスト用）"))
      .mockResolvedValueOnce(makeRunDetail({ status: "completed" }));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("初回取得の失敗（テスト用）")).toBeInTheDocument());
    const retryButton = screen.getByRole("button", { name: "最新の状態を取得" });

    await user.click(retryButton);

    await waitFor(() => expect(screen.getByText("指摘はありません")).toBeInTheDocument());
    expect(getRun).toHaveBeenCalledTimes(2);
  });
});

// Task 6（指摘一覧と絞り込み、決定 7・8・10）。BODY = "一段落目\n二段落目\n三段落目" の
// 段落 0（"一段落目"、範囲 [0,4)）に finding-1（notation）、段落 1（"二段落目"、範囲 [5,9)）に
// finding-2（grammar）を located で置く。
function findingsSpans() {
  return document.querySelectorAll("[data-findings]");
}

describe("ResultsPage: Task 6 絞り込みを変えると強調も減ること", () => {
  it("分類の絞り込みを外すと、その分類の指摘の強調が消える", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({
      id: "finding-1",
      category: "notation",
      locateStatus: "located",
      range: { start: 0, end: 1 },
      paragraphId: 0,
    });
    const finding2 = makeFinding({
      id: "finding-2",
      category: "grammar",
      locateStatus: "located",
      range: { start: 5, end: 6 },
      paragraphId: 1,
    });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([finding1, finding2]));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(findingsSpans().length).toBe(2));
    expect(screen.getByText("2 / 2 件")).toBeInTheDocument();

    // 分類「文法」（grammar）のチェックを外す。finding-2 だけが分類 grammar。
    await user.click(screen.getByRole("checkbox", { name: "文法" }));

    await waitFor(() => expect(findingsSpans().length).toBe(1));
    expect(document.querySelector('[data-findings~="finding-2"]')).toBeNull();
    expect(document.querySelector('[data-findings~="finding-1"]')).not.toBeNull();
    expect(screen.getByText("1 / 2 件")).toBeInTheDocument();
  });
});

describe("ResultsPage: Task 6 選択中の指摘が消えたら選択が外れること", () => {
  it("選択中の指摘の分類を絞り込みで外すと、選択が null に戻る", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({
      id: "finding-1",
      category: "notation",
      locateStatus: "located",
      range: { start: 0, end: 1 },
      paragraphId: 0,
    });
    const finding2 = makeFinding({
      id: "finding-2",
      category: "grammar",
      locateStatus: "located",
      range: { start: 5, end: 6 },
      paragraphId: 1,
    });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([finding1, finding2]));
    // Task 7：選択すると getFinding が呼ばれるようになったので、この Task 6 のテストでも
    // 応答を用意する（このテスト自体は選択の解除だけを見ており、詳細取得は検査対象ではない）。
    const getFinding = vi.fn((findingId: string) =>
      Promise.resolve(makeFindingDetail({ id: findingId })),
    );
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding });

    renderPage(client);

    await waitFor(() => expect(findingsSpans().length).toBe(2));

    // 一覧の行（finding-2 は表示順で 2 番目）をクリックして選択する——選択状態は
    // `results-page.tsx` が一元管理し、`BodyView` と一覧の両方に同じ状態を渡すので、一覧側から
    // 選んでも本文側の強調に選択用 class が付くことを確認する（逆方向は
    // `body-view.test.tsx`（R2-8・R2-9）で検査済み）。
    const rows = document.querySelectorAll(`.${findingListStyles.findingRow}`);
    expect(rows).toHaveLength(2);
    const row2 = rows[1] as HTMLElement;
    await user.click(row2);

    expect(row2.getAttribute("aria-current")).toBe("true");
    const selectedSpan2 = document.querySelector('[data-findings~="finding-2"]') as HTMLElement;
    expect(selectedSpan2.className).toContain("highlightSelected");

    // 選択中の指摘（finding-2、分類 grammar）の分類を絞り込みで外す。
    await user.click(screen.getByRole("checkbox", { name: "文法" }));

    await waitFor(() => expect(findingsSpans().length).toBe(1));
    // finding-2 の強調自体が消える（絞り込みで隠れたため）。
    expect(document.querySelector('[data-findings~="finding-2"]')).toBeNull();

    // 分類を戻しても、選択は null に戻っている（隠れている間だけ見た目上外れたのではなく、
    // 状態そのものが null に戻っている）ので、finding-2 は選択済み表示にならない。
    await user.click(screen.getByRole("checkbox", { name: "文法" }));
    await waitFor(() => expect(findingsSpans().length).toBe(2));
    const span2Again = document.querySelector('[data-findings~="finding-2"]') as HTMLElement;
    expect(span2Again.className).not.toContain("highlightSelected");
  });
});

// レビュー対応（Important 1）：`showSuppressed` / `showWithdrawn` は `CheckboxGroup` を通さない
// 素の <input type="checkbox"> の別実装で、分類の絞り込みテストでは守られない。抑制候補と
// 撤回候補を別々の指摘として fixture に入れ、片方のチェックボックスが「自分の対象の指摘だけ」を
// 出し入れすることを検査する（`showSuppressed` と `showWithdrawn` を取り違えていれば赤くなる）。
describe("ResultsPage: Task 6 抑制候補・撤回候補の表示切替え", () => {
  function makeSuppressedFinding(): FindingDto {
    return makeFinding({
      id: "finding-suppressed",
      category: "notation",
      locateStatus: "located",
      range: { start: 0, end: 1 },
      paragraphId: 0,
      suppression: { word: "こと", ruleVersion: "1" },
    });
  }

  function makeWithdrawnFinding(): FindingDto {
    return makeFinding({
      id: "finding-withdrawn",
      category: "grammar",
      locateStatus: "located",
      range: { start: 5, end: 6 },
      paragraphId: 1,
      recheck: {
        id: "recheck-1",
        status: "done",
        notApplicableReason: null,
        verdict: "withdraw",
        reasonKind: "intentional-expression",
        reason: "意図的な表現",
        suggestionValid: null,
        failure: null,
      },
    });
  }

  it("抑制候補は既定で隠れ、『抑制された指摘も表示する』で出し入れできる（撤回候補は影響を受けない）", async () => {
    const user = userEvent.setup();
    const suppressed = makeSuppressedFinding();
    const withdrawn = makeWithdrawnFinding();
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([suppressed, withdrawn]));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("0 / 2 件")).toBeInTheDocument());
    expect(document.querySelector('[data-findings~="finding-suppressed"]')).toBeNull();
    expect(document.querySelector('[data-findings~="finding-withdrawn"]')).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: "抑制された指摘も表示する" }));

    await waitFor(() =>
      expect(document.querySelector('[data-findings~="finding-suppressed"]')).not.toBeNull(),
    );
    // 撤回候補は「抑制された指摘も表示する」の影響を受けない（取り違えていれば出てしまう）。
    expect(document.querySelector('[data-findings~="finding-withdrawn"]')).toBeNull();
    expect(screen.getByText("1 / 2 件")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "抑制された指摘も表示する" }));

    await waitFor(() =>
      expect(document.querySelector('[data-findings~="finding-suppressed"]')).toBeNull(),
    );
    expect(screen.getByText("0 / 2 件")).toBeInTheDocument();
  });

  it("撤回候補は既定で隠れ、『撤回された指摘も表示する』で出し入れできる（抑制候補は影響を受けない）", async () => {
    const user = userEvent.setup();
    const suppressed = makeSuppressedFinding();
    const withdrawn = makeWithdrawnFinding();
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([suppressed, withdrawn]));
    const client = makeClient({ getRun, getManuscript, getFindings });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("0 / 2 件")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "撤回された指摘も表示する" }));

    await waitFor(() =>
      expect(document.querySelector('[data-findings~="finding-withdrawn"]')).not.toBeNull(),
    );
    // 抑制候補は「撤回された指摘も表示する」の影響を受けない（取り違えていれば出てしまう）。
    expect(document.querySelector('[data-findings~="finding-suppressed"]')).toBeNull();
    expect(screen.getByText("1 / 2 件")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "撤回された指摘も表示する" }));

    await waitFor(() =>
      expect(document.querySelector('[data-findings~="finding-withdrawn"]')).toBeNull(),
    );
    expect(screen.getByText("0 / 2 件")).toBeInTheDocument();
  });
});

// Task 7（指摘詳細、決定 3・9・12）：選択と `getFinding` の配線。表示規則そのものは
// `finding-detail.test.ts`・`finding-detail.test.tsx` で検査済みなので、ここでは配線だけを見る。
describe("ResultsPage: Task 7 指摘詳細の取得配線", () => {
  it("指摘を選択すると getFinding が 1 回呼ばれる", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({ id: "finding-1", quote: "あ" });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([finding1]));
    const getFinding = vi.fn(() => Promise.resolve(makeFindingDetail({ id: "finding-1" })));
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    const row = document.querySelector(`.${findingListStyles.findingRow}`) as HTMLElement;
    await user.click(row);

    await waitFor(() => expect(getFinding).toHaveBeenCalledTimes(1));
    expect(getFinding).toHaveBeenCalledWith("finding-1");
  });

  it("取得前（getFinding が未解決）でも、一覧が持つ情報から引用と理由が出る", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({
      id: "finding-1",
      quote: "あ",
      reasons: [{ candidateId: "candidate-1", perspective: "typo", reason: "誤字の可能性がある" }],
    });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([finding1]));
    const detailDeferred = deferred<FindingDetailDto>();
    const getFinding = vi.fn(() => detailDeferred.promise);
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    const row = document.querySelector(`.${findingListStyles.findingRow}`) as HTMLElement;
    await user.click(row);

    await waitFor(() => expect(getFinding).toHaveBeenCalledTimes(1));
    // getFinding はまだ解決していないが、引用・理由は finding（一覧が持つ情報）から既に出ている。
    // 本文の段落表示にも、詳細パネルの見出し（分類ラベル＋原文、仕様 5.4）にも同じ文字「一」
    // （BODY.slice(0,1)）が出るため、詳細パネルの中の「原文」節（`<h3>` を含む `<section>`）
    // だけを見て一意に絞る。
    const detailPanel = document.querySelector(`.${findingListStyles.detail}`) as HTMLElement;
    expect(detailPanel).not.toBeNull();
    const quoteHeading = within(detailPanel).getByText("原文");
    const quoteSection = quoteHeading.closest("section") as HTMLElement;
    expect(within(quoteSection).getByText(BODY.slice(0, 1))).toBeInTheDocument();
    expect(within(detailPanel).getByText(/誤字の可能性がある/)).toBeInTheDocument();
    // 元候補・位置診断の欄だけが「読み込み中」。
    expect(within(detailPanel).getByText("読み込み中…")).toBeInTheDocument();
  });

  it("他の指摘（同じ範囲）のリンクをクリックすると選択が移り、getFinding がその指摘で呼ばれる", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({ id: "finding-1", range: { start: 0, end: 1 }, quote: "あ" });
    const finding2 = makeFinding({ id: "finding-2", range: { start: 0, end: 1 }, quote: "い" });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([finding1, finding2]));
    const getFinding = vi.fn((findingId: string) =>
      Promise.resolve(makeFindingDetail({ id: findingId })),
    );
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());
    const rows = document.querySelectorAll(`.${findingListStyles.findingRow}`);
    await user.click(rows[0] as HTMLElement);

    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-1"));
    // finding-1 と finding-2 は range が完全一致するので「同じ範囲の他の指摘」に finding-2 が出る。
    // 一覧側の行（finding-2）の見出しにも「い」を含むボタンがあるため、完全一致の名前で
    // 詳細パネル側のリンクだけを狙う（`誤字・表記：い`）。
    const relatedButton = await screen.findByRole("button", { name: "誤字・表記：い" });
    await user.click(relatedButton);

    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-2"));
    // 一覧側の選択表示も finding-2 に移っている。
    const rowsAfter = document.querySelectorAll(`.${findingListStyles.findingRow}`);
    expect((rowsAfter[1] as HTMLElement).getAttribute("aria-current")).toBe("true");
  });
});

// Task 8（採否と判断メモ、決定 13）：`putJudgment` の呼び出しは `results-page.tsx` に閉じ、
// 成功したら該当指摘の `judgment` を差し替える（一覧を取り直さない）。操作子そのものの規則
// （4 状態・null 送信・保存中の無効化・失敗時の巻き戻し・常時表示の注記）は
// judgment-control.test.tsx（R5）の役割。ここでは「状態の持ち主が 1 か所であること」の
// 実質的な確認として、保存に成功すると一覧の行の採否表示も変わることを見る。
describe("ResultsPage: Task 8 採否の保存で一覧の行の表示も更新される", () => {
  it("保存に成功すると、一覧を取り直さずに一覧の行の採否表示が応答の JudgmentDto に差し替わる", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({ id: "finding-1", quote: "あ" });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([finding1]));
    const getFinding = vi.fn(() => Promise.resolve(makeFindingDetail({ id: "finding-1" })));
    const updatedJudgment: JudgmentDto = {
      findingId: "finding-1",
      status: "rejected",
      note: null,
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    const putJudgment = vi.fn(() => Promise.resolve(updatedJudgment));
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding, putJudgment });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    const row = document.querySelector(`.${findingListStyles.findingRow}`) as HTMLElement;
    await user.click(row);
    await waitFor(() => expect(getFinding).toHaveBeenCalledTimes(1));

    // 保存前は一覧の行に「未判断」が出ている。
    expect(within(row).getByText("未判断")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "却下" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(putJudgment).toHaveBeenCalledTimes(1));
    expect(putJudgment).toHaveBeenCalledWith("finding-1", { status: "rejected" });

    // 成功応答の JudgmentDto で一覧の行の採否表示が差し替わる（一覧を取り直さない＝
    // getFindings は初回の 1 回のまま）。
    await waitFor(() => expect(within(row).getByText("却下")).toBeInTheDocument());
    expect(getFindings).toHaveBeenCalledTimes(1);
  });
});

/** `CandidateDto` の最小構成（`makeFindingDetail` の `candidates` に足すための補助）。 */
function makeCandidate(overrides: Partial<CandidateDto> = {}): CandidateDto {
  return {
    id: "candidate-1",
    checkUnitId: "unit-1",
    perspective: "typo",
    candidateIndex: 0,
    llm: {
      paragraphId: 0,
      quote: "候補の引用",
      before: "",
      after: "",
      category: "notation",
      reason: "候補の理由",
      suggestion: null,
      verdict: "likely-error",
    },
    locateStatus: "located",
    range: { start: 0, end: 1 },
    ...overrides,
  };
}

// PR21 レビュー指摘 1：「最新の状態を取得」が、選択中の指摘の詳細と採否フォームを更新しない
// 問題への対応。3 つの経路（getFinding の再取得、未編集フォームの追従、編集中フォームの保護）を
// それぞれ検査する。
describe("ResultsPage: PR21 レビュー指摘 1 更新で選択中の指摘の詳細も取り直す", () => {
  it("同じ指摘が選ばれたままでも、更新後に getFinding が再度呼ばれ、増えた元候補が画面に出る", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({ id: "finding-1", quote: "あ" });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([finding1]));
    const candidate1 = makeCandidate({
      id: "candidate-1",
      llm: {
        paragraphId: 0,
        quote: "候補その1",
        before: "",
        after: "",
        category: "notation",
        reason: "理由その1",
        suggestion: null,
        verdict: "likely-error",
      },
    });
    const candidate2 = makeCandidate({
      id: "candidate-2",
      llm: {
        paragraphId: 0,
        quote: "候補その2",
        before: "",
        after: "",
        category: "notation",
        reason: "理由その2",
        suggestion: null,
        verdict: "likely-error",
      },
    });
    const getFinding = vi
      .fn<() => Promise<FindingDetailDto>>()
      .mockResolvedValueOnce(makeFindingDetail({ id: "finding-1", candidates: [candidate1] }))
      .mockResolvedValueOnce(
        makeFindingDetail({ id: "finding-1", candidates: [candidate1, candidate2] }),
      );
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    const row = document.querySelector(`.${findingListStyles.findingRow}`) as HTMLElement;
    await user.click(row);

    await waitFor(() => expect(getFinding).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("候補その1")).toBeInTheDocument();
    expect(screen.queryByText("候補その2")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "最新の状態を取得" }));

    await waitFor(() => expect(getFinding).toHaveBeenCalledTimes(2));
    expect(getFinding).toHaveBeenLastCalledWith("finding-1");
    expect(await screen.findByText("候補その2")).toBeInTheDocument();
    expect(screen.getByText("候補その1")).toBeInTheDocument();
  });

  it("未編集のフォームは、更新後の新しい採否にラジオが追従する", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({ id: "finding-1", quote: "あ" });
    const finding1Updated = makeFinding({
      id: "finding-1",
      quote: "あ",
      judgment: {
        findingId: "finding-1",
        status: "adopt-planned",
        note: null,
        updatedAt: "2026-09-11T00:00:00.000Z",
      },
    });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi
      .fn<() => Promise<FindingDto[]>>()
      .mockResolvedValueOnce([finding1])
      .mockResolvedValueOnce([finding1Updated]);
    const getFinding = vi.fn(() => Promise.resolve(makeFindingDetail({ id: "finding-1" })));
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    const row = document.querySelector(`.${findingListStyles.findingRow}`) as HTMLElement;
    await user.click(row);
    await waitFor(() => expect(getFinding).toHaveBeenCalledTimes(1));

    expect(screen.getByRole("radio", { name: "未判断" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "最新の状態を取得" }));

    await waitFor(() => expect(screen.getByRole("radio", { name: "採用予定" })).toBeChecked());
    expect(screen.getByRole("radio", { name: "未判断" })).not.toBeChecked();
  });

  it("編集中のフォームは入力を保ったまま、別の場所で更新された旨が表示される", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({ id: "finding-1", quote: "あ" });
    const finding1Updated = makeFinding({
      id: "finding-1",
      quote: "あ",
      judgment: {
        findingId: "finding-1",
        status: "held",
        note: null,
        updatedAt: "2026-09-11T00:00:00.000Z",
      },
    });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi
      .fn<() => Promise<FindingDto[]>>()
      .mockResolvedValueOnce([finding1])
      .mockResolvedValueOnce([finding1Updated]);
    const getFinding = vi.fn(() => Promise.resolve(makeFindingDetail({ id: "finding-1" })));
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    const row = document.querySelector(`.${findingListStyles.findingRow}`) as HTMLElement;
    await user.click(row);
    await waitFor(() => expect(getFinding).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("radio", { name: "却下" }));

    await user.click(screen.getByRole("button", { name: "最新の状態を取得" }));

    await waitFor(() => expect(getFindings).toHaveBeenCalledTimes(2));
    // 編集中の入力（却下）は保たれたまま、勝手に上書きされない。
    expect(screen.getByRole("radio", { name: "却下" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "保留" })).not.toBeChecked();
    expect(screen.getByText(/採否が別の場所で更新されました/)).toBeInTheDocument();
  });
});

// PR21 レビュー指摘 2：採否保存の失敗が、指摘を切り替えるだけで消える問題への対応。
// `JudgmentControl` は指摘ごとに作り直される（`key={finding.id}`）ため、保存を投げた直後に
// 別の指摘へ切り替えると操作子がアンマウントされる。それでも失敗が選択を変えても消えない場所
// （ヘッダー直下）に表示されることを検査する。
describe("ResultsPage: PR21 レビュー指摘 2 保存の失敗は選択を変えても消えない", () => {
  it("保存中に別の指摘へ切り替えたあとで保存が失敗しても、失敗がヘッダー直下に表示される", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({ id: "finding-1", quote: "あ" });
    const finding2 = makeFinding({ id: "finding-2", quote: "い" });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([finding1, finding2]));
    const getFinding = vi.fn((findingId: string) =>
      Promise.resolve(makeFindingDetail({ id: findingId })),
    );
    const putJudgmentDeferred = deferred<JudgmentDto>();
    const putJudgment = vi.fn(() => putJudgmentDeferred.promise);
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding, putJudgment });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());
    const rows = document.querySelectorAll(`.${findingListStyles.findingRow}`);
    await user.click(rows[0] as HTMLElement);
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-1"));

    await user.click(screen.getByRole("radio", { name: "却下" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(putJudgment).toHaveBeenCalledTimes(1));
    expect(putJudgment).toHaveBeenCalledWith("finding-1", { status: "rejected" });

    // 保存の応答を待たずに別の指摘へ切り替える。finding-1 の操作子はアンマウントされる。
    await user.click(rows[1] as HTMLElement);
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-2"));
    expect(document.querySelector(`.${findingListStyles.detail}`)).not.toBeNull();

    putJudgmentDeferred.reject(new Error("保存に失敗しました（テスト用）"));

    // アンマウント済みの操作子ではなく、選択を変えても消えない場所（ヘッダー直下）に出る。
    await waitFor(() => {
      expect(document.querySelector(`.${findingListStyles.judgmentErrorItem}`)).not.toBeNull();
    });
    const errorItem = document.querySelector(
      `.${findingListStyles.judgmentErrorItem}`,
    ) as HTMLElement;
    // どの指摘の保存が失敗したのか（引用の先頭）が識別できる。
    expect(within(errorItem).getByText("あ")).toBeInTheDocument();
    expect(within(errorItem).getByText(/保存に失敗しました（テスト用）/)).toBeInTheDocument();
  });
});

// 最終レビュー Important 2：絞り込み以外の経路（採否の保存）で選択中の指摘が可視集合から外れたとき、
// 詳細パネルと移動ボタンが（対応する要素が無いまま）残ってしまわないこと。
describe("ResultsPage: 最終レビュー Important 2 採否の保存で絞り込みから外れたとき", () => {
  it("詳細が閉じ、移動ボタンが消える", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({
      id: "finding-1",
      quote: "あ",
      judgment: {
        findingId: "finding-1",
        status: "undecided",
        note: null,
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([finding1]));
    const getFinding = vi.fn(() => Promise.resolve(makeFindingDetail({ id: "finding-1" })));
    const updatedJudgment: JudgmentDto = {
      findingId: "finding-1",
      status: "rejected",
      note: null,
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    const putJudgment = vi.fn(() => Promise.resolve(updatedJudgment));
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding, putJudgment });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());

    // 絞り込みを「未判断」だけにする（採否フィルターの「採用予定」「却下」「保留」を外す。
    // ロールで絞る——「却下」はこの後 JudgmentControl のラジオにも同名で出るが、role が
    // "checkbox" と "radio" で異なるため取り違えない）。
    await user.click(screen.getByRole("checkbox", { name: "採用予定" }));
    await user.click(screen.getByRole("checkbox", { name: "却下" }));
    await user.click(screen.getByRole("checkbox", { name: "保留" }));

    // finding-1（undecided）はまだ可視のまま。
    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());

    const row = document.querySelector(`.${findingListStyles.findingRow}`) as HTMLElement;
    await user.click(row);
    await waitFor(() => expect(getFinding).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "本文の該当箇所へ移動" })).toBeInTheDocument();

    // 「却下」で保存する。応答の judgment.status が "rejected" になり、絞り込み
    // （未判断のみ）から外れる。
    await user.click(screen.getByRole("radio", { name: "却下" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(putJudgment).toHaveBeenCalledTimes(1));

    // 可視集合から消え、選択も外れて詳細・移動ボタンが消える（「一覧に行が無く強調も無いのに
    // 詳細だけ残る」を作らない）。可視集合の更新（レンダー N）と選択を外す `useEffect`（レンダー
    // N+1）は別のコミットなので、詳細・移動ボタンの消滅も `waitFor` で待つ
    // （`act` によるカスケードのフラッシュに暗黙に頼らない）。
    await waitFor(() => expect(screen.getByText("0 / 1 件")).toBeInTheDocument());
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "本文の該当箇所へ移動" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(document.querySelector(`.${findingListStyles.detail}`)).toBeNull());
  });
});

// Task 9（指摘から本文への移動、決定 9、申し送り 3）：移動先の決定そのもの（位置確定なら強調、
// 位置未確定なら検査対象範囲を含む段落）は navigate.test.ts の役割。ここでは配線、特に
// 「一覧の行をクリックすると、正しい要素に対して scrollIntoView が呼ばれる」ことと、
// 「本文の強調をクリックして選んだときは移動しない」という違いを固定する。
// jsdom には scrollIntoView が無い（申し送り 3）ため、Element.prototype にテスト用のスタブを
// 代入し、テストの後で元に戻す。
describe("ResultsPage: Task 9 指摘から本文への移動", () => {
  // 2 つのテストで共通のスタブ設定・後始末を beforeEach/afterEach に寄せる（レビュー対応）。
  // `vi.fn()`（型引数なし）の戻り値は `Mock<Constructable | Procedure>` になり
  // `Element.prototype.scrollIntoView` の型に代入できないため、実際のシグネチャを型引数で渡す。
  let scrollIntoView: ReturnType<typeof vi.fn<typeof Element.prototype.scrollIntoView>>;
  let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    if (originalScrollIntoView === undefined) {
      delete (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView;
    } else {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("一覧の行をクリックすると移動し、本文の強調をクリックしたときは移動しない", async () => {
    const user = userEvent.setup();
    const finding1 = makeFinding({ id: "finding-1", range: { start: 0, end: 1 }, quote: "一" });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([finding1]));
    const getFinding = vi.fn(() => Promise.resolve(makeFindingDetail({ id: "finding-1" })));
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    const highlight = document.querySelector('[data-findings~="finding-1"]') as HTMLElement;
    expect(highlight).not.toBeNull();

    // 本文の強調をクリック：選択は変わる（詳細パネルが出る）が、移動はしない
    // （すでに見えている場所なので画面を跳ねさせる必要が無いため）。
    await user.click(highlight);
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-1"));
    expect(scrollIntoView).not.toHaveBeenCalled();

    // 一覧の行をクリック：同じ指摘を選び直すだけでも、正しい要素（強調）に対して移動する。
    const row = document.querySelector(`.${findingListStyles.findingRow}`) as HTMLElement;
    await user.click(row);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // `this`（呼び出された要素）を見るには `mock.contexts` を使う。`mock.instances` は
    // `new` 呼び出しで生成されたインスタンスを記録する API で、通常の呼び出しでも実装上
    // `this` が入ってしまうが、それは `contexts` の役割であり `instances` の意図した用途ではない。
    expect(scrollIntoView.mock.contexts[0]).toBe(highlight);
  });

  it("詳細の『本文の該当箇所へ移動』を押すと移動する（位置未確定なら検査対象範囲の段落へ）", async () => {
    const user = userEvent.setup();
    // 位置未確定の指摘。検査対象（target-1）は三段落目（BODY の 10-14）の内側（10-12）を指す。
    const finding1 = makeFinding({
      id: "finding-1",
      locateStatus: "not-found",
      range: null,
      targetId: "target-1",
      quote: "未確認の引用",
    });
    const runDetail = {
      ...makeRunDetail({ status: "completed" }),
      targets: [
        {
          id: "target-1",
          targetIndex: 0,
          target: { start: 10, end: 12 },
          contextBefore: null,
          contextAfter: null,
          input: { start: 10, end: 12 },
          paragraphIds: [2],
        },
      ],
    };
    const getRun = vi.fn(() => Promise.resolve(runDetail));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([finding1]));
    const getFinding = vi.fn(() => Promise.resolve(makeFindingDetail({ id: "finding-1" })));
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    const row = document.querySelector(`.${findingListStyles.findingRow}`) as HTMLElement;
    await user.click(row);
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-1"));

    // 一覧の行クリックでも移動するので、ここまでの呼び出しは無視し、詳細の操作子を押した
    // 分だけを見る。
    scrollIntoView.mockClear();

    const navigateButton = await screen.findByRole("button", { name: "本文の該当箇所へ移動" });
    await user.click(navigateButton);

    const paragraph = document.querySelector('[data-paragraph-id="2"]') as HTMLElement;
    expect(paragraph).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(paragraph);
  });

  it("該当する検査対象が無ければ移動の操作子を出さない", async () => {
    const finding1 = makeFinding({
      id: "finding-1",
      locateStatus: "not-found",
      range: null,
      targetId: "target-missing", // targets に無い
    });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" }))); // targets: []
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([finding1]));
    const getFinding = vi.fn(() => Promise.resolve(makeFindingDetail({ id: "finding-1" })));
    const client = makeClient({ getRun, getManuscript, getFindings, getFinding });
    const user = userEvent.setup();

    renderPage(client);

    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    const row = document.querySelector(`.${findingListStyles.findingRow}`) as HTMLElement;
    await user.click(row);
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-1"));

    expect(screen.queryByRole("button", { name: "本文の該当箇所へ移動" })).not.toBeInTheDocument();
  });
});

// 実行制御（PR12b Task 5、決定 6・7・8）：停止・再開・失敗単位の再試行の配線。ボタンの出し分け
// そのもの（`controlAvailability`）は `run-control.test.ts`・`run-control.test.tsx` が単体で
// 検査済み。ここでは「操作後に必ず状態を取り直すこと」「202 の応答をそのまま画面の状態へ
// 継ぎ当てないこと」「409 の `code` ごとの案内と `error.message` を画面に出さないこと」
// 「取り直しが終わるまでボタンが disabled のままであること（二重送信の窓を開けない）」を見る。
describe("ResultsPage: 実行制御（決定 6・7・8）", () => {
  it("停止を押すと stopRun を呼び、202 の応答を継ぎ当てず必ず状態を取り直す", async () => {
    const user = userEvent.setup();
    const getRun = vi
      .fn<() => Promise<RunDetailDto>>()
      .mockResolvedValueOnce(makeRunDetail({ status: "running" }))
      .mockResolvedValueOnce(makeRunDetail({ status: "stopped", stopReason: "aborted" }));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const getRunUnits = vi.fn(() => Promise.resolve(makeUnits()));
    // stopRun の 202 応答はわざと "running" のまま返す——画面がこれを直接状態へ継ぎ当てていたら
    // 誤って「実行中」のまま表示されてしまう（`RunDto` であって `RunDetailDto` ではないため、
    // そもそも進捗も持たない）。
    const stopRun = vi.fn(() => Promise.resolve(makeRun({ status: "running" })));
    const client = makeClient({ getRun, getManuscript, getFindings, getRunUnits, stopRun });

    renderPage(client);

    const stopButton = await screen.findByRole("button", { name: "停止" });
    await waitFor(() => expect(stopButton).toBeEnabled());
    await user.click(stopButton);

    await waitFor(() => expect(screen.getByText("状態: 停止中")).toBeInTheDocument());
    expect(stopRun).toHaveBeenCalledTimes(1);
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(getRunUnits).toHaveBeenCalledTimes(2);
    expect(getFindings).toHaveBeenCalledTimes(2);
  });

  it("409 で拒否されても、code ごとの案内が出て必ず状態を取り直す。error.message は出ない", async () => {
    const user = userEvent.setup();
    const getRun = vi.fn(() =>
      Promise.resolve(makeRunDetail({ status: "stopped", stopReason: "connection-lost" })),
    );
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const getRunUnits = vi.fn(() => Promise.resolve(makeUnits()));
    const resumeRun = vi.fn(() =>
      Promise.reject(
        new ApiRequestError(
          409,
          "run-rejected-running",
          "実行中のため受け付けられません: secret-run-id",
        ),
      ),
    );
    const client = makeClient({ getRun, getManuscript, getFindings, getRunUnits, resumeRun });

    renderPage(client);

    const resumeButton = await screen.findByRole("button", { name: "再開" });
    await waitFor(() => expect(resumeButton).toBeEnabled());
    await user.click(resumeButton);

    await waitFor(() =>
      expect(screen.getByText("すでに実行中です。最新の状態を取得しました。")).toBeInTheDocument(),
    );
    expect(resumeRun).toHaveBeenCalledTimes(1);
    // 失敗でも必ず状態を取り直す（決定 8）。
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    expect(getRunUnits).toHaveBeenCalledTimes(2);
    expect(getFindings).toHaveBeenCalledTimes(2);
    // サーバーの `error.message`（実行 ID を含む）は画面に出さない。
    expect(document.body.textContent ?? "").not.toContain("secret-run-id");
  });

  it("操作が終わっても、状態の取り直しが終わるまでボタンは disabled のまま（二重送信の窓を開けない）", async () => {
    const user = userEvent.setup();
    let getRunCalls = 0;
    const refetchDeferred = deferred<RunDetailDto>();
    const getRun = vi.fn(() => {
      getRunCalls += 1;
      if (getRunCalls === 1) {
        return Promise.resolve(makeRunDetail({ status: "stopped", stopReason: "connection-lost" }));
      }
      return refetchDeferred.promise;
    });
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const getRunUnits = vi.fn(() => Promise.resolve(makeUnits()));
    const resumeRun = vi.fn(() => Promise.resolve(makeRun({ status: "running" })));
    const client = makeClient({ getRun, getManuscript, getFindings, getRunUnits, resumeRun });

    renderPage(client);

    const resumeButton = await screen.findByRole("button", { name: "再開" });
    await waitFor(() => expect(resumeButton).toBeEnabled());
    await user.click(resumeButton);

    // resumeRun はすぐ解決するが、取り直し（2 回目の getRun）はまだ終わっていない。
    // ここで `pending` を戻してしまうと、古い（"stopped" のままの）状態に対して再開ボタンが
    // 再び押せてしまい、二重送信の窓が開く。
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    expect(resumeButton).toBeDisabled();

    refetchDeferred.resolve(makeRunDetail({ status: "stopped", stopReason: "connection-lost" }));

    await waitFor(() => expect(resumeButton).toBeEnabled());
  });

  it("『失敗単位を再試行』を押すと retryFailedUnits を本文なし（全件対象）で呼ぶ", async () => {
    const user = userEvent.setup();
    const failedUnits = makeUnits({
      checkUnits: [
        makeCheckUnit({
          status: "failed",
          failure: { reason: "timeout", message: "", finishReason: null, origin: "chat" },
        }),
      ],
    });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "partially-failed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const getRunUnits = vi.fn(() => Promise.resolve(failedUnits));
    const retryFailedUnits = vi.fn(() => Promise.resolve(makeRun({ status: "running" })));
    const client = makeClient({
      getRun,
      getManuscript,
      getFindings,
      getRunUnits,
      retryFailedUnits,
    });

    renderPage(client);

    const retryButton = await screen.findByRole("button", { name: "失敗単位を再試行" });
    await user.click(retryButton);

    await waitFor(() => expect(retryFailedUnits).toHaveBeenCalledTimes(1));
    expect(retryFailedUnits).toHaveBeenCalledWith(RUN_ID);
  });

  // Task 6：失敗単位の一覧（`failed-units.tsx`）からの個別再試行。出し分けそのものは
  // `failed-units.test.tsx` が検査済み。ここでは `results-page.tsx` の配線
  // （`{ unitIds: [id] }` を付けて呼ぶこと、全件用の口を本文なしで呼ばないこと）だけを見る。
  it("失敗単位の一覧の『この単位を再試行』を押すと retryFailedUnits を unitIds 1 件で呼ぶ", async () => {
    const user = userEvent.setup();
    const failedUnits = makeUnits({
      checkUnits: [
        makeCheckUnit({
          id: "check-1",
          status: "failed",
          failure: { reason: "timeout", message: "", finishReason: null, origin: "chat" },
        }),
      ],
    });
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "partially-failed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const getRunUnits = vi.fn(() => Promise.resolve(failedUnits));
    const retryFailedUnits = vi.fn(() => Promise.resolve(makeRun({ status: "running" })));
    const client = makeClient({
      getRun,
      getManuscript,
      getFindings,
      getRunUnits,
      retryFailedUnits,
    });

    renderPage(client);

    const retryButton = await screen.findByRole("button", { name: "この単位を再試行" });
    await user.click(retryButton);

    await waitFor(() => expect(retryFailedUnits).toHaveBeenCalledTimes(1));
    expect(retryFailedUnits).toHaveBeenCalledWith(RUN_ID, { unitIds: ["check-1"] });
    // 空振り防止：全件用（本文なし）の呼び出しと混同していないこと。
    expect(retryFailedUnits).not.toHaveBeenCalledWith(RUN_ID);
  });
});

describe("ResultsPage: 実行制御（決定 6・7・8）別の実行への遷移", () => {
  const OTHER_RUN_ID = "run-2";

  /** `RUN_ID` から `OTHER_RUN_ID` へ直リンク遷移するボタンを持つ、`ResultsPage` を包む木。 */
  function NavigationProbe() {
    const navigate = useNavigate();
    return (
      <button type="button" onClick={() => navigate(runPath(OTHER_RUN_ID))}>
        検査用ナビゲーション：別の実行へ
      </button>
    );
  }

  function renderPageWithNavigation(client: ApiClient) {
    return render(
      <MemoryRouter initialEntries={[runPath(RUN_ID)]}>
        <ApiClientProvider client={client}>
          <NavigationProbe />
          <Routes>
            <Route path={ROUTES.run} element={<ResultsPage />} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>,
    );
  }

  it("『確認だけ記録する』ボタンを押すと confirmRecovery を呼ぶ（resumeRun は呼ばない。Task 7）", async () => {
    const user = userEvent.setup();
    const getRun = vi.fn(() =>
      Promise.resolve(makeRunDetail({ status: "recovery-waiting", recoveryConfirmedAt: null })),
    );
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const getRunUnits = vi.fn(() => Promise.resolve(makeUnits()));
    const confirmRecovery = vi.fn(() => Promise.resolve({ blocked: false, runIds: [] }));
    const resumeRun = vi.fn(() => Promise.resolve(makeRun({ status: "running" })));
    const client = makeClient({
      getRun,
      getManuscript,
      getFindings,
      getRunUnits,
      confirmRecovery,
      resumeRun,
    });

    renderPage(client);

    const confirmButton = await screen.findByRole("button", {
      name: "確認だけ記録する（この検査は再開しない）",
    });
    await user.click(confirmButton);

    await waitFor(() => expect(confirmRecovery).toHaveBeenCalledTimes(1));
    expect(confirmRecovery).toHaveBeenCalledWith(RUN_ID);
    expect(resumeRun).not.toHaveBeenCalled();
    // 操作後は必ず状態を取り直す（決定 8）。
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
  });

  it("別の実行へ直リンクで移ると、前の実行の実行制御の失敗案内は残らない", async () => {
    const user = userEvent.setup();
    const getRun = vi.fn((id: string) =>
      Promise.resolve(
        id === RUN_ID
          ? makeRunDetail({ status: "stopped", stopReason: "connection-lost" })
          : makeRunDetail({ id: OTHER_RUN_ID, status: "running" }),
      ),
    );
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const getRunUnits = vi.fn(() => Promise.resolve(makeUnits()));
    const resumeRun = vi.fn(() =>
      Promise.reject(
        new ApiRequestError(409, "run-rejected-running", "実行中のため受け付けられません"),
      ),
    );
    const client = makeClient({ getRun, getManuscript, getFindings, getRunUnits, resumeRun });

    renderPageWithNavigation(client);

    const resumeButton = await screen.findByRole("button", { name: "再開" });
    await user.click(resumeButton);
    await waitFor(() =>
      expect(screen.getByText("すでに実行中です。最新の状態を取得しました。")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "検査用ナビゲーション：別の実行へ" }));

    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());
    expect(
      screen.queryByText("すでに実行中です。最新の状態を取得しました。"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Task 8：自動更新の結線（決定 1・2・3・4。B5・B6・B7・B13・B14・B15・B16）
//
// どの検査がどの壊れ方を判別するかを、各 `it` の直前に日本語で書く。静かに壊れる部分
// （無限再接続・イベントの取りこぼし・更新が永久に止まる）は、素朴な実装でも緑になって
// しまわないよう、必ず「壊したら赤くなる」形にしてある。
// ---------------------------------------------------------------------------

/** 決定 4 の 3 行。同時に 2 つ出さない（上から優先）。 */
const STREAM_ENDED_NOTICE = "自動更新は停止しています。「最新の状態を取得」を押してください。";
const DISCONNECTED_NOTICE = "サーバーとの接続が切れました。再接続を試みています。";
const AUTO_REFRESH_ERROR_NOTICE =
  "最新情報の取得に失敗しました。「最新の状態を取得」を押してください。";

/** 今どの案内が出ているか。決定 4 の「行は同時に 2 つ出ない」を数で見る。 */
function autoUpdateNotices(): string[] {
  return [STREAM_ENDED_NOTICE, DISCONNECTED_NOTICE, AUTO_REFRESH_ERROR_NOTICE].filter(
    (text) => screen.queryByText(text) !== null,
  );
}

const CHECK_STARTED: RunEventDto = { type: "check-started", targetIndex: 0, perspective: "typo" };
const CHECK_FINISHED: RunEventDto = {
  type: "check-finished",
  targetIndex: 0,
  perspective: "typo",
  status: "done",
};
const RUN_SETTLED: RunEventDto = { type: "run-settled", status: "completed", stopReason: null };

/**
 * `getRun` を 1 回ごとに保留できる形にする。1 回目（初回読み込み）だけ即座に解決し、
 * 2 回目以降は `resolveRun(n, ...)` で明示的に解決する——取り直しの「最中」を作るため。
 */
function deferredGetRun(first: RunDetailDto) {
  const queue: Deferred<RunDetailDto>[] = [];
  const getRun = vi.fn(() => {
    const entry = deferred<RunDetailDto>();
    queue.push(entry);
    if (queue.length === 1) entry.resolve(first);
    return entry.promise;
  });
  /** n 回目（1 始まり）の `getRun` を解決する。 */
  const resolveRun = async (n: number, detail: RunDetailDto) => {
    const entry = queue[n - 1];
    if (entry === undefined) throw new Error(`${n} 回目の getRun はまだ呼ばれていない`);
    await act(async () => {
      entry.resolve(detail);
    });
  };
  const rejectRun = async (n: number, cause: unknown) => {
    const entry = queue[n - 1];
    if (entry === undefined) throw new Error(`${n} 回目の getRun はまだ呼ばれていない`);
    await act(async () => {
      entry.reject(cause);
    });
  };
  return { getRun, resolveRun, rejectRun };
}

describe("ResultsPage: Task 8 購読を張る条件（決定 1。B13）", () => {
  // 終端状態の実行で購読を張ると、サーバーが合成 `run-settled` を返して接続を閉じ、
  // `EventSource` が自動再接続する——「接続 → run-settled → 切断 → 再接続」の無限ループ。
  // ここを壊す（`status` を見ずに常に購読する）と赤になる。
  it("終端状態の実行では 1 本も購読しない", async () => {
    const stream = fakeStream();
    const client = makeClient({
      getRun: () => Promise.resolve(makeRunDetail({ status: "completed" })),
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);

    await waitFor(() => expect(screen.getByText("指摘はありません")).toBeInTheDocument());
    expect(stream.subscribeRunEvents).not.toHaveBeenCalled();
  });

  it("実行中なら 1 本だけ購読し、実行 ID を渡す", async () => {
    const stream = fakeStream();
    const client = makeClient({
      getRun: () => Promise.resolve(makeRunDetail({ status: "running" })),
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);

    await waitFor(() => expect(stream.subscribeRunEvents).toHaveBeenCalledTimes(1));
    expect(stream.subscribeRunEvents).toHaveBeenCalledWith(RUN_ID, expect.anything());
    expect(stream.live().length).toBe(1);
  });
});

describe("ResultsPage: Task 8 取り直しの合流（決定 3。B5）", () => {
  // 「追い 1 本だけ」の実装を赤にする検査。追い取得の最中に届いたイベントを黙って捨てる
  // 実装では `getRun` が 3 回で止まり、この検査が落ちる。
  it("最中の合図は 1 本に畳まれ、その追い取得の最中の合図でもう 1 本走る", async () => {
    const stream = fakeStream();
    const { getRun, resolveRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings,
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());
    expect(getRun).toHaveBeenCalledTimes(1);
    expect(getFindings).toHaveBeenCalledTimes(1);

    // 開通 → 1 本目（重い）。まだ終わらせない。
    const handlers = stream.handlers();
    act(() => handlers.onOpen());
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));

    // 1 本目の最中に 2 件。強い方（ここでは軽い同士）に畳まれて 1 本になるはず。
    act(() => handlers.onEvent(CHECK_STARTED));
    act(() => handlers.onEvent(CHECK_STARTED));
    expect(getRun).toHaveBeenCalledTimes(2);

    await resolveRun(2, makeRunDetail({ status: "running" }));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(3));

    // 2 本目（追い取得）の最中にもう 1 件。ここを捨てる実装だと 3 本目が走らない。
    act(() => handlers.onEvent(CHECK_STARTED));
    await resolveRun(3, makeRunDetail({ status: "running" }));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(4));

    await resolveRun(4, makeRunDetail({ status: "running" }));
    // 門が空になったので 5 本目は走らない（合図が無いのに回り続ける実装なら赤くなる）。
    expect(getRun).toHaveBeenCalledTimes(4);
    // 畳んだぶんは軽い取り直しなので、指摘の取得は初回と開通時の 2 回だけ。
    expect(getFindings).toHaveBeenCalledTimes(2);
  });

  // 畳むときに「後勝ち」「先勝ち」にした実装を赤にする（軽い合図で重い合図を潰さない）。
  it("畳むときは強い方が残る（軽い + 重い → 重い）", async () => {
    const stream = fakeStream();
    const { getRun, resolveRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings,
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());

    const handlers = stream.handlers();
    act(() => handlers.onOpen());
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));

    // 重い → 軽いの順に届く。後勝ちだと軽いに落ちてしまう。
    act(() => handlers.onEvent(CHECK_FINISHED));
    act(() => handlers.onEvent(CHECK_STARTED));

    await resolveRun(2, makeRunDetail({ status: "running" }));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(3));
    await resolveRun(3, makeRunDetail({ status: "running" }));

    // 初回 + 開通 + 畳んだ 1 本（重い）＝ 3 回。
    await waitFor(() => expect(getFindings).toHaveBeenCalledTimes(3));
  });

  // 手動の取り直しを門の外に置くと、3N+1 の `getFindings` が 2 本同時に走るか、
  // 「更新中…」と出たまま何も走っていない状態になる。
  it("手動の取り直しも同じ門を通り、追い取得が終わるまで「更新中…」が続く", async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const { getRun, resolveRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());

    const handlers = stream.handlers();
    act(() => handlers.onOpen());
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "最新の状態を取得" }));
    // 門に積まれただけで、2 本目は走っていない。
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "更新中…" })).toBeDisabled();

    await resolveRun(2, makeRunDetail({ status: "running" }));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(3));
    // 追い取得の最中はまだ「更新中…」のまま。
    expect(screen.getByRole("button", { name: "更新中…" })).toBeDisabled();

    await resolveRun(3, makeRunDetail({ status: "running" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "最新の状態を取得" })).toBeEnabled(),
    );
  });
});

describe("ResultsPage: Task 8 合図の割り付け（決定 2。B6）", () => {
  // 何でも重い取り直しにする実装（3N+1 の `getFindings` を毎イベント叩く）を赤にする。
  it("軽い合図では getFindings を呼ばず、重い合図では呼ぶ", async () => {
    const stream = fakeStream();
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "running" })));
    const getFindings = vi.fn(() => Promise.resolve([]));
    const getRunUnits = vi.fn(() => Promise.resolve(makeUnits()));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings,
      getRunUnits,
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());
    expect(getFindings).toHaveBeenCalledTimes(1);

    const handlers = stream.handlers();
    await act(async () => {
      handlers.onEvent(CHECK_STARTED);
    });
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    expect(getRunUnits).toHaveBeenCalledTimes(2);
    expect(getFindings).toHaveBeenCalledTimes(1);

    await act(async () => {
      handlers.onEvent(CHECK_FINISHED);
    });
    await waitFor(() => expect(getFindings).toHaveBeenCalledTimes(2));
    expect(getRun).toHaveBeenCalledTimes(3);
  });

  // 決定 10：遅延通知は取り直さない。取り直す実装だと `getRun` が増えて赤になる。
  it("generation-slow は取り直さず、遅延の件数だけを出す", async () => {
    const stream = fakeStream();
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "running" })));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      getRunUnits: () =>
        Promise.resolve(makeUnits({ checkUnits: [makeCheckUnit({ status: "running" })] })),
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());

    const handlers = stream.handlers();
    await act(async () => {
      handlers.onEvent({ type: "generation-slow", unitId: "check-1", elapsedMs: 120_000 });
    });

    await waitFor(() => expect(screen.getByText(/生成が遅延しています/)).toBeInTheDocument());
    expect(getRun).toHaveBeenCalledTimes(1);
  });
});

describe("ResultsPage: Task 8 自動更新は静かに（決定 4。B7）", () => {
  // `refreshing` を自動更新でも立てる実装を赤にする（ボタンが点滅し続ける回帰）。
  it("自動の取り直しの最中でもボタンは「最新の状態を取得」のまま押せる", async () => {
    const stream = fakeStream();
    const { getRun, resolveRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());

    act(() => stream.handlers().onOpen());
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));

    expect(screen.getByRole("button", { name: "最新の状態を取得" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "更新中…" })).not.toBeInTheDocument();

    await resolveRun(2, makeRunDetail({ status: "running" }));
    expect(autoUpdateNotices()).toEqual([]);
  });

  // 自動の失敗で内容を消す／手動用のエラー帯を出す実装を赤にする。
  it("自動の取り直しが失敗しても内容は残り、1 行の案内だけが出る", async () => {
    const stream = fakeStream();
    const { getRun, rejectRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([makeFinding()]),
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    const expectedParagraphs = splitParagraphs(BODY).length;

    act(() => stream.handlers().onOpen());
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    await rejectRun(2, new Error("自動更新の失敗（テスト用）"));

    await waitFor(() => expect(autoUpdateNotices()).toEqual([AUTO_REFRESH_ERROR_NOTICE]));
    // 内容は消えない。サーバー由来の文言も画面に出さない（静かに 1 行だけ）。
    expect(paragraphElements().length).toBe(expectedParagraphs);
    expect(screen.getByText("1 / 1 件")).toBeInTheDocument();
    expect(screen.queryByText("自動更新の失敗（テスト用）")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "最新の状態を取得" })).toBeEnabled();
  });

  it("自動の取り直しが成功したら案内は消える", async () => {
    const stream = fakeStream();
    const { getRun, resolveRun, rejectRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());

    const handlers = stream.handlers();
    act(() => handlers.onOpen());
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    await rejectRun(2, new Error("自動更新の失敗（テスト用）"));
    await waitFor(() => expect(autoUpdateNotices()).toEqual([AUTO_REFRESH_ERROR_NOTICE]));

    act(() => handlers.onEvent(CHECK_STARTED));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(3));
    await resolveRun(3, makeRunDetail({ status: "running" }));

    await waitFor(() => expect(autoUpdateNotices()).toEqual([]));
  });
});

describe("ResultsPage: Task 8 反映は 2 段（決定 3。B15）", () => {
  // 「1 本でも失敗したら全部捨てる」実装を赤にする。停止・再開の直後に最も知りたい
  // 「操作が効いたかどうか」が、3N+1 の `getFindings` の失敗に道連れにされる回帰。
  it("getFindings が失敗しても、状態・進捗・ボタンは新しい値に追従し一覧は消えない", async () => {
    const stream = fakeStream();
    const { getRun, resolveRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const getFindings = vi
      .fn<() => Promise<FindingDto[]>>()
      .mockResolvedValueOnce([makeFinding()])
      .mockRejectedValueOnce(new Error("指摘の再取得に失敗しました"));
    const failedUnits = makeUnits({
      checkUnits: [
        makeCheckUnit({
          status: "failed",
          failure: { reason: "timeout", message: "", finishReason: null, origin: "chat" },
        }),
      ],
    });
    const getRunUnits = vi
      .fn<() => Promise<RunUnitsDto>>()
      .mockResolvedValueOnce(makeUnits())
      .mockResolvedValue(failedUnits);
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings,
      getRunUnits,
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "失敗単位を再試行" })).not.toBeInTheDocument();

    act(() => stream.handlers().onOpen());
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    await resolveRun(2, makeRunDetail({ status: "partially-failed" }));

    // 1 段目（getRun + getRunUnits）は反映される：状態も、単位に依存するボタンも。
    await waitFor(() => expect(screen.getByText("状態: 一部失敗")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "失敗単位を再試行" })).toBeInTheDocument();
    // 2 段目の失敗で 1 段目を巻き戻さない。既に出ている一覧も消さない。
    expect(screen.getByText("1 / 1 件")).toBeInTheDocument();
    await waitFor(() => expect(autoUpdateNotices()).toEqual([AUTO_REFRESH_ERROR_NOTICE]));
  });
});

describe("ResultsPage: Task 8 run-settled の後（決定 1 の規則 3・4。B14）", () => {
  // 自動更新が永久に止まる壊れ方を判別する検査。`run-settled` で購読を閉じた後の取り直しが
  // 失敗すると `run.status` は running のまま・依存も変わらないので、規則 3・4 が無いと
  // `useEffect` は二度と走らず、しかも画面は「再接続を試みています」と嘘をつく。
  it("取り直しが失敗したら購読は張り直されず、自動更新の停止が案内される", async () => {
    const stream = fakeStream();
    const { getRun, rejectRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(stream.subscribeRunEvents).toHaveBeenCalledTimes(1));

    act(() => stream.handlers().onEvent(RUN_SETTLED));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    await rejectRun(2, new Error("決着後の取り直しの失敗（テスト用）"));

    // 張り直さない（張り直すと「購読 → 合成 run-settled → 張り直し」のループが復活する）。
    expect(stream.subscribeRunEvents).toHaveBeenCalledTimes(1);
    expect(stream.live().length).toBe(0);
    // 「再接続を試みています」ではなく、手動の復旧を促す 1 行だけ。
    await waitFor(() => expect(autoUpdateNotices()).toEqual([STREAM_ENDED_NOTICE]));
  });

  // 規則 4 を「重い取得まで成功したら」にした実装を赤にする。指摘が多い実行ほど
  // `getFindings` は失敗しやすく、そこに引きずられると自動更新が戻らない。
  it("その後の取り直しで軽い取得が成功すれば、getFindings が失敗しても張り直す", async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const { getRun, resolveRun, rejectRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const getFindings = vi
      .fn<() => Promise<FindingDto[]>>()
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("指摘の再取得に失敗しました"));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings,
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(stream.subscribeRunEvents).toHaveBeenCalledTimes(1));

    act(() => stream.handlers().onEvent(RUN_SETTLED));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    await rejectRun(2, new Error("決着後の取り直しの失敗（テスト用）"));
    await waitFor(() => expect(autoUpdateNotices()).toEqual([STREAM_ENDED_NOTICE]));

    await user.click(screen.getByRole("button", { name: "最新の状態を取得" }));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(3));
    // 軽い取得は成功、重い取得（getFindings）は失敗する。
    await resolveRun(3, makeRunDetail({ status: "running" }));

    await waitFor(() => expect(stream.subscribeRunEvents).toHaveBeenCalledTimes(2));
    expect(stream.live().length).toBe(1);
    // 手動の失敗はこれまでどおりエラー帯に出す。自動の 3 行は出さない。
    await waitFor(() => expect(screen.getByText("指摘の再取得に失敗しました")).toBeInTheDocument());
    expect(autoUpdateNotices()).toEqual([]);
  });

  // 規則 4 の成功側。取り直しが成功して `status` が終端なら `streamEnded` は立てたままにする
  // （下ろすと、サーバーが合成 `run-settled` を返す実行にもう一度つなぎに行くループに戻る）。
  it("取り直しが成功して終端状態なら、購読は張り直されず案内も出ない", async () => {
    const stream = fakeStream();
    const { getRun, resolveRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(stream.subscribeRunEvents).toHaveBeenCalledTimes(1));

    act(() => stream.handlers().onEvent(RUN_SETTLED));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    await resolveRun(2, makeRunDetail({ status: "completed" }));

    await waitFor(() => expect(screen.getByText("状態: 完了")).toBeInTheDocument());
    expect(stream.subscribeRunEvents).toHaveBeenCalledTimes(1);
    expect(stream.live().length).toBe(0);
    // 決着して取り直しも成功しているので、自動更新について言うことは何も無い。
    expect(autoUpdateNotices()).toEqual([]);
  });
});

// レビュー I-1：2 段反映は「状態だけ先に進む」窓を開ける。指摘 0 件の実行が `completed` に
// 変わった瞬間、まだ `getFindings` が返っていないのに「指摘はありません」と描いてしまう
// （`getFindings` は 3N+1 で中央値 110〜130 ms あり、目に見える）。失敗したときはそれが
// 残り続ける。「取得の失敗を空として見せない」という規律に反するので、一覧が実行の状態に
// 追いついているかを持ち、追いついていない間は 0 件の断定をしない。
describe("ResultsPage: Task 8 指摘 0 件の断定は一覧が追いついてから（レビュー I-1）", () => {
  /** `getFindings` を 1 回ごとに保留できる形にする（1 回目＝初回読み込みだけ即座に解決）。 */
  function deferredGetFindings(first: readonly FindingDto[]) {
    const queue: Deferred<FindingDto[]>[] = [];
    const getFindings = vi.fn(() => {
      const entry = deferred<FindingDto[]>();
      queue.push(entry);
      if (queue.length === 1) entry.resolve([...first]);
      return entry.promise;
    });
    const settle = async (n: number, apply: (entry: Deferred<FindingDto[]>) => void) => {
      const entry = queue[n - 1];
      if (entry === undefined) throw new Error(`${n} 回目の getFindings はまだ呼ばれていない`);
      await act(async () => {
        apply(entry);
      });
    };
    return {
      getFindings,
      resolveFindings: (n: number, findings: FindingDto[]) =>
        settle(n, (entry) => entry.resolve(findings)),
      rejectFindings: (n: number, cause: unknown) => settle(n, (entry) => entry.reject(cause)),
    };
  }

  it("重い取り直しの getFindings が保留のうちは「指摘はありません」を出さない", async () => {
    const stream = fakeStream();
    const { getRun, resolveRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const { getFindings, resolveFindings } = deferredGetFindings([]);
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings,
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());

    act(() => stream.handlers().onEvent(RUN_SETTLED));
    await waitFor(() => expect(getFindings).toHaveBeenCalledTimes(2));
    // 1 段目だけが先に届く：状態は completed になるが、一覧はまだ追いついていない。
    await resolveRun(2, makeRunDetail({ status: "completed" }));

    await waitFor(() => expect(screen.getByText("状態: 完了")).toBeInTheDocument());
    expect(screen.queryByText("指摘はありません")).not.toBeInTheDocument();
    expect(screen.getByText("指摘を読み込んでいます…")).toBeInTheDocument();

    await resolveFindings(2, []);
    await waitFor(() => expect(screen.getByText("指摘はありません")).toBeInTheDocument());
  });

  it("重い取り直しの getFindings が失敗したら「指摘はありません」ではなく失敗を出す", async () => {
    const stream = fakeStream();
    const { getRun, resolveRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const { getFindings, rejectFindings } = deferredGetFindings([]);
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings,
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());

    act(() => stream.handlers().onEvent(RUN_SETTLED));
    await waitFor(() => expect(getFindings).toHaveBeenCalledTimes(2));
    await resolveRun(2, makeRunDetail({ status: "completed" }));
    await rejectFindings(2, new Error("指摘の再取得に失敗しました"));

    await waitFor(() => expect(screen.getByText("指摘の取得に失敗しました")).toBeInTheDocument());
    expect(screen.queryByText("指摘はありません")).not.toBeInTheDocument();
  });
});

describe("ResultsPage: Task 8 接続断の案内（決定 4。B16）", () => {
  // `onError` で取り直しを走らせる実装、切断の行を取り直しの成功で消す実装、
  // 2 行同時に出す実装のいずれも赤になる。
  it("onError で切断の行が出て、onOpen の時点で消える（取り直しの完了を待たない）", async () => {
    const stream = fakeStream();
    const { getRun, resolveRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());

    const handlers = stream.handlers();
    act(() => handlers.onError());
    await waitFor(() => expect(autoUpdateNotices()).toEqual([DISCONNECTED_NOTICE]));
    // 切れている間に取り直しても意味が無いので、取り直しは走らない。
    expect(getRun).toHaveBeenCalledTimes(1);

    act(() => handlers.onOpen());
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    // 取り直しはまだ終わっていないが、行はもう消えている。
    expect(autoUpdateNotices()).toEqual([]);

    await resolveRun(2, makeRunDetail({ status: "running" }));
    expect(autoUpdateNotices()).toEqual([]);
  });

  // 「自動更新は停止しています」と「接続が切れました」が同時に出る実装を赤にする。
  it("決着の後に接続断が来ても、出る行は自動更新の停止だけ", async () => {
    const stream = fakeStream();
    const { getRun, rejectRun } = deferredGetRun(makeRunDetail({ status: "running" }));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());

    const handlers = stream.handlers();
    act(() => handlers.onError());
    await waitFor(() => expect(autoUpdateNotices()).toEqual([DISCONNECTED_NOTICE]));

    act(() => handlers.onEvent(RUN_SETTLED));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    await rejectRun(2, new Error("決着後の取り直しの失敗（テスト用）"));

    await waitFor(() => expect(autoUpdateNotices()).toEqual([STREAM_ENDED_NOTICE]));
  });
});

// レビュー M-1：`fetchDetail` が毎回 `setFindingDetail(null)` すると、実行中に
// `check-finished` / `target-merged` が届くたびに元候補・位置診断の欄が点滅する。
// 手動更新だけだった頃は目立たなかったが、自動更新では高頻度で起きる。
describe("ResultsPage: Task 8 取り直しで詳細を点滅させない（レビュー M-1）", () => {
  const CANDIDATE_MARK = "候補の理由（1 回目）";

  /** 本文の強調（`data-findings`）をクリックして選ぶ。引用は一覧にも出るので要素で特定する。 */
  function clickHighlight(findingId: string) {
    const element = document.querySelector(`[data-findings="${findingId}"]`);
    if (element === null) throw new Error(`${findingId} の強調が本文に無い`);
    return element as HTMLElement;
  }

  function setup() {
    const stream = fakeStream();
    const finding1 = makeFinding({ id: "finding-1", quote: "あ" });
    const finding2 = makeFinding({
      id: "finding-2",
      quote: "二",
      range: { start: 5, end: 6 },
      paragraphId: 1,
      judgment: {
        findingId: "finding-2",
        status: "undecided",
        note: null,
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    });
    const detailQueue: Deferred<FindingDetailDto>[] = [];
    const getFinding = vi.fn((findingId: string) => {
      const entry = deferred<FindingDetailDto>();
      detailQueue.push(entry);
      if (detailQueue.length === 1) {
        entry.resolve(
          makeFindingDetail({
            ...finding1,
            candidates: [
              makeCandidate({ llm: { ...makeCandidate().llm, reason: CANDIDATE_MARK } }),
            ],
          }),
        );
      }
      void findingId;
      return entry.promise;
    });
    const client = makeClient({
      getRun: () => Promise.resolve(makeRunDetail({ status: "running" })),
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([finding1, finding2]),
      getFinding,
      subscribeRunEvents: stream.subscribeRunEvents,
    });
    return { stream, client, getFinding, detailQueue };
  }

  it("重い取り直しでは、詳細が届くまで前の値を出し続ける", async () => {
    const user = userEvent.setup();
    const { stream, client, getFinding } = setup();

    renderPage(client);
    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());

    await user.click(clickHighlight("finding-1"));
    await waitFor(() => expect(screen.getByText(CANDIDATE_MARK)).toBeInTheDocument());
    expect(getFinding).toHaveBeenCalledTimes(1);

    // 重い合図 → 取り直し。詳細の 2 回目はまだ返さない。
    await act(async () => {
      stream.handlers().onEvent(CHECK_FINISHED);
    });
    await waitFor(() => expect(getFinding).toHaveBeenCalledTimes(2));

    // 前の値が出たまま（「読み込み中…」に戻らない）。
    expect(screen.getByText(CANDIDATE_MARK)).toBeInTheDocument();
    expect(screen.queryByText("読み込み中…")).not.toBeInTheDocument();
  });

  it("選択を変えたときは前の指摘の詳細を出さない（読み込み中に戻す）", async () => {
    const user = userEvent.setup();
    const { client, getFinding } = setup();

    renderPage(client);
    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());

    await user.click(clickHighlight("finding-1"));
    await waitFor(() => expect(screen.getByText(CANDIDATE_MARK)).toBeInTheDocument());

    await user.click(clickHighlight("finding-2"));
    await waitFor(() => expect(getFinding).toHaveBeenCalledTimes(2));

    expect(screen.queryByText(CANDIDATE_MARK)).not.toBeInTheDocument();
    expect(screen.getByText("読み込み中…")).toBeInTheDocument();
  });
});

describe("ResultsPage: Task 8 取り直しの鎖を実行 ID で守る（前タスクの申し送り 1）", () => {
  const OTHER_RUN_ID = "run-2";

  function NavigationProbe() {
    const navigate = useNavigate();
    return (
      <button type="button" onClick={() => navigate(runPath(OTHER_RUN_ID))}>
        検査用ナビゲーション：別の実行へ
      </button>
    );
  }

  function renderPageWithNavigation(client: ApiClient) {
    return render(
      <MemoryRouter initialEntries={[runPath(RUN_ID)]}>
        <ApiClientProvider client={client}>
          <NavigationProbe />
          <Routes>
            <Route path={ROUTES.run} element={<ResultsPage />} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>,
    );
  }

  // 鎖を実行 ID（世代）で守らないと、(a) 旧実行の取り直しの応答が新しい実行の画面を上書きし、
  // (b) 合流の追い取得が旧実行の鎖から走って世代番号を進め、**まだ終わっていない新実行の
  // 初回読み込みの応答が捨てられて「読み込み中…」から戻らなくなる**。両方をこの 1 本で判別する。
  // (b) を判別するには、新実行の初回読み込みが保留のうちに旧い鎖を終わらせる必要がある
  // （新実行が読み終わった後だと、余分な追い取得が走っても画面は壊れない）。
  it("別の実行の読み込み中に旧実行の鎖が終わっても、追い取得が割り込まない", async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const oldRun = deferredGetRun(makeRunDetail({ status: "running" }));
    const newRunQueue: Deferred<RunDetailDto>[] = [];
    const getRun = vi.fn((id: string) => {
      if (id === RUN_ID) return oldRun.getRun();
      const entry = deferred<RunDetailDto>();
      newRunQueue.push(entry);
      return entry.promise;
    });
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPageWithNavigation(client);
    await waitFor(() => expect(screen.getByText("モデル: model-a")).toBeInTheDocument());

    const handlers = stream.handlers();
    act(() => handlers.onOpen());
    await waitFor(() => expect(oldRun.getRun).toHaveBeenCalledTimes(2));
    // 合流の門に 1 件積んでおく（旧い鎖から追い取得が走るかどうかを見るため）。
    act(() => handlers.onEvent(CHECK_STARTED));

    // 新しい実行へ移る。初回読み込みはまだ返さない。
    await user.click(screen.getByRole("button", { name: "検査用ナビゲーション：別の実行へ" }));
    await waitFor(() => expect(newRunQueue.length).toBe(1));
    expect(screen.getByText("読み込み中…")).toBeInTheDocument();

    // 旧実行の取り直しが今ごろ返ってくる。終端状態を返すので、上書きされれば一目で分かる。
    await oldRun.resolveRun(2, makeRunDetail({ status: "stopped", stopReason: "aborted" }));
    // 旧い鎖からの追い取得が走っていないこと（走ると世代番号が進み、下の応答が捨てられる）。
    expect(getRun).toHaveBeenCalledTimes(3);

    const pendingNewRun = newRunQueue[0];
    if (pendingNewRun === undefined) throw new Error("新しい実行の getRun がまだ呼ばれていない");
    await act(async () => {
      pendingNewRun.resolve(
        makeRunDetail({ id: OTHER_RUN_ID, status: "running", modelId: "model-b" }),
      );
    });

    await waitFor(() => expect(screen.getByText("モデル: model-b")).toBeInTheDocument());
    expect(screen.getByText("状態: 実行中")).toBeInTheDocument();
    expect(screen.queryByText("状態: 停止中")).not.toBeInTheDocument();
    expect(screen.queryByText("読み込み中…")).not.toBeInTheDocument();
  });

  // (b) の片割れ：操作の送信中に別の実行へ移ると、旧い鎖の完了を待つあいだ新しい実行の
  // ボタンが disabled のままになる（`pending` が実行 ID に紐づいていない）。
  it("操作の送信中に別の実行へ移っても、新しい実行のボタンは押せる", async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const oldRun = deferredGetRun(makeRunDetail({ status: "running" }));
    const getRun = vi.fn((id: string) => {
      if (id === RUN_ID) return oldRun.getRun();
      return Promise.resolve(
        makeRunDetail({ id: OTHER_RUN_ID, status: "running", modelId: "model-b" }),
      );
    });
    const stopRun = vi.fn(() => Promise.resolve(makeRun({ status: "running" })));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      stopRun,
      subscribeRunEvents: stream.subscribeRunEvents,
    });

    renderPageWithNavigation(client);
    await waitFor(() => expect(screen.getByText("モデル: model-a")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "停止" }));
    // 操作後の取り直し（旧実行の 2 回目の getRun）は保留のまま。
    await waitFor(() => expect(oldRun.getRun).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "検査用ナビゲーション：別の実行へ" }));
    await waitFor(() => expect(screen.getByText("モデル: model-b")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();

    // 旧い鎖が今ごろ終わっても、新しい実行の操作を巻き込まない。
    await oldRun.resolveRun(2, makeRunDetail({ status: "stopped", stopReason: "aborted" }));
    expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
  });
});

describe("ResultsPage: Task 8 前タスクの申し送り 2・3", () => {
  // 申し送り 2：`.finally()` で閉じた鎖は、`apiClient.*` が同期 throw したときに
  // 未処理の拒否（unhandled rejection）になる。vitest は未処理の拒否を失敗として拾う。
  it("取り直しの口が同期例外を投げても未処理の拒否にならず、送信中の表示が解ける", async () => {
    const user = userEvent.setup();
    let getRunCalls = 0;
    const getRun = vi.fn(() => {
      getRunCalls += 1;
      if (getRunCalls === 1) return Promise.resolve(makeRunDetail({ status: "running" }));
      throw new Error("取り直しの同期例外（テスト用）");
    });
    const stopRun = vi.fn(() => Promise.resolve(makeRun({ status: "running" })));
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      stopRun,
    });

    renderPage(client);
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "停止" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeEnabled());
    expect(getRun).toHaveBeenCalledTimes(2);
  });

  // 申し送り 3：409 の「…最新の状態を取得しました。」が、その後の手動更新をまたいで残ると
  // 文面と状態がずれる。取り直しの成功で消す。
  it("操作失敗の案内は、手動の取り直しが成功したら消える", async () => {
    const user = userEvent.setup();
    const getRun = vi.fn(() =>
      Promise.resolve(makeRunDetail({ status: "stopped", stopReason: "connection-lost" })),
    );
    const resumeRun = vi.fn(() =>
      Promise.reject(
        new ApiRequestError(409, "run-rejected-running", "実行中のため受け付けられません"),
      ),
    );
    const client = makeClient({
      getRun,
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([]),
      resumeRun,
    });

    renderPage(client);

    const resumeButton = await screen.findByRole("button", { name: "再開" });
    await user.click(resumeButton);
    await waitFor(() =>
      expect(screen.getByText("すでに実行中です。最新の状態を取得しました。")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "最新の状態を取得" }));

    await waitFor(() =>
      expect(
        screen.queryByText("すでに実行中です。最新の状態を取得しました。"),
      ).not.toBeInTheDocument(),
    );
  });
});
