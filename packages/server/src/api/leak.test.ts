/**
 * A0：漏えい検査（決定 3）。
 *
 * 番兵の接続先 URL（`http://sentinel.invalid:9`）と番兵 API キー（`sentinel-api-key`）で API を組み、
 * **エンドポイント表の全行を正常・エラー・SSE で呼び**、応答本文・エラー本文・SSE の全行を
 * そのままの文字列で集めてから、番兵が現れないことを見る。
 *
 * 見るもの（決定 3・不変条件）：
 *
 * 1. 接続先 URL の番兵は、`GET`/`PUT /api/settings/connection` の**正常応答の `endpointUrl` を除いて**
 *    どこにも出ない（仕様 5.1 が接続先の表示を求める唯一の場所）。その 2 つでも `endpointUrl` 以外の
 *    項目には出ない。
 * 2. API キーの番兵は例外なくどこにも出ない。
 * 3. 原稿の番兵断片（`SENTINEL-MANUSCRIPT-FRAGMENT`）は**エラー応答**（`status >= 400`）に出ない。
 *    正常応答は対象外（指摘の `quote` や原稿の `body` に原稿が入るのは正常）。
 * 4. 失敗経路を実際に通ったこと（`FAKE_FAILURE_MARKER`）。これが無いと 1〜3 は空振りで通る。
 * 5. 表の全行を呼んだこと。エンドポイントの一覧をこのファイルに配列で持ち、
 *    `createApiRouter` が登録した route と突き合わせる（足し忘れの検出）。
 *
 * **エンドポイントを足すときはここに加えること。**
 *
 * ## 道具立て
 *
 * 実 HTTP サーバー（`api/events.test.ts` や `lmstudio/client.test.ts` の C47・C51）は**使わない**。
 * それらが実 HTTP を要るのは切断（abort）を `stream.onAbort` に届かせるためで、A0 が要るのは
 * 「SSE の線に何が乗ったか」だけである。`app.request` が返す応答本文は SSE でもそのまま読めて、
 * ストリームは実行の決着（`run-settled` → `finish`）で終わるので `res.text()` が解決する。
 * 3 つ目の実 HTTP の複製を作らずに済む。
 *
 * ## 原稿の番兵とエラー本文
 *
 * エラー応答に原稿が出ないことを空振りでなく見るため、**わざと原稿の番兵を入れた要求で失敗させる**
 * （孤立サロゲート付きの本文、不正な UTF-8 バイト列、`note` に番兵を入れた採否）。
 * 一方 ID は 404 の `message` にそのまま入る仕様（`notFound`）なので、**ID には番兵を使わない**
 * （原稿の断片ではなく利用者が送った ID なので、入っていても漏えいではない）。
 */

import {
  ALLOWED_WORD_RULE_VERSION,
  DIAGNOSTIC_TRANSFORM_VERSION,
  PROMPT_VERSION,
} from "@shuten/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { insertRun } from "../db/repositories/runs.ts";
import type { ChatResult, ModelInfo } from "../lmstudio/types.ts";
import type { ChatStep } from "../run/test-support.ts";
import { FAKE_FAILURE_MARKER, SCRIPTED_LOADED_MODEL } from "../run/test-support.ts";
import type { ApiDeps } from "./deps.ts";
import { createApiRouter } from "./router.ts";
import type { ApiHarness } from "./test-support.ts";
import { JSON_HEADERS, setupApi, waitSettled } from "./test-support.ts";

/**
 * 呼び出しは `beforeAll` にまとめてあり、そこで検査実行を 2 本走らせる。vitest の既定
 * （テスト 5 秒・フック 10 秒）では CI の遅さで足りなくなりうるので両方広げる
 * （`api/events.test.ts` と同じ理由）。
 */
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

/** ---------------------------------------------------------------------- */
/** 番兵 */
/** ---------------------------------------------------------------------- */

/** 番兵の接続先。到達しない TLD（`.invalid`）なので、取り違えて実際に叩いても外へ出ない。 */
const SENTINEL_URL = "http://sentinel.invalid:9";
/** URL 全体ではなくホスト名で探す（`http://sentinel.invalid:9/v1` のような変形も捕まえる）。 */
const SENTINEL_HOST = "sentinel.invalid";
const SENTINEL_API_KEY = "sentinel-api-key";
/** 原稿本文にだけ入れる番兵。エラー本文に出たら漏えい。 */
const MANUSCRIPT_SENTINEL = "SENTINEL-MANUSCRIPT-FRAGMENT";

