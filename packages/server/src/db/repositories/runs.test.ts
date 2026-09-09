import type { ChunkSettings } from "@shuten/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { ModelInfo } from "../../lmstudio/types.ts";
import type { GenerationSettings } from "../../prompts/types.ts";
import { createDatabase } from "../client.ts";
import { applyMigrations } from "../migrate.ts";
import { insertManuscriptVersion } from "./manuscripts.ts";
import {
  claimRun,
  findRun,
  findRunByStartOperationId,
  finishRun,
  type InsertRunInput,
  insertRun,
  insertRunTarget,
  listRunsByStatus,
  listRunTargets,
  setStopRequestedAt,
  toGenerationSettings,
  updateRunModelInfo,
} from "./runs.ts";

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

const CHUNK_SETTINGS: ChunkSettings = {
  targetGraphemes: 1500,
  contextGraphemes: 1000,
  recheckContextGraphemes: 3000,
  roundingTolerance: 0.2,
  maxInputGraphemes: 8000,
};

const GENERATION_SETTINGS: Omit<GenerationSettings, "model"> = {
  maxTokens: 512,
  temperature: 0.2,
  seed: 42,
  reasoningEffort: "medium",
};

const MODEL_INFO: ModelInfo = {
  id: "model-a",
  type: "llm",
  state: "loaded",
  quantization: "Q4_K_M",
  maxContextLength: 8192,
  loadedContextLength: 4096,
};

/** `insertRun` に渡す最小限の入力を組み立てる。テストごとに一部を上書きする。 */
function baseRunInput(overrides: Partial<InsertRunInput> = {}): InsertRunInput {
  return {
    manuscriptVersionId: "mv1",
    modelId: "model-a",
    modelInfo: MODEL_INFO,
    endpointUrl: "http://127.0.0.1:1234",
    generationSettings: GENERATION_SETTINGS,
    chunkSettings: CHUNK_SETTINGS,
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
    startOperationId: null,
    finishedAt: null,
    ...overrides,
  };
}

