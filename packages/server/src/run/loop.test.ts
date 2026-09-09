import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  ChunkSettings,
  FindingCategory,
  InitialVerdict,
  LlmFinding,
  LocatedCandidate,
  Perspective,
} from "@shuten/shared";
import { mergeCandidates } from "@shuten/shared";
import { describe, expect, it, vi } from "vitest";

import { createDatabase } from "../db/client.ts";
import { applyMigrations } from "../db/migrate.ts";
import type { CheckUnitRecord, RunRecord } from "../db/records.ts";
import { insertCheckUnit, listCheckUnits } from "../db/repositories/check-units.ts";
import { listDiagnostics } from "../db/repositories/diagnostics.ts";
import {
  findFindingByMergeKey,
  insertFinding,
  listCandidates,
  listCandidatesForFinding,
  listFindings,
} from "../db/repositories/findings.ts";
import { listJudgments } from "../db/repositories/judgments.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { insertRecheckUnit, listRecheckUnits } from "../db/repositories/rechecks.ts";
import { insertRun, insertRunTarget } from "../db/repositories/runs.ts";
import { LmStudioError } from "../lmstudio/errors.ts";
import type {
  ChatRequest,
  ChatResult,
  LmStudioClient,
  ModelInfo,
  Usage,
} from "../lmstudio/types.ts";
import type { RunEvent } from "./events.ts";
import { runLoop } from "./loop.ts";
import type { OrchestratorDeps, StartRunInput } from "./orchestrator.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { createRequestQueue } from "./queue.ts";
import type { StopGate } from "./recovery.ts";
import { createStopGate } from "./recovery.ts";
import { createRecoveryGate } from "./recovery-gate.ts";

/** ---------------------------------------------------------------------- */
/** 素材 */
/** ---------------------------------------------------------------------- */

/**
 * 20 書記素・1 段落の本文。同じ文字が 2 度出ないので、どの部分文字列を引用しても
 * `locateQuote` の完全一致が高々 1 件になり、位置確定が決定的になる。
 */
const BODY = "あいうえおかきくけこさしすせそたちつてと";

/**
 * `targetGraphemes: 10`・`roundingTolerance: 0` で `[0,10)` `[10,20)` の 2 対象に割れる設定。
 * `contextGraphemes: 0` にしてあるので入力範囲は検査対象の範囲そのもの（引用の位置を
 * 目で追えるようにするため）。
 */
const CHUNK_TWO_TARGETS: ChunkSettings = {
  targetGraphemes: 10,
  contextGraphemes: 0,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 50,
};

/** 本文全体（20 書記素）が 1 対象になる設定。 */
const CHUNK_ONE_TARGET: ChunkSettings = { ...CHUNK_TWO_TARGETS, targetGraphemes: 20 };

const PERSPECTIVES: readonly Perspective[] = ["typo", "naturalness"];

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

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

/** LLM の指摘 1 件。段落は 1 つだけなので `paragraphId` は常に 0。 */
function finding(
  quote: string,
  suggestion: string | null,
  category: FindingCategory,
  verdict: InitialVerdict,
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

/** 初回検査の応答。 */
function checkResponse(findings: readonly LlmFinding[]): ChatResult {
  return chatResult(JSON.stringify({ findings }));
}

/** 再確認の応答（`keep` / `error-confirmed`）。 */
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

/** 1 回の生成要求への応答を決める関数。`index` は 0 始まりの通し番号。 */
type ChatStep = (request: ChatRequest, index: number) => ChatResult | Promise<ChatResult>;

interface ScriptedClient {
  readonly client: LmStudioClient;
  /** 送った要求（再試行を含む）。 */
  readonly requests: ChatRequest[];
  readonly ensureLoadedCalls: string[];
}

/**
 * 台本どおりに応答するモック。台本を使い切ったあとに要求が来たら例外にする
 * （想定外の生成要求を黙って成功させない）。
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
    chat: async (request) => {
      const index = requests.length;
      requests.push(request);
      const step = steps[index];
      if (step === undefined) {
        throw new Error(`台本にない生成要求（${String(index)} 件目）`);
      }
      return await step(request, index);
    },
  };
  return { client, requests, ensureLoadedCalls };
}

interface Harness {
  readonly db: ReturnType<typeof setupDb>["db"];
  readonly events: RunEvent[];
  readonly deps: OrchestratorDeps;
}

/** `createId` を「先に決めた列 → 使い切ったら連番」にする（N3 が対象 ID を作り分けるために使う）。 */
function idSequence(preset: readonly string[] = []): () => string {
  let count = 0;
  return () => {
    const preselected = preset[count];
    count += 1;
    return preselected ?? `id-${String(count)}`;
  };
}

function makeHarness(
  client: LmStudioClient,
  overrides: Partial<OrchestratorDeps> = {},
  body = BODY,
): Harness {
  const { db } = setupDb();
  insertManuscriptVersion(db, { id: "mv1", name: "原稿", body });
  const events: RunEvent[] = [];
  const deps: OrchestratorDeps = {
    db,
    client,
    queue: createRequestQueue(),
    recoveryGate: createRecoveryGate(),
    endpointUrl: "http://127.0.0.1:1234",
    recoveryConfirmMs: 0,
    createId: idSequence(),
    onEvent: (event) => events.push(event),
    ...overrides,
  };
  return { db, events, deps };
}

function baseInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    startOperationId: "op-1",
    manuscriptVersionId: "mv1",
    modelId: "model-a",
    generation: { maxTokens: 512, temperature: 0 },
    chunkSettings: CHUNK_TWO_TARGETS,
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: PERSPECTIVES,
    recheckEnabled: false,
    allowedWordsRaw: "",
    ...overrides,
  };
}

