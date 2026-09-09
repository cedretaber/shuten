/**
 * 停止・再開・失敗単位の個別再試行のテスト（決定 6・20・21・23・26・32・33・36・39）。
 *
 * `run/loop.test.ts` が「1 回のループが最後まで回る」ことを見るのに対し、ここでは
 * **ループの外から状態を動かす 3 つの入口**（`stopRun` / `resumeRun` / `retryFailedUnits`）と、
 * それらが `run/recovery.ts` の停止ゲート・`run/recovery-gate.ts` の復旧ゲートとどう噛み合うかを見る。
 */

import type { ChunkSettings, FindingCategory, InitialVerdict, LlmFinding } from "@shuten/shared";
import {
  ALLOWED_WORD_RULE_VERSION,
  DIAGNOSTIC_TRANSFORM_VERSION,
  PROMPT_VERSION,
} from "@shuten/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { createDatabase } from "../db/client.ts";
import { applyMigrations } from "../db/migrate.ts";
import type { CheckUnitRecord, RunRecord } from "../db/records.ts";
import { insertCheckUnit, listCheckUnits } from "../db/repositories/check-units.ts";
import {
  insertFinding,
  listCandidatesForFinding,
  listFindings,
} from "../db/repositories/findings.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { insertRecheckUnit, listRecheckUnits } from "../db/repositories/rechecks.ts";
import { findRun, insertRun, insertRunTarget } from "../db/repositories/runs.ts";
import { runs as runsTable } from "../db/schema.ts";
import { LmStudioError } from "../lmstudio/errors.ts";
import type {
  ChatRequest,
  ChatResult,
  LmStudioClient,
  ModelInfo,
  Usage,
} from "../lmstudio/types.ts";
import type { RunEvent } from "./events.ts";
import type { Orchestrator, OrchestratorDeps, StartRunInput } from "./orchestrator.ts";
import { createOrchestrator, RetryTargetError } from "./orchestrator.ts";
import { PersistBoundaryError } from "./persist.ts";
import { createRequestQueue } from "./queue.ts";
import type { RecoveryGate } from "./recovery-gate.ts";
import { createRecoveryGate } from "./recovery-gate.ts";

/** ---------------------------------------------------------------------- */
/** 素材 */
/** ---------------------------------------------------------------------- */

/** 20 書記素・1 段落。同じ文字が 2 度出ないので、どの部分文字列の位置確定も決定的になる。 */
const BODY = "あいうえおかきくけこさしすせそたちつてと";

/** 本文全体（20 書記素）が 1 対象になる設定。参考文脈なし。 */
const CHUNK_ONE_TARGET: ChunkSettings = {
  targetGraphemes: 20,
  contextGraphemes: 0,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 50,
};

/**
 * `targetGraphemes` が 1 未満なので `planTargets` が `InvalidChunkSettingsError` を投げる設定。
 * `startRun` は対象も検査単位も 1 件も作らずに `stopped`（`settings`）を書く（決定 18）。
 */
const CHUNK_INVALID_SETTINGS: ChunkSettings = {
  targetGraphemes: 0,
  contextGraphemes: 0,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 50,
};

/**
 * 20 書記素の `BODY` が `[0,10)` `[10,20)` の 2 対象に割れ、どちらも参考文脈 5 書記素を足すと
 * 15 > `maxInputGraphemes` で `buildCheckInput` が `InputTooLongError` を投げる設定。
 * `startRun` は全単位を `failed`（`input-too-long`）で作りつつ実行を `stopped`（`settings`）にする（決定 18）。
 */
const CHUNK_TOO_LONG: ChunkSettings = {
  targetGraphemes: 10,
  contextGraphemes: 5,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 10,
};

/** 停止ゲートの上限。これを超えると打ち切る（決定 6）。 */
const RECOVERY_CONFIRM_MS = 60_000;

const USAGE: Usage = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  reasoningTokens: null,
};

const LOADED_MODEL: ModelInfo = {
  id: "model-a",
  type: "llm",
  state: "loaded",
  quantization: null,
  maxContextLength: 4096,
  loadedContextLength: 2048,
};

function setupDb() {
  const { db } = createDatabase(":memory:");
  applyMigrations(db);
  return db;
}

type Db = ReturnType<typeof setupDb>;

function finding(
  quote: string,
  suggestion: string | null,
  category: FindingCategory = "notation",
  verdict: InitialVerdict = "likely-error",
): LlmFinding {
  return {
    paragraphId: 0,
    quote,
    before: "",
    after: "",
    category,
    reason: "理由",
    suggestion,
    verdict,
  };
}

function chatResult(content: string): ChatResult {
  return { content, reasoningContent: null, finishReason: "stop", usage: USAGE, raw: {} };
}

function checkResponse(findings: readonly LlmFinding[]): ChatResult {
  return chatResult(JSON.stringify({ findings }));
}

function recheckResponse(): ChatResult {
  return chatResult(
    JSON.stringify({
      reason: "誤りである",
      reasonKind: "error-confirmed",
      verdict: "keep",
      suggestionValid: true,
    }),
  );
}

/** 生成中に応答を受け取れずに切断した（`generationUnconfirmed: true` になる作り方）。 */
function connectionLost(): LmStudioError {
  return new LmStudioError("connection", "応答を受け取れずに切断した", { status: null });
}

/** ハード上限を超えた（決定 7）。 */
function timedOut(): LmStudioError {
  return new LmStudioError("timeout", "生成要求がタイムアウトした", { raw: null });
}

/** 中断された（停止ゲートの `abort()` に反応する経路）。 */
function abortedError(): LmStudioError {
  return new LmStudioError("aborted", "生成要求が中断された", { raw: null });
}

/**
 * `signal` が落ちるまで解決しない `chat` の応答。落ちたら `aborted` で reject する。
 * 実際の `LmStudioClient` が `AbortSignal` を受けて返す形（`lmstudio/client.ts`）を模す。
 */
function rejectOnAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      reject(abortedError());
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(abortedError());
      },
      { once: true },
    );
  });
}

/** 外から解決・拒否できる Promise。 */
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: (value) => resolve(value), reject: (error) => reject(error) };
}

/** 1 回の生成要求への応答を決める関数。 */
type ChatStep = (context: {
  readonly request: ChatRequest;
  readonly index: number;
  readonly signal: AbortSignal | undefined;
}) => ChatResult | Promise<ChatResult>;

interface ScriptedClient {
  readonly client: LmStudioClient;
  readonly requests: ChatRequest[];
  readonly ensureLoadedCalls: string[];
}

/**
 * 台本どおりに応答するモック。台本を使い切ったあとに要求が来たら例外にする
 * （「送らないはずの生成要求」を黙って成功させない）。
 */
function scriptedClient(
  steps: readonly ChatStep[],
  options: { readonly ensureLoaded?: () => Promise<ModelInfo> } = {},
): ScriptedClient {
  const requests: ChatRequest[] = [];
  const ensureLoadedCalls: string[] = [];
  const client: LmStudioClient = {
    listModels: () => Promise.resolve([LOADED_MODEL]),
    ensureLoaded: (modelId) => {
      ensureLoadedCalls.push(modelId);
      return options.ensureLoaded?.() ?? Promise.resolve(LOADED_MODEL);
    },
    chat: async (request, chatOptions) => {
      const index = requests.length;
      requests.push(request);
      const step = steps[index];
      if (step === undefined) {
        throw new Error(`台本にない生成要求（${String(index)} 件目）`);
      }
      return await step({ request, index, signal: chatOptions.signal });
    },
  };
  return { client, requests, ensureLoadedCalls };
}

function idSequence(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `id-${String(count)}`;
  };
}

interface Harness {
  readonly db: Db;
  readonly events: RunEvent[];
  readonly deps: OrchestratorDeps;
  readonly recoveryGate: RecoveryGate;
  readonly orchestrator: Orchestrator;
}

function makeHarness(client: LmStudioClient, overrides: Partial<OrchestratorDeps> = {}): Harness {
  const db = setupDb();
  insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
  const events: RunEvent[] = [];
  const recoveryGate = overrides.recoveryGate ?? createRecoveryGate();
  const deps: OrchestratorDeps = {
    db,
    client,
    queue: createRequestQueue(),
    recoveryGate,
    endpointUrl: "http://127.0.0.1:1234",
    recoveryConfirmMs: RECOVERY_CONFIRM_MS,
    createId: idSequence(),
    onEvent: (event) => events.push(event),
    ...overrides,
  };
  return { db, events, deps, recoveryGate, orchestrator: createOrchestrator(deps) };
}

function baseInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    startOperationId: "op-1",
    manuscriptVersionId: "mv1",
    modelId: "model-a",
    generation: { maxTokens: 512, temperature: 0 },
    chunkSettings: CHUNK_ONE_TARGET,
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo", "naturalness"],
    recheckEnabled: false,
    allowedWordsRaw: "",
    ...overrides,
  };
}

function eventTypes(events: readonly RunEvent[]): string[] {
  return events.map((entry) => entry.event.type);
}

/** DB から実行を読み直す（テストの断定はすべて DB の値で行う）。 */
function readRun(db: Db, runId: string): RunRecord {
  const run = findRun(db, runId);
  if (run === null) {
    throw new Error(`実行が見つかりません（実行 ID: ${runId}）`);
  }
  return run;
}

function unitsOf(db: Db, runId: string): CheckUnitRecord[] {
  return listCheckUnits(db, runId);
}