describe("db/repositories/runs", () => {
  it("R3: chunk_settings・generation_settings・allowed_words・model_info が値として往復する", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });

    const finishedAt = new Date("2026-09-09T00:00:00.000Z");
    const inserted = insertRun(
      db,
      baseRunInput({ allowedWords: ["伏線", "描写"], modelInfo: MODEL_INFO, finishedAt }),
    );

    const found = findRun(db, inserted.id);
    expect(found).not.toBeNull();
    expect(found?.chunkSettings).toEqual(CHUNK_SETTINGS);
    expect(found?.generationSettings).toEqual(GENERATION_SETTINGS);
    expect(found?.allowedWords).toEqual(["伏線", "描写"]);
    expect(found?.modelInfo).toEqual(MODEL_INFO);
    // finishedAt も values() に書き込まれ、往復する（insertRun の書き漏れ検知）。
    expect(found?.finishedAt).toEqual(finishedAt);
    close();
  });

  it("R4: model_info が null でも往復する", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });

    const inserted = insertRun(db, baseRunInput({ modelInfo: null }));

    const found = findRun(db, inserted.id);
    expect(found).not.toBeNull();
    expect(found?.modelInfo).toBeNull();
    close();
  });

  it("R5: 検査対象の [start, end) と paragraph_ids が往復し、参考文脈なし（両側 null）も表せる", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    const run = insertRun(db, baseRunInput({ id: "r1" }));

    // targetIndex を逆順に入れ、listRunTargets が昇順で返すことも確認する。
    insertRunTarget(db, {
      id: "t1",
      runId: run.id,
      targetIndex: 1,
      target: { start: 30, end: 40 },
      contextBefore: { start: 20, end: 30 },
      contextAfter: { start: 40, end: 50 },
      input: { start: 20, end: 50 },
      paragraphIds: [3, 4],
    });
    const t0 = insertRunTarget(db, {
      id: "t0",
      runId: run.id,
      targetIndex: 0,
      target: { start: 10, end: 20 },
      contextBefore: null,
      contextAfter: null,
      input: { start: 10, end: 20 },
      paragraphIds: [0, 1, 2],
    });

    // 参考文脈なし（両側 null）が表せる。
    expect(t0.contextBefore).toBeNull();
    expect(t0.contextAfter).toBeNull();
    expect(t0.target).toEqual({ start: 10, end: 20 });
    expect(t0.input).toEqual({ start: 10, end: 20 });
    expect(t0.paragraphIds).toEqual([0, 1, 2]);

    const listed = listRunTargets(db, run.id);
    expect(listed).toHaveLength(2);
    expect(listed[0]?.id).toBe("t0");
    expect(listed[0]?.targetIndex).toBe(0);
    expect(listed[0]?.contextBefore).toBeNull();
    expect(listed[1]?.id).toBe("t1");
    expect(listed[1]?.targetIndex).toBe(1);
    expect(listed[1]?.target).toEqual({ start: 30, end: 40 });
    expect(listed[1]?.contextBefore).toEqual({ start: 20, end: 30 });
    expect(listed[1]?.contextAfter).toEqual({ start: 40, end: 50 });
    expect(listed[1]?.paragraphIds).toEqual([3, 4]);
    close();
  });

  it("run_targets の参考文脈が片方だけ null の行は listRunTargets で例外になる（不変条件の防御）", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    const run = insertRun(db, baseRunInput({ id: "r1" }));

    // insertRunTarget は同一の Range から context_before_start/end を導出するため、
    // 片方だけ null の行はリポジトリ経由では作れない。不変条件が壊れた行を模すため
    // SQL で直接書き込む。
    db.run(sql`
      INSERT INTO run_targets (
        id, run_id, target_index, target_start, target_end,
        context_before_start, context_before_end,
        context_after_start, context_after_end,
        input_start, input_end, paragraph_ids
      ) VALUES (
        't-broken', ${run.id}, 0, 10, 20,
        20, NULL,
        NULL, NULL,
        10, 20, '[0]'
      )
    `);

    expect(() => listRunTargets(db, run.id)).toThrow(/context_before_start \/ context_before_end/);
    close();
  });

  it("R16b: claimRun は running→stopped が 1 回だけ成功し、2 回目は false で状態も変わらない", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    const run = insertRun(db, baseRunInput({ id: "r1", status: "running" }));
    expect(run.status).toBe("running");

    const first = claimRun(db, run.id, "running", "stopped");
    expect(first).toBe(true);
    expect(findRun(db, run.id)?.status).toBe("stopped");

    const second = claimRun(db, run.id, "running", "stopped");
    expect(second).toBe(false);
    expect(findRun(db, run.id)?.status).toBe("stopped");
    close();
  });

  it("R20: finishRun は status・stopReason・stopMessage・generationUnconfirmed・finishedAt を更新し、他の列を変えない", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });

    // 停止理由が null の完了（completed）。
    const completedRun = insertRun(db, baseRunInput({ id: "r-completed", status: "running" }));
    const finishedAt1 = new Date("2026-09-09T01:00:00.000Z");
    const completedFinished = finishRun(db, completedRun.id, {
      expectedStatus: "running",
      status: "completed",
      stopReason: null,
      stopMessage: null,
      generationUnconfirmed: false,
      finishedAt: finishedAt1,
    });
    expect(completedFinished).toBe(true);
    const completed = findRun(db, completedRun.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.stopReason).toBeNull();
    expect(completed?.stopMessage).toBeNull();
    expect(completed?.generationUnconfirmed).toBe(false);
    expect(completed?.finishedAt).toEqual(finishedAt1);
    // status・stopReason・stopMessage・generationUnconfirmed・finishedAt 以外の列は変わらない。
    expect(completed?.modelId).toBe(completedRun.modelId);
    expect(completed?.generationSettings).toEqual(completedRun.generationSettings);
    expect(completed?.allowedWords).toEqual(completedRun.allowedWords);
    expect(completed?.chunkSettings).toEqual(completedRun.chunkSettings);

    // 停止理由のある停止（stopped + generationUnconfirmed = true）。
    const stoppedRun = insertRun(db, baseRunInput({ id: "r-stopped", status: "running" }));
    const finishedAt2 = new Date("2026-09-09T02:00:00.000Z");
    const stoppedFinished = finishRun(db, stoppedRun.id, {
      expectedStatus: "running",
      status: "stopped",
      stopReason: "aborted",
      stopMessage: "ユーザーが停止しました",
      generationUnconfirmed: true,
      finishedAt: finishedAt2,
    });
    expect(stoppedFinished).toBe(true);
    const stopped = findRun(db, stoppedRun.id);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.stopReason).toBe("aborted");
    expect(stopped?.stopMessage).toBe("ユーザーが停止しました");
    expect(stopped?.generationUnconfirmed).toBe(true);
    expect(stopped?.finishedAt).toEqual(finishedAt2);
    expect(stopped?.modelId).toBe(stoppedRun.modelId);
    expect(stopped?.allowedWords).toEqual(stoppedRun.allowedWords);
    close();
  });

  it("R19: 検査実行の読み出しで GenerationSettings に model_id が入って戻る", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    const inserted = insertRun(db, baseRunInput({ id: "r1", modelId: "qwen/qwen3-8b" }));

    const found = findRun(db, inserted.id);
    expect(found).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: 直前で not.toBeNull() を確認済み
    const settings = toGenerationSettings(found!);
    expect(settings).toEqual({ ...GENERATION_SETTINGS, model: "qwen/qwen3-8b" });
    close();
  });

  it("S4c: finishRun は expectedStatus に合わない行を更新せず false を返し、状態以外の列も一切変わらない", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    const run = insertRun(db, baseRunInput({ id: "r1", status: "running" }));

    // 実際の status は "running" だが、expectedStatus に "stopped"（不一致）を渡す。
    const finished = finishRun(db, run.id, {
      expectedStatus: "stopped",
      status: "completed",
      stopReason: null,
      stopMessage: null,
      generationUnconfirmed: false,
      finishedAt: new Date("2026-09-09T03:00:00.000Z"),
    });
    expect(finished).toBe(false);

    const found = findRun(db, run.id);
    expect(found?.status).toBe("running");
    expect(found?.stopReason).toBeNull();
    expect(found?.stopMessage).toBeNull();
    expect(found?.generationUnconfirmed).toBe(false);
    expect(found?.finishedAt).toBeNull();
    close();
  });

  it("マイグレーション 0001：recoveryConfirmMs / stopRequestedAt が省略時の既定値（0・null）で往復し、指定時はその値で往復する", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });

    const defaulted = insertRun(db, baseRunInput({ id: "r-default" }));
    expect(defaulted.recoveryConfirmMs).toBe(0);
    expect(defaulted.stopRequestedAt).toBeNull();
    const foundDefaulted = findRun(db, defaulted.id);
    expect(foundDefaulted?.recoveryConfirmMs).toBe(0);
    expect(foundDefaulted?.stopRequestedAt).toBeNull();

    const stopRequestedAt = new Date("2026-09-09T04:00:00.000Z");
    const explicit = insertRun(
      db,
      baseRunInput({ id: "r-explicit", recoveryConfirmMs: 120_000, stopRequestedAt }),
    );
    expect(explicit.recoveryConfirmMs).toBe(120_000);
    expect(explicit.stopRequestedAt).toEqual(stopRequestedAt);
    const foundExplicit = findRun(db, explicit.id);
    expect(foundExplicit?.recoveryConfirmMs).toBe(120_000);
    expect(foundExplicit?.stopRequestedAt).toEqual(stopRequestedAt);
    close();
  });

  it("findRunByStartOperationId は start_operation_id で1件探し、見つからなければ null", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    insertRun(db, baseRunInput({ id: "r1", startOperationId: "op-1" }));

    const found = findRunByStartOperationId(db, "op-1");
    expect(found?.id).toBe("r1");

    expect(findRunByStartOperationId(db, "no-such-op")).toBeNull();
    close();
  });

  it("N1: updateRunModelInfo は model_info が null の行だけ更新し、2度目の呼び出しでは上書きしない（決定 30）", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    const run = insertRun(db, baseRunInput({ id: "r1", modelInfo: null }));
    expect(run.modelInfo).toBeNull();

    const firstInfo: ModelInfo = MODEL_INFO;
    updateRunModelInfo(db, "r1", firstInfo);
    expect(findRun(db, "r1")?.modelInfo).toEqual(firstInfo);

    // 2度目の呼び出し（既に model_info が非 null）は無視され、最初の値のまま。
    const secondInfo: ModelInfo = { ...MODEL_INFO, id: "model-b", loadedContextLength: 2048 };
    updateRunModelInfo(db, "r1", secondInfo);
    expect(findRun(db, "r1")?.modelInfo).toEqual(firstInfo);
    close();
  });

  it("setStopRequestedAt は stop_requested_at だけを書き、status には触れない（決定 21・36）", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    insertRun(db, baseRunInput({ id: "r1", status: "running" }));

    const at = new Date("2026-09-09T05:00:00.000Z");
    setStopRequestedAt(db, "r1", at);

    const found = findRun(db, "r1");
    expect(found?.stopRequestedAt).toEqual(at);
    expect(found?.status).toBe("running");
    close();
  });

  it("N2a: claimRun の options.clearStopState は状態と同時に stop_requested_at・generation_unconfirmed・finished_at・stop_reason・stop_message を消す（決定 36）", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    const run = insertRun(db, baseRunInput({ id: "r1", status: "running" }));
    setStopRequestedAt(db, "r1", new Date("2026-09-09T05:00:00.000Z"));
    finishRun(db, run.id, {
      expectedStatus: "running",
      status: "stopped",
      stopReason: "aborted",
      stopMessage: "ユーザーが停止しました",
      generationUnconfirmed: true,
      finishedAt: new Date("2026-09-09T06:00:00.000Z"),
    });
    const stopped = findRun(db, "r1");
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.stopRequestedAt).not.toBeNull();
    expect(stopped?.generationUnconfirmed).toBe(true);
    expect(stopped?.finishedAt).not.toBeNull();
    expect(stopped?.stopReason).toBe("aborted");
    expect(stopped?.stopMessage).toBe("ユーザーが停止しました");

    const resumed = claimRun(db, "r1", "stopped", "running", { clearStopState: true });
    expect(resumed).toBe(true);

    const after = findRun(db, "r1");
    expect(after?.status).toBe("running");
    expect(after?.stopRequestedAt).toBeNull();
    expect(after?.generationUnconfirmed).toBe(false);
    expect(after?.finishedAt).toBeNull();
    expect(after?.stopReason).toBeNull();
    expect(after?.stopMessage).toBeNull();
    close();
  });

  it("N2b: claimRun の options.clearStopState は runs への UPDATE を1回しか発行しない（同じ1文であること）", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    const run = insertRun(db, baseRunInput({ id: "r1", status: "running" }));
    finishRun(db, run.id, {
      expectedStatus: "running",
      status: "stopped",
      stopReason: "aborted",
      stopMessage: "ユーザーが停止しました",
      generationUnconfirmed: true,
      finishedAt: new Date("2026-09-09T06:00:00.000Z"),
    });

    // runs への UPDATE の発行回数を、行レベルの AFTER UPDATE トリガーで数える
    // （`check-units.test.ts` の S3c と同じ手法）。WHERE が対象行1件にちょうど一致する構成なので、
    // トリガーの発火回数 = 実際に発行された UPDATE 文の本数になる（2文に分けて status →
    // 停止関連の列の順に書けば2回発火する）。
    db.run(sql`CREATE TEMP TABLE run_update_log (n integer)`);
    db.run(sql`
      CREATE TEMP TRIGGER t_runs_update AFTER UPDATE ON runs
      BEGIN
        INSERT INTO run_update_log VALUES (1);
      END
    `);

    const resumed = claimRun(db, "r1", "stopped", "running", { clearStopState: true });
    expect(resumed).toBe(true);

    const count = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM run_update_log`);
    expect(count.n).toBe(1);
    close();
  });

  it("claimRun はオプション無しでは従来どおり status 以外の列を変えない（既存の呼び出しの挙動は変えない）", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    const run = insertRun(db, baseRunInput({ id: "r1", status: "running" }));
    setStopRequestedAt(db, "r1", new Date("2026-09-09T05:00:00.000Z"));
    finishRun(db, run.id, {
      expectedStatus: "running",
      status: "stopped",
      stopReason: "aborted",
      stopMessage: "ユーザーが停止しました",
      generationUnconfirmed: true,
      finishedAt: new Date("2026-09-09T06:00:00.000Z"),
    });

    const resumed = claimRun(db, "r1", "stopped", "running");
    expect(resumed).toBe(true);

    const after = findRun(db, "r1");
    expect(after?.status).toBe("running");
    // clearStopState を渡していないので、停止関連の列はそのまま残る。
    expect(after?.stopRequestedAt).not.toBeNull();
    expect(after?.generationUnconfirmed).toBe(true);
    expect(after?.finishedAt).not.toBeNull();
    expect(after?.stopReason).toBe("aborted");
    expect(after?.stopMessage).toBe("ユーザーが停止しました");
    close();
  });

  it("listRunsByStatus は指定した状態のいずれかに一致する実行を started_at 昇順で列挙する（決定 39・40）", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
    // id の辞書順（r-running-a < r-running-z）と started_at の時系列順（z が先、a が後）を
    // わざと逆にする（`listCandidates` のテストと同じ姿勢：orderBy の取り違えを検出できるように）。
    insertRun(
      db,
      baseRunInput({
        id: "r-running-a",
        status: "running",
        startedAt: new Date("2026-09-09T02:00:00.000Z"),
      }),
    );
    insertRun(
      db,
      baseRunInput({
        id: "r-running-z",
        status: "running",
        startedAt: new Date("2026-09-09T01:00:00.000Z"),
      }),
    );
    insertRun(
      db,
      baseRunInput({
        id: "r-recovery",
        status: "recovery-waiting",
        generationUnconfirmed: true,
        startedAt: new Date("2026-09-09T00:30:00.000Z"),
      }),
    );
    insertRun(
      db,
      baseRunInput({
        id: "r-completed",
        status: "completed",
        startedAt: new Date("2026-09-09T00:00:00.000Z"),
      }),
    );

    const running = listRunsByStatus(db, ["running"]);
    // started_at 昇順（01:00 の r-running-z が先）。id の辞書順（a < z）とは逆になる。
    expect(running.map((r) => r.id)).toEqual(["r-running-z", "r-running-a"]);

    const recovering = listRunsByStatus(db, ["recovery-waiting"]);
    expect(recovering.map((r) => r.id)).toEqual(["r-recovery"]);

    const both = listRunsByStatus(db, ["running", "recovery-waiting"]);
    expect(both.map((r) => r.id)).toEqual(["r-recovery", "r-running-z", "r-running-a"]);

    expect(listRunsByStatus(db, ["stopped"])).toEqual([]);
    close();
  });
});