/** `startRun` して `done` を待つ。 */
async function runToCompletion(
  harness: Harness,
  input: StartRunInput,
): Promise<{ readonly run: RunRecord }> {
  const orchestrator = createOrchestrator(harness.deps);
  const started = orchestrator.startRun(input);
  const run = await started.done;
  return { run };
}

/** 外から解決できる Promise（`units.test.ts` の同名ヘルパーと同じ形）。 */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve: (value) => resolve(value) };
}

/** 進捗イベントの `type` だけを並べる。 */
function eventTypes(events: readonly RunEvent[]): string[] {
  return events.map((entry) => entry.event.type);
}

/** ---------------------------------------------------------------------- */
/** O1〜O3・O14・O17 */
/** ---------------------------------------------------------------------- */

describe("run/loop: 単位駆動ループ", () => {
  it("O1: 初回実行で runs・run_targets・check_units・candidates・findings・judgments・recheck_units・diagnostics に期待どおりの行が残る", async () => {
    const harness = makeHarness(
      scriptedClient([
        // 対象 0 / typo：位置確定する 1 件。
        () => checkResponse([finding("うえ", "ウエ", "notation", "likely-error")]),
        // 対象 0 / naturalness：同じ引用・同じ修正案なので mergeKey が一致し、統合される。
        () => checkResponse([finding("うえ", "ウエ", "notation", "likely-error")]),
        // 対象 0 の再確認（統合後の 1 指摘ぶん）。
        () => recheckResponse(),
        // 対象 1 / typo：修正案なしの 1 件と、本文に存在しない引用 1 件（not-found）。
        () =>
          checkResponse([
            finding("たち", null, "grammar", "confirm-with-author"),
            finding("ぬ", "ヌ", "notation", "likely-error"),
          ]),
        // 対象 1 / naturalness：指摘なし。
        () => checkResponse([]),
        // 対象 1 の再確認（位置確定済みの 1 指摘ぶん。not-found の指摘は not-applicable）。
        () => recheckResponse(),
      ]).client,
    );

    const { run } = await runToCompletion(harness, baseInput({ recheckEnabled: true }));
    const { db } = harness;

    expect(run.status).toBe("completed");
    expect(run.stopReason).toBeNull();
    expect(run.finishedAt).not.toBeNull();
    // 決定 30：最初の ensureLoaded 成功でモデル情報が書かれる。
    expect(run.modelInfo?.id).toBe("model-a");

    const units = listCheckUnits(db, run.id);
    expect(units).toHaveLength(4);
    expect(units.every((unit) => unit.status === "done")).toBe(true);
    expect(units.every((unit) => unit.startedAt !== null && unit.finishedAt !== null)).toBe(true);

    expect(listCandidates(db, run.id)).toHaveLength(4);
    const findings = listFindings(db, run.id);
    // 「うえ」（2 候補が統合）・「たち」・「ぬ」（not-found）の 3 件。
    expect(findings).toHaveLength(3);
    expect(listJudgments(db, run.id)).toHaveLength(3);
    expect(listDiagnostics(db, run.id)).toHaveLength(1);

    const rechecks = listRecheckUnits(db, run.id);
    expect(rechecks).toHaveLength(3);
    expect(rechecks.filter((unit) => unit.status === "done")).toHaveLength(2);
    const notApplicable = rechecks.filter((unit) => unit.status === "not-applicable");
    expect(notApplicable).toHaveLength(1);
    expect(notApplicable[0]?.notApplicableReason).toBe("unlocated");

    // 候補が統合された指摘は 2 候補を持つ。
    const merged = findings.find((entry) => entry.quote === "うえ");
    expect(merged).toBeDefined();
    expect(listCandidatesForFinding(db, merged?.id ?? "")).toHaveLength(2);

    // イベントは pipeline.ts と同じ位置で出る。
    expect(eventTypes(harness.events)).toEqual([
      "target-planned",
      "target-planned",
      "check-started",
      "check-finished",
      "check-started",
      "check-finished",
      "target-merged",
      "recheck-started",
      "recheck-finished",
      "check-started",
      "check-finished",
      "check-started",
      "check-finished",
      "target-merged",
      "recheck-started",
      "recheck-finished",
      "run-settled",
    ]);
  });

  it("O2: 観点の一部が失敗しても成功分で統合に進み、実行は partially-failed になる", async () => {
    const scripted = scriptedClient([
      // typo：JSON として解析できない応答。executor が 1 回だけ再試行する。
      () => chatResult("これは JSON ではない"),
      () => chatResult("これは JSON ではない"),
      // naturalness：正常な応答。
      () => checkResponse([finding("うえ", "ウエ", "notation", "likely-error")]),
    ]);
    const harness = makeHarness(scripted.client);

    const { run } = await runToCompletion(harness, baseInput({ chunkSettings: CHUNK_ONE_TARGET }));
    const { db } = harness;

    expect(run.status).toBe("partially-failed");
    expect(run.stopReason).toBeNull();
    expect(scripted.requests).toHaveLength(3);

    const units = listCheckUnits(db, run.id);
    const typo = units.find((unit) => unit.perspective === "typo");
    const naturalness = units.find((unit) => unit.perspective === "naturalness");
    expect(typo?.status).toBe("failed");
    expect(typo?.failure?.reason).toBe("malformed");
    expect(typo?.attempts).toBe(2);
    expect(naturalness?.status).toBe("done");

    // 失敗した観点があっても、成功した観点の候補は統合されて残る。
    expect(listFindings(db, run.id)).toHaveLength(1);
    const rechecks = listRecheckUnits(db, run.id);
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0]?.status).toBe("not-applicable");
    expect(rechecks[0]?.notApplicableReason).toBe("disabled");
  });

  it("O3: モデルが未ロードなら当該単位は pending のまま、実行は stopped（model-not-loaded）になる", async () => {
    const scripted = scriptedClient([], {
      ensureLoaded: () =>
        Promise.reject(
          new LmStudioError("model-not-loaded", "モデルがロードされていない", { raw: null }),
        ),
    });
    const harness = makeHarness(scripted.client);

    const { run } = await runToCompletion(harness, baseInput({ chunkSettings: CHUNK_ONE_TARGET }));
    const { db } = harness;

    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("model-not-loaded");
    expect(run.generationUnconfirmed).toBe(false);
    // 生成要求は 1 件も送っていない。
    expect(scripted.requests).toHaveLength(0);

    const units = listCheckUnits(db, run.id);
    expect(units).toHaveLength(2);
    expect(units.every((unit) => unit.status === "pending")).toBe(true);
    // 2 観点目は claim すらしない（停止した時点でループを抜ける）。
    expect(units.filter((unit) => unit.startedAt !== null)).toHaveLength(1);
    expect(listRecheckUnits(db, run.id)).toHaveLength(0);
  });

  it("O14: 位置特定に失敗した指摘には not-applicable の再確認単位が作られ、理由は unlocated になる", async () => {
    const harness = makeHarness(
      scriptedClient([
        () => checkResponse([finding("ぬ", "ヌ", "notation", "likely-error")]),
        () => checkResponse([]),
      ]).client,
    );

    const { run } = await runToCompletion(
      harness,
      baseInput({ chunkSettings: CHUNK_ONE_TARGET, recheckEnabled: true }),
    );

    const rechecks = listRecheckUnits(harness.db, run.id);
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0]?.status).toBe("not-applicable");
    expect(rechecks[0]?.notApplicableReason).toBe("unlocated");
  });

  it("O14: 再確認が無効なら、位置特定に失敗した指摘の理由は disabled が優先される（決定 11）", async () => {
    const harness = makeHarness(
      scriptedClient([
        () => checkResponse([finding("ぬ", "ヌ", "notation", "likely-error")]),
        () => checkResponse([]),
      ]).client,
    );

    const { run } = await runToCompletion(
      harness,
      baseInput({ chunkSettings: CHUNK_ONE_TARGET, recheckEnabled: false }),
    );

    const rechecks = listRecheckUnits(harness.db, run.id);
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0]?.notApplicableReason).toBe("disabled");
  });

  it("O14: 抑制された指摘の再確認単位は not-applicable（suppressed）になる", async () => {
    const harness = makeHarness(
      scriptedClient([
        () => checkResponse([finding("うえ", "ウエ", "notation", "likely-error")]),
        () => checkResponse([]),
      ]).client,
    );

    const { run } = await runToCompletion(
      harness,
      baseInput({
        chunkSettings: CHUNK_ONE_TARGET,
        recheckEnabled: true,
        allowedWordsRaw: "うえ",
      }),
    );

    const rechecks = listRecheckUnits(harness.db, run.id);
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0]?.status).toBe("not-applicable");
    expect(rechecks[0]?.notApplicableReason).toBe("suppressed");
  });

  it("O17: 1 観点が pending の間は recheck_units が 0 件で、対象の全単位が決着した瞬間に作られる（決定 19・34）", async () => {
    // DB とハーネスは台本より後に作るので、観測は遅延評価する。
    let observe: () => number = () => {
      throw new Error("観測の準備前に生成要求が来た");
    };
    /** 各生成要求の時点での recheck_units の件数。 */
    const recheckCountsAtRequest: number[] = [];

    const scripted = scriptedClient([
      () => {
        recheckCountsAtRequest.push(observe());
        return checkResponse([finding("うえ", "ウエ", "notation", "likely-error")]);
      },
      () => {
        // 決定 34 を守っていれば、この時点（2 観点目の要求）でも再確認単位は 1 件も無い。
        recheckCountsAtRequest.push(observe());
        return checkResponse([]);
      },
      () => {
        recheckCountsAtRequest.push(observe());
        return recheckResponse();
      },
    ]);
    const harness = makeHarness(scripted.client);

    const orchestrator = createOrchestrator(harness.deps);
    const started = orchestrator.startRun(
      baseInput({ chunkSettings: CHUNK_ONE_TARGET, recheckEnabled: true }),
    );
    const startedRunId = started.run.id;
    observe = () => listRecheckUnits(harness.db, startedRunId).length;
    const run = await started.done;

    expect(run.status).toBe("completed");
    // 1 観点目・2 観点目の要求時点ではまだ 0 件。再確認の要求時点では作られている。
    expect(recheckCountsAtRequest).toEqual([0, 0, 1]);

    const rechecks = listRecheckUnits(harness.db, run.id);
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0]?.status).toBe("done");
    expect(rechecks[0]?.verdict).toBe("keep");
    expect(rechecks[0]?.inputRange).not.toBeNull();
  });

  it("O17: 前回セッションで pending のまま残った再確認だけを進める（検査単位は 1 つも実行しない）", async () => {
    // 検査単位はすべて done、指摘と pending の再確認単位だけが残っている状態を作る。
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const seeded = seedRun(db, {
      runId: "run-resume",
      unitStatuses: ["done", "done"],
      recheckEnabled: true,
    });
    const findingRecord = insertLocatedFinding(db, seeded, "うえ", 2, 4, "ウエ");
    insertRecheckUnit(db, {
      id: "ru-1",
      runId: seeded.run.id,
      findingId: findingRecord.id,
      inputRange: null,
      status: "pending",
      notApplicableReason: null,
      attempts: 0,
      failure: null,
      pendingNote: null,
      verdict: null,
      reasonKind: null,
      reason: null,
      suggestionValid: null,
      usage: null,
      inputGraphemes: null,
      elapsedMs: null,
      startedAt: null,
      finishedAt: null,
    });

    const scripted = scriptedClient([() => recheckResponse()]);
    const run = await runLoopDirect(db, seeded.run.id, scripted.client);

    expect(run.status).toBe("completed");
    expect(scripted.requests).toHaveLength(1);
    const rechecks = listRecheckUnits(db, run.id);
    expect(rechecks[0]?.status).toBe("done");
  });

  /** ---------------------------------------------------------------------- */
  /** R1 */
  /** ---------------------------------------------------------------------- */

  it("R1: checkMs を超えても上限内に応答が届けば結果として採用され、実行が続く（generation-slow が出る）", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<ChatResult>();
      const scripted = scriptedClient([() => pending.promise]);
      const harness = makeHarness(scripted.client, { recoveryConfirmMs: 500 });

      const orchestrator = createOrchestrator(harness.deps);
      const started = orchestrator.startRun(
        baseInput({
          chunkSettings: CHUNK_ONE_TARGET,
          perspectives: ["typo"],
          timeouts: { checkMs: 1000, recheckMs: 1000 },
        }),
      );

      // checkMs（1000ms）は超えたが、ハード上限（1500ms）にはまだ達していない。
      await vi.advanceTimersByTimeAsync(1200);
      const slow = harness.events.filter((entry) => entry.event.type === "generation-slow");
      expect(slow).toHaveLength(1);
      expect(slow[0]?.event).toMatchObject({ elapsedMs: 1000 });

      pending.resolve(checkResponse([finding("うえ", "ウエ", "notation", "likely-error")]));
      const run = await started.done;

      expect(run.status).toBe("completed");
      const units = listCheckUnits(harness.db, run.id);
      expect(units[0]?.status).toBe("done");
      expect(listFindings(harness.db, run.id)).toHaveLength(1);
      // ハード上限は checkMs + recoveryConfirmMs（決定 20・44）。
      expect(scripted.requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /** ---------------------------------------------------------------------- */
  /** M1〜M3（統合の同値） */
  /** ---------------------------------------------------------------------- */

  /**
   * M1 のオラクル用の候補列。1 対象・2 観点で次を含める。
   * - 同じ mergeKey で category が食い違う組（統合後は unclear）
   * - 同じ mergeKey で verdict が食い違う組（統合後は confirm-with-author）
   * - 修正案なし（mergeKey が null）の同一引用 2 件（常に別の指摘。M2）
   * - どの組にも属さない単独の候補
   */
  const ORACLE_TYPO: readonly LlmFinding[] = [
    finding("うえ", "ウエ", "notation", "likely-error"),
    finding("かき", null, "grammar", "likely-error"),
    finding("さし", "サシ", "particle", "likely-error"),
    finding("たち", "タチ", "notation", "likely-error"),
  ];
  const ORACLE_NATURALNESS: readonly LlmFinding[] = [
    finding("うえ", "ウエ", "grammar", "likely-error"),
    finding("かき", null, "grammar", "likely-error"),
    finding("さし", "サシ", "particle", "confirm-with-author"),
  ];

  async function runOracle(): Promise<{ readonly harness: Harness; readonly run: RunRecord }> {
    const harness = makeHarness(
      scriptedClient([() => checkResponse(ORACLE_TYPO), () => checkResponse(ORACLE_NATURALNESS)])
        .client,
    );
    const { run } = await runToCompletion(harness, baseInput({ chunkSettings: CHUNK_ONE_TARGET }));
    return { harness, run };
  }

  it("M1: 一括統合（mergeCandidates）と、ループが保存した増分統合の結果が、グルーピング・category・initialVerdict で一致する", async () => {
    const { harness, run } = await runOracle();
    const { db } = harness;

    // 保存された候補（candidate_index 昇順＝LLM が返した順）から LocatedCandidate を組み立て、
    // CLI 経路が使う一括統合にかける。
    const saved = listCandidates(db, run.id);
    expect(saved).toHaveLength(ORACLE_TYPO.length + ORACLE_NATURALNESS.length);
    const located: LocatedCandidate[] = saved.map((candidate) => {
      if (candidate.range === null) {
        throw new Error("この素材では全候補が位置確定するはず");
      }
      return {
        id: candidate.id,
        // 観点は統合規則に影響しないので、オラクル側では固定でよい。
        perspective: "typo",
        llm: candidate.llm,
        locate: { status: "located", range: candidate.range },
      };
    });
    let counter = 0;
    const oracle = mergeCandidates(located, () => {
      counter += 1;
      return `oracle-${String(counter)}`;
    });

    const savedFindings = listFindings(db, run.id);
    expect(savedFindings).toHaveLength(oracle.length);

    // グルーピング（元候補 ID の集合）で対応付け、category と initialVerdict を突き合わせる。
    const savedGroups = savedFindings.map((entry) => ({
      members: listCandidatesForFinding(db, entry.id)
        .map((candidate) => candidate.id)
        .sort(),
      category: entry.category,
      initialVerdict: entry.initialVerdict,
    }));
    const oracleGroups = oracle.map((entry) => ({
      members: entry.sources.map((source) => source.id).sort(),
      category: entry.category,
      initialVerdict: entry.verdict,
    }));
    const byMembers = (a: { members: string[] }, b: { members: string[] }): number =>
      a.members.join(",").localeCompare(b.members.join(","));
    expect([...savedGroups].sort(byMembers)).toEqual([...oracleGroups].sort(byMembers));

    // 素材が「食い違いを含む」ことを念のため確認する（全員一致なら差分を検出できないため）。
    expect(oracleGroups.some((group) => group.category === "unclear")).toBe(true);
    expect(oracleGroups.some((group) => group.initialVerdict === "confirm-with-author")).toBe(true);
    expect(oracleGroups.some((group) => group.members.length === 2)).toBe(true);
  });

  it("M2: 修正案なし（mergeKey が null）の候補は、引用が同じでも常に別の指摘になる", async () => {
    const { harness, run } = await runOracle();
    const noSuggestion = listFindings(harness.db, run.id).filter((entry) => entry.quote === "かき");
    expect(noSuggestion).toHaveLength(2);
    expect(noSuggestion[0]?.id).not.toBe(noSuggestion[1]?.id);
    expect(noSuggestion.every((entry) => entry.mergeKey === null)).toBe(true);
    expect(
      noSuggestion.every((entry) => listCandidatesForFinding(harness.db, entry.id).length === 1),
    ).toBe(true);
  });

  it("M3: 実行 ID が違えば、同じ mergeKey の候補でも別の指摘になる（仕様 6.4）", async () => {
    const scripted = scriptedClient([
      () => checkResponse([finding("うえ", "ウエ", "notation", "likely-error")]),
      () => checkResponse([]),
      () => checkResponse([finding("うえ", "ウエ", "notation", "likely-error")]),
      () => checkResponse([]),
    ]);
    const harness = makeHarness(scripted.client);
    const orchestrator = createOrchestrator(harness.deps);

    const first = orchestrator.startRun(
      baseInput({ startOperationId: "op-1", chunkSettings: CHUNK_ONE_TARGET }),
    );
    const runA = await first.done;
    const second = orchestrator.startRun(
      baseInput({ startOperationId: "op-2", chunkSettings: CHUNK_ONE_TARGET }),
    );
    const runB = await second.done;

    expect(runA.id).not.toBe(runB.id);
    const findingsA = listFindings(harness.db, runA.id);
    const findingsB = listFindings(harness.db, runB.id);
    expect(findingsA).toHaveLength(1);
    expect(findingsB).toHaveLength(1);
    expect(findingsA[0]?.id).not.toBe(findingsB[0]?.id);

    const key = findingsA[0]?.mergeKey ?? "";
    expect(key).not.toBe("");
    expect(findFindingByMergeKey(harness.db, runA.id, key)?.id).toBe(findingsA[0]?.id);
    expect(findFindingByMergeKey(harness.db, runB.id, key)?.id).toBe(findingsB[0]?.id);
  });

  /** ---------------------------------------------------------------------- */
  /** N3（走査順） */
  /** ---------------------------------------------------------------------- */

  it("N3: 走査順は target_index 昇順・runs.perspectives の順で、対象 ID の UUID 順に依存しない（決定 25）", async () => {
    /**
     * `startRun` が `createId` を呼ぶ順は 実行 → 対象 0 → 対象 0 の単位 ×2 → 対象 1 →
     * 対象 1 の単位 ×2。対象 ID だけを昇順・降順に作り分ける。
     */
    async function collectOrder(
      target0Id: string,
      target1Id: string,
    ): Promise<Array<{ targetIndex: number; perspective: string }>> {
      const harness = makeHarness(
        scriptedClient([
          () => checkResponse([]),
          () => checkResponse([]),
          () => checkResponse([]),
          () => checkResponse([]),
        ]).client,
        {
          createId: idSequence([
            "run-x",
            target0Id,
            "cu-0-0",
            "cu-0-1",
            target1Id,
            "cu-1-0",
            "cu-1-1",
          ]),
        },
      );
      await runToCompletion(harness, baseInput());
      return harness.events.flatMap((entry) =>
        entry.event.type === "check-started"
          ? [{ targetIndex: entry.event.targetIndex, perspective: entry.event.perspective }]
          : [],
      );
    }

    const expected = [
      { targetIndex: 0, perspective: "typo" },
      { targetIndex: 0, perspective: "naturalness" },
      { targetIndex: 1, perspective: "typo" },
      { targetIndex: 1, perspective: "naturalness" },
    ];
    // 対象 ID が昇順のときも降順のときも同じ順序になること。
    expect(await collectOrder("t-aaa", "t-zzz")).toEqual(expected);
    expect(await collectOrder("t-zzz", "t-aaa")).toEqual(expected);
  });

  /** ---------------------------------------------------------------------- */
  /** 決定 26・27（停止ゲートの出入りは executor のフック経由だけ） */
  /** ---------------------------------------------------------------------- */

  it("決定 26: beginRequest / endRequest は client.chat の直前・直後だけで呼ばれる（ensureLoaded を挟まない）", async () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const seeded = seedRun(db, { runId: "run-gate", unitStatuses: ["pending"] });

    const trace: string[] = [];
    const client: LmStudioClient = {
      listModels: () => Promise.resolve([LOADED_MODEL]),
      ensureLoaded: () => {
        trace.push("ensureLoaded");
        return Promise.resolve(LOADED_MODEL);
      },
      chat: () => {
        trace.push("chat");
        return Promise.resolve(checkResponse([]));
      },
    };

    const inner = createStopGate(0);
    const gate = {
      ...inner,
      get signal() {
        return inner.signal;
      },
      get stopRequested() {
        return inner.stopRequested;
      },
      beginRequest: () => {
        trace.push("beginRequest");
        inner.beginRequest();
      },
      endRequest: () => {
        trace.push("endRequest");
        inner.endRequest();
      },
    };

    await runLoopDirect(db, seeded.run.id, client, gate);

    // ループが executeCheckUnit の前後で呼んでいると "beginRequest" が "ensureLoaded" より
    // 前に来る（キュー待ちと ensureLoaded が「実行中の生成」に含まれてしまう）。
    expect(trace).toEqual(["ensureLoaded", "beginRequest", "chat", "endRequest"]);
    inner.dispose();
  });

  /** ---------------------------------------------------------------------- */
  /** 決定 35（終了状態は DB を読み直して決める） */
  /** ---------------------------------------------------------------------- */

  it("決定 35: ループが実行しなかった failed の検査単位も終了状態に反映される（DB を読み直す）", async () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    // 1 観点はすでに failed（前回セッションの結果）。もう 1 観点だけを今回のループが進める。
    const seeded = seedRun(db, { runId: "run-mixed", unitStatuses: ["failed", "pending"] });

    const scripted = scriptedClient([() => checkResponse([])]);
    const run = await runLoopDirect(db, seeded.run.id, scripted.client);

    expect(scripted.requests).toHaveLength(1);
    // 今回のループが処理した単位だけを数えると completed になってしまう。
    expect(run.status).toBe("partially-failed");
  });

  it("決定 35: ループが 1 単位も実行しなくても、failed の再確認単位があれば partially-failed になる", async () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const seeded = seedRun(db, { runId: "run-recheck-failed", unitStatuses: ["done", "done"] });
    const findingRecord = insertLocatedFinding(db, seeded, "うえ", 2, 4, "ウエ");
    insertRecheckUnit(db, {
      id: "ru-failed",
      runId: seeded.run.id,
      findingId: findingRecord.id,
      inputRange: null,
      status: "failed",
      notApplicableReason: null,
      attempts: 1,
      failure: {
        reason: "malformed",
        message: "解析できなかった",
        finishReason: null,
        origin: "chat",
      },
      pendingNote: null,
      verdict: null,
      reasonKind: null,
      reason: null,
      suggestionValid: null,
      usage: null,
      inputGraphemes: null,
      elapsedMs: 1,
      startedAt: null,
      finishedAt: new Date(),
    });

    const scripted = scriptedClient([]);
    const run = await runLoopDirect(db, seeded.run.id, scripted.client);

    expect(scripted.requests).toHaveLength(0);
    expect(run.status).toBe("partially-failed");
  });

  /** ---------------------------------------------------------------------- */
  /** 決定 24（done は reject しない） */
  /** ---------------------------------------------------------------------- */

  it("done は想定外の例外でも reject しない（決定 24）", async () => {
    const scripted = scriptedClient([
      () => {
        // LmStudioError ではない例外は executor を素通りしてループの外まで抜ける。
        throw new TypeError("想定外の例外");
      },
    ]);
    const harness = makeHarness(scripted.client);

    const orchestrator = createOrchestrator(harness.deps);
    const started = orchestrator.startRun(
      baseInput({ chunkSettings: CHUNK_ONE_TARGET, perspectives: ["typo"] }),
    );
    const run = await started.done;

    // 決定 33 の完全な処理（pending への差し戻しと internal-error での終端化）は Task 8。
    // ここで確かめるのは「reject しない」ことだけ。
    expect(run.id).toBe(started.run.id);
  });
});