/** 33 書記素・1 段落。指摘の引用（`quote`）に番兵をそのまま使えるようにしてある。 */
const BODY = `${MANUSCRIPT_SENTINEL}を含む本文`;

/** 本文全体が 1 対象になる設定（1 観点なので検査単位も 1 つ）。 */
const CHUNK_ONE_TARGET = {
  targetGraphemes: 40,
  contextGraphemes: 0,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 100,
};

/** ---------------------------------------------------------------------- */
/** エンドポイント表（計画書の「エンドポイント」節。**足したらここに加える**） */
/** ---------------------------------------------------------------------- */

interface EndpointSpec {
  /** `createApiRouter` に登録した形（`${METHOD} /api${path}`）。 */
  readonly key: string;
  /** 表の状態コード欄にエラー（4xx）があるか。ある行は 4xx の観測も要る。 */
  readonly hasErrorForm: boolean;
}

const ENDPOINTS: readonly EndpointSpec[] = [
  { key: "GET /api/settings/connection", hasErrorForm: false },
  { key: "PUT /api/settings/connection", hasErrorForm: true },
  { key: "POST /api/settings/connection/check", hasErrorForm: false },
  { key: "POST /api/manuscripts", hasErrorForm: true },
  { key: "POST /api/manuscripts/upload", hasErrorForm: true },
  { key: "GET /api/manuscripts/:id", hasErrorForm: true },
  { key: "GET /api/runs", hasErrorForm: false },
  { key: "POST /api/runs", hasErrorForm: true },
  { key: "GET /api/runs/:id", hasErrorForm: true },
  { key: "GET /api/runs/:id/units", hasErrorForm: true },
  { key: "POST /api/runs/:id/stop", hasErrorForm: true },
  { key: "POST /api/runs/:id/resume", hasErrorForm: true },
  { key: "POST /api/runs/:id/retry-failed", hasErrorForm: true },
  { key: "GET /api/recovery", hasErrorForm: false },
  { key: "POST /api/recovery/confirm", hasErrorForm: true },
  { key: "GET /api/runs/:id/findings", hasErrorForm: true },
  { key: "GET /api/findings/:id", hasErrorForm: true },
  { key: "PUT /api/findings/:id/judgment", hasErrorForm: true },
  { key: "GET /api/runs/:id/events", hasErrorForm: true },
  { key: "GET /api/health", hasErrorForm: false },
];

/** 表に無い観測（未知の `/api/*` など）。件数の突き合わせからは外す。 */
const EXTRA = "（表の外）";

/** ---------------------------------------------------------------------- */
/** 観測 */
/** ---------------------------------------------------------------------- */

interface Observation {
  /** `ENDPOINTS` の `key`、または `EXTRA`。 */
  readonly endpoint: string;
  readonly label: string;
  readonly status: number;
  /** 応答本文そのまま（再直列化しない。SSE は全行）。 */
  readonly text: string;
  /** 決定 3 の唯一の例外。正常な接続設定の応答だけ true。 */
  readonly endpointUrlAllowed: boolean;
}

const observations: Observation[] = [];

let harness: ApiHarness;

/** 台本の門。`null` なら素通り。 */
interface Gate<T> {
  readonly promise: Promise<T>;
  open(value: T): void;
}

