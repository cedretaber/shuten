import type { ChunkSettings, Perspective } from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { createDatabase } from "../db/client.ts";
import { applyMigrations } from "../db/migrate.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { checkUnits, runs, runTargets } from "../db/schema.ts";
import type { LmStudioClient } from "../lmstudio/types.ts";
import type { RunEvent } from "./events.ts";
import type { OrchestratorDeps, StartRunInput } from "./orchestrator.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { createRequestQueue } from "./queue.ts";
import { createRecoveryGate } from "./recovery-gate.ts";

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

/**
 * このタスク（Task 6）のテストは生成要求を 1 件も送らない（ループが無いため）。
 * 呼ばれたら即座に落として、想定外に呼ばれていないことを検出する。
 */
function unusedClient(): LmStudioClient {
  return {
    listModels: () => {
      throw new Error("listModels は呼ばれない想定（Task 6 は生成要求を送らない）");
    },
    ensureLoaded: () => {
      throw new Error("ensureLoaded は呼ばれない想定（Task 6 は生成要求を送らない）");
    },
    chat: () => {
      throw new Error("chat は呼ばれない想定（Task 6 は生成要求を送らない）");
    },
  };
}

function makeDeps(
  db: ReturnType<typeof setupDb>["db"],
  overrides: Partial<OrchestratorDeps> = {},
): OrchestratorDeps {
  return {
    db,
    client: unusedClient(),
    queue: createRequestQueue(),
    recoveryGate: createRecoveryGate(),
    endpointUrl: "http://127.0.0.1:1234",
    recoveryConfirmMs: 120_000,
    ...overrides,
  };
}

/**
 * 1 段落・20 書記素の本文。改行・句読点を含まないため段落境界・文境界の候補が端の 1 つしかなく、
 * `chooseTargetEnd` が理想位置（ideal）にそのまま落ちる。分割結果が決定的になるようにするため。
 */
const TEXT = "0123456789ABCDEFGHIJ";

/**
 * targetGraphemes: 10・roundingTolerance: 0（delta 0）で `[0,10)` `[10,20)` の 2 対象に割れる。
 * maxInputGraphemes は「目標 + 丸め幅」の最小値（10）を大きく超えて取り、文脈を含めても
 * 上限を超えない設定（正常系用）。
 */
const CHUNK_SETTINGS_OK: ChunkSettings = {
  targetGraphemes: 10,
  contextGraphemes: 5,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 50,
};

/**
 * 上と同じ分割（`[0,10)` `[10,20)`）だが、`maxInputGraphemes` を分割の最小値ちょうど（10）にし、
 * 文脈（前後 5 字）を足すと必ず上限を超えるようにした設定（O16 用）。
 * 両対象とも「前」または「後」のどちらかに文脈を持つため、2 対象とも InputTooLongError になる
 * （対象 0 は後方文脈、対象 1 は前方文脈で超える）。
 */
const CHUNK_SETTINGS_TOO_LONG: ChunkSettings = {
  targetGraphemes: 10,
  contextGraphemes: 5,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 10,
};

const PERSPECTIVES: readonly Perspective[] = ["typo", "naturalness"];

function baseInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    startOperationId: "op-1",
    manuscriptVersionId: "mv1",
    modelId: "model-a",
    generation: { maxTokens: 512, temperature: 0.2 },
    chunkSettings: CHUNK_SETTINGS_OK,
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: PERSPECTIVES,
    recheckEnabled: false,
    allowedWordsRaw: "",
    ...overrides,
  };
}

function countRows(db: ReturnType<typeof setupDb>["db"]): {
  readonly runs: number;
  readonly runTargets: number;
  readonly checkUnits: number;
} {
  return {
    runs: db.select().from(runs).all().length,
    runTargets: db.select().from(runTargets).all().length,
    checkUnits: db.select().from(checkUnits).all().length,
  };
}

