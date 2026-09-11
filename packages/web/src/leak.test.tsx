/**
 * 漏えい検査（W9-4〜7、決定 18）。web 側から見る。
 *
 * `packages/server/src/api/leak.test.ts`（PR10・A0）と同じ趣旨で、番兵の文字列（API キー・
 * 接続先 URL）を実際に画面へ流し、どこにも漏れないことを見る。サーバー側と違う点は 2 つ：
 *
 * - サーバー側は `app.request` で HTTP を直接呼ぶが、こちらは `createApiClient` に fake の
 *   `fetch` を注入し（決定 14）、**クライアントが実際に送ったすべての要求**（メソッド・URL・本文）
 *   を集める。`ApiClient` を丸ごとモックする他のテスト（`connection-section.test.tsx` 等）
 *   と違い、ここは fetch の 1 段下まで見ないと「要求本文に出ない」を確かめられない（決定 18 の
 *   「`PUT /api/settings/connection` の要求本文以外へ送らない」はクライアントの実装そのものの
 *   検証であって、`ApiClient` のモックでは素通りしてしまう）。
 * - 画面の描画（`document.body.textContent`）と `localStorage` も見る。
 *
 * 実際の `fetch` は一切呼ばない。
 *
 * ## この 4 件が実際に境界を守っているかの確認
 *
 * 前タスクでヘッダーに「接続先 URL を出さない」テストを書いたが、`ConnectionState`
 * （`app/connection-context.tsx`）が型の上で `endpointUrl` を持てず、実装をどう誤らせても
 * 描画しようがないため常に緑になることが分かり、削除した（決定 18 の実質の担保はここ W9-7 に
 * 一本化する、という判断）。そのため W9-4〜7 それぞれについて、この 4 件を書いた時点で
 * **実装を一時的に誤らせて実際に赤くなることを手作業で確認してから戻した**（作業報告に記録）。
 *
 * - W9-4：保存直後の接続確認（`connection-section.tsx` の `checkConnection` 呼び出し）に
 *   誤って `apiKeyInput` を紛れ込ませ、`POST /api/settings/connection/check` の本文に番兵が
 *   乗って赤くなることを確認した。
 * - W9-5：保存成功の表示に `apiKeyInput` をそのまま添えるよう変え、描画テキストに番兵が
 *   出て赤くなることを確認した。
 * - W9-6：保存成功時に `writeStored` で `apiKeyInput` を `localStorage` へ書くよう変え、
 *   赤くなることを確認した。
 * - W9-7：`app/header.tsx` の描画へ、番兵のホスト名（`leak-sentinel.invalid`）を含む文字列を
 *   一時的に足し、`/` と `/runs/:id` の両方で赤くなることを確認した。
 * - W9-7（PR12a 決定 16 で `/runs` へ拡張）：`features/run-list/run-list-page.tsx` の描画へ、
 *   番兵のホスト名を一時的に足し、`/runs` でも赤くなることを確認した。API キーの localStorage
 *   検査についても、`connection-section.tsx` の保存成功時に `apiKeyInput` を `localStorage` へ
 *   書くよう一時的に変え（W9-6 と同じ手口）、W9-6・W9-7 の両方が赤くなることを確認した。
 *   （画面の描画テキストへの API キーの混入は既存の他画面に混入経路が無いため、この 4 件の
 *   時点では常に緑になる。実質の担保は `localStorage` 側にある。）
 */

import type {
  ConnectionCheckDto,
  ConnectionSettingsDto,
  FindingDto,
  ManuscriptVersionDto,
  ModelInfoDto,
  RunDetailDto,
  RunSummaryDto,
} from "@shuten/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiClient } from "./api/client.ts";
import { createApiClient } from "./api/client.ts";
import { ApiClientProvider } from "./api/context.tsx";
import { ConnectionProvider } from "./app/connection-context.tsx";
import { HomePage } from "./app/home-page.tsx";
import { Layout } from "./app/layout.tsx";
import { ROUTES, runPath } from "./app/routes.ts";
import { SettingsPage } from "./app/settings-page.tsx";
import { ResultsPage } from "./features/results/results-page.tsx";
import { RunListPage } from "./features/run-list/run-list-page.tsx";