function gate<T>(): Gate<T> {
  let open: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** 条件が満たされるまで待つ（実タイマー）。満たされなければ名札付きで落とす。 */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`条件が満たされませんでした: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * 実行の決着を待ち、**レジストリから外れる**まで待つ。`run-settled` は DB を書いた時点で出るが、
 * レジストリ（「走っているか」の正本。決定 7）から外れるのはそのすぐ後なので、決着の直後に
 * `stop` を呼ぶと 409 ではなく 202 が返る（受け付けられてしまう）。
 */
async function settleRun(runId: string): Promise<string> {
  const settled = await waitSettled(harness.hub, harness.db, runId);
  await waitFor(
    () => !harness.orchestrator.activeRunIds().includes(runId),
    `実行 ${runId} がレジストリから外れる`,
  );
  return settled.status;
}

interface CallResult {
  readonly status: number;
  readonly text: string;
  readonly json: unknown;
}

/** 1 回の要求を送り、応答本文をそのまま観測に控える。 */
async function call(
  endpoint: string,
  label: string,
  path: string,
  init?: RequestInit,
  options: { readonly endpointUrlAllowed?: boolean } = {},
): Promise<CallResult> {
  const res = await harness.app.request(path, init);
  const text = await res.text();
  observations.push({
    endpoint,
    label,
    status: res.status,
    text,
    endpointUrlAllowed: options.endpointUrlAllowed === true,
  });
  return { status: res.status, text, json: text === "" ? null : JSON.parse(text) };
}

function getJson(endpoint: string, label: string, path: string): Promise<CallResult> {
  return call(endpoint, label, path);
}

function postJson(
  endpoint: string,
  label: string,
  path: string,
  body: unknown,
): Promise<CallResult> {
  return call(endpoint, label, path, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

function putJson(
  endpoint: string,
  label: string,
  path: string,
  body: unknown,
  options: { readonly endpointUrlAllowed?: boolean } = {},
): Promise<CallResult> {
  return call(
    endpoint,
    label,
    path,
    { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) },
    options,
  );
}

/** ---------------------------------------------------------------------- */
/** 台本 */
/** ---------------------------------------------------------------------- */

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: null };

/** 引用に原稿の番兵をそのまま使う指摘 1 件（正常応答に原稿が入るのは正常、という側の材料）。 */
function checkResponse(): ChatResult {
  return {
    content: JSON.stringify({
      findings: [
        {
          paragraphId: 0,
          quote: MANUSCRIPT_SENTINEL,
          before: "",
          after: "",
          category: "notation",
          reason: "理由",
          suggestion: "修正案",
          verdict: "likely-error",
        },
      ],
    }),
    reasoningContent: null,
    finishReason: "stop",
    usage: USAGE,
    raw: {},
  };
}

/** 検査実行 S（成功）の門。開くまで生成要求が返らない＝実行が running のまま。 */
const chatGate = gate<void>();
let chatReached = false;

/** `ensureLoaded` の門。検査実行 T（停止）で使う。`null` の間は素通り。 */
let loadGate: Gate<ModelInfo> | null = null;
let loadReached = false;

/** 接続確認の到達不能を作る切り替え。 */
let listModelsFails = false;

/**
 * 台本。**消費される順に並べる**（フェイクは要求の通し番号で引く）。
 * 0：実行 S の 1 単位（門つき・成功）。1〜2：実行 T の再開（`malformed` は 1 回再試行されるので 2 件）。
 * 3〜4：実行 T の失敗単位の再試行（同上）。
 */
function buildSteps(): ChatStep[] {
  const succeed: ChatStep = async () => {
    chatReached = true;
    await chatGate.promise;
    return checkResponse();
  };
  const fail: ChatStep = ({ failure }) => {
    throw failure("malformed");
  };
  return [succeed, fail, fail, fail, fail];
}

/** ---------------------------------------------------------------------- */
/** 台本の外の材料 */
/** ---------------------------------------------------------------------- */

function startRequest(
  manuscriptVersionId: string,
  startOperationId: string,
): Record<string, unknown> {
  return {
    startOperationId,
    manuscriptVersionId,
    modelId: SCRIPTED_LOADED_MODEL.id,
    generation: { maxTokens: 512, temperature: 0 },
    chunkSettings: CHUNK_ONE_TARGET,
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: false,
    allowedWordsRaw: "",
  };
}

/**
 * 復旧待ちの実行を 1 行だけ作る（`startRun` を経由しないのでレジストリには乗らない）。
 * `endpointUrl` は**現在の接続先＝番兵**を入れる。DB に番兵が入っている状態で
 * `GET /api/runs/:id` などが番兵を出さないことを見るため。
 */
function seedRecoveryWaitingRun(runId: string): void {
  const manuscriptVersionId = `mv-${runId}`;
  insertManuscriptVersion(harness.db, { id: manuscriptVersionId, name: "原稿", body: BODY });
  insertRun(harness.db, {
    id: runId,
    manuscriptVersionId,
    modelId: SCRIPTED_LOADED_MODEL.id,
    modelInfo: null,
    endpointUrl: harness.connection.current().endpointUrl,
    generationSettings: { maxTokens: 512, temperature: 0 },
    chunkSettings: CHUNK_ONE_TARGET,
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: false,
    allowedWords: [],
    allowedWordRuleVersion: ALLOWED_WORD_RULE_VERSION,
    promptVersion: PROMPT_VERSION,
    diagnosticTransformVersion: DIAGNOSTIC_TRANSFORM_VERSION,
    status: "recovery-waiting",
    stopReason: "recovery-needed",
    stopMessage: null,
    generationUnconfirmed: true,
    startOperationId: `seed-${runId}`,
    finishedAt: null,
  });
}

/** ---------------------------------------------------------------------- */
/** 呼び出し（全エンドポイントを正常・エラー・SSE で 1 度ずつ以上） */
/** ---------------------------------------------------------------------- */

beforeAll(async () => {
  harness = setupApi({
    env: { lmStudioUrl: SENTINEL_URL, lmStudioApiKey: SENTINEL_API_KEY },
    steps: buildSteps(),
    // 心拍を短くして SSE の `: ping` も本文に載せる（線に何も付いていないことを見る）。
    ssePingIntervalMs: 30,
    listModels: async ({ failure }) => {
      if (listModelsFails) {
        throw failure("connection");
      }
      return [SCRIPTED_LOADED_MODEL];
    },
    ensureLoaded: async () => {
      loadReached = true;
      return loadGate === null ? SCRIPTED_LOADED_MODEL : await loadGate.promise;
    },
  });

  /** 健全性・接続設定の参照 ------------------------------------------------ */

  expect((await getJson("GET /api/health", "正常", "/api/health")).status).toBe(200);

  const settings = await call(
    "GET /api/settings/connection",
    "正常（番兵の URL を出してよい唯一の場所）",
    "/api/settings/connection",
    undefined,
    { endpointUrlAllowed: true },
  );
  expect(settings.status).toBe(200);
  // 例外の側を積極的に確かめる（番兵が出ていなければ、下の「例外の 1 項目以外に出ない」は空振り）。
  expect(settings.json).toEqual({ endpointUrl: SENTINEL_URL, hasApiKey: true });

  /** 接続確認（到達・不到達・検証失敗） ------------------------------------ */

  const check = await postJson(
    "POST /api/settings/connection/check",
    "正常（到達）",
    "/api/settings/connection/check",
    { modelId: SCRIPTED_LOADED_MODEL.id },
  );
  expect(check.status).toBe(200);

  listModelsFails = true;
  const unreachable = await postJson(
    "POST /api/settings/connection/check",
    "到達不能（200 で reachable: false。例外の message を転記しない）",
    "/api/settings/connection/check",
    {},
  );
  expect(unreachable.status).toBe(200);
  expect((unreachable.json as { reachable: boolean }).reachable).toBe(false);
  listModelsFails = false;

  expect(
    (
      await postJson(
        "POST /api/settings/connection/check",
        "400 validation",
        "/api/settings/connection/check",
        { modelId: 123 },
      )
    ).status,
  ).toBe(400);

  /** 原稿 ------------------------------------------------------------------ */

  const created = await postJson("POST /api/manuscripts", "201（貼り付け）", "/api/manuscripts", {
    name: "原稿A",
    body: BODY,
  });
  expect(created.status).toBe(201);
  const manuscriptVersionId = (created.json as { id: string }).id;

  expect(
    (
      await postJson("POST /api/manuscripts", "400 validation", "/api/manuscripts", {
        name: "原稿A",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await postJson("POST /api/manuscripts", "400 empty-body", "/api/manuscripts", {
        name: MANUSCRIPT_SENTINEL,
        body: "",
      })
    ).status,
  ).toBe(400);
  // 原稿の番兵を含む本文で失敗させる（エラー本文に本文が転記されないことを空振りでなく見る）。
  expect(
    (
      await postJson("POST /api/manuscripts", "400 malformed-body", "/api/manuscripts", {
        name: "原稿A",
        body: `${MANUSCRIPT_SENTINEL}\uD800`,
      })
    ).status,
  ).toBe(400);

  const uploadForm = new FormData();
  uploadForm.append("file", new File([new TextEncoder().encode(BODY)], "manuscript.txt"));
  const uploaded = await call(
    "POST /api/manuscripts/upload",
    "201（ファイル）",
    "/api/manuscripts/upload",
    { method: "POST", body: uploadForm },
  );
  expect(uploaded.status).toBe(201);

  const invalidForm = new FormData();
  // 番兵のバイト列 + 不正な UTF-8 バイト（0xFF）。
  const invalidBytes = new Uint8Array([...new TextEncoder().encode(MANUSCRIPT_SENTINEL), 0xff]);
  invalidForm.append("file", new File([invalidBytes], "invalid.txt"));
  expect(
    (
      await call(
        "POST /api/manuscripts/upload",
        "400 invalid-utf8（本文に番兵を入れて失敗させる）",
        "/api/manuscripts/upload",
        { method: "POST", body: invalidForm },
      )
    ).status,
  ).toBe(400);

  const noFileForm = new FormData();
  noFileForm.append("name", "原稿A");
  expect(
    (
      await call("POST /api/manuscripts/upload", "400 validation", "/api/manuscripts/upload", {
        method: "POST",
        body: noFileForm,
      })
    ).status,
  ).toBe(400);

  expect(
    (
      await getJson(
        "GET /api/manuscripts/:id",
        "200（本文に原稿の番兵が入る。正常応答なので対象外）",
        `/api/manuscripts/${manuscriptVersionId}`,
      )
    ).status,
  ).toBe(200);
  expect(
    (await getJson("GET /api/manuscripts/:id", "404", "/api/manuscripts/mv-missing")).status,
  ).toBe(404);

  /** 実行の開始（エラー側） ------------------------------------------------ */

  expect((await postJson("POST /api/runs", "400 validation", "/api/runs", {})).status).toBe(400);
  expect(
    (
      await postJson("POST /api/runs", "400 invalid-run-settings", "/api/runs", {
        ...startRequest(manuscriptVersionId, "op-invalid"),
        chunkSettings: { ...CHUNK_ONE_TARGET, targetGraphemes: -1 },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await postJson("POST /api/runs", "404（原稿版なし）", "/api/runs", {
        ...startRequest("mv-missing", "op-missing"),
      })
    ).status,
  ).toBe(404);

  /** 検査実行 S：走らせたまま見るもの ------------------------------------- */

  const started = await postJson(
    "POST /api/runs",
    "201（作成直後のスナップショット）",
    "/api/runs",
    startRequest(manuscriptVersionId, "op-s"),
  );
  expect(started.status).toBe(201);
  const runS = (started.json as { id: string }).id;
  await waitFor(() => chatReached, "実行 S が生成要求まで進む");

  // 走っている間だけ観測できるもの（409 の 3 種）。
  expect(
    (
      await putJson("PUT /api/settings/connection", "409 runs-active", "/api/settings/connection", {
        endpointUrl: SENTINEL_URL,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await postJson(
        "POST /api/runs/:id/resume",
        "409 run-rejected-running",
        `/api/runs/${runS}/resume`,
        {},
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await postJson(
        "POST /api/runs/:id/retry-failed",
        "409 run-rejected-running",
        `/api/runs/${runS}/retry-failed`,
        {},
      )
    ).status,
  ).toBe(409);

  expect((await getJson("GET /api/runs", "200（一覧）", "/api/runs")).status).toBe(200);
  expect((await getJson("GET /api/runs/:id", "200（実行中）", `/api/runs/${runS}`)).status).toBe(
    200,
  );
  expect(
    (await getJson("GET /api/runs/:id/units", "200（実行中）", `/api/runs/${runS}/units`)).status,
  ).toBe(200);

  // SSE（実況）。門を開ける前に購読して読み始め、決着（`run-settled`）で本文が終わる。
  const liveSse = await harness.app.request(`/api/runs/${runS}/events`);
  expect(liveSse.status).toBe(200);
  const liveBody = liveSse.text();

  chatGate.open();
  expect(await settleRun(runS)).toBe("completed");

  observations.push({
    endpoint: "GET /api/runs/:id/events",
    label: "SSE（実況。実行中に購読して決着まで）",
    status: liveSse.status,
    text: await liveBody,
    endpointUrlAllowed: false,
  });

  // SSE（終端状態）。合成した `run-settled` を 1 件送って閉じる。
  const settledSse = await harness.app.request(`/api/runs/${runS}/events`);
  expect(settledSse.status).toBe(200);
  observations.push({
    endpoint: "GET /api/runs/:id/events",
    label: "SSE（終端状態の実行を購読）",
    status: settledSse.status,
    text: await settledSse.text(),
    endpointUrlAllowed: false,
  });

  expect(
    (await getJson("GET /api/runs/:id/events", "404", "/api/runs/run-missing/events")).status,
  ).toBe(404);

  expect((await getJson("GET /api/runs/:id", "404", "/api/runs/run-missing")).status).toBe(404);
  expect(
    (await getJson("GET /api/runs/:id/units", "404", "/api/runs/run-missing/units")).status,
  ).toBe(404);
  // 冪等（同じ startOperationId の 2 回目は 200 で既存）。
  expect(
    (
      await postJson(
        "POST /api/runs",
        "200（同じ startOperationId の既存）",
        "/api/runs",
        startRequest(manuscriptVersionId, "op-s"),
      )
    ).status,
  ).toBe(200);

  /** 指摘と採否 ------------------------------------------------------------ */

  const findings = await getJson(
    "GET /api/runs/:id/findings",
    "200（quote に原稿の番兵が入る。正常応答なので対象外）",
    `/api/runs/${runS}/findings`,
  );
  expect(findings.status).toBe(200);
  const findingList = findings.json as readonly { id: string }[];
  expect(findingList.length).toBeGreaterThan(0);
  const findingId = findingList[0]?.id ?? "";

  expect(
    (await getJson("GET /api/runs/:id/findings", "404", "/api/runs/run-missing/findings")).status,
  ).toBe(404);
  expect(
    (await getJson("GET /api/findings/:id", "200（詳細）", `/api/findings/${findingId}`)).status,
  ).toBe(200);
  expect(
    (await getJson("GET /api/findings/:id", "404", "/api/findings/finding-missing")).status,
  ).toBe(404);

  expect(
    (
      await putJson(
        "PUT /api/findings/:id/judgment",
        "200（採否）",
        `/api/findings/${findingId}/judgment`,
        { status: "adopt-planned", note: "メモ" },
      )
    ).status,
  ).toBe(200);
  // 原稿の番兵を `note` に入れた検証失敗（エラー本文に要求の値が転記されないことを見る）。
  expect(
    (
      await putJson(
        "PUT /api/findings/:id/judgment",
        "400 validation（note に番兵）",
        `/api/findings/${findingId}/judgment`,
        { status: "bogus", note: MANUSCRIPT_SENTINEL },
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await putJson(
        "PUT /api/findings/:id/judgment",
        "404",
        "/api/findings/finding-missing/judgment",
        { status: "held" },
      )
    ).status,
  ).toBe(404);

  /** 検査実行 T：停止・再開・失敗単位の再試行 ------------------------------ */

  loadGate = gate<ModelInfo>();
  loadReached = false;
  const startedT = await postJson(
    "POST /api/runs",
    "201（停止・再開の観測用）",
    "/api/runs",
    startRequest(manuscriptVersionId, "op-t"),
  );
  expect(startedT.status).toBe(201);
  const runT = (startedT.json as { id: string }).id;
  await waitFor(() => loadReached, "実行 T がモデルのロード待ちまで進む");

  expect(
    (await postJson("POST /api/runs/:id/stop", "202", `/api/runs/${runT}/stop`, {})).status,
  ).toBe(202);
  loadGate.open(SCRIPTED_LOADED_MODEL);
  loadGate = null;
  expect(await settleRun(runT)).toBe("stopped");

  expect(
    (await postJson("POST /api/runs/:id/stop", "409 run-not-active", `/api/runs/${runT}/stop`, {}))
      .status,
  ).toBe(409);
  expect(
    (await postJson("POST /api/runs/:id/stop", "404", "/api/runs/run-missing/stop", {})).status,
  ).toBe(404);

  // 再開：`malformed` の台本で失敗単位を作る（`FAKE_FAILURE_MARKER` の出どころ）。
  expect(
    (await postJson("POST /api/runs/:id/resume", "202", `/api/runs/${runT}/resume`, {})).status,
  ).toBe(202);
  expect(await settleRun(runT)).toBe("partially-failed");

  const unitsT = await getJson(
    "GET /api/runs/:id/units",
    "200（失敗した検査単位。失敗の印が入る）",
    `/api/runs/${runT}/units`,
  );
  expect(unitsT.status).toBe(200);

  expect(
    (await postJson("POST /api/runs/:id/resume", "404", "/api/runs/run-missing/resume", {})).status,
  ).toBe(404);
  expect(
    (
      await postJson(
        "POST /api/runs/:id/retry-failed",
        "400 validation（空配列）",
        `/api/runs/${runT}/retry-failed`,
        { unitIds: [] },
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await postJson(
        "POST /api/runs/:id/retry-failed",
        "400 invalid-retry-target",
        `/api/runs/${runT}/retry-failed`,
        { unitIds: ["cu-missing"] },
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await postJson(
        "POST /api/runs/:id/retry-failed",
        "404",
        "/api/runs/run-missing/retry-failed",
        {},
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await postJson(
        "POST /api/runs/:id/retry-failed",
        "202（全件）",
        `/api/runs/${runT}/retry-failed`,
        {},
      )
    ).status,
  ).toBe(202);
  expect(await settleRun(runT)).toBe("partially-failed");

  // 終端状態からの再開は 409（走っていないので `status` 拒否）。
  expect(
    (
      await postJson(
        "POST /api/runs/:id/resume",
        "409 run-rejected-status",
        `/api/runs/${runT}/resume`,
        {},
      )
    ).status,
  ).toBe(409);

  /** 復旧 ------------------------------------------------------------------ */

  seedRecoveryWaitingRun("run-recovery");
  harness.gate.block("run-recovery");

  const recovery = await getJson("GET /api/recovery", "200（復旧待ちあり）", "/api/recovery");
  expect(recovery.status).toBe(200);
  expect(recovery.json).toEqual({ blocked: true, runIds: ["run-recovery"] });
  // DB に番兵の接続先を持つ実行でも、公開 DTO には出ない。
  expect(
    (
      await getJson(
        "GET /api/runs/:id",
        "200（DB に番兵の接続先を持つ実行）",
        "/api/runs/run-recovery",
      )
    ).status,
  ).toBe(200);

  expect(
    (
      await postJson("POST /api/recovery/confirm", "200", "/api/recovery/confirm", {
        runId: "run-recovery",
      })
    ).status,
  ).toBe(200);
  expect(
    (await postJson("POST /api/recovery/confirm", "400 validation", "/api/recovery/confirm", {}))
      .status,
  ).toBe(400);
  expect(
    (
      await postJson("POST /api/recovery/confirm", "404", "/api/recovery/confirm", {
        runId: "run-missing",
      })
    ).status,
  ).toBe(404);

  /** 接続設定の更新（最後。走っている実行が無くなってから） ---------------- */

  const putInvalid = await putJson(
    "PUT /api/settings/connection",
    "400 validation（`/v1` 付き。例外の message を転記しない）",
    "/api/settings/connection",
    { endpointUrl: `${SENTINEL_URL}/v1`, apiKey: SENTINEL_API_KEY },
  );
  expect(putInvalid.status).toBe(400);

  const putOk = await putJson(
    "PUT /api/settings/connection",
    "200（番兵の URL を出してよい唯一の場所）",
    "/api/settings/connection",
    { endpointUrl: SENTINEL_URL, apiKey: SENTINEL_API_KEY },
    { endpointUrlAllowed: true },
  );
  expect(putOk.status).toBe(200);
  expect(putOk.json).toEqual({ endpointUrl: SENTINEL_URL, hasApiKey: true });

  /** 表の外（未知の `/api/*`） --------------------------------------------- */

  expect((await getJson(EXTRA, "404（表に無い /api/*）", "/api/nope")).status).toBe(404);
});