/** ---------------------------------------------------------------------- */
/** 手で組み立てた実行（`startRun` を経由せずに「途中まで進んだ実行」を再現する） */
/** ---------------------------------------------------------------------- */

interface SeededRun {
  readonly run: RunRecord;
  readonly targetId: string;
  readonly units: readonly CheckUnitRecord[];
}

interface SeedRunInput {
  readonly runId: string;
  readonly status: RunRecord["status"];
  /** `perspectives`（typo, naturalness の順）に対応する検査単位の状態。 */
  readonly unitStatuses: readonly CheckUnitRecord["status"][];
  readonly recheckEnabled?: boolean;
  /** `failed` の単位に入れる失敗理由（省略時は `malformed`）。 */
  readonly failureReason?: "malformed" | "input-too-long";
  readonly manuscriptVersionId?: string;
  /**
   * 保存済みの版（既定は現行の定数）。決定 45-1 の検査に引っかかるケースを作るときだけ上書きする。
   * 既定を定数にしてあるので、定数が上がっても他のテストは再開・再試行を受け付けるままになる。
   */
  readonly promptVersion?: string;
  readonly allowedWordRuleVersion?: string;
  readonly diagnosticTransformVersion?: string;
}

function seedRun(db: Db, input: SeedRunInput): SeededRun {
  const perspectives = (["typo", "naturalness"] as const).slice(0, input.unitStatuses.length);
  const run = insertRun(db, {
    id: input.runId,
    manuscriptVersionId: input.manuscriptVersionId ?? "mv1",
    modelId: "model-a",
    modelInfo: null,
    endpointUrl: "http://127.0.0.1:1234",
    generationSettings: { maxTokens: 512, temperature: 0 },
    chunkSettings: CHUNK_ONE_TARGET,
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    recoveryConfirmMs: RECOVERY_CONFIRM_MS,
    perspectives,
    recheckEnabled: input.recheckEnabled ?? false,
    allowedWords: [],
    allowedWordRuleVersion: input.allowedWordRuleVersion ?? ALLOWED_WORD_RULE_VERSION,
    promptVersion: input.promptVersion ?? PROMPT_VERSION,
    diagnosticTransformVersion: input.diagnosticTransformVersion ?? DIAGNOSTIC_TRANSFORM_VERSION,
    status: input.status,
    stopReason: input.status === "running" ? null : "aborted",
    stopMessage: input.status === "running" ? null : "前回の停止",
    generationUnconfirmed: input.status === "recovery-waiting",
    stopRequestedAt: input.status === "running" ? null : new Date(1000),
    startOperationId: null,
    finishedAt: input.status === "running" ? null : new Date(2000),
  });
  const target = insertRunTarget(db, {
    id: `${input.runId}-t0`,
    runId: run.id,
    targetIndex: 0,
    target: { start: 0, end: BODY.length },
    contextBefore: null,
    contextAfter: null,
    input: { start: 0, end: BODY.length },
    paragraphIds: [0],
  });
  const units = input.unitStatuses.map((status, index) => {
    const perspective = perspectives[index];
    if (perspective === undefined) {
      throw new Error("unitStatuses が perspectives より長い");
    }
    return insertCheckUnit(db, {
      id: `${input.runId}-cu${String(index)}`,
      runId: run.id,
      targetId: target.id,
      perspective,
      status,
      attempts: status === "pending" ? 0 : 2,
      failure:
        status === "failed"
          ? {
              reason: input.failureReason ?? "malformed",
              message: "解析できなかった",
              finishReason: null,
              origin: input.failureReason === "input-too-long" ? "local" : "chat",
            }
          : null,
      pendingNote: null,
      usage: null,
      inputGraphemes: null,
      elapsedMs: status === "pending" ? null : 1,
      startedAt: null,
      finishedAt: status === "pending" ? null : new Date(2000),
    });
  });
  return { run, targetId: target.id, units };
}

/** 位置確定済みの指摘を 1 件作る（`insertFinding` は judgments も同時に作る）。 */
function seedFinding(db: Db, seeded: SeededRun, quote: string, start: number, end: number) {
  return insertFinding(db, {
    id: `${seeded.run.id}-f0`,
    runId: seeded.run.id,
    manuscriptVersionId: "mv1",
    targetId: seeded.targetId,
    locateStatus: "located",
    range: { start, end },
    paragraphId: 0,
    quote,
    suggestion: `${quote}の修正案`,
    category: "notation",
    initialVerdict: "likely-error",
    mergeKey: `${String(start)}:${String(end)}:${JSON.stringify(quote)}`,
    suppression: null,
  });
}

/** 指摘 1 件と、その再確認単位を作る。 */
function seedRecheckUnit(
  db: Db,
  seeded: SeededRun,
  status: "pending" | "failed",
): { readonly recheckUnitId: string; readonly findingId: string } {
  const record = seedFinding(db, seeded, "うえ", 2, 4);
  const recheckUnitId = `${seeded.run.id}-ru0`;
  insertRecheckUnit(db, {
    id: recheckUnitId,
    runId: seeded.run.id,
    findingId: record.id,
    inputRange: null,
    status,
    notApplicableReason: null,
    attempts: status === "failed" ? 2 : 0,
    failure:
      status === "failed"
        ? { reason: "malformed", message: "解析できなかった", finishReason: null, origin: "chat" }
        : null,
    pendingNote: null,
    verdict: null,
    reasonKind: null,
    reason: null,
    suggestionValid: null,
    usage: null,
    inputGraphemes: null,
    elapsedMs: null,
    startedAt: null,
    finishedAt: status === "failed" ? new Date(2000) : null,
  });
  return { recheckUnitId, findingId: record.id };
}

/** マイクロタスクを流し切る（キューへの投入・`ensureLoaded` の開始を待つ）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

/**
 * 決定 45-1：保存済みの版が現行の定数と食い違う 3 通り。3 つのうちどれか 1 つでも違えば、
 * 再開も再試行も受け付けない（仕様 8.2）。
 */
const STALE_VERSION_CASES: readonly {
  readonly label: string;
  readonly seed: Partial<SeedRunInput>;
}[] = [
  { label: "prompt_version", seed: { promptVersion: "0" } },
  { label: "allowed_word_rule_version", seed: { allowedWordRuleVersion: "0" } },
  { label: "diagnostic_transform_version", seed: { diagnosticTransformVersion: "0" } },
];

/** ---------------------------------------------------------------------- */
/** O4・O18・決定 21（停止要求そのもの） */
/** ---------------------------------------------------------------------- */

describe("run/orchestrator: stopRun（決定 6・21・26）", () => {
  it("O4: 停止要求の後に上限内で届いた応答は保存され、送らずに済ませた単位は pending のまま実行が stopped になる", async () => {
    let stop: () => void = () => {
      throw new Error("停止の準備前に生成要求が来た");
    };
    /** 停止要求を出した直後（＝ループが決着を書く前）の DB の状態。 */
    const observed: Array<{ status: string; stopRequestedAt: Date | null; accepted: boolean }> = [];

    const scripted = scriptedClient([
      () => {
        stop();
        return checkResponse([finding("うえ", "ウエ")]);
      },
    ]);
    const harness = makeHarness(scripted.client);
    const started = harness.orchestrator.startRun(baseInput());
    const runId = started.run.id;
    stop = () => {
      const result = harness.orchestrator.stopRun(runId);
      const current = readRun(harness.db, runId);
      observed.push({
        status: current.status,
        stopRequestedAt: current.stopRequestedAt,
        accepted: result.accepted,
      });
    };

    const run = await started.done;

    // 決定 21：停止要求は runs.status を変えない。状態を書くのはループだけ。
    expect(observed).toHaveLength(1);
    expect(observed[0]?.accepted).toBe(true);
    expect(observed[0]?.status).toBe("running");
    expect(observed[0]?.stopRequestedAt).not.toBeNull();

    // 決定 26 の 3 番目の経路：応答は上限内に届いたので生成終了は確認できた。
    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("aborted");
    expect(run.generationUnconfirmed).toBe(false);
    expect(run.finishedAt).not.toBeNull();

    // 届いた応答は捨てずに保存する（決定 6 の 3）。
    expect(listFindings(harness.db, runId)).toHaveLength(1);

    const units = unitsOf(harness.db, runId);
    const first = units.find((unit) => unit.perspective === "typo");
    const second = units.find((unit) => unit.perspective === "naturalness");
    expect(first?.status).toBe("done");
    // 送らずに済ませた単位が 1 つ以上残るからこそ、この実行は completed ではなく stopped になる。
    expect(second?.status).toBe("pending");
    expect(second?.startedAt).toBeNull();
    expect(scripted.requests).toHaveLength(1);

    const types = eventTypes(harness.events);
    expect(types).toContain("stop-requested");
    expect(types.indexOf("stop-requested")).toBeLessThan(types.indexOf("run-settled"));
  });

  it("O18・N2: 停止要求で stop_requested_at が書かれ、再開が停止の記録を同じ更新で消す（決定 36）", async () => {
    let stop: () => void = () => {
      throw new Error("停止の準備前に生成要求が来た");
    };
    const scripted = scriptedClient([
      () => {
        stop();
        return checkResponse([]);
      },
      () => checkResponse([]),
    ]);
    const harness = makeHarness(scripted.client);
    const started = harness.orchestrator.startRun(baseInput());
    const runId = started.run.id;
    stop = () => {
      harness.orchestrator.stopRun(runId);
    };

    const stopped = await started.done;
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopRequestedAt).not.toBeNull();
    expect(stopped.stopReason).toBe("aborted");

    const resumed = harness.orchestrator.resumeRun(runId);
    expect(resumed.accepted).toBe(true);
    // 決定 36：状態と同時に 1 文の UPDATE で消える 5 つ。
    expect(resumed.run.status).toBe("running");
    expect(resumed.run.stopRequestedAt).toBeNull();
    expect(resumed.run.generationUnconfirmed).toBe(false);
    expect(resumed.run.finishedAt).toBeNull();
    expect(resumed.run.stopReason).toBeNull();
    expect(resumed.run.stopMessage).toBeNull();

    const finished = await resumed.done;
    expect(finished.status).toBe("completed");
    expect(scripted.requests).toHaveLength(2);
  });

  it("レジストリに無い実行への停止要求は受け付けず、DB を 1 行も変えない（決定 21）", async () => {
    const scripted = scriptedClient([() => checkResponse([]), () => checkResponse([])]);
    const harness = makeHarness(scripted.client);
    const started = harness.orchestrator.startRun(baseInput());
    const run = await started.done;
    expect(run.status).toBe("completed");

    // 走っているループが無い（終端済み）実行。
    const result = harness.orchestrator.stopRun(run.id);
    expect(result.accepted).toBe(false);
    expect(result.run?.status).toBe("completed");
    expect(readRun(harness.db, run.id).stopRequestedAt).toBeNull();

    // 存在しない実行 ID でも例外にせず、accepted: false を返す。
    const missing = harness.orchestrator.stopRun("存在しない実行");
    expect(missing.accepted).toBe(false);
    expect(missing.run).toBeNull();
  });

  it("2 回目の停止要求は stop_requested_at を書き直さない（冪等）", async () => {
    let clock = 1_000;
    let stop: () => void = () => {
      throw new Error("停止の準備前に生成要求が来た");
    };
    const scripted = scriptedClient([
      () => {
        stop();
        return checkResponse([]);
      },
    ]);
    const harness = makeHarness(scripted.client, { now: () => new Date(clock) });
    const started = harness.orchestrator.startRun(baseInput());
    const runId = started.run.id;
    stop = () => {
      harness.orchestrator.stopRun(runId);
      clock += 5_000;
      const second = harness.orchestrator.stopRun(runId);
      expect(second.accepted).toBe(true);
    };

    const run = await started.done;
    expect(run.status).toBe("stopped");
    // 最初に要求を受けた時刻が残る（表示するのは「いつ停止操作を受けたか」）。
    expect(run.stopRequestedAt?.getTime()).toBe(1_000);
    // stop-requested の通知も 1 回だけ。
    expect(eventTypes(harness.events).filter((type) => type === "stop-requested")).toHaveLength(1);
  });
});