/** ---------------------------------------------------------------------- */
/** 番兵 */
/** ---------------------------------------------------------------------- */

const API_KEY_SENTINEL = "sk-leak-sentinel-9f2c8b41";
/** URL 全体ではなくホスト名で探す（`/v1` を付けた変形などでも捕まえられるように）。 */
const ENDPOINT_URL_HOST_SENTINEL = "leak-sentinel.invalid";
const ENDPOINT_URL_SENTINEL = `http://${ENDPOINT_URL_HOST_SENTINEL}:9999`;
const SETTLED_RUN_ID = "run-leak-sentinel-1";
const MANUSCRIPT_ID = "mv-leak-sentinel-1";

/** ---------------------------------------------------------------------- */
/** fake fetch（実際の HTTP は呼ばない） */
/** ---------------------------------------------------------------------- */

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  /** 要求本文をそのまま文字列化したもの。本文が無ければ空文字列。 */
  readonly body: string;
}

function where(request: RecordedRequest): string {
  return `${request.method} ${request.url}`;
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input.toString();
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

function makeSettings(overrides: Partial<ConnectionSettingsDto> = {}): ConnectionSettingsDto {
  return { endpointUrl: ENDPOINT_URL_SENTINEL, hasApiKey: false, ...overrides };
}

function makeCheck(overrides: Partial<ConnectionCheckDto> = {}): ConnectionCheckDto {
  return { reachable: true, error: null, models: [makeModel()], model: null, ...overrides };
}

function makeManuscript(): ManuscriptVersionDto {
  return {
    id: MANUSCRIPT_ID,
    name: "原稿（漏えい検査用）",
    body: "本文の段落。",
    bodyHash: "hash-leak-sentinel",
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}

/** `/runs/:id` の描画に要る指摘一覧。件数だけ確認できれば十分なので空でよい。 */
function makeFindings(): FindingDto[] {
  return [];
}

/** `/runs`（実行一覧）の描画に要る 1 件。`RunSummaryDto` は `endpointUrl` を持たない。 */
function makeRunSummary(): RunSummaryDto {
  return {
    id: SETTLED_RUN_ID,
    manuscriptVersionId: MANUSCRIPT_ID,
    manuscriptName: "原稿（漏えい検査用）",
    modelId: "model-a",
    status: "running",
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: null,
  };
}

function makeRunDetail(): RunDetailDto {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, "not-applicable": 0 } as const;
  return {
    run: {
      id: SETTLED_RUN_ID,
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
    },
    progress: { checkUnits: { ...counts }, recheckUnits: { ...counts } },
    targets: [],
  };
}

/**
 * この検査に要る最小限の口だけに応える fake fetch。呼ばれた要求は `requests` にそのまま積む。
 * 想定していない要求が来たら、空振りに気付けるよう例外にする。
 */
function createFakeFetch(requests: RecordedRequest[]): typeof globalThis.fetch {
  return async (input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ method, url, body });

    if (url === "/api/settings/connection" && method === "GET") {
      return jsonResponse(200, makeSettings());
    }
    if (url === "/api/settings/connection" && method === "PUT") {
      // 保存できても、API キー本体は応答に決して含めない（決定 5・18）。
      return jsonResponse(200, makeSettings({ hasApiKey: true }));
    }
    if (url === "/api/settings/connection/check" && method === "POST") {
      return jsonResponse(200, makeCheck());
    }
    if (url === "/api/runs" && method === "GET") {
      return jsonResponse(200, [makeRunSummary()]);
    }
    if (url === `/api/runs/${SETTLED_RUN_ID}` && method === "GET") {
      return jsonResponse(200, makeRunDetail());
    }
    if (url === `/api/manuscripts/${MANUSCRIPT_ID}` && method === "GET") {
      return jsonResponse(200, makeManuscript());
    }
    if (url === `/api/runs/${SETTLED_RUN_ID}/findings` && method === "GET") {
      return jsonResponse(200, makeFindings());
    }

    throw new Error(`fake fetch: 想定していない要求 ${method} ${url}`);
  };
}

