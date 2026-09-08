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
  type InsertRunInput,
  insertRun,
  insertRunTarget,
  listRunTargets,
  toGenerationSettings,
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
});