/** ---------------------------------------------------------------------- */
/** W3（状態を書く経路は transitions.ts だけ） */
/** ---------------------------------------------------------------------- */

describe("W3: ループ・save・orchestrator はリポジトリの claim* / finish* を直接 import しない（決定 29）", () => {
  const TARGET_FILES = ["loop.ts", "save.ts", "orchestrator.ts"] as const;

  /** `import { ... } from ".../db/repositories/xxx.ts"` の名前付き import を列挙する。 */
  function repositoryImports(source: string): string[] {
    // 波括弧の中に `{` `}` を許さない（`[\s\S]*?` だけだと、直前の import 文をまたいで
    // 「最初の `{` から repositories を指す `}` まで」を 1 つの塊として飲み込んでしまい、
    // 先頭に並んだ名前が検査から漏れる）。
    const pattern = /import\s+(?:type\s+)?\{([^{}]*?)\}\s*from\s*"[^"]*db\/repositories\/[^"]+"/g;
    const names: string[] = [];
    for (const match of source.matchAll(pattern)) {
      const body = match[1] ?? "";
      for (const raw of body.split(",")) {
        const name = raw
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name !== undefined && name !== "") {
          names.push(name);
        }
      }
    }
    return names;
  }

  it("検査対象のファイルの import を実際に読めていること（正規表現が空振り・取りこぼしをしていない）", () => {
    // 各ファイルの import ブロックの**先頭の名前**を含める。取りこぼしがあると、
    // 禁止名が先頭に並んだときに検査をすり抜けてしまうため。
    const expected: Record<(typeof TARGET_FILES)[number], readonly string[]> = {
      "loop.ts": ["findCheckUnit", "listCandidateSourcesForFinding", "findRecheckUnitByFinding"],
      "save.ts": ["nextCandidateIndex", "insertRecheckUnit", "updateRunModelInfo"],
      "orchestrator.ts": ["insertCheckUnit", "findManuscriptVersion", "findRun"],
    };
    for (const file of TARGET_FILES) {
      const source = readFileSync(path.resolve(import.meta.dirname, file), "utf8");
      const names = repositoryImports(source);
      for (const name of expected[file]) {
        expect({ file, name, found: names.includes(name) }).toEqual({ file, name, found: true });
      }
    }
  });

  it("claim* / finish* をリポジトリから直接 import していないこと", () => {
    for (const file of TARGET_FILES) {
      const source = readFileSync(path.resolve(import.meta.dirname, file), "utf8");
      const forbidden = repositoryImports(source).filter((name) => /^(claim|finish)/.test(name));
      expect({ file, forbidden }).toEqual({ file, forbidden: [] });
    }
  });
});