/** ---------------------------------------------------------------------- */
/** 描画 */
/** ---------------------------------------------------------------------- */

function renderConnectionPage(client: ApiClient) {
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

async function waitForConnectionLoaded() {
  await waitFor(() =>
    expect(screen.getByLabelText("接続先 URL")).toHaveValue(ENDPOINT_URL_SENTINEL),
  );
}

/**
 * 検査用のナビゲーション（画面に実在するリンクだけでは `/settings/connection` から `/` や
 * `/runs/:id` へ移れないため）。`App.test.tsx` の `HistoryControls` と同じ流儀。
 */
function NavigationProbe() {
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => navigate(ROUTES.home)}>
        検査用ナビゲーション：トップへ
      </button>
      <button type="button" onClick={() => navigate(ROUTES.runs)}>
        検査用ナビゲーション：一覧へ
      </button>
      <button type="button" onClick={() => navigate(runPath(SETTLED_RUN_ID))}>
        検査用ナビゲーション：実行画面へ
      </button>
    </div>
  );
}

/** `App.tsx` と同じ route 構成（Header を含む `Layout`）を、fake fetch を注入した client で組む。 */
function renderAppTree(client: ApiClient) {
  return render(
    <MemoryRouter initialEntries={[ROUTES.settings]}>
      <ApiClientProvider client={client}>
        <ConnectionProvider client={client}>
          <NavigationProbe />
          <Routes>
            <Route element={<Layout />}>
              <Route path={ROUTES.home} element={<HomePage />} />
              <Route path={ROUTES.settings} element={<SettingsPage />} />
              <Route path={ROUTES.runs} element={<RunListPage />} />
              <Route path={ROUTES.run} element={<ResultsPage />} />
            </Route>
          </Routes>
        </ConnectionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("漏えい検査：接続設定画面（決定 18）", () => {
  it("W9-4: 保存した API キーは、fetch に渡ったどの要求でも PUT /api/settings/connection の本文以外に出ない", async () => {
    const requests: RecordedRequest[] = [];
    const client = createApiClient({ fetch: createFakeFetch(requests) });
    renderConnectionPage(client);
    await waitForConnectionLoaded();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("API キー"), API_KEY_SENTINEL);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByText(/設定済み/)).toBeInTheDocument());
    // 保存直後の接続確認（決定 8 の契機 2）まで送り終えるのを待つ。これを待たずに検査すると、
    // まだ送られていない要求は「本文に含まれない」側へ数えられてしまい空振りになる。
    await waitFor(() =>
      expect(
        requests.filter((r) => r.url === "/api/settings/connection/check").length,
      ).toBeGreaterThanOrEqual(2),
    );

    // 空振り防止：PUT の本文には実際に API キーが乗っていること。
    const put = requests.find((r) => r.method === "PUT" && r.url === "/api/settings/connection");
    expect(put?.body).toContain(API_KEY_SENTINEL);

    const leaked = requests
      .filter((r) => !(r.method === "PUT" && r.url === "/api/settings/connection"))
      .filter((r) => r.body.includes(API_KEY_SENTINEL))
      .map(where);
    expect(leaked).toEqual([]);
  });

  it("W9-5: 保存後、画面の描画テキストに API キーが出ない（password 欄の value は対象外）", async () => {
    const client = createApiClient({ fetch: createFakeFetch([]) });
    renderConnectionPage(client);
    await waitForConnectionLoaded();

    const user = userEvent.setup();
    const apiKeyInput = screen.getByLabelText("API キー");
    await user.type(apiKeyInput, API_KEY_SENTINEL);
    // 空振り防止：入力欄には実際に API キーが入っている（password 欄の value としては許される）。
    expect(apiKeyInput).toHaveValue(API_KEY_SENTINEL);

    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByText(/設定済み/)).toBeInTheDocument());

    expect(document.body.textContent ?? "").not.toContain(API_KEY_SENTINEL);
    // `document.body.textContent` はどの `<input>` の value も拾わない（password 欄に限らない）。
    // 「password 欄の value としては存在してよい」の除外対象を password 欄だけに絞るため、
    // 他の入力欄（接続先 URL 欄など）の value も別途見る。
    for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([type="password"]), textarea',
    )) {
      expect(el.value).not.toContain(API_KEY_SENTINEL);
    }
  });

  it("W9-6: 保存後、localStorage のどのキーの値にも API キーが出ない", async () => {
    const client = createApiClient({ fetch: createFakeFetch([]) });
    renderConnectionPage(client);
    await waitForConnectionLoaded();
    await waitFor(() => expect(screen.getByText("model-a")).toBeInTheDocument());

    const user = userEvent.setup();
    // localStorage に実際に何か書かれる操作（モデル選択）を混ぜる。空振り防止：
    // localStorage が終始空のままでは「API キーが無い」ことを何も検査していないのと同じになる。
    await user.click(screen.getByRole("radio", { name: "model-a" }));
    await user.type(screen.getByLabelText("API キー"), API_KEY_SENTINEL);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByText(/設定済み/)).toBeInTheDocument());

    expect(localStorage.length).toBeGreaterThan(0); // 空振り防止
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key === null) continue;
      expect(localStorage.getItem(key) ?? "").not.toContain(API_KEY_SENTINEL);
    }
  });
});

