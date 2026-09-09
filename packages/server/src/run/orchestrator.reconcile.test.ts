/**
 * 起動時照合（`reconcileOnStartup`）のテスト（決定 13・39・40）。
 *
 * `orchestrator.stop.test.ts` が実行中の状態遷移を見るのに対し、ここでは
 * **プロセスが落ちた後に残った `running` の行をどう片づけるか**（決定 13 の 3 規則）と、
 * その片づけが実行ごとに 1 トランザクションであること（決定 40）、復旧ゲートの復元（決定 39）を見る。
 */

import type { ChunkSettings } from "@shuten/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db/client.ts";
import { applyMigrations } from "../db/migrate.ts";
import type { CheckUnitRecord, RecheckUnitRecord, RunRecord } from "../db/records.ts";
import { insertCheckUnit, listCheckUnits } from "../db/repositories/check-units.ts";
import { insertFinding } from "../db/repositories/findings.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { insertRecheckUnit, listRecheckUnits } from "../db/repositories/rechecks.ts";
import { findRun, insertRun, insertRunTarget } from "../db/repositories/runs.ts";
import type { LmStudioClient } from "../lmstudio/types.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { createRequestQueue } from "./queue.ts";
import { createRecoveryGate } from "./recovery-gate.ts";

/** 本文（1 段落）。 */
const BODY = "あいうえおかきくけこさしすせそたちつてと";

const CHUNK_ONE_TARGET: ChunkSettings = {
  targetGraphemes: 20,
  contextGraphemes: 0,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 50,
};

/** I-2：1 回失敗した後に再試行で running に戻った単位が持つ「直前の失敗」の記録。 */
const STALE_FAILURE = {
  reason: "malformed",
  message: "解析できなかった（1 回目の失敗）",
  finishReason: null,
  origin: "chat",
} as const;

/** I-2：直前の生成要求が残した `usage`。 */
const STALE_USAGE = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  reasoningTokens: null,
};

/** 起動時照合はどこにも `chat` を送らないので、呼ばれたら例外にするクライアント。 */
const UNUSED_CLIENT: LmStudioClient = {
  listModels: () => {
    throw new Error("起動時照合は listModels を呼ばないはず");
  },
  ensureLoaded: () => {
    throw new Error("起動時照合は ensureLoaded を呼ばないはず");
  },
  chat: () => {
    throw new Error("起動時照合は chat を呼ばないはず");
  },
};

function setupDb() {
  const { db } = createDatabase(":memory:");
  applyMigrations(db);
  return db;
}

type Db = ReturnType<typeof setupDb>;

function makeOrchestrator(
  db: Db,
  overrides: { readonly recoveryGate?: ReturnType<typeof createRecoveryGate> } = {},
) {
  const recoveryGate = overrides.recoveryGate ?? createRecoveryGate();
  const orchestrator = createOrchestrator({
    db,
    client: UNUSED_CLIENT,
    queue: createRequestQueue(),
    recoveryGate,
    endpointUrl: "http://127.0.0.1:1234",
    recoveryConfirmMs: 60_000,
  });
  return { orchestrator, recoveryGate };
}

interface SeedRunInput {
  readonly runId: string;
  readonly status: RunRecord["status"];
  readonly unitStatuses: readonly CheckUnitRecord["status"][];
  /**
   * 個別の単位に既定値以外の `failure` / `usage` / `elapsedMs` を持たせたいときのオーバーライド
   * （`unitStatuses` の添字をキーにする）。`claimUnit`（`db/repositories/check-units.ts`）は
   * `failed → pending → running` と遷移しても `failure` / `usage` を消さないため、1 回失敗して
   * 再試行に入った直後に `running` のままバックエンドが落ちた単位は、`failure` を持ったまま
   * 起動時照合の対象になりうる（I-2）。
   */
  readonly unitOverrides?: Readonly<
    Record<number, Partial<Pick<CheckUnitRecord, "failure" | "usage" | "elapsedMs">>>
  >;
  /**
   * `runs.started_at` を明示的に指定する（I-1）。`listRunsByStatus` は
   * `asc(started_at), asc(id)` で並ぶので、複数の実行を狙った順に処理させたいテストで使う。
   * 省略時は `insertRun` の既定（呼び出し時点の現在時刻）。
   */
  readonly startedAt?: Date;
}