/** ---------------------------------------------------------------------- */
/** ヘルパー（DB を手で組み立てて runLoop を直接呼ぶ経路） */
/** ---------------------------------------------------------------------- */

interface SeededRun {
  readonly run: RunRecord;
  readonly targetId: string;
  readonly units: readonly CheckUnitRecord[];
}

/**
 * `running` の実行・1 対象・観点ぶんの検査単位を手で作る。`startRun` を経由せずに
 * 「途中まで進んだ実行」を再現するために使う。
 */
function seedRun(
  db: ReturnType<typeof setupDb>["db"],
  input: {
    readonly runId: string;
    /** `PERSPECTIVES` の順に対応する検査単位の状態。 */
    readonly unitStatuses: readonly CheckUnitRecord["status"][];
    readonly recheckEnabled?: boolean;
  },
): SeededRun {
  const run = insertRun(db, {
    id: input.runId,
    manuscriptVersionId: "mv1",
    modelId: "model-a",
    modelInfo: null,
    endpointUrl: "http://127.0.0.1:1234",
    generationSettings: { maxTokens: 512, temperature: 0 },
    chunkSettings: CHUNK_ONE_TARGET,
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    // 観点の数は検査単位の数に合わせる（`runs.perspectives` は走査順の正本なので、
    // 単位を作っていない観点を載せるとループが「単位が見つからない」で落ちる）。
    perspectives: PERSPECTIVES.slice(0, input.unitStatuses.length),
    recheckEnabled: input.recheckEnabled ?? false,
    allowedWords: [],
    allowedWordRuleVersion: "1",
    promptVersion: "1",
    diagnosticTransformVersion: "1",
    status: "running",
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    startOperationId: null,
    finishedAt: null,
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
    const perspective = PERSPECTIVES[index];
    if (perspective === undefined) {
      throw new Error("unitStatuses が perspectives より長い");
    }
    return insertCheckUnit(db, {
      id: `${input.runId}-cu${String(index)}`,
      runId: run.id,
      targetId: target.id,
      perspective,
      status,
      attempts: status === "pending" ? 0 : 1,
      failure:
        status === "failed"
          ? {
              reason: "malformed",
              message: "解析できなかった",
              finishReason: null,
              origin: "chat",
            }
          : null,
      pendingNote: null,
      usage: null,
      inputGraphemes: null,
      elapsedMs: status === "pending" ? null : 1,
      startedAt: null,
      finishedAt: status === "pending" ? null : new Date(),
    });
  });
  return { run, targetId: target.id, units };
}

