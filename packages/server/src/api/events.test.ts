/**
 * A6：SSE（`GET /api/runs/:id/events`。決定 12・13）。
 *
 * ## 道具立ての選択（手順 1 の前提確認の結果。推測ではなく実測で決めた）
 *
 * 最小の route を書いて hono 4.13.7 の挙動を測った。結果：
 *
 * 1. `app.request(path, { signal })` の abort は **`stream.onAbort` に届かない**。
 *    `hono/helper/streaming/sse` が `c.req.raw.signal` を購読するのは `isOldBunVersion()` の
 *    ときだけで、Node ではその配線が無い（測定：`aborted = false`）。
 * 2. 応答本文の `cancel()`（`res.body.cancel()` / reader の `cancel()`）は `onAbort` に**届く**
 *    （`StreamingApi` が `responseReadable` の `cancel` で `abort()` を呼ぶ）。
 * 3. `@hono/node-server` の `serve` で立てた実 HTTP に対する `fetch` の abort も `onAbort` に**届く**。
 *
 * よって、ブリーフの指示どおり **A6 は `@hono/node-server` を任意ポート（0）で立てた実 HTTP で書く**
 * （`lmstudio/client.test.ts` の C47・C51 と同じ道具立て）。切断は「実際の HTTP 接続の切断」で起こす。
 *
 * ## もう 1 つの実測（ブリーフの前提との差）
 *
 * hono 4.13.7 の `StreamingApi.write` は `try { await writer.write() } catch {}` で書き込みの失敗を
 * **握りつぶす**。したがって「閉じた応答へ書くと `writeSSE` が reject する」は成り立たない
 * （測定：cancel 後の `writeSSE` は 3 回とも resolve した）。切断は書き込みの reject ではなく
 * `onAbort` として観測される。決定 12 の chain の `.catch(finish)` は多重防御であり、
 * **この版では到達しない**（テストでも覆えていない）。切断時に要求される観測可能な結末——購読の解除、
 * ストリームの完了、以後の書き込みなし——は下の「閉じた応答」のテストで押さえている。
 *
 * ## 書き方の約束
 *
 * - 実時間の長さは主張しない（観測できた列だけを主張する）。待ちは `waitFor` で余裕を持たせる。
 * - ループを起こしたテストは `waitSettled` で決着を待ってから終わる（`api/runs.test.ts` と同じ規則）。
 */

import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import {
  ALLOWED_WORD_RULE_VERSION,
  DIAGNOSTIC_TRANSFORM_VERSION,
  PROMPT_VERSION,
} from "@shuten/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunRecord } from "../db/records.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { insertRun } from "../db/repositories/runs.ts";
import type { RunEventHub } from "../run/event-hub.ts";
import type { RunEvent } from "../run/events.ts";
import type { CheckUnitResult, RunStop } from "../run/result.ts";
import type { ChatStep } from "../run/test-support.ts";
import { toRunEventDto } from "./events.ts";
import type { ApiHarness } from "./test-support.ts";
import { createHarnessRegistry, JSON_HEADERS, waitSettled } from "./test-support.ts";

const { open } = createHarnessRegistry();

/** 20 書記素・1 段落（`api/runs.test.ts` と同じ素材）。 */
const BODY = "あいうえおかきくけこさしすせそたちつてと";

/** `[0,10)` `[10,20)` の 2 対象に割れる設定。 */
const CHUNK_TWO_TARGETS = {
  targetGraphemes: 10,
  contextGraphemes: 0,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 50,
};

/** ---------------------------------------------------------------------- */
/** 実 HTTP サーバー */
/** ---------------------------------------------------------------------- */