describe("run/orchestrator: startRun", () => {
  it("正常系：running で開始し、対象 × 観点ぶんの pending な検査単位が 1 トランザクションで作られる", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const orchestrator = createOrchestrator(makeDeps(db));

    const { run } = orchestrator.startRun(baseInput());

    expect(run.status).toBe("running");
    expect(run.stopReason).toBeNull();
    expect(run.stopMessage).toBeNull();
    expect(run.modelInfo).toBeNull();
    expect(run.finishedAt).toBeNull();

    const rows = countRows(db);
    expect(rows.runs).toBe(1);
    expect(rows.runTargets).toBe(2); // [0,10) と [10,20)
    expect(rows.checkUnits).toBe(4); // 2 対象 × 2 観点
  });

  it("O10: 同じ startOperationId の 2 回目は新しい実行を作らず、既存の実行を返す", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const orchestrator = createOrchestrator(makeDeps(db));

    const first = orchestrator.startRun(baseInput({ startOperationId: "dup-op" }));
    const second = orchestrator.startRun(baseInput({ startOperationId: "dup-op" }));

    expect(second.run.id).toBe(first.run.id);
    expect(countRows(db).runs).toBe(1);
    expect(countRows(db).checkUnits).toBe(4); // 2 回目で増えていない
  });

  it("O10: start_operation_id 以外の一意制約違反は握りつぶさずに送出する", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const orchestrator = createOrchestrator(makeDeps(db));

    // 同じ観点を 2 つ渡すと、対象ごとの (target_id, perspective) 一意制約に違反する
    // （check_units_target_id_perspective_key）。start_operation_id の一意制約ではないため
    // 二重送信の救済（findRunByStartOperationId での引き直し）の対象にならず、そのまま投げる。
    expect(() =>
      orchestrator.startRun(
        baseInput({ startOperationId: "op-dup-perspective", perspectives: ["typo", "typo"] }),
      ),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("O15・C2: 開始の途中で落ちても「実行はあるが検査単位が 0 件」の行が残らず、target-planned も 1 件も出ない（1 トランザクション）", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const events: RunEvent[] = [];
    const orchestrator = createOrchestrator(
      makeDeps(db, { onEvent: (event) => events.push(event) }),
    );

    expect(() =>
      orchestrator.startRun(
        baseInput({ startOperationId: "op-rollback", perspectives: ["typo", "typo"] }),
      ),
    ).toThrow();

    // runs も run_targets も check_units も、1 行も残っていない（ロールバック）。
    const rows = countRows(db);
    expect(rows.runs).toBe(0);
    expect(rows.runTargets).toBe(0);
    expect(rows.checkUnits).toBe(0);
    // 対象 0（[0,10)）の run_targets 行はトランザクション内で作られたが、コミットされていない
    // 以上、target-planned も 1 件も出ていないはず。
    expect(events).toHaveLength(0);
  });

  it("O16: 分割時に InputTooLongError が出た対象は failed（input-too-long）で作られ、実行は stopped（settings）", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const orchestrator = createOrchestrator(makeDeps(db));

    const { run } = orchestrator.startRun(
      baseInput({ startOperationId: "op-too-long", chunkSettings: CHUNK_SETTINGS_TOO_LONG }),
    );

    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("settings");
    expect(run.stopMessage).not.toBeNull();
    expect(run.stopMessage).not.toContain("127.0.0.1"); // 接続先 URL を含めない

    // 対象は 2 件（run_targets）作られ、各対象 × 各観点が failed（input-too-long）。
    const targetRows = db.select().from(runTargets).all();
    expect(targetRows).toHaveLength(2);

    const unitRows = db.select().from(checkUnits).all();
    expect(unitRows).toHaveLength(4);
    for (const unit of unitRows) {
      expect(unit.status).toBe("failed");
      expect(unit.failureReason).toBe("input-too-long");
      expect(unit.failureOrigin).toBe("local");
      expect(unit.attempts).toBe(0);
    }
  });

  it("C1: onEvent が例外を投げても実行が止まらず、以降のイベントも通知される", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const events: RunEvent[] = [];
    let calls = 0;
    const orchestrator = createOrchestrator(
      makeDeps(db, {
        onEvent: (event) => {
          calls += 1;
          if (calls === 1) {
            throw new Error("1 件目の通知だけ失敗させる");
          }
          events.push(event);
        },
      }),
    );

    const { run } = orchestrator.startRun(baseInput());

    // 例外を投げても startRun 自体は正常に完了し、2 件目以降のイベントは記録される。
    expect(run.status).toBe("running");
    expect(calls).toBe(2); // 対象 2 件ぶんの target-planned
    expect(events).toHaveLength(1);
    expect(events[0]?.runId).toBe(run.id);
    expect(events[0]?.event.type).toBe("target-planned");
  });

  it("C2: target-planned は開始トランザクションのコミット後に対象ごとに出る", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const events: RunEvent[] = [];
    const orchestrator = createOrchestrator(
      makeDeps(db, { onEvent: (event) => events.push(event) }),
    );

    const { run } = orchestrator.startRun(baseInput());

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.runId === run.id)).toBe(true);
    expect(events.every((e) => e.event.type === "target-planned")).toBe(true);
    const indices = events.map((e) =>
      e.event.type === "target-planned" ? e.event.targetIndex : -1,
    );
    expect(indices.sort()).toEqual([0, 1]);
  });

  it("C2: 開始が失敗した場合（設定不正）は target-planned が 1 件も出ない", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const events: RunEvent[] = [];
    const orchestrator = createOrchestrator(
      makeDeps(db, { onEvent: (event) => events.push(event) }),
    );

    const invalidSettings: ChunkSettings = {
      targetGraphemes: 0, // 1 以上でなければならない → InvalidChunkSettingsError
      contextGraphemes: 0,
      recheckContextGraphemes: 0,
      roundingTolerance: 0,
      maxInputGraphemes: 10,
    };

    const { run } = orchestrator.startRun(
      baseInput({ startOperationId: "op-invalid-settings", chunkSettings: invalidSettings }),
    );

    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("settings");
    expect(events).toHaveLength(0);
    expect(countRows(db).runTargets).toBe(0);
    expect(countRows(db).checkUnits).toBe(0);
  });

  it("C4: checkMs + recoveryConfirmMs が 2^31-1 を超えると、生成要求を 1 件も送らずに stopped（settings）になる", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const events: RunEvent[] = [];
    const orchestrator = createOrchestrator(
      makeDeps(db, { recoveryConfirmMs: 120_000, onEvent: (event) => events.push(event) }),
    );

    const { run } = orchestrator.startRun(
      baseInput({
        startOperationId: "op-check-overflow",
        timeouts: { checkMs: 2_147_483_647, recheckMs: 60_000 },
      }),
    );

    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("settings");
    expect(run.stopMessage).not.toBeNull();
    expect(countRows(db).runTargets).toBe(0);
    expect(countRows(db).checkUnits).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("C4: recheckMs + recoveryConfirmMs が 2^31-1 を超えても同じく stopped（settings）", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const orchestrator = createOrchestrator(makeDeps(db, { recoveryConfirmMs: 120_000 }));

    const { run } = orchestrator.startRun(
      baseInput({
        startOperationId: "op-recheck-overflow",
        timeouts: { checkMs: 60_000, recheckMs: 2_147_483_647 },
      }),
    );

    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("settings");
  });

  it("C4: checkMs が 0・負値・非整数のいずれでも stopped（settings）になる", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const orchestrator = createOrchestrator(makeDeps(db));

    for (const [label, checkMs] of [
      ["0", 0],
      ["負値", -1],
      ["非整数", 1.5],
    ] as const) {
      const { run } = orchestrator.startRun(
        baseInput({
          startOperationId: `op-checkms-${label}`,
          timeouts: { checkMs, recheckMs: 60_000 },
        }),
      );
      expect(run.status, `checkMs=${label}`).toBe("stopped");
      expect(run.stopReason, `checkMs=${label}`).toBe("settings");
    }
  });

  it("manuscriptVersionId が存在しない場合は実行を作らずに例外を投げる（呼び出し側の誤り）", () => {
    const { db } = setupDb();
    const orchestrator = createOrchestrator(makeDeps(db));

    expect(() =>
      orchestrator.startRun(baseInput({ manuscriptVersionId: "does-not-exist" })),
    ).toThrow();
    expect(countRows(db).runs).toBe(0);
  });

  it("O13: 完了済み（に相当する）実行があっても、新しい startOperationId は別の実行 ID になる", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const orchestrator = createOrchestrator(makeDeps(db));

    const first = orchestrator.startRun(baseInput({ startOperationId: "op-a" }));
    const second = orchestrator.startRun(baseInput({ startOperationId: "op-b" }));

    expect(second.run.id).not.toBe(first.run.id);
    expect(countRows(db).runs).toBe(2);
    expect(countRows(db).runTargets).toBe(4); // 2 実行 × 2 対象
    expect(countRows(db).checkUnits).toBe(8); // 2 実行 × 2 対象 × 2 観点

    // 各実行の検査対象は自分の run_id にだけ属し、混ざらない。
    const targetsForFirst = db
      .select()
      .from(runTargets)
      .all()
      .filter((t) => t.runId === first.run.id);
    const targetsForSecond = db
      .select()
      .from(runTargets)
      .all()
      .filter((t) => t.runId === second.run.id);
    expect(targetsForFirst).toHaveLength(2);
    expect(targetsForSecond).toHaveLength(2);
  });

  it("done は開始直後の RunRecord をそのまま解決する Promise である（本タスクの仮実装）", async () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const orchestrator = createOrchestrator(makeDeps(db));

    const { run, done } = orchestrator.startRun(baseInput());
    await expect(done).resolves.toEqual(run);
  });
});