/** ---------------------------------------------------------------------- */
/** 決定 26 の 3 経路（写像を自前で持たないことの確認） */
/** ---------------------------------------------------------------------- */

describe("run/orchestrator: 停止要求が届いた場所で結果が変わる（決定 26）", () => {
  it("キュー待ち中に停止要求が届いたら、上限を待たずにただちに stopped になる", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<ChatResult>();
      // 台本は 1 件だけ。実行 B が生成要求を送ったら「台本にない生成要求」で落ちる。
      const scripted = scriptedClient([() => first.promise]);
      const harness = makeHarness(scripted.client);

      const startedA = harness.orchestrator.startRun(
        baseInput({ startOperationId: "op-a", perspectives: ["typo"] }),
      );
      const startedB = harness.orchestrator.startRun(
        baseInput({ startOperationId: "op-b", perspectives: ["typo"] }),
      );

      // A が送信中で、B は共有キューで順番待ち（決定 2）。
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.deps.queue.size).toBe(2);
      expect(scripted.requests).toHaveLength(1);

      expect(harness.orchestrator.stopRun(startedB.run.id).accepted).toBe(true);

      first.resolve(checkResponse([]));
      // タイマーを 1 ミリ秒も進めずに B が決着すること（上限まで待っていない）。
      const runB = await startedB.done;
      const runA = await startedA.done;

      expect(runA.status).toBe("completed");
      // 送信していない（キュー待ちの）停止なので、生成終了は未確認にならない（決定 26）。
      expect(runB.status).toBe("stopped");
      expect(runB.stopReason).toBe("aborted");
      expect(runB.generationUnconfirmed).toBe(false);
      expect(runB.stopRequestedAt).not.toBeNull();
      expect(harness.recoveryGate.blocked).toBe(false);
      expect(scripted.requests).toHaveLength(1);

      // 決定 32：送信前に止めた単位（origin: "local"）は「生成終了は未確認」ではないので、
      // 文言は失敗メッセージそのまま。`origin === "chat"` のガードを落とすとここが
      // 「停止操作により打ち切った。生成終了は未確認」に化ける（送っていないのに未確認と記録する）。
      const unitB = unitsOf(harness.db, runB.id)[0];
      expect(unitB?.status).toBe("pending");
      expect(unitB?.failure?.reason).toBe("aborted");
      expect(unitB?.failure?.origin).toBe("local");
      expect(unitB?.pendingNote).toBe("停止要求により生成要求を送らなかった");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ensureLoaded 中に停止要求が届いても、上限を待たずに stopped になる（生成要求は 1 件も送らない）", async () => {
    vi.useFakeTimers();
    try {
      const loading = deferred<ModelInfo>();
      let firstEnsureLoaded = true;
      const scripted = scriptedClient([], {
        ensureLoaded: () => {
          if (firstEnsureLoaded) {
            firstEnsureLoaded = false;
            return loading.promise;
          }
          return Promise.resolve(LOADED_MODEL);
        },
      });
      const harness = makeHarness(scripted.client);
      const started = harness.orchestrator.startRun(baseInput({ perspectives: ["typo"] }));

      await vi.advanceTimersByTimeAsync(0);
      expect(scripted.ensureLoadedCalls).toHaveLength(1);

      expect(harness.orchestrator.stopRun(started.run.id).accepted).toBe(true);
      loading.resolve(LOADED_MODEL);

      const run = await started.done;
      expect(run.status).toBe("stopped");
      expect(run.generationUnconfirmed).toBe(false);
      expect(scripted.requests).toHaveLength(0);
      expect(harness.recoveryGate.blocked).toBe(false);

      // ここも送信前に止めた単位（origin: "local"）。決定 32 の文言にしてはならない。
      const unit = unitsOf(harness.db, run.id)[0];
      expect(unit?.status).toBe("pending");
      expect(unit?.failure?.origin).toBe("local");
      expect(unit?.pendingNote).toBe("停止要求により生成要求を送らなかった");
    } finally {
      vi.useRealTimers();
    }
  });

  it("R2・R4b: chat 中の停止要求は上限まで待ち、超過したら recovery-waiting になって単位が pending で残る", async () => {
    vi.useFakeTimers();
    try {
      const scripted = scriptedClient([({ signal }) => rejectOnAbort(signal)]);
      const harness = makeHarness(scripted.client, { recoveryConfirmMs: 500 });
      const started = harness.orchestrator.startRun(
        baseInput({ perspectives: ["typo"], timeouts: { checkMs: 60_000, recheckMs: 60_000 } }),
      );
      const runId = started.run.id;
      const settled: RunRecord[] = [];
      void started.done.then((run) => settled.push(run));

      await vi.advanceTimersByTimeAsync(0);
      expect(scripted.requests).toHaveLength(1);
      expect(harness.orchestrator.stopRun(runId).accepted).toBe(true);

      // 上限（500ms）までは自然な完了を待つ。実行は running のまま。
      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toHaveLength(0);
      expect(readRun(harness.db, runId).status).toBe("running");

      await vi.advanceTimersByTimeAsync(1);
      const run = await started.done;

      // 決定 6 の 4・決定 23：生成終了を確認できないので recovery-waiting。
      expect(run.status).toBe("recovery-waiting");
      expect(run.stopReason).toBe("aborted");
      expect(run.generationUnconfirmed).toBe(true);
      // 決定 39：復旧ゲートが閉じ、プロセス全体で新しい生成要求を送らなくなる。
      expect(harness.recoveryGate.blocked).toBe(true);
      expect([...harness.recoveryGate.blockedRunIds]).toEqual([runId]);

      // 決定 20：打ち切った単位は failed ではなく pending。失敗の事実は捨てない。
      const unit = unitsOf(harness.db, runId)[0];
      expect(unit?.status).toBe("pending");
      expect(unit?.failure?.reason).toBe("aborted");
      expect(unit?.failure?.origin).toBe("chat");
      expect(unit?.attempts).toBe(1);
      // 決定 32：停止経路の pending_note。
      expect(unit?.pendingNote).toBe("停止操作により打ち切った。生成終了は未確認");
    } finally {
      vi.useRealTimers();
    }
  });

  it("停止ゲートの上限はプロセス設定ではなく実行ごとの値（runs.recovery_confirm_ms）を使う", async () => {
    vi.useFakeTimers();
    try {
      const scripted = scriptedClient([({ signal }) => rejectOnAbort(signal)]);
      // プロセス設定は 60 秒。再開する実行の値は 200 ミリ秒（設定を変えて再起動した後を模す）。
      const harness = makeHarness(scripted.client, { recoveryConfirmMs: 60_000 });
      const seeded = seedRun(harness.db, {
        runId: "run-per-run-limit",
        status: "stopped",
        unitStatuses: ["pending"],
      });
      harness.db
        .update(runsTable)
        .set({ recoveryConfirmMs: 200 })
        .where(eq(runsTable.id, seeded.run.id))
        .run();

      const resumed = harness.orchestrator.resumeRun(seeded.run.id);
      const settled: RunRecord[] = [];
      void resumed.done.then((run) => settled.push(run));

      await vi.advanceTimersByTimeAsync(0);
      expect(scripted.requests).toHaveLength(1);
      expect(harness.orchestrator.stopRun(seeded.run.id).accepted).toBe(true);

      // プロセス設定（60 秒）でゲートを作っていると、ここでは決着しない。
      await vi.advanceTimersByTimeAsync(200);
      const run = await resumed.done;
      expect(settled).toHaveLength(1);
      expect(run.status).toBe("recovery-waiting");
      expect(run.generationUnconfirmed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("R4b: タイムアウト経路でも打ち切られた単位は pending で、pending_note が経路ごとに違う（決定 20・32）", async () => {
    const scripted = scriptedClient([
      () => {
        throw timedOut();
      },
    ]);
    const harness = makeHarness(scripted.client, { recoveryConfirmMs: 500 });
    const started = harness.orchestrator.startRun(
      baseInput({ perspectives: ["typo"], timeouts: { checkMs: 1_000, recheckMs: 1_000 } }),
    );
    const run = await started.done;

    expect(run.status).toBe("recovery-waiting");
    expect(run.stopReason).toBe("recovery-needed");
    expect(run.generationUnconfirmed).toBe(true);

    const unit = unitsOf(harness.db, run.id)[0];
    expect(unit?.status).toBe("pending");
    expect(unit?.failure?.reason).toBe("timeout");
    expect(unit?.pendingNote).toBe("応答が上限内に届かなかった。生成終了は未確認");
  });

  it("45-3: recoveryConfirmMs が 0 でも打ち切られた単位は pending で、手動再開が拾い直す（決定 20・43）", async () => {
    const scripted = scriptedClient([
      () => {
        throw timedOut();
      },
      () => checkResponse([]),
    ]);
    // 決定 43 が認める正規の設定値。checkMs がそのままハード上限になるだけで、
    // 「オーケストレーター経路か否か」の判別には使わない（決定 45-3）。
    const harness = makeHarness(scripted.client, { recoveryConfirmMs: 0 });
    const started = harness.orchestrator.startRun(
      baseInput({ perspectives: ["typo"], timeouts: { checkMs: 1_000, recheckMs: 1_000 } }),
    );
    const run = await started.done;

    expect(run.status).toBe("recovery-waiting");
    expect(run.stopReason).toBe("recovery-needed");
    expect(scripted.requests).toHaveLength(1);

    // 待機時間が 0 でも failed にはならない。failed になると手動再開が拾えない。
    const stalled = unitsOf(harness.db, run.id)[0];
    expect(stalled?.status).toBe("pending");
    expect(stalled?.pendingNote).toBe("応答が上限内に届かなかった。生成終了は未確認");

    // その単位を手動再開が拾って、生成要求を送り直す。
    const resumed = harness.orchestrator.resumeRun(run.id);
    const resumedRun = await resumed.done;

    expect(resumed.accepted).toBe(true);
    expect(scripted.requests).toHaveLength(2);
    expect(resumedRun.status).toBe("completed");
    expect(unitsOf(harness.db, run.id)[0]?.status).toBe("done");
  });

  it("R3: recovery-waiting の実行があると、別の実行にも自動で生成要求を送らない（決定 39）", async () => {
    const scripted = scriptedClient([
      () => {
        throw timedOut();
      },
    ]);
    const harness = makeHarness(scripted.client, { recoveryConfirmMs: 500 });
    const first = await harness.orchestrator.startRun(
      baseInput({ startOperationId: "op-a", perspectives: ["typo"] }),
    ).done;
    expect(first.status).toBe("recovery-waiting");
    expect(scripted.requests).toHaveLength(1);

    // 台本は使い切っている。2 本目の実行が生成要求を送ったら「台本にない生成要求」で落ちる。
    const second = await harness.orchestrator.startRun(
      baseInput({ startOperationId: "op-b", perspectives: ["typo"] }),
    ).done;

    expect(scripted.requests).toHaveLength(1);
    expect(second.status).toBe("stopped");
    expect(second.stopReason).toBe("recovery-blocked");
    expect(second.generationUnconfirmed).toBe(false);
    expect(unitsOf(harness.db, second.id).every((unit) => unit.status === "pending")).toBe(true);
  });
});

/** ---------------------------------------------------------------------- */
/** V1・V2・V4・V5（復旧ゲートと停止後の自動再試行） */
/** ---------------------------------------------------------------------- */

describe("run/orchestrator: 復旧ゲート（決定 39）", () => {
  it("V1: A が復旧待ちに入った時点ですでにキュー待ちだった B は、生成要求を送らずに recovery-blocked で終わる", async () => {
    const first = deferred<ChatResult>();
    const scripted = scriptedClient([() => first.promise]);
    const harness = makeHarness(scripted.client);

    const startedA = harness.orchestrator.startRun(
      baseInput({ startOperationId: "op-a", perspectives: ["typo"] }),
    );
    const startedB = harness.orchestrator.startRun(
      baseInput({ startOperationId: "op-b", perspectives: ["typo"] }),
    );

    await flush();
    // B は「A の解決の直後に runOne が始まる」位置で待っている。
    expect(harness.deps.queue.size).toBe(2);
    expect(scripted.requests).toHaveLength(1);

    first.reject(connectionLost());
    const runA = await startedA.done;
    const runB = await startedB.done;

    expect(runA.status).toBe("recovery-waiting");
    expect(runA.generationUnconfirmed).toBe(true);
    // ゲートを閉じるのが executor の onRecoveryRequired でなくループ側だと、ここで B の
    // runOne がゲートを見る前に A の保存・終端化が挟まり、B が要求を送ってしまう。
    expect(scripted.requests).toHaveLength(1);
    expect(runB.status).toBe("stopped");
    expect(runB.stopReason).toBe("recovery-blocked");
    expect(unitsOf(harness.db, runB.id).every((unit) => unit.status === "pending")).toBe(true);
  });

  it("V2: A を再開するとゲートが開き、B も再開できる（決定 39 のゲートを開ける唯一の口）", async () => {
    const first = deferred<ChatResult>();
    const scripted = scriptedClient([
      () => first.promise,
      () => checkResponse([]),
      () => checkResponse([]),
    ]);
    const harness = makeHarness(scripted.client);

    // A は 2 観点。1 観点目が「応答を受け取れずに切断」で終わり、2 観点目は手つかず（pending）で残る。
    const startedA = harness.orchestrator.startRun(baseInput({ startOperationId: "op-a" }));
    const startedB = harness.orchestrator.startRun(
      baseInput({ startOperationId: "op-b", perspectives: ["typo"] }),
    );
    await flush();
    first.reject(connectionLost());
    const runA = await startedA.done;
    const runB = await startedB.done;
    expect(runA.status).toBe("recovery-waiting");
    expect(runB.stopReason).toBe("recovery-blocked");
    expect(harness.recoveryGate.blocked).toBe(true);
    expect(scripted.requests).toHaveLength(1);

    // A の再開だけがゲートを開ける。開いた後は生成要求がまた通る。
    const resumedA = harness.orchestrator.resumeRun(runA.id);
    expect(resumedA.accepted).toBe(true);
    expect(harness.recoveryGate.blocked).toBe(false);
    // 1 観点目は failed のまま残る（再開は pending の単位だけを拾う）。
    expect(await resumedA.done).toMatchObject({ status: "partially-failed" });
    expect(scripted.requests).toHaveLength(2);

    const resumedB = harness.orchestrator.resumeRun(runB.id);
    expect(resumedB.accepted).toBe(true);
    expect(await resumedB.done).toMatchObject({ status: "completed" });
    expect(scripted.requests).toHaveLength(3);
  });

  it("V4: 復旧待ちが 2 件あるとき、1 件を再開してもゲートは開かない（集合で持つ）", async () => {
    const scripted = scriptedClient([]);
    const harness = makeHarness(scripted.client);
    const a = seedRun(harness.db, {
      runId: "run-a",
      status: "recovery-waiting",
      unitStatuses: ["pending"],
    });
    seedRun(harness.db, {
      runId: "run-b",
      status: "recovery-waiting",
      unitStatuses: ["pending"],
    });
    // 起動時照合（Task 9）がゲートを復元した状態を手で作る。
    harness.recoveryGate.block("run-a");
    harness.recoveryGate.block("run-b");

    const resumed = harness.orchestrator.resumeRun(a.run.id);
    expect(resumed.accepted).toBe(true);
    // A は外れたが B が残っているので、プロセス全体の門は閉じたまま。
    expect([...harness.recoveryGate.blockedRunIds]).toEqual(["run-b"]);
    expect(harness.recoveryGate.blocked).toBe(true);

    const run = await resumed.done;
    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("recovery-blocked");
    expect(scripted.requests).toHaveLength(0);
  });

  it("V5: 停止要求の後、executor の自動再試行は送られない（malformed でも 2 回目の chat を出さない）", async () => {
    let stop: () => void = () => {
      throw new Error("停止の準備前に生成要求が来た");
    };
    const scripted = scriptedClient([
      () => {
        stop();
        // 通常なら executor が 1 回だけ自動再試行する応答（決定 5(a)）。
        return chatResult("これは JSON ではない");
      },
    ]);
    const harness = makeHarness(scripted.client);
    const started = harness.orchestrator.startRun(baseInput({ perspectives: ["typo"] }));
    stop = () => {
      harness.orchestrator.stopRun(started.run.id);
    };

    const run = await started.done;

    // 決定 26：endRequest がその場で abort するので、再試行の手前で止まる。
    expect(scripted.requests).toHaveLength(1);
    expect(run.status).toBe("stopped");
    expect(run.generationUnconfirmed).toBe(false);

    // 応答は届いていて内容が不正だった、という確定した失敗なので pending には戻さない
    // （決定 20 の pending は「生成終了を確認できない」場合の規則）。
    const unit = unitsOf(harness.db, run.id)[0];
    expect(unit?.status).toBe("failed");
    expect(unit?.failure?.reason).toBe("malformed");
    expect(unit?.attempts).toBe(1);
    expect(unit?.pendingNote).toBeNull();
  });

  /**
   * `recoveryConfirmMs` が 0 のとき、`requestStop()` は送信中の要求に対して
   * `setTimeout(abortNow, 0)` を張るので、`abort()` は 1 マクロタスク遅れる。
   * その間に executor の自動再試行が滑り込まないことを確かめる（滑り込むと、停止要求後に
   * 新しい生成要求を送らない（仕様 8.2）が破れる）。実際に守っているのは
   * `endRequest()` の同期 `abort()` であって、タイマーではない。
   */
  it("recoveryConfirmMs が 0 でも、停止要求の後に自動再試行は送られない", async () => {
    let stop: () => void = () => {
      throw new Error("停止の準備前に生成要求が来た");
    };
    const scripted = scriptedClient([
      () => {
        stop();
        return chatResult("これは JSON ではない");
      },
    ]);
    const harness = makeHarness(scripted.client, { recoveryConfirmMs: 0 });
    const started = harness.orchestrator.startRun(baseInput({ perspectives: ["typo"] }));
    stop = () => {
      harness.orchestrator.stopRun(started.run.id);
    };

    const run = await started.done;

    expect(scripted.requests).toHaveLength(1);
    expect(run.status).toBe("stopped");
    expect(run.generationUnconfirmed).toBe(false);
    expect(unitsOf(harness.db, run.id)[0]?.status).toBe("failed");
  });
});

/** ---------------------------------------------------------------------- */
/** O5〜O8・O11（再開） */
/** ---------------------------------------------------------------------- */

describe("run/orchestrator: resumeRun（決定 36）", () => {
  it("O5: 再開は完了済みの単位に生成要求を送らない", async () => {
    const scripted = scriptedClient([() => checkResponse([])]);
    const harness = makeHarness(scripted.client);
    const seeded = seedRun(harness.db, {
      runId: "run-resume",
      status: "stopped",
      unitStatuses: ["done", "pending"],
    });

    const resumed = harness.orchestrator.resumeRun(seeded.run.id);
    const run = await resumed.done;

    expect(resumed.accepted).toBe(true);
    expect(scripted.requests).toHaveLength(1);
    expect(run.status).toBe("completed");
    const units = unitsOf(harness.db, run.id);
    expect(units.find((unit) => unit.perspective === "typo")?.status).toBe("done");
    // 完了済みの単位は attempts も触られない。
    expect(units.find((unit) => unit.perspective === "typo")?.attempts).toBe(2);
    expect(units.find((unit) => unit.perspective === "naturalness")?.status).toBe("done");
  });

  it("O6: 再開後の候補は保存済み指摘に mergeKey で照合され、指摘 ID が変わらない", async () => {
    let stop: () => void = () => {
      throw new Error("停止の準備前に生成要求が来た");
    };
    const scripted = scriptedClient([
      () => {
        stop();
        return checkResponse([finding("うえ", "ウエ")]);
      },
      () => checkResponse([finding("うえ", "ウエ")]),
    ]);
    const harness = makeHarness(scripted.client);
    const started = harness.orchestrator.startRun(baseInput());
    const runId = started.run.id;
    stop = () => {
      harness.orchestrator.stopRun(runId);
    };

    expect((await started.done).status).toBe("stopped");
    const before = listFindings(harness.db, runId);
    expect(before).toHaveLength(1);
    const findingId = before[0]?.id ?? "";

    const resumed = harness.orchestrator.resumeRun(runId);
    expect((await resumed.done).status).toBe("completed");

    const after = listFindings(harness.db, runId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(findingId);
    // 再開後の候補が同じ指摘に統合されている。
    expect(listCandidatesForFinding(harness.db, findingId)).toHaveLength(2);
  });

  it("O7: 再開後の候補の mergeKey が一致しなければ新しい指摘になる", async () => {
    let stop: () => void = () => {
      throw new Error("停止の準備前に生成要求が来た");
    };
    const scripted = scriptedClient([
      () => {
        stop();
        return checkResponse([finding("うえ", "ウエ")]);
      },
      () => checkResponse([finding("うえ", "上")]),
    ]);
    const harness = makeHarness(scripted.client);
    const started = harness.orchestrator.startRun(baseInput());
    const runId = started.run.id;
    stop = () => {
      harness.orchestrator.stopRun(runId);
    };

    await started.done;
    const findingId = listFindings(harness.db, runId)[0]?.id ?? "";

    const resumed = harness.orchestrator.resumeRun(runId);
    expect((await resumed.done).status).toBe("completed");

    const after = listFindings(harness.db, runId);
    expect(after).toHaveLength(2);
    expect(after.some((entry) => entry.id === findingId)).toBe(true);
    expect(listCandidatesForFinding(harness.db, findingId)).toHaveLength(1);
  });

  it("O8: 前回セッションで pending のまま残った再確認だけを進める再開", async () => {
    const scripted = scriptedClient([() => recheckResponse()]);
    const harness = makeHarness(scripted.client);
    const seeded = seedRun(harness.db, {
      runId: "run-recheck",
      status: "stopped",
      unitStatuses: ["done", "done"],
      recheckEnabled: true,
    });
    const { recheckUnitId } = seedRecheckUnit(harness.db, seeded, "pending");

    const resumed = harness.orchestrator.resumeRun(seeded.run.id);
    const run = await resumed.done;

    expect(scripted.requests).toHaveLength(1);
    expect(run.status).toBe("completed");
    const recheck = listRecheckUnits(harness.db, run.id).find((unit) => unit.id === recheckUnitId);
    expect(recheck?.status).toBe("done");
    expect(recheck?.verdict).toBe("keep");
  });

  it("O11: 実行中の実行への再開要求は二重にループを走らせず、走っている done をそのまま返す", async () => {
    const pending = deferred<ChatResult>();
    const scripted = scriptedClient([() => pending.promise]);
    const harness = makeHarness(scripted.client);
    const started = harness.orchestrator.startRun(baseInput({ perspectives: ["typo"] }));
    await flush();

    const resumed = harness.orchestrator.resumeRun(started.run.id);
    expect(resumed.accepted).toBe(false);
    expect(resumed.done).toBe(started.done);
    const retried = harness.orchestrator.retryFailedUnits(started.run.id);
    expect(retried.accepted).toBe(false);
    expect(retried.done).toBe(started.done);

    pending.resolve(checkResponse([]));
    const run = await started.done;
    expect(run.status).toBe("completed");
    // 二重に走っていれば台本を使い切って「台本にない生成要求」になる。
    expect(scripted.requests).toHaveLength(1);
  });

  it("completed / partially-failed の実行への再開要求は状態を変えずに拒否される（決定 36 の表）", async () => {
    const scripted = scriptedClient([]);
    const harness = makeHarness(scripted.client);
    const completed = seedRun(harness.db, {
      runId: "run-completed",
      status: "completed",
      unitStatuses: ["done"],
    });
    const partial = seedRun(harness.db, {
      runId: "run-partial",
      status: "partially-failed",
      unitStatuses: ["failed"],
    });

    const rejectedCompleted = harness.orchestrator.resumeRun(completed.run.id);
    expect(rejectedCompleted.accepted).toBe(false);
    expect(rejectedCompleted.run.status).toBe("completed");
    expect(await rejectedCompleted.done).toMatchObject({ status: "completed" });
    expect(readRun(harness.db, completed.run.id).status).toBe("completed");

    const rejectedPartial = harness.orchestrator.resumeRun(partial.run.id);
    expect(rejectedPartial.accepted).toBe(false);
    expect(readRun(harness.db, partial.run.id).status).toBe("partially-failed");
    // 停止の記録も消えていない（claimRunChecked を呼んでいない）。
    expect(readRun(harness.db, partial.run.id).stopReason).toBe("aborted");
    expect(scripted.requests).toHaveLength(0);
  });

  it("stopped（settings・分割設定不正）の実行は再開を拒否され、停止の記録が残り、生成要求も送られない（決定 36）", async () => {
    const scripted = scriptedClient([]);
    const harness = makeHarness(scripted.client);

    const started = harness.orchestrator.startRun(
      baseInput({ startOperationId: "op-invalid", chunkSettings: CHUNK_INVALID_SETTINGS }),
    );
    const before = readRun(harness.db, started.run.id);
    expect(before.status).toBe("stopped");
    expect(before.stopReason).toBe("settings");
    expect(before.stopMessage).not.toBeNull();
    // 検査単位が 0 件なので、受け付けてしまうと即 completed（指摘 0 件）になる。
    expect(unitsOf(harness.db, started.run.id)).toHaveLength(0);

    const resumed = harness.orchestrator.resumeRun(started.run.id);
    expect(resumed.accepted).toBe(false);
    expect(resumed.run.status).toBe("stopped");
    expect(await resumed.done).toMatchObject({ status: "stopped", stopReason: "settings" });
    await flush();

    const after = readRun(harness.db, started.run.id);
    expect(after.status).toBe("stopped");
    expect(after.stopReason).toBe("settings");
    expect(after.stopMessage).toBe(before.stopMessage);
    expect(after.finishedAt).not.toBeNull();
    expect(unitsOf(harness.db, started.run.id)).toHaveLength(0);
    // ループが起きていない（`chat` も `ensureLoaded` も 1 度も呼ばれない）。
    expect(scripted.requests).toHaveLength(0);
    expect(scripted.ensureLoadedCalls).toHaveLength(0);
  });

  it("stopped（settings・入力上限超過）の実行は再開を拒否され、failed の単位も停止の記録も変わらない（決定 36）", async () => {
    const scripted = scriptedClient([]);
    const harness = makeHarness(scripted.client);

    const started = harness.orchestrator.startRun(
      baseInput({ startOperationId: "op-too-long", chunkSettings: CHUNK_TOO_LONG }),
    );
    const before = readRun(harness.db, started.run.id);
    expect(before.status).toBe("stopped");
    expect(before.stopReason).toBe("settings");
    expect(before.stopMessage).not.toBeNull();
    // 2 対象 × 2 観点がすべて failed（input-too-long）。受け付けると即 partially-failed になる。
    const unitsBefore = unitsOf(harness.db, started.run.id);
    expect(unitsBefore).toHaveLength(4);
    for (const unit of unitsBefore) {
      expect(unit.status).toBe("failed");
      expect(unit.failure?.reason).toBe("input-too-long");
    }

    const resumed = harness.orchestrator.resumeRun(started.run.id);
    expect(resumed.accepted).toBe(false);
    expect(resumed.run.status).toBe("stopped");
    expect(await resumed.done).toMatchObject({ status: "stopped", stopReason: "settings" });
    await flush();

    const after = readRun(harness.db, started.run.id);
    expect(after.status).toBe("stopped");
    expect(after.stopReason).toBe("settings");
    expect(after.stopMessage).toBe(before.stopMessage);
    expect(after.finishedAt).not.toBeNull();
    for (const unit of unitsOf(harness.db, started.run.id)) {
      expect(unit.status).toBe("failed");
      expect(unit.failure?.reason).toBe("input-too-long");
    }
    expect(scripted.requests).toHaveLength(0);
    expect(scripted.ensureLoadedCalls).toHaveLength(0);
  });

  for (const testCase of STALE_VERSION_CASES) {
    it(`45-1: 保存済みの ${testCase.label} が現行と違う実行は再開せず、DB を 1 行も変えない（仕様 8.2）`, async () => {
      const scripted = scriptedClient([]);
      const harness = makeHarness(scripted.client);
      const seeded = seedRun(harness.db, {
        runId: `run-stale-${testCase.label}`,
        status: "stopped",
        unitStatuses: ["pending", "pending"],
        ...testCase.seed,
      });
      const runBefore = readRun(harness.db, seeded.run.id);
      const unitsBefore = unitsOf(harness.db, seeded.run.id);

      const resumed = harness.orchestrator.resumeRun(seeded.run.id);

      expect(resumed.accepted).toBe(false);
      expect(await resumed.done).toMatchObject({ status: "stopped" });
      await flush();

      // 生成要求も ensureLoaded も 1 件も送らない。
      expect(scripted.requests).toHaveLength(0);
      expect(scripted.ensureLoadedCalls).toHaveLength(0);
      // 実行の行も単位の行も、読み直して 1 つも変わっていない。
      expect(readRun(harness.db, seeded.run.id)).toEqual(runBefore);
      expect(unitsOf(harness.db, seeded.run.id)).toEqual(unitsBefore);
    });
  }

  it("45-1: 版が古い recovery-waiting の実行は再開を拒否しつつ、復旧ゲートだけは開ける", async () => {
    const scripted = scriptedClient([]);
    const harness = makeHarness(scripted.client);
    const seeded = seedRun(harness.db, {
      runId: "run-stale-waiting",
      status: "recovery-waiting",
      unitStatuses: ["pending", "pending"],
      promptVersion: "0",
    });
    // 起動時照合（reconcileOnStartup）が閉じた状態を模す。
    harness.recoveryGate.block(seeded.run.id);
    const runBefore = readRun(harness.db, seeded.run.id);
    const unitsBefore = unitsOf(harness.db, seeded.run.id);

    const resumed = harness.orchestrator.resumeRun(seeded.run.id);

    expect(resumed.accepted).toBe(false);
    await flush();
    // ゲートは開く（「利用者が生成終了を確認した」ことの記録であって、実行を続ける許可ではない）。
    expect(harness.recoveryGate.blocked).toBe(false);
    // それでも DB は 1 行も変わらず、生成要求も送らない。
    expect(scripted.requests).toHaveLength(0);
    expect(readRun(harness.db, seeded.run.id)).toEqual(runBefore);
    expect(unitsOf(harness.db, seeded.run.id)).toEqual(unitsBefore);
  });

  it("45-1: 版が古い stopped の実行を拒否するときは復旧ゲートに触らない", async () => {
    const scripted = scriptedClient([]);
    const harness = makeHarness(scripted.client);
    const seeded = seedRun(harness.db, {
      runId: "run-stale-stopped-gate",
      status: "stopped",
      unitStatuses: ["pending"],
      promptVersion: "0",
    });
    // `stopped` では起こらない状態だが、unblock が呼ばれたかどうかを見るために閉じておく。
    harness.recoveryGate.block(seeded.run.id);

    expect(harness.orchestrator.resumeRun(seeded.run.id).accepted).toBe(false);
    await flush();

    expect(harness.recoveryGate.blocked).toBe(true);
    expect(harness.recoveryGate.blockedRunIds.has(seeded.run.id)).toBe(true);
  });

  it("45-1: 版が古い recovery-waiting を拒否した後は、新しい実行が recovery-blocked にならずに走る", async () => {
    const scripted = scriptedClient([() => checkResponse([])]);
    const harness = makeHarness(scripted.client);
    const seeded = seedRun(harness.db, {
      runId: "run-stale-waiting-then-start",
      status: "recovery-waiting",
      unitStatuses: ["pending"],
      diagnosticTransformVersion: "0",
    });
    harness.recoveryGate.block(seeded.run.id);

    expect(harness.orchestrator.resumeRun(seeded.run.id).accepted).toBe(false);

    // 案内どおり「新しい実行を開始してください」が実際に通ること（決定 45-1 の帰結）。
    const started = harness.orchestrator.startRun(baseInput({ perspectives: ["typo"] }));
    const run = await started.done;

    expect(run.stopReason).not.toBe("recovery-blocked");
    expect(run.status).toBe("completed");
    expect(scripted.requests).toHaveLength(1);
  });

  it("存在しない実行 ID の再開は呼び出し側の誤りとして例外にする", () => {
    const harness = makeHarness(scriptedClient([]).client);
    expect(() => harness.orchestrator.resumeRun("存在しない実行")).toThrow(
      /検査実行が見つかりません/,
    );
  });
});

/** ---------------------------------------------------------------------- */
/** O9・Y1〜Y5（個別再試行） */
/** ---------------------------------------------------------------------- */

describe("run/orchestrator: retryFailedUnits（決定 36）", () => {
  it("O9・T8: failed の単位が pending → running → done に進み、実行状態が再計算され、attempts が累積する", async () => {
    const scripted = scriptedClient([() => checkResponse([])]);
    const harness = makeHarness(scripted.client);
    const seeded = seedRun(harness.db, {
      runId: "run-retry",
      status: "partially-failed",
      unitStatuses: ["failed", "done"],
    });

    const retried = harness.orchestrator.retryFailedUnits(seeded.run.id);
    expect(retried.accepted).toBe(true);
    expect(retried.run.status).toBe("running");
    expect(retried.run.stopReason).toBeNull();

    const run = await retried.done;
    expect(run.status).toBe("completed");
    expect(scripted.requests).toHaveLength(1);

    const unit = unitsOf(harness.db, run.id).find((entry) => entry.perspective === "typo");
    expect(unit?.status).toBe("done");
    // 決定 41：実行をまたいで累積する（2 回失敗 → 今回 1 回で成功）。
    expect(unit?.attempts).toBe(3);
  });

  it("Y3: check_units と recheck_units の ID を混ぜて渡せる", async () => {
    const scripted = scriptedClient([() => checkResponse([]), () => recheckResponse()]);
    const harness = makeHarness(scripted.client);
    const seeded = seedRun(harness.db, {
      runId: "run-mixed",
      status: "partially-failed",
      unitStatuses: ["failed", "done"],
      recheckEnabled: true,
    });
    const { recheckUnitId } = seedRecheckUnit(harness.db, seeded, "failed");
    const checkUnitId = seeded.units[0]?.id ?? "";

    const retried = harness.orchestrator.retryFailedUnits(seeded.run.id, {
      unitIds: [checkUnitId, recheckUnitId],
    });
    expect(retried.accepted).toBe(true);
    const run = await retried.done;

    expect(run.status).toBe("completed");
    expect(scripted.requests).toHaveLength(2);
    expect(unitsOf(harness.db, run.id).find((unit) => unit.id === checkUnitId)?.status).toBe(
      "done",
    );
    expect(
      listRecheckUnits(harness.db, run.id).find((unit) => unit.id === recheckUnitId)?.status,
    ).toBe("done");
  });

  it("Y5: unitIds を省略すると failed の単位が全件戻り、空配列は拒否される", async () => {
    const scripted = scriptedClient([() => checkResponse([]), () => recheckResponse()]);
    const harness = makeHarness(scripted.client);
    const seeded = seedRun(harness.db, {
      runId: "run-all",
      status: "partially-failed",
      unitStatuses: ["failed", "done"],
      recheckEnabled: true,
    });
    const { recheckUnitId } = seedRecheckUnit(harness.db, seeded, "failed");

    // 空配列は「全件」ではなく誤り（省略が全件なので、取り違えが静かに通らないようにする）。
    expect(() => harness.orchestrator.retryFailedUnits(seeded.run.id, { unitIds: [] })).toThrow(
      RetryTargetError,
    );
    expect(readRun(harness.db, seeded.run.id).status).toBe("partially-failed");

    const retried = harness.orchestrator.retryFailedUnits(seeded.run.id);
    const run = await retried.done;
    expect(run.status).toBe("completed");
    expect(unitsOf(harness.db, run.id).every((unit) => unit.status === "done")).toBe(true);
    expect(
      listRecheckUnits(harness.db, run.id).find((unit) => unit.id === recheckUnitId)?.status,
    ).toBe("done");
  });

  it("Y1: 別の実行に属する単位 ID は拒否され、その単位も実行も変わらない", () => {
    const scripted = scriptedClient([]);
    const harness = makeHarness(scripted.client);
    const target = seedRun(harness.db, {
      runId: "run-target",
      status: "partially-failed",
      unitStatuses: ["failed"],
    });
    const other = seedRun(harness.db, {
      runId: "run-other",
      status: "partially-failed",
      unitStatuses: ["failed"],
    });
    const otherUnitId = other.units[0]?.id ?? "";

    expect(() =>
      harness.orchestrator.retryFailedUnits(target.run.id, { unitIds: [otherUnitId] }),
    ).toThrow(RetryTargetError);

    expect(readRun(harness.db, target.run.id).status).toBe("partially-failed");
    expect(readRun(harness.db, other.run.id).status).toBe("partially-failed");
    expect(unitsOf(harness.db, other.run.id)[0]?.status).toBe("failed");
    expect(unitsOf(harness.db, target.run.id)[0]?.status).toBe("failed");
    expect(scripted.requests).toHaveLength(0);
  });

  it("Y2: done / pending / 存在しない ID は拒否される", () => {
    const harness = makeHarness(scriptedClient([]).client);
    const seeded = seedRun(harness.db, {
      runId: "run-y2",
      status: "partially-failed",
      unitStatuses: ["failed", "done"],
    });
    const doneUnitId = seeded.units[1]?.id ?? "";

    expect(() =>
      harness.orchestrator.retryFailedUnits(seeded.run.id, { unitIds: [doneUnitId] }),
    ).toThrow(RetryTargetError);
    expect(() =>
      harness.orchestrator.retryFailedUnits(seeded.run.id, { unitIds: ["存在しない単位"] }),
    ).toThrow(RetryTargetError);

    // pending の単位も対象外（再試行は failed を戻すもの）。
    const pendingRun = seedRun(harness.db, {
      runId: "run-y2b",
      status: "stopped",
      unitStatuses: ["pending"],
    });
    expect(() =>
      harness.orchestrator.retryFailedUnits(pendingRun.run.id, {
        unitIds: [pendingRun.units[0]?.id ?? ""],
      }),
    ).toThrow(RetryTargetError);

    expect(readRun(harness.db, seeded.run.id).status).toBe("partially-failed");
    expect(readRun(harness.db, pendingRun.run.id).status).toBe("stopped");
  });

  it("Y4: 複数 ID のうち 1 件が不正なら、正しい ID の単位も含めて 1 つも変わらない", () => {
    const harness = makeHarness(scriptedClient([]).client);
    const seeded = seedRun(harness.db, {
      runId: "run-y4",
      status: "partially-failed",
      unitStatuses: ["failed", "done"],
    });
    const failedUnitId = seeded.units[0]?.id ?? "";
    const doneUnitId = seeded.units[1]?.id ?? "";

    expect(() =>
      harness.orchestrator.retryFailedUnits(seeded.run.id, { unitIds: [failedUnitId, doneUnitId] }),
    ).toThrow(RetryTargetError);

    // 実行も、正しかったほうの単位も 1 つも変わらない（トランザクションごとロールバック）。
    expect(readRun(harness.db, seeded.run.id).status).toBe("partially-failed");
    expect(readRun(harness.db, seeded.run.id).stopReason).toBe("aborted");
    expect(
      unitsOf(harness.db, seeded.run.id).find((unit) => unit.id === failedUnitId)?.status,
    ).toBe("failed");
  });

  it("input-too-long で失敗した検査単位は再試行の対象から外れる（決定 36）", () => {
    const harness = makeHarness(scriptedClient([]).client);
    const seeded = seedRun(harness.db, {
      runId: "run-too-long",
      status: "stopped",
      unitStatuses: ["failed"],
      failureReason: "input-too-long",
    });
    const unitId = seeded.units[0]?.id ?? "";

    // 明示指定は拒否する（暫定値から入力を組み直すと、参考文脈のない狭い入力になってしまう）。
    expect(() =>
      harness.orchestrator.retryFailedUnits(seeded.run.id, { unitIds: [unitId] }),
    ).toThrow(RetryTargetError);
    // 省略時は「戻せる単位が 1 件も無い」ので、実行を running にせずに拒否する。
    expect(() => harness.orchestrator.retryFailedUnits(seeded.run.id)).toThrow(RetryTargetError);

    expect(readRun(harness.db, seeded.run.id).status).toBe("stopped");
    expect(unitsOf(harness.db, seeded.run.id)[0]?.status).toBe("failed");
  });

  it("completed / recovery-waiting の実行への再試行要求は状態を変えずに拒否される（決定 36 の表）", () => {
    const harness = makeHarness(scriptedClient([]).client);
    const completed = seedRun(harness.db, {
      runId: "run-r-completed",
      status: "completed",
      unitStatuses: ["done"],
    });
    const waiting = seedRun(harness.db, {
      runId: "run-r-waiting",
      status: "recovery-waiting",
      unitStatuses: ["failed"],
    });

    expect(harness.orchestrator.retryFailedUnits(completed.run.id).accepted).toBe(false);
    // recovery-waiting は再試行では受け付けない（ゲートを開けられるのは resumeRun だけ）。
    expect(harness.orchestrator.retryFailedUnits(waiting.run.id).accepted).toBe(false);
    expect(readRun(harness.db, waiting.run.id).status).toBe("recovery-waiting");
    expect(unitsOf(harness.db, waiting.run.id)[0]?.status).toBe("failed");
  });

  for (const testCase of STALE_VERSION_CASES) {
    it(`45-1: 保存済みの ${testCase.label} が現行と違う実行は再試行せず、DB を 1 行も変えない（仕様 8.2）`, async () => {
      const scripted = scriptedClient([]);
      const harness = makeHarness(scripted.client);
      const seeded = seedRun(harness.db, {
        runId: `retry-stale-${testCase.label}`,
        status: "stopped",
        // 失敗単位があるので、版の検査が無ければ受け付けられて単位が pending に戻ってしまう。
        unitStatuses: ["failed", "done"],
        ...testCase.seed,
      });
      const runBefore = readRun(harness.db, seeded.run.id);
      const unitsBefore = unitsOf(harness.db, seeded.run.id);

      const retried = harness.orchestrator.retryFailedUnits(seeded.run.id);

      expect(retried.accepted).toBe(false);
      expect(await retried.done).toMatchObject({ status: "stopped" });
      await flush();

      expect(scripted.requests).toHaveLength(0);
      expect(scripted.ensureLoadedCalls).toHaveLength(0);
      expect(readRun(harness.db, seeded.run.id)).toEqual(runBefore);
      expect(unitsOf(harness.db, seeded.run.id)).toEqual(unitsBefore);
    });
  }
});

/** ---------------------------------------------------------------------- */
/** X1〜X3（想定外の例外。決定 33） */
/** ---------------------------------------------------------------------- */

describe("run/orchestrator: 想定外の例外（決定 33）", () => {
  /**
   * 保存の直前（候補 ID の採番）で `PersistBoundaryError` を投げさせる。実際の
   * `PersistBoundaryError` は違反した引用の先頭 20 コード単位をメッセージに持つので、
   * ここでも**原稿の断片を含む**メッセージにして、それが DB に残らないことを見る。
   */
  function armedIdSequence(armed: { value: boolean }): () => string {
    let count = 0;
    return () => {
      if (armed.value) {
        throw new PersistBoundaryError(
          `位置確定済みの paragraphId が本文から導いた値と一致しません（引用: "${BODY.slice(0, 20)}"）`,
        );
      }
      count += 1;
      return `id-${String(count)}`;
    };
  }

  it("X1: PersistBoundaryError で終わっても stop_message は定型文で、原稿の断片も接続先 URL も残らない", async () => {
    const armed = { value: false };
    const scripted = scriptedClient([
      () => {
        armed.value = true;
        return checkResponse([finding("うえ", "ウエ")]);
      },
    ]);
    const harness = makeHarness(scripted.client, { createId: armedIdSequence(armed) });
    const started = harness.orchestrator.startRun(baseInput({ perspectives: ["typo"] }));

    const run = await started.done;

    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("internal-error");
    expect(run.generationUnconfirmed).toBe(false);
    expect(run.stopMessage).toBe("想定外のエラーで実行を停止しました");
    expect(run.stopMessage).not.toContain(BODY.slice(0, 4));
    expect(run.stopMessage).not.toContain("127.0.0.1");
    expect(run.finishedAt).not.toBeNull();

    // 例外で終わっても run-settled は出る（決定 33 の 4）。
    const settled = harness.events.filter((entry) => entry.event.type === "run-settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.event).toMatchObject({
      status: "stopped",
      stop: { reason: "internal-error", message: "想定外のエラーで実行を停止しました" },
    });
  });

  it("X2: 想定外の例外の後、running だった単位が pending に戻り、再開が拾える", async () => {
    const armed = { value: false };
    const scripted = scriptedClient([
      () => {
        armed.value = true;
        return checkResponse([finding("うえ", "ウエ")]);
      },
      () => checkResponse([]),
    ]);
    const harness = makeHarness(scripted.client, { createId: armedIdSequence(armed) });
    const started = harness.orchestrator.startRun(baseInput({ perspectives: ["typo"] }));
    const run = await started.done;
    expect(run.status).toBe("stopped");

    const unit = unitsOf(harness.db, run.id)[0];
    // running のまま残ると resumeRun の claimUnitChecked(pending → running) が 0 行になり、
    // この単位は二度と拾われない（起動時照合は起動時にしか走らない）。
    expect(unit?.status).toBe("pending");
    expect(unit?.pendingNote).toBe("想定外のエラーで実行が中断した");

    // 例外を解除して再開すると、同じ単位から続けられる。
    armed.value = false;
    const resumed = harness.orchestrator.resumeRun(run.id);
    expect(resumed.accepted).toBe(true);
    const finished = await resumed.done;

    expect(finished.status).toBe("completed");
    expect(scripted.requests).toHaveLength(2);
    expect(unitsOf(harness.db, run.id)[0]?.status).toBe("done");
  });

  it("X3: 想定外の例外でも done は reject しない（決定 24）", async () => {
    const scripted = scriptedClient([
      () => {
        throw new TypeError("想定外の例外");
      },
    ]);
    const harness = makeHarness(scripted.client);
    const started = harness.orchestrator.startRun(baseInput({ perspectives: ["typo"] }));

    await expect(started.done).resolves.toMatchObject({
      id: started.run.id,
      status: "stopped",
      stopReason: "internal-error",
    });
  });

  /**
   * 保存の直前（`saveCheckUnitOutcome` / `saveRecheckOutcome` に渡す `now()` の評価）で
   * 1 度だけ投げる継ぎ目。`claim` で単位を `running` にした後・保存トランザクションを開く前に
   * 抜けるので、「`running` の単位を残したまま想定外の例外で終わった」状況が作れる。
   * 1 度だけにするのは、決定 33 の後始末自身（`settleInternalError` の `now()`）まで
   * 巻き込むと後始末の成否が観測できなくなるため。
   */
  function throwOnceNow(armed: { value: boolean }): () => Date {
    return () => {
      if (armed.value) {
        armed.value = false;
        throw new PersistBoundaryError(
          `位置確定済みの paragraphId が本文から導いた値と一致しません（引用: "${BODY.slice(0, 20)}"）`,
        );
      }
      return new Date();
    };
  }

  it("X2: 差し戻した単位は attempts・failure・elapsed_ms を保つ（決定 20：直前に何が起きたかは捨てない）", async () => {
    const armed = { value: false };
    const scripted = scriptedClient([
      () => {
        armed.value = true;
        return checkResponse([]);
      },
    ]);
    const harness = makeHarness(scripted.client, { now: throwOnceNow(armed) });
    // 2 回失敗している単位を個別再試行すると、`running` になった時点でも
    // attempts: 2・failure: malformed・elapsed_ms: 1 を持っている。
    const seeded = seedRun(harness.db, {
      runId: "run-x2-keep",
      status: "partially-failed",
      unitStatuses: ["failed"],
    });

    const retried = harness.orchestrator.retryFailedUnits(seeded.run.id);
    const run = await retried.done;
    expect(run.stopReason).toBe("internal-error");

    const unit = unitsOf(harness.db, run.id)[0];
    expect(unit?.status).toBe("pending");
    expect(unit?.pendingNote).toBe("想定外のエラーで実行が中断した");
    expect(unit?.attempts).toBe(2);
    expect(unit?.failure?.reason).toBe("malformed");
    expect(unit?.elapsedMs).toBe(1);
  });

  it("X2: 再確認単位も running のまま残らず pending に戻り、再開が拾える（決定 33 の 1）", async () => {
    const armed = { value: false };
    const scripted = scriptedClient([
      () => {
        armed.value = true;
        return recheckResponse();
      },
      () => recheckResponse(),
    ]);
    const harness = makeHarness(scripted.client, { now: throwOnceNow(armed) });
    const seeded = seedRun(harness.db, {
      runId: "run-x2-recheck",
      status: "stopped",
      unitStatuses: ["done", "done"],
      recheckEnabled: true,
    });
    const { recheckUnitId } = seedRecheckUnit(harness.db, seeded, "pending");

    const resumed = harness.orchestrator.resumeRun(seeded.run.id);
    const run = await resumed.done;

    expect(run.stopReason).toBe("internal-error");
    const recheck = listRecheckUnits(harness.db, run.id).find((unit) => unit.id === recheckUnitId);
    // running のまま残ると、再開の claimRecheckUnitChecked(pending → running) が 0 行になり
    // この再確認は二度と拾われない（検査単位と同じ危険）。
    expect(recheck?.status).toBe("pending");
    expect(recheck?.pendingNote).toBe("想定外のエラーで実行が中断した");

    const again = harness.orchestrator.resumeRun(run.id);
    expect(again.accepted).toBe(true);
    expect((await again.done).status).toBe("completed");
    expect(
      listRecheckUnits(harness.db, run.id).find((unit) => unit.id === recheckUnitId)?.status,
    ).toBe("done");
  });

  it("A-1: 復旧ゲートが閉じている実行の想定外の例外は recovery-waiting で終端化し、再開でゲートが開く", async () => {
    const armed = { value: false };
    const scripted = scriptedClient([
      () => {
        // 生成中に応答を受け取れずに切断（executor が同期的にゲートを閉じる）。
        armed.value = true;
        throw connectionLost();
      },
      () => checkResponse([]),
    ]);
    const harness = makeHarness(scripted.client, { now: throwOnceNow(armed) });
    const started = harness.orchestrator.startRun(baseInput({ perspectives: ["typo"] }));
    const run = await started.done;

    // 生成が未確認であることは、後から起きた例外とは無関係に真である（決定 23 の写像）。
    expect(run.status).toBe("recovery-waiting");
    expect(run.stopReason).toBe("internal-error");
    expect(run.generationUnconfirmed).toBe(true);
    expect(run.stopMessage).toBe("想定外のエラーで実行を停止しました");
    expect(harness.recoveryGate.blocked).toBe(true);

    const settled = harness.events.filter((entry) => entry.event.type === "run-settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.event).toMatchObject({
      status: "recovery-waiting",
      stop: { reason: "internal-error", generationUnconfirmed: true },
    });

    // stopped にしていると resumeRun がゲートを開けず、プロセス全体の送信が止まったままになる。
    const resumed = harness.orchestrator.resumeRun(run.id);
    expect(resumed.accepted).toBe(true);
    expect(harness.recoveryGate.blocked).toBe(false);
    expect((await resumed.done).status).toBe("completed");
    expect(scripted.requests).toHaveLength(2);
  });

  /**
   * DB そのものが壊れた状況。`findRun` は「行が無い」を null で返すが、DB が壊れていれば
   * **例外を投げる**。決定 33 の 5 が想定しているのはこの場合で、読み直しを握らないと
   * `startLoop` の `catch` の中で投げることになり `done` が reject する。
   */
  function breakableDb(db: Db, broken: { value: boolean }): Db {
    const failing = ["select", "insert", "update", "delete", "transaction"];
    return new Proxy(db, {
      get(target, property, receiver): unknown {
        if (broken.value && typeof property === "string" && failing.includes(property)) {
          return () => {
            throw new Error("DB が壊れた（テスト用）");
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("S-1: 後始末（単位の差し戻し・終端化・読み直し）が全部失敗しても done は reject しない（決定 33 の 5）", async () => {
    const broken = { value: false };
    const scripted = scriptedClient([
      () => {
        broken.value = true;
        return checkResponse([]);
      },
    ]);
    const db = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const harness = makeHarness(scripted.client, { db: breakableDb(db, broken) });
    const started = harness.orchestrator.startRun(baseInput({ perspectives: ["typo"] }));

    // 保存も、決定 33 の後始末も、その後の読み直しも例外になる。
    await expect(started.done).resolves.toMatchObject({ id: started.run.id });
    // 読み直せなかったので、ループに入る前に読めた値（開始直後のレコード）で解決する。
    expect((await started.done).status).toBe("running");
  });
});