const servers: ServerType[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    // 生きている接続を先に切る。切らないと keep-alive の分だけ `close` が待たされる。
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

/** ハーネスのアプリを任意ポート（0）のループバックで立て、`http://127.0.0.1:<port>` を返す。 */
async function startServer(harness: ApiHarness): Promise<string> {
  let server!: ServerType;
  const info = await new Promise<AddressInfo>((resolve) => {
    server = serve({ fetch: harness.app.fetch, hostname: "127.0.0.1", port: 0 }, resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${info.port}`;
}

/** ---------------------------------------------------------------------- */
/** SSE の読み手 */
/** ---------------------------------------------------------------------- */

interface SseFrame {
  readonly event: string | null;
  readonly data: string;
}

interface SseClient {
  readonly status: number;
  /** 受け取ったイベント（`event:` + `data:`）。 */
  readonly frames: SseFrame[];
  /** 受け取ったコメント行（`: ping` など）。 */
  readonly comments: string[];
  /** 受け取った本文そのまま（`id:` を付けていないことなどを見る）。 */
  raw(): string;
  /** 本文の読み取りが終わったか（終端に達した／切れた）。 */
  ended(): boolean;
  /** 読み取りが例外で終わったならその値。正常終端なら null。 */
  failure(): unknown;
  /** 応答本文を取り消す（クライアント切断）。 */
  cancel(): Promise<void>;
}

/**
 * SSE を開いて背景で読み続ける。フレームは `\n\n` 区切りで**跨いだ読み取りも繋いで**解釈する
 * （1 回の書き込み＝1 チャンクとは限らない）。
 */
async function openSse(origin: string, path: string, init?: RequestInit): Promise<SseClient> {
  const response = await fetch(`${origin}${path}`, init);
  const frames: SseFrame[] = [];
  const comments: string[] = [];
  let text = "";
  let ended = false;
  let failure: unknown = null;

  const body = response.body;
  if (body === null) {
    throw new Error("応答本文がありません");
  }
  const reader = body.getReader();

  function consume(block: string): void {
    const lines = block.split("\n");
    let event: string | null = null;
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) {
        comments.push(line);
      } else if (line.startsWith("event: ")) {
        event = line.slice("event: ".length);
      } else if (line.startsWith("data: ")) {
        data.push(line.slice("data: ".length));
      }
    }
    if (data.length > 0 || event !== null) {
      frames.push({ event, data: data.join("\n") });
    }
  }

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        const decoded = decoder.decode(chunk.value, { stream: true });
        text += decoded;
        buffer += decoded;
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          consume(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      failure = error;
    }
    ended = true;
  })();

  return {
    status: response.status,
    frames,
    comments,
    raw: () => text,
    ended: () => ended,
    failure: () => failure,
    cancel: async () => {
      await reader.cancel();
    },
  };
}

/**
 * このファイルのテスト上限（裁定 R18）。実 HTTP と実タイマーを使うので vitest の既定（5 秒）より広げる。
 *
 * **`WAIT_BUDGET_MS` と対で調整すること。** 1 つのテストの中で `waitFor` は多くて 4 回並ぶので、
 * `TEST_TIMEOUT_MS > WAIT_BUDGET_MS * 4` を保つ。これが崩れると、条件が満たされないときに
 * `waitFor` の名札付きの例外ではなく vitest の無名のタイムアウトで落ち、診断が失われる。
 */
const TEST_TIMEOUT_MS = 20_000;

/** `waitFor` 1 回あたりの待ちの上限（実時間）。反復回数ではなく実時間で測る（CI の遅さに依らない）。 */
const WAIT_BUDGET_MS = 4_000;

/** `waitFor` の間隔。短くしても待ちの上限は `WAIT_BUDGET_MS` のまま。 */
const WAIT_POLL_MS = 2;

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

/** 条件が満たされるまで待つ（実タイマー）。満たされなければ**名札付きで**落とす。 */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`条件が満たされませんでした: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}

/** 「起きないこと」を見る前の猶予。長さそのものは主張しない。 */
async function settleTicks(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** ---------------------------------------------------------------------- */
/** hub の観測（購読・解除・配信の回数） */
/** ---------------------------------------------------------------------- */

interface HubSpy {
  subscribes(): number;
  unsubscribes(): number;
  /** SSE の購読者に配信された回数（＝書き込みを試みうる回数）。 */
  deliveries(): number;
}

/**
 * `hub.subscribe` を包んで、購読・解除・配信の回数を数える。`ApiDeps` が持つのはハーネスと
 * **同じオブジェクト**なので、この差し替えは route から見える（route は呼び出しのたびに
 * `deps.hub.subscribe` を引く）。「切断のあと購読が解除され、以後 `emit` しても書き込みが
 * 試みられない」を外から観測する唯一の継ぎ目なので、テストの中だけで使う。
 */
function spyOnHub(hub: RunEventHub): HubSpy {
  const original = hub.subscribe;
  let subscribes = 0;
  let unsubscribes = 0;
  let deliveries = 0;

  (hub as { subscribe: RunEventHub["subscribe"] }).subscribe = (runId, subscriber) => {
    subscribes += 1;
    const unsubscribe = original(runId, {
      onEvent: (event) => {
        deliveries += 1;
        subscriber.onEvent(event);
      },
      onClose: () => subscriber.onClose(),
    });
    return () => {
      unsubscribes += 1;
      unsubscribe();
    };
  };

  return {
    subscribes: () => subscribes,
    unsubscribes: () => unsubscribes,
    deliveries: () => deliveries,
  };
}

/** ---------------------------------------------------------------------- */
/** 状態を作り込む実行 */
/** ---------------------------------------------------------------------- */

interface SeedRunOptions {
  readonly runId: string;
  readonly status: RunRecord["status"];
  readonly stopReason?: RunRecord["stopReason"];
}

/** 原稿版と実行を 1 件ずつ作る（SSE は検査対象・単位を読まないので実行の行だけでよい）。 */
function seedRun(harness: ApiHarness, options: SeedRunOptions): void {
  const manuscriptVersionId = `mv-${options.runId}`;
  insertManuscriptVersion(harness.db, { id: manuscriptVersionId, name: "原稿", body: BODY });
  insertRun(harness.db, {
    id: options.runId,
    manuscriptVersionId,
    modelId: "model-a",
    modelInfo: null,
    endpointUrl: harness.connection.current().endpointUrl,
    generationSettings: { maxTokens: 512, temperature: 0 },
    chunkSettings: CHUNK_TWO_TARGETS,
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: false,
    allowedWords: [],
    allowedWordRuleVersion: ALLOWED_WORD_RULE_VERSION,
    promptVersion: PROMPT_VERSION,
    diagnosticTransformVersion: DIAGNOSTIC_TRANSFORM_VERSION,
    status: options.status,
    stopReason: options.stopReason ?? null,
    stopMessage: null,
    generationUnconfirmed: false,
    startOperationId: `seed-${options.runId}`,
    finishedAt: null,
  });
}

const ABORTED_STOP: RunStop = {
  reason: "aborted",
  message: "停止要求を受け付けた",
  failure: null,
  generationUnconfirmed: false,
};

function runEvent(runId: string, event: RunEvent["event"]): RunEvent {
  return { runId, event };
}

function frameData(client: SseClient, index: number): Record<string, unknown> {
  const frame = client.frames[index];
  if (frame === undefined) {
    throw new Error(`フレーム ${index} がありません`);
  }
  return JSON.parse(frame.data) as Record<string, unknown>;
}

/** ---------------------------------------------------------------------- */
/** 射影（`toRunEventDto`） */
/** ---------------------------------------------------------------------- */

describe("toRunEventDto", () => {
  it("check-finished は対象・観点・状態だけを写し、CheckUnitResult の中身を持ち出さない", () => {
    const result: CheckUnitResult = {
      status: "done",
      targetIndex: 3,
      perspective: "naturalness",
      attempts: 2,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, reasoningTokens: null },
      inputGraphemes: 40,
      elapsedMs: 50,
      findingCount: 1,
    };
    expect(toRunEventDto(runEvent("r1", { type: "check-finished", result }))).toEqual({
      type: "check-finished",
      targetIndex: 3,
      perspective: "naturalness",
      status: "done",
    });
  });

  it("recheck-finished の disabled / suppressed は not-applicable + 理由に写る", () => {
    expect(
      toRunEventDto(
        runEvent("r1", {
          type: "recheck-finished",
          findingId: "f1",
          result: { status: "disabled" },
        }),
      ),
    ).toEqual({
      type: "recheck-finished",
      findingId: "f1",
      status: "not-applicable",
      notApplicableReason: "disabled",
    });
    expect(
      toRunEventDto(
        runEvent("r1", {
          type: "recheck-finished",
          findingId: "f2",
          result: { status: "suppressed" },
        }),
      ),
    ).toEqual({
      type: "recheck-finished",
      findingId: "f2",
      status: "not-applicable",
      notApplicableReason: "suppressed",
    });
  });

  it("recheck-finished の pending / failed / done はそのまま（理由は null）", () => {
    expect(
      toRunEventDto(
        runEvent("r1", {
          type: "recheck-finished",
          findingId: "f1",
          result: { status: "pending", attempts: 0, inputRange: null, note: "停止" },
        }),
      ),
    ).toEqual({
      type: "recheck-finished",
      findingId: "f1",
      status: "pending",
      notApplicableReason: null,
    });
  });

  it("target-planned の範囲は start / end だけを写す（余分な項目を線上に出さない）", () => {
    const target = { start: 0, end: 10, paragraphIds: [0] } as unknown as {
      start: number;
      end: number;
    };
    expect(
      toRunEventDto(
        runEvent("r1", {
          type: "target-planned",
          targetIndex: 0,
          target,
          input: { start: 0, end: 10 },
        }),
      ),
    ).toEqual({
      type: "target-planned",
      targetIndex: 0,
      target: { start: 0, end: 10 },
      input: { start: 0, end: 10 },
    });
  });

  it("run-settled の stopReason は stop.reason（stop が null なら null）", () => {
    expect(
      toRunEventDto(runEvent("r1", { type: "run-settled", status: "stopped", stop: ABORTED_STOP })),
    ).toEqual({ type: "run-settled", status: "stopped", stopReason: "aborted" });
    expect(
      toRunEventDto(runEvent("r1", { type: "run-settled", status: "completed", stop: null })),
    ).toEqual({ type: "run-settled", status: "completed", stopReason: null });
  });

  it("オーケストレーターが出さない run-started / run-finished は例外にする（PR9b 決定 37）", () => {
    expect(() =>
      toRunEventDto(runEvent("r1", { type: "run-started", targetCount: 1, unitCount: 1 })),
    ).toThrow(/run-started/);
    expect(() =>
      toRunEventDto(runEvent("r1", { type: "run-finished", status: "completed", stop: null })),
    ).toThrow(/run-finished/);
  });
});

/** ---------------------------------------------------------------------- */
/** route */
/** ---------------------------------------------------------------------- */

describe("GET /api/runs/:id/events", () => {
  it("存在しない実行は 404", async () => {
    const harness = open();
    const origin = await startServer(harness);
    const res = await fetch(`${origin}/api/runs/missing/events`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not-found");
  });

  it("終端状態の実行は合成した run-settled を 1 件送って閉じる", async () => {
    const harness = open();
    seedRun(harness, { runId: "run-stopped", status: "stopped", stopReason: "aborted" });
    const origin = await startServer(harness);

    const client = await openSse(origin, "/api/runs/run-stopped/events");
    await waitFor(() => client.ended(), "ストリームが閉じる");

    expect(client.status).toBe(200);
    expect(client.frames).toEqual([
      {
        event: "run-settled",
        data: JSON.stringify({ type: "run-settled", status: "stopped", stopReason: "aborted" }),
      },
    ]);
    expect(client.failure()).toBeNull();
    // 再送はしないので `id:` は付けない（決定 12 の 6）。
    expect(client.raw()).not.toContain("id:");
  });

  it("購読したあとに決着すると run-settled が届いて閉じる", async () => {
    const harness = open();
    seedRun(harness, { runId: "run-live", status: "running" });
    const origin = await startServer(harness);

    const client = await openSse(origin, "/api/runs/run-live/events");
    harness.hub.emit(
      runEvent("run-live", { type: "run-settled", status: "stopped", stop: ABORTED_STOP }),
    );

    await waitFor(() => client.ended(), "ストリームが閉じる");
    expect(client.frames).toEqual([
      {
        event: "run-settled",
        data: JSON.stringify({ type: "run-settled", status: "stopped", stopReason: "aborted" }),
      },
    ]);
  });

  it("check-finished の data に CheckUnitResult の中身（usage など）が入らない", async () => {
    const harness = open();
    seedRun(harness, { runId: "run-live", status: "running" });
    const origin = await startServer(harness);

    const client = await openSse(origin, "/api/runs/run-live/events");
    harness.hub.emit(
      runEvent("run-live", {
        type: "check-finished",
        result: {
          status: "done",
          targetIndex: 1,
          perspective: "typo",
          attempts: 1,
          usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33, reasoningTokens: 44 },
          inputGraphemes: 55,
          elapsedMs: 66,
          findingCount: 7,
        },
      }),
    );

    await waitFor(() => client.frames.length === 1, "check-finished が届く");
    expect(client.frames[0]?.event).toBe("check-finished");
    expect(frameData(client, 0)).toEqual({
      type: "check-finished",
      targetIndex: 1,
      perspective: "typo",
      status: "done",
    });
    for (const leak of [
      "usage",
      "promptTokens",
      "attempts",
      "inputGraphemes",
      "elapsedMs",
      "findingCount",
    ]) {
      expect(client.raw()).not.toContain(leak);
    }
  });

  it("同期に出した 3 件が送った順で届く", async () => {
    const harness = open();
    seedRun(harness, { runId: "run-live", status: "running" });
    const origin = await startServer(harness);

    const client = await openSse(origin, "/api/runs/run-live/events");
    harness.hub.emit(
      runEvent("run-live", { type: "check-started", targetIndex: 0, perspective: "typo" }),
    );
    harness.hub.emit(
      runEvent("run-live", { type: "target-merged", targetIndex: 0, findingCount: 2 }),
    );
    harness.hub.emit(runEvent("run-live", { type: "recheck-started", findingId: "f1" }));

    await waitFor(() => client.frames.length === 3, "3 件届く");
    expect(client.frames.map((frame) => frame.event)).toEqual([
      "check-started",
      "target-merged",
      "recheck-started",
    ]);
    expect(frameData(client, 1)).toEqual({
      type: "target-merged",
      targetIndex: 0,
      findingCount: 2,
    });
  });

  it("閉じた応答（クライアント切断）で購読が解除され、以後 emit しても配信されない", async () => {
    const harness = open();
    const spy = spyOnHub(harness.hub);
    seedRun(harness, { runId: "run-live", status: "running" });
    const origin = await startServer(harness);

    const client = await openSse(origin, "/api/runs/run-live/events");
    harness.hub.emit(runEvent("run-live", { type: "stop-requested" }));
    await waitFor(() => client.frames.length === 1, "最初のイベントが届く");

    await client.cancel();
    await waitFor(() => spy.unsubscribes() === 1, "購読が解除される");

    const before = spy.deliveries();
    harness.hub.emit(runEvent("run-live", { type: "stop-requested" }));
    harness.hub.emit(
      runEvent("run-live", { type: "check-started", targetIndex: 0, perspective: "typo" }),
    );
    await settleTicks();

    // 購読が外れているので配信されない＝書き込みも試みられない。
    expect(spy.deliveries()).toBe(before);
    expect(client.frames.length).toBe(1);
  });

  it("closeAll で待機中の応答が完了する（本文の読み取りが終端に達する）", async () => {
    const harness = open();
    seedRun(harness, { runId: "run-live", status: "running" });
    const origin = await startServer(harness);

    const client = await openSse(origin, "/api/runs/run-live/events");
    harness.hub.emit(runEvent("run-live", { type: "stop-requested" }));
    await waitFor(() => client.frames.length === 1, "最初のイベントが届く");

    harness.hub.closeAll();

    await waitFor(() => client.ended(), "ストリームが完了する");
    expect(client.failure()).toBeNull();
  });

  it(": ping が注入した間隔で届く", async () => {
    const harness = open({ ssePingIntervalMs: 20 });
    seedRun(harness, { runId: "run-live", status: "running" });
    const origin = await startServer(harness);

    const client = await openSse(origin, "/api/runs/run-live/events");
    await waitFor(() => client.comments.length >= 2, "心拍が 2 回届く");
    expect(client.comments.every((comment) => comment === ": ping")).toBe(true);
    expect(client.frames).toEqual([]);
  });

  it("購読が閉じたら心拍のタイマーも止まる（clearInterval。裁定 R18）", async () => {
    // 他の何とも重ならない間隔にして、SSE の心拍のタイマーだけを見分ける。
    const PING_MS = 37;
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    try {
      const harness = open({ ssePingIntervalMs: PING_MS });
      seedRun(harness, { runId: "run-live", status: "running" });
      const origin = await startServer(harness);

      const client = await openSse(origin, "/api/runs/run-live/events");
      await waitFor(() => client.comments.length >= 2, "心拍が 2 回届く");

      const pingTimers = setSpy.mock.calls
        .map((call, index) => ({ delay: call[1], result: setSpy.mock.results[index] }))
        .filter((entry) => entry.delay === PING_MS);
      expect(pingTimers.length).toBe(1);
      const handle = pingTimers[0]?.result?.value;

      const received = client.comments.length;
      harness.hub.closeAll();
      await waitFor(() => client.ended(), "ストリームが完了する");
      await settleTicks();

      // 線上で見えるのはここまで（閉じたあとの書き込みは握りつぶされるので、心拍が止まったかは
      // 本文だけでは見分けられない）。**タイマーが実際に止められたか**は handle で確かめる。
      expect(client.comments.length).toBe(received);
      expect(clearSpy.mock.calls.some((call) => call[0] === handle)).toBe(true);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it("決定 3: スキーマに通らないイベントは書かずに購読を閉じる", async () => {
    const harness = open();
    const spy = spyOnHub(harness.hub);
    seedRun(harness, { runId: "run-live", status: "running" });
    const origin = await startServer(harness);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const client = await openSse(origin, "/api/runs/run-live/events");
      // 観点の語彙にない値。射影は通るがスキーマで落ちる（線上に出してはならない値）。
      harness.hub.emit(
        runEvent("run-live", {
          type: "check-started",
          targetIndex: 0,
          perspective: "bogus",
        } as unknown as RunEvent["event"]),
      );

      await waitFor(() => client.ended(), "ストリームが閉じる");
      expect(client.frames).toEqual([]);
      expect(spy.unsubscribes()).toBe(1);
      // ログに載せるのは種別だけ（値は載せない）。
      expect(logged).toHaveBeenCalledWith("SSE event rejected by schema", "check-started");
    } finally {
      logged.mockRestore();
    }
  });

  it("クライアント切断は実行を止めない（切断後もフェイクの chat 回数が増える）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 最初の 1 件だけ門で止め、以降は解釈不能で失敗させる（単位は failed になるが実行は続く）。
    const steps: ChatStep[] = [
      async ({ failure }) => {
        await gate;
        throw failure("malformed");
      },
      ...Array.from(
        { length: 3 },
        (): ChatStep =>
          ({ failure }) => {
            throw failure("malformed");
          },
      ),
    ];
    const harness = open({ steps });
    const spy = spyOnHub(harness.hub);
    const origin = await startServer(harness);

    const created = await fetch(`${origin}/api/manuscripts`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "原稿A", body: BODY }),
    });
    expect(created.status).toBe(201);
    const manuscriptVersionId = ((await created.json()) as { id: string }).id;

    const started = await fetch(`${origin}/api/runs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        startOperationId: "op-sse-1",
        manuscriptVersionId,
        modelId: "model-a",
        generation: { maxTokens: 512, temperature: 0 },
        chunkSettings: CHUNK_TWO_TARGETS,
        timeouts: { checkMs: 60_000, recheckMs: 60_000 },
        perspectives: ["typo"],
        recheckEnabled: false,
        allowedWordsRaw: "",
      }),
    });
    expect(started.status).toBe(201);
    const runId = ((await started.json()) as { id: string }).id;

    const controller = new AbortController();
    const client = await openSse(origin, `/api/runs/${runId}/events`, {
      signal: controller.signal,
    });
    // 最初の生成要求が門で止まっている（＝実行中）ことを確かめてから切る。購読が始まっている
    // ことは購読数で見る（開始直後のイベントは購読より前に出ているし、再送はしない）。
    await waitFor(() => harness.client.requests.length === 1, "最初の生成要求が送られる");
    await waitFor(() => spy.subscribes() === 1, "SSE の購読が始まる");
    expect(client.ended()).toBe(false);

    controller.abort();
    await waitFor(() => spy.unsubscribes() === 1, "切断で購読が解除される");
    expect(harness.client.requests.length).toBe(1);

    // 切断のあとも実行は進む（2 対象 × 1 観点、malformed は 1 回だけ再試行するので計 4 要求）。
    release();
    await waitFor(() => harness.client.requests.length === 4, "切断後も生成要求が増える");

    const settled = await waitSettled(harness.hub, harness.db, runId);
    expect(settled.status).not.toBe("running");
  });
});