interface SeededRun {
  readonly run: RunRecord;
  readonly targetId: string;
  readonly units: readonly CheckUnitRecord[];
}

/** `startRun` を経由せずに「途中まで進んだ実行」を DB に直接作る。 */
function seedRun(db: Db, input: SeedRunInput): SeededRun {
  const perspectives = (["typo", "naturalness"] as const).slice(0, input.unitStatuses.length);
  const run = insertRun(db, {
    id: input.runId,
    manuscriptVersionId: "mv1",
    modelId: "model-a",
    modelInfo: null,
    endpointUrl: "http://127.0.0.1:1234",
    generationSettings: { maxTokens: 512, temperature: 0 },
    chunkSettings: CHUNK_ONE_TARGET,
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    recoveryConfirmMs: 60_000,
    perspectives,
    recheckEnabled: true,
    allowedWords: [],
    allowedWordRuleVersion: "1",
    promptVersion: "1",
    diagnosticTransformVersion: "1",
    status: input.status,
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    stopRequestedAt: null,
    startOperationId: null,
    finishedAt: null,
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
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
    const override = input.unitOverrides?.[index];
    return insertCheckUnit(db, {
      id: `${input.runId}-cu${String(index)}`,
      runId: run.id,
      targetId: target.id,
      perspective,
      status,
      attempts: status === "pending" ? 0 : 2,
      failure:
        override?.failure !== undefined
          ? override.failure
          : status === "failed"
            ? {
                reason: "malformed",
                message: "解析できなかった",
                finishReason: null,
                origin: "chat",
              }
            : null,
      pendingNote: null,
      usage: override?.usage ?? null,
      inputGraphemes: null,
      elapsedMs:
        override?.elapsedMs !== undefined ? override.elapsedMs : status === "pending" ? null : 1,
      startedAt: status === "pending" ? null : new Date(1000),
      finishedAt: status === "done" || status === "failed" ? new Date(2000) : null,
    });
  });
  return { run, targetId: target.id, units };
}

/** 位置確定済みの指摘を 1 件作り、その再確認単位を作る（`recheck_units.finding_id` の FK のため）。 */
function seedRecheckUnit(
  db: Db,
  seeded: SeededRun,
  status: RecheckUnitRecord["status"],
): { readonly recheckUnitId: string } {
  const finding = insertFinding(db, {
    id: `${seeded.run.id}-f0`,
    runId: seeded.run.id,
    manuscriptVersionId: "mv1",
    targetId: seeded.targetId,
    locateStatus: "located",
    range: { start: 2, end: 4 },
    paragraphId: 0,
    quote: "うえ",
    suggestion: "うえの修正案",
    category: "notation",
    initialVerdict: "likely-error",
    mergeKey: '2:4:"うえ"',
    suppression: null,
  });
  const recheckUnitId = `${seeded.run.id}-ru0`;
  insertRecheckUnit(db, {
    id: recheckUnitId,
    runId: seeded.run.id,
    findingId: finding.id,
    inputRange: null,
    status,
    notApplicableReason: null,
    attempts: status === "pending" ? 0 : 2,
    failure: null,
    pendingNote: null,
    verdict: null,
    reasonKind: null,
    reason: null,
    suggestionValid: null,
    usage: null,
    inputGraphemes: null,
    elapsedMs: status === "pending" ? null : 1,
    startedAt: status === "pending" ? null : new Date(1000),
    finishedAt: null,
  });
  return { recheckUnitId };
}

function readRun(db: Db, runId: string): RunRecord {
  const run = findRun(db, runId);
  if (run === null) {
    throw new Error(`実行が見つかりません（実行 ID: ${runId}）`);
  }
  return run;
}