describe("漏えい検査：接続設定画面以外（決定 18）", () => {
  it("W9-7: 接続先 URL・API キーは '/'・'/runs'・'/runs/:id' のいずれにも出ない（PR12a 決定 16）", async () => {
    const client = createApiClient({ fetch: createFakeFetch([]) });
    renderAppTree(client);

    // 空振り防止：接続設定画面で GET が実際に走り、番兵の URL を読み込んだことを確認してから、
    // 他画面へ移る（読み込まれてすらいない値が出ないのは当然で、検査にならない）。
    await waitForConnectionLoaded();
    await waitFor(() => expect(screen.getByText("model-a")).toBeInTheDocument());

    const user = userEvent.setup();

    // localStorage に実際に何か書かれる操作（モデル選択）と、API キーの保存を両方混ぜる
    // （W9-6 と同じ空振り防止：localStorage が終始空のままでは何も検査していないのと同じ）。
    await user.click(screen.getByRole("radio", { name: "model-a" }));
    await user.type(screen.getByLabelText("API キー"), API_KEY_SENTINEL);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByText(/設定済み/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "検査用ナビゲーション：トップへ" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "原稿と検査設定" })).toBeInTheDocument(),
    );
    expect(document.body.textContent ?? "").not.toContain(ENDPOINT_URL_HOST_SENTINEL);
    expect(document.body.textContent ?? "").not.toContain(API_KEY_SENTINEL);

    // 実行一覧（Task 10・決定 16）。RunSummaryDto は endpointUrl を持たないが、ヘッダー
    // （全画面共通）を経由した漏えいはここでも起こり得るため、他の画面と同じ検査を行う。
    await user.click(screen.getByRole("button", { name: "検査用ナビゲーション：一覧へ" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "検査結果" })).toBeInTheDocument(),
    );
    expect(document.body.textContent ?? "").not.toContain(ENDPOINT_URL_HOST_SENTINEL);
    expect(document.body.textContent ?? "").not.toContain(API_KEY_SENTINEL);

    await user.click(screen.getByRole("button", { name: "検査用ナビゲーション：実行画面へ" }));
    // ヘッダー（決定 1）と右側の指摘 0 件表示（決定 2）の両方に「状態:」が出るため、
    // 完全一致でヘッダー側だけを選ぶ。
    await waitFor(() => expect(screen.getByText("状態: 実行中")).toBeInTheDocument());
    expect(document.body.textContent ?? "").not.toContain(ENDPOINT_URL_HOST_SENTINEL);
    expect(document.body.textContent ?? "").not.toContain(API_KEY_SENTINEL);

    // localStorage のどのキーの値にも、いずれの番兵も出ない（決定 18）。
    expect(localStorage.length).toBeGreaterThan(0); // 空振り防止
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key === null) continue;
      const value = localStorage.getItem(key) ?? "";
      expect(value).not.toContain(ENDPOINT_URL_HOST_SENTINEL);
      expect(value).not.toContain(API_KEY_SENTINEL);
    }
  });
});