afterAll(() => {
  harness.close();
});

/** ---------------------------------------------------------------------- */
/** 検査 */
/** ---------------------------------------------------------------------- */

/** 観測を「どこで見つかったか」まで言える形にする。 */
function where(observation: Observation): string {
  return `${observation.endpoint}（${observation.label}、status ${String(observation.status)}）`;
}

describe("A0：漏えい検査", () => {
  it("失敗経路を実際に通っている（この印が無ければ以下の検査は空振り）", () => {
    const marked = observations.filter((o) => o.text.includes(FAKE_FAILURE_MARKER));
    expect(marked.map(where)).not.toEqual([]);
    // 印が出るのは検査単位の失敗（`GET /api/runs/:id/units`）。
    expect(marked.some((o) => o.endpoint === "GET /api/runs/:id/units")).toBe(true);
  });

  it("SSE の観測に実際のイベントが乗っている（SSE の検査が空振りでない）", () => {
    const sse = observations.filter(
      (o) => o.endpoint === "GET /api/runs/:id/events" && o.status === 200,
    );
    expect(sse.map(where)).toHaveLength(2);
    for (const observation of sse) {
      expect(observation.text).toContain("event: run-settled");
    }
    // 実況の側は決着以外のイベントも運んでいる（線に載る形をひととおり見ている）。
    expect(sse.some((o) => o.text.includes("event: check-finished"))).toBe(true);
  });

  it("正常応答に原稿の番兵が実際に入っている（原稿の検査が空振りでない）", () => {
    const carrying = observations.filter(
      (o) => o.status < 400 && o.text.includes(MANUSCRIPT_SENTINEL),
    );
    expect(carrying.map(where)).not.toEqual([]);
  });

  it("接続先 URL の番兵は、接続設定の正常応答の endpointUrl 以外に出ない", () => {
    const leaked = observations
      .filter((o) => !o.endpointUrlAllowed && o.text.includes(SENTINEL_HOST))
      .map(where);
    expect(leaked).toEqual([]);
  });

  it("例外の 2 つでも、endpointUrl 以外の項目には番兵が出ない", () => {
    const allowed = observations.filter((o) => o.endpointUrlAllowed);
    // 例外は `GET`/`PUT /api/settings/connection` の正常応答の 2 つだけ。
    expect(allowed.map((o) => o.endpoint).sort()).toEqual([
      "GET /api/settings/connection",
      "PUT /api/settings/connection",
    ]);
    for (const observation of allowed) {
      const body = JSON.parse(observation.text) as Record<string, unknown>;
      expect(body.endpointUrl).toBe(SENTINEL_URL);
      const { endpointUrl: _dropped, ...rest } = body;
      expect(JSON.stringify(rest)).not.toContain(SENTINEL_HOST);
    }
  });

  it("API キーの番兵は例外なくどこにも出ない", () => {
    const leaked = observations.filter((o) => o.text.includes(SENTINEL_API_KEY)).map(where);
    expect(leaked).toEqual([]);
  });

  it("原稿の番兵はエラー応答（status >= 400）に出ない", () => {
    const leaked = observations
      .filter((o) => o.status >= 400 && o.text.includes(MANUSCRIPT_SENTINEL))
      .map(where);
    expect(leaked).toEqual([]);
  });

  it("エンドポイント表の全行を正常（2xx）で呼んでいる", () => {
    const missing = ENDPOINTS.filter(
      (endpoint) =>
        !observations.some((o) => o.endpoint === endpoint.key && o.status >= 200 && o.status < 300),
    ).map((endpoint) => endpoint.key);
    expect(missing).toEqual([]);
  });

  it("表がエラーを持つ行は、エラー（4xx）でも呼んでいる", () => {
    const missing = ENDPOINTS.filter(
      (endpoint) =>
        endpoint.hasErrorForm &&
        !observations.some((o) => o.endpoint === endpoint.key && o.status >= 400),
    ).map((endpoint) => endpoint.key);
    expect(missing).toEqual([]);
  });

  it("エンドポイントの一覧が router の登録と一致する（足し忘れの検出）", () => {
    // `createApiRouter` の route だけを数える。`createApp` のアプリを数えると、静的配信の
    // 2 route（`webDistDir` が存在するときだけ付く）が入って件数が構成に左右される。
    const deps: ApiDeps = {
      db: harness.db,
      connection: harness.connection,
      recoveryGate: harness.gate,
      orchestrator: harness.orchestrator,
      hub: harness.hub,
      recoveryConfirmMs: 0,
    };
    const registered = createApiRouter(deps).routes.map(
      (route) => `${route.method} /api${route.path}`,
    );
    expect([...registered].sort()).toEqual([...ENDPOINTS.map((e) => e.key)].sort());
  });
});