/** 位置確定済みの指摘を 1 件、手で作る（`insertFinding` は judgments も同時に作る）。 */
function insertLocatedFinding(
  db: ReturnType<typeof setupDb>["db"],
  seeded: SeededRun,
  quote: string,
  start: number,
  end: number,
  suggestion: string | null,
) {
  return insertFinding(db, {
    runId: seeded.run.id,
    manuscriptVersionId: "mv1",
    targetId: seeded.targetId,
    locateStatus: "located",
    range: { start, end },
    paragraphId: 0,
    quote,
    suggestion,
    category: "notation",
    initialVerdict: "likely-error",
    mergeKey: `${String(start)}:${String(end)}:${JSON.stringify(quote)}:${JSON.stringify(suggestion)}`,
    suppression: null,
  });
}

/** `runLoop` を直接呼ぶ（オーケストレーターを介さない）。 */
async function runLoopDirect(
  db: ReturnType<typeof setupDb>["db"],
  runId: string,
  client: LmStudioClient,
  gateOverride?: StopGate,
): Promise<RunRecord> {
  const gate = gateOverride ?? createStopGate(0);
  try {
    return await runLoop({
      db,
      client,
      queue: createRequestQueue(),
      recoveryGate: createRecoveryGate(),
      gate,
      runId,
      now: () => new Date(),
      createId: idSequence(),
      emit: () => undefined,
    });
  } finally {
    if (gateOverride === undefined) {
      gate.dispose();
    }
  }
}