describe("run/orchestrator: reconcileOnStartup（決定 13・39・40）", () => {
  it("R5a: running の検査単位を持つ実行は recovery-waiting になり、単位は pending に戻り、ゲートが閉じる", () => {
    const db = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    // I-2：running の種に、1 回失敗した後の再試行で running に戻った、という状況を持たせる
    // （failure・usage・elapsedMs が非 null のまま running）。`claimUnit` はこれらを消さない。
    const seeded = seedRun(db, {
      runId: "run-a",
      status: "running",
      unitStatuses: ["done", "running"],
      unitOverrides: {
        1: { failure: STALE_FAILURE, usage: STALE_USAGE, elapsedMs: 1500 },
      },
    });
    const { orchestrator, recoveryGate } = makeOrchestrator(db);
    orchestrator.reconcileOnStartup();

    const run = readRun(db, "run-a");
    expect(run.status).toBe("recovery-waiting");
    expect(run.generationUnconfirmed).toBe(true);
    // R-1（レビュー裁定）：起動時照合は両分岐とも専用の "backend-restarted" を使う。
    expect(run.stopReason).toBe("backend-restarted");
    expect(run.stopMessage).toBe(
      "バックエンドが終了しました。LM Studio 側を確認して再開してください",
    );
    expect(run.finishedAt).not.toBeNull();

    const units = listCheckUnits(db, "run-a");
    const runningUnit = units.find((unit) => unit.id === seeded.units[1]?.id);
    expect(runningUnit?.status).toBe("pending");
    expect(runningUnit?.pendingNote).toBe("バックエンドが終了したため未完了のまま残った");
    expect(runningUnit?.startedAt).toEqual(new Date(1000));
    // 決定 20 と同じ考え方：処理状態は戻すが、直前に何が起きたか（attempts・failure・usage・
    // elapsedMs）は保つ。I-2：failure を null に潰す変異を入れるとここが落ちる。
    expect(runningUnit?.attempts).toBe(2);
    expect(runningUnit?.failure).toEqual(STALE_FAILURE);
    expect(runningUnit?.usage).toEqual(STALE_USAGE);
    expect(runningUnit?.elapsedMs).toBe(1500);

    // done の単位は触られない（R6 の一部）。
    const doneUnit = units.find((unit) => unit.id === seeded.units[0]?.id);
    expect(doneUnit?.status).toBe("done");
    expect(doneUnit?.pendingNote).toBeNull();

    // 決定 39：復旧ゲートが閉じる。
    expect(recoveryGate.blocked).toBe(true);
    expect([...recoveryGate.blockedRunIds]).toEqual(["run-a"]);
  });

  it("R5b: running の再確認単位だけを持つ実行も recovery-waiting になる", () => {
    const db = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const seeded = seedRun(db, {
      runId: "run-b",
      status: "running",
      unitStatuses: ["done"],
    });
    const { recheckUnitId } = seedRecheckUnit(db, seeded, "running");

    const { orchestrator, recoveryGate } = makeOrchestrator(db);
    orchestrator.reconcileOnStartup();

    const run = readRun(db, "run-b");
    expect(run.status).toBe("recovery-waiting");
    expect(run.generationUnconfirmed).toBe(true);

    const recheck = listRecheckUnits(db, "run-b").find((unit) => unit.id === recheckUnitId);
    expect(recheck?.status).toBe("pending");
    expect(recheck?.pendingNote).toBe("バックエンドが終了したため未完了のまま残った");

    expect(recoveryGate.blocked).toBe(true);
    expect([...recoveryGate.blockedRunIds]).toEqual(["run-b"]);
  });

  it("R5c: running の単位を 1 つも持たない running の実行は stopped になり、ゲートは閉じない", () => {
    const db = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    seedRun(db, {
      runId: "run-c",
      status: "running",
      unitStatuses: ["done", "failed"],
    });

    const { orchestrator, recoveryGate } = makeOrchestrator(db);
    orchestrator.reconcileOnStartup();

    const run = readRun(db, "run-c");
    expect(run.status).toBe("stopped");
    expect(run.generationUnconfirmed).toBe(false);
    // R-1（レビュー裁定）：stopped 側も同じ "backend-restarted" を使う（recovery-waiting 側との
    // 区別は status・generationUnconfirmed・stopMessage が担う）。
    expect(run.stopReason).toBe("backend-restarted");
    expect(run.stopMessage).toBe("バックエンドが終了しました");
    expect(run.finishedAt).not.toBeNull();

    expect(recoveryGate.blocked).toBe(false);
  });

  it("R6: 起動時照合は done / failed / not-applicable の行と、running でない実行を一切書き換えない", () => {
    const db = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const seeded = seedRun(db, {
      runId: "run-r6",
      status: "running",
      unitStatuses: ["done", "running"],
    });
    const { recheckUnitId } = seedRecheckUnit(db, seeded, "failed");
    const doneBefore = listCheckUnits(db, "run-r6").find((unit) => unit.id === seeded.units[0]?.id);
    const failedRecheckBefore = listRecheckUnits(db, "run-r6").find(
      (unit) => unit.id === recheckUnitId,
    );

    // running を含まない、別の実行（stopped）も用意し、listRunsByStatus(["running"]) の
    // 絞り込みが効いていること（running でない実行に触れないこと）を確認する。
    seedRun(db, {
      runId: "run-other",
      status: "stopped",
      unitStatuses: ["failed"],
    });
    const otherBefore = readRun(db, "run-other");
    const otherUnitBefore = listCheckUnits(db, "run-other")[0];

    const { orchestrator } = makeOrchestrator(db);
    orchestrator.reconcileOnStartup();

    const doneAfter = listCheckUnits(db, "run-r6").find((unit) => unit.id === seeded.units[0]?.id);
    const failedRecheckAfter = listRecheckUnits(db, "run-r6").find(
      (unit) => unit.id === recheckUnitId,
    );
    expect(doneAfter).toEqual(doneBefore);
    expect(failedRecheckAfter).toEqual(failedRecheckBefore);

    // running ではない実行は状態も単位も一切変わらない。
    expect(readRun(db, "run-other")).toEqual(otherBefore);
    expect(listCheckUnits(db, "run-other")[0]).toEqual(otherUnitBefore);
  });

  it("T9: 実行の状態更新で例外が起きると、単位の pending への差し戻しごとロールバックされる（決定 40 の 1 トランザクション性）", () => {
    const db = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const seeded = seedRun(db, {
      runId: "run-t9",
      status: "running",
      unitStatuses: ["running"],
    });

    // runs.status への UPDATE だけを失敗させるトリガー（単位の UPDATE より後、同じトランザクション
    // 内で起きる失敗を模す）。これで「単位だけ pending に書けてしまう」経路が無いことを確かめる。
    db.run(sql`
      CREATE TRIGGER reconcile_fail_run_update
      BEFORE UPDATE OF status ON runs
      WHEN NEW.id = 'run-t9'
      BEGIN
        SELECT RAISE(ABORT, 'injected failure for T9');
      END;
    `);

    const { orchestrator, recoveryGate } = makeOrchestrator(db);
    expect(() => orchestrator.reconcileOnStartup()).toThrow(/injected failure for T9/);

    // ロールバックされていれば、単位は running のまま・pending_note は null のまま。
    const unit = listCheckUnits(db, "run-t9").find((entry) => entry.id === seeded.units[0]?.id);
    expect(unit?.status).toBe("running");
    expect(unit?.pendingNote).toBeNull();

    // 実行自体も running のまま（トリガーが弾いた UPDATE は 1 行も効いていない）。
    expect(readRun(db, "run-t9").status).toBe("running");

    // 例外を投げて抜けた以上、ゲートも触られていない（コミット後にしか block しないため）。
    expect(recoveryGate.blocked).toBe(false);
  });

  it("I-1: 実行ごとに 1 トランザクション（実行をまたがない）。B の失敗で A の照合済みの結果は巻き戻らない", () => {
    const db = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    // listRunsByStatus は asc(started_at), asc(id) で並ぶ（db/repositories/runs.ts）。
    // A が先に処理されるよう started_at を明示的に離す（同時刻だと処理順がテストのたびに
    // 揺れ、B が先に落ちてこのテストが空振りしうる）。
    const seededA = seedRun(db, {
      runId: "run-i1-a",
      status: "running",
      unitStatuses: ["running"],
      startedAt: new Date(1000),
    });
    seedRun(db, {
      runId: "run-i1-b",
      status: "running",
      unitStatuses: ["running"],
      startedAt: new Date(2000),
    });

    // B の実行状態の更新だけを失敗させる（A は正常に照合できる）。
    db.run(sql`
      CREATE TRIGGER reconcile_fail_run_i1_b
      BEFORE UPDATE OF status ON runs
      WHEN NEW.id = 'run-i1-b'
      BEGIN
        SELECT RAISE(ABORT, 'injected failure for I-1 (run-i1-b)');
      END;
    `);

    const { orchestrator, recoveryGate } = makeOrchestrator(db);
    expect(() => orchestrator.reconcileOnStartup()).toThrow(
      /injected failure for I-1 \(run-i1-b\)/,
    );

    // 決定 40：複数の実行をまたいで 1 つのトランザクションにしない。B の失敗で A の照合が
    // 巻き戻ってはならない。A は running の単位を持っていたので recovery-waiting・単位は
    // pending にコミット済みのはず。
    expect(readRun(db, "run-i1-a").status).toBe("recovery-waiting");
    expect(readRun(db, "run-i1-a").generationUnconfirmed).toBe(true);
    const unitA = listCheckUnits(db, "run-i1-a").find((entry) => entry.id === seededA.units[0]?.id);
    expect(unitA?.status).toBe("pending");
    expect(unitA?.pendingNote).toBe("バックエンドが終了したため未完了のまま残った");

    // B は自分のトランザクションだけロールバックされ running のまま残る。
    expect(readRun(db, "run-i1-b").status).toBe("running");
    const unitB = listCheckUnits(db, "run-i1-b")[0];
    expect(unitB?.status).toBe("running");
    expect(unitB?.pendingNote).toBeNull();

    // 例外は「running を列挙して 1 件ずつ照合する」ループの中（B のところ）で投げられ、
    // ゲート復元ループ（2 つ目の for）にはそもそも到達しない。A が先に recovery-waiting に
    // コミット済みでも、ゲートはまだ何も block していない（V3 とは別の観点）。
    expect(recoveryGate.blocked).toBe(false);
  });

  it("V3: 起動時照合が recovery-waiting の実行を読んでゲートを復元すること（再起動しただけでは開かない）", () => {
    const db = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    // 前回の起動時照合（あるいはそれ以前の停止）で recovery-waiting のまま残っていた実行。
    seedRun(db, {
      runId: "run-existing",
      status: "recovery-waiting",
      unitStatuses: ["pending"],
    });
    // 今回のプロセスが落ちた時点で running だった実行。
    seedRun(db, {
      runId: "run-new",
      status: "running",
      unitStatuses: ["running"],
    });

    // 新しいプロセスを模すため、block されていない新しいゲートを使う。
    const { orchestrator, recoveryGate } = makeOrchestrator(db);
    expect(recoveryGate.blocked).toBe(false);

    orchestrator.reconcileOnStartup();

    expect(recoveryGate.blocked).toBe(true);
    expect([...recoveryGate.blockedRunIds].sort()).toEqual(["run-existing", "run-new"]);
    expect(readRun(db, "run-existing").status).toBe("recovery-waiting");
    expect(readRun(db, "run-new").status).toBe("recovery-waiting");
  });
});
