/**
 * `/runs/:id` — 結果画面の骨組み（Task 5、決定 1・2・3。R7）。
 *
 * 3 つの取得（`getRun`・`getManuscript`・`getFindings`）がそろうまで部分描画をしないこと、
 * 世代番号による古い応答の破棄、404・取得失敗・`settings` 停止の扱い、指摘 0 件の文言分岐
 * （決定 2）、「最新の状態を取得」での再取得を確認する。
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
 */

import type {
  FindingDetailDto,
  FindingDto,
  JudgmentDto,
  ManuscriptVersionDto,
  RunDetailDto,
  RunDto,
} from "@shuten/shared";
import { splitParagraphs } from "@shuten/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiClientProvider } from "../../api/context.tsx";
import { ApiRequestError } from "../../api/errors.ts";
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
