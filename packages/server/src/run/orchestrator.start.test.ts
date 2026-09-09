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
    close: () => Promise.resolve(),
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

/**
 * 3 段落なし・30 書記素の本文。`CHUNK_SETTINGS_TOO_LONG_PARTIAL` と組み合わせると
 * `[0,10)` `[10,20)` `[20,30)` の 3 対象に割れ、真ん中（対象 1）だけが前後両方に文脈を持つため
 * 単独で上限超過になる（対象 0・2 は片側だけの文脈で収まる。実際に `buildCheckInput` を
 * 動かして確認済み：対象 0 は `required=15`・対象 1 は `required=20`・対象 2 は `required=15`）。
 */
const TEXT_3_TARGETS = "0123456789ABCDEFGHIJKLMNOPQRST";

/**
 * `[0,10)` `[10,20)` `[20,30)` に割れる設定で、`maxInputGraphemes: 15` は片側文脈（required 15）
 * ちょうど収まり、両側文脈（required 20）だけが超過するようにしたもの（I-1 用）。
 */
const CHUNK_SETTINGS_TOO_LONG_PARTIAL: ChunkSettings = {
  targetGraphemes: 10,
  contextGraphemes: 5,
  recheckContextGraphemes: 0,
  roundingTolerance: 0,
  maxInputGraphemes: 15,
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

    // I-2: 件数だけでなく、実際の状態が pending であることを検査する（claimUnitChecked が
    // pending → running で拾う値そのもの。壊れると単位が永久に拾われなくなる）。
    const unitRows = db.select().from(checkUnits).all();
    expect(unitRows).toHaveLength(4);
    for (const unit of unitRows) {
      expect(unit.status).toBe("pending");
      expect(unit.attempts).toBe(0);
      expect(unit.failureReason).toBeNull();
      expect(unit.startedAt).toBeNull();
      expect(unit.finishedAt).toBeNull();
    }
  });

  it("I-3: run_targets の contextBefore/contextAfter/input が実際に組み立てた CheckInput の値で保存され、target-planned にも同じ値が載る", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const events: RunEvent[] = [];
    const orchestrator = createOrchestrator(
      makeDeps(db, { onEvent: (event) => events.push(event) }),
    );

    orchestrator.startRun(baseInput());

    // buildCheckInput を実際に動かして確認済みの値（対象 0：後方文脈のみ、対象 1：前方文脈のみ）。
    const targetRows = db
      .select()
      .from(runTargets)
      .all()
      .sort((a, b) => a.targetIndex - b.targetIndex);
    expect(targetRows).toHaveLength(2);

    const target0 = targetRows[0];
    expect(target0?.targetStart).toBe(0);
    expect(target0?.targetEnd).toBe(10);
    expect(target0?.contextBeforeStart).toBeNull();
    expect(target0?.contextBeforeEnd).toBeNull();
    expect(target0?.contextAfterStart).toBe(10);
    expect(target0?.contextAfterEnd).toBe(15);
    expect(target0?.inputStart).toBe(0);
    expect(target0?.inputEnd).toBe(15);

    const target1 = targetRows[1];
    expect(target1?.targetStart).toBe(10);
    expect(target1?.targetEnd).toBe(20);
    expect(target1?.contextBeforeStart).toBe(5);
    expect(target1?.contextBeforeEnd).toBe(10);
    expect(target1?.contextAfterStart).toBeNull();
    expect(target1?.contextAfterEnd).toBeNull();
    expect(target1?.inputStart).toBe(5);
    expect(target1?.inputEnd).toBe(20);

    // target-planned イベントにも、target.range 固定ではなく実際の inputRange が載っている。
    const planned = events.filter((e) => e.event.type === "target-planned");
    expect(planned).toHaveLength(2);
    for (const e of planned) {
      if (e.event.type !== "target-planned") continue;
      if (e.event.targetIndex === 0) {
        expect(e.event.input).toEqual({ start: 0, end: 15 });
      } else if (e.event.targetIndex === 1) {
        expect(e.event.input).toEqual({ start: 5, end: 20 });
      } else {
        throw new Error(`想定外の targetIndex: ${e.event.targetIndex}`);
      }
    }
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

  it("I-4: 同じ startOperationId の 2 回目は、レジストリに登録済みの done をそのまま返す（新しい done を作らない）", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const orchestrator = createOrchestrator(makeDeps(db));

    const first = orchestrator.startRun(baseInput({ startOperationId: "dup-op-done" }));
    const second = orchestrator.startRun(baseInput({ startOperationId: "dup-op-done" }));

    // run オブジェクトの一致だけでなく、done が「同じ Promise インスタンス」であることを見る。
    // レジストリを削除すると、2 回目は毎回新しい Promise.resolve(existing) を作ってしまい、
    // 参照が一致しなくなる。
    expect(second.done).toBe(first.done);
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

  it("I-1: 一部の対象だけが上限超過のとき、その対象だけ failed になり、他の対象は pending のまま残る", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT_3_TARGETS });
    const orchestrator = createOrchestrator(makeDeps(db));

    const { run } = orchestrator.startRun(
      baseInput({
        startOperationId: "op-partial-too-long",
        chunkSettings: CHUNK_SETTINGS_TOO_LONG_PARTIAL,
      }),
    );

    // 実行全体としては、1 対象でも超過があれば stopped（settings）になる（決定 18）。
    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("settings");

    const targetRows = db.select().from(runTargets).all();
    expect(targetRows).toHaveLength(3);
    const targetIdByIndex = new Map(targetRows.map((t) => [t.targetIndex, t.id]));

    const unitRows = db.select().from(checkUnits).all();
    expect(unitRows).toHaveLength(6); // 3 対象 × 2 観点

    // 超過した対象 1（[10,20)）の単位だけ failed（input-too-long）。
    const targetId1 = targetIdByIndex.get(1);
    const unitsForTarget1 = unitRows.filter((u) => u.targetId === targetId1);
    expect(unitsForTarget1).toHaveLength(2);
    for (const unit of unitsForTarget1) {
      expect(unit.status).toBe("failed");
      expect(unit.failureReason).toBe("input-too-long");
    }

    // 超過しなかった対象 0・2 の単位は pending のまま（生成要求を送っていない）。
    for (const targetIndex of [0, 2]) {
      const targetId = targetIdByIndex.get(targetIndex);
      const unitsForTarget = unitRows.filter((u) => u.targetId === targetId);
      expect(unitsForTarget, `targetIndex=${targetIndex}`).toHaveLength(2);
      for (const unit of unitsForTarget) {
        expect(unit.status, `targetIndex=${targetIndex}`).toBe("pending");
        expect(unit.failureReason, `targetIndex=${targetIndex}`).toBeNull();
      }
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

  it("C2・M-2: 開始が失敗した場合（設定不正）は target-planned が 1 件も出ず、run-settled が 1 件だけ出る", () => {
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
    expect(countRows(db).runTargets).toBe(0);
    expect(countRows(db).checkUnits).toBe(0);

    // target-planned は対象が 1 件も作られていないので 0 件。run-settled はちょうど 1 件。
    expect(events.filter((e) => e.event.type === "target-planned")).toHaveLength(0);
    expect(events).toHaveLength(1);
    const settled = events[0];
    expect(settled?.runId).toBe(run.id);
    expect(settled?.event.type).toBe("run-settled");
    if (settled?.event.type === "run-settled") {
      expect(settled.event.status).toBe("stopped");
      expect(settled.event.stop?.reason).toBe("settings");
      expect(settled.event.stop?.generationUnconfirmed).toBe(false);
      expect(settled.event.stop?.failure).toBeNull(); // InvalidChunkSettingsError は failure を持たない
    }
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
    // 対象が無いので target-planned は出ない。run-settled は出る（M-2）。
    expect(events.filter((e) => e.event.type === "target-planned")).toHaveLength(0);
    expect(events.filter((e) => e.event.type === "run-settled")).toHaveLength(1);
  });

  it("M-2: target-planned の後に run-settled が出る（対象を持つ stopped 実行）", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const events: RunEvent[] = [];
    const orchestrator = createOrchestrator(
      makeDeps(db, { onEvent: (event) => events.push(event) }),
    );

    const { run } = orchestrator.startRun(
      baseInput({ startOperationId: "op-order", chunkSettings: CHUNK_SETTINGS_TOO_LONG }),
    );

    expect(run.status).toBe("stopped");
    // 2 対象ぶんの target-planned のあとに、run-settled が 1 件だけ続く。
    expect(events).toHaveLength(3);
    expect(events[0]?.event.type).toBe("target-planned");
    expect(events[1]?.event.type).toBe("target-planned");
    expect(events[2]?.event.type).toBe("run-settled");
    const settled = events[2];
    expect(settled?.runId).toBe(run.id);
    if (settled?.event.type === "run-settled") {
      expect(settled.event.status).toBe("stopped");
      expect(settled.event.stop?.reason).toBe("settings");
      // InputTooLongError の代表失敗が乗っている。
      expect(settled.event.stop?.failure?.reason).toBe("input-too-long");
      expect(settled.event.stop?.generationUnconfirmed).toBe(false);
    }
  });

  it("M-2: running で開始が完了した場合は run-settled を出さない", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const events: RunEvent[] = [];
    const orchestrator = createOrchestrator(
      makeDeps(db, { onEvent: (event) => events.push(event) }),
    );

    const { run } = orchestrator.startRun(baseInput());

    expect(run.status).toBe("running");
    expect(events.filter((e) => e.event.type === "run-settled")).toHaveLength(0);
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

  it("M-3: perspectives が空配列なら実行を作らずに例外を投げる（呼び出し側の誤り）", () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const events: RunEvent[] = [];
    const orchestrator = createOrchestrator(
      makeDeps(db, { onEvent: (event) => events.push(event) }),
    );

    // perspectives: [] を許すと「running かつ検査単位 0 件」の実行ができてしまい、
    // 決定 18 が 1 トランザクションで防ごうとしている状態（再開が「やることなし」を返して
    // 復旧できない実行）に、例外ではなく入力経由で到達する。manuscriptVersionId が
    // 存在しないときと同じ扱い（実行を作らずに例外）にする。
    expect(() => orchestrator.startRun(baseInput({ perspectives: [] }))).toThrow();

    expect(countRows(db).runs).toBe(0);
    expect(countRows(db).runTargets).toBe(0);
    expect(countRows(db).checkUnits).toBe(0);
    expect(events).toHaveLength(0);
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

  /**
   * Task 7 までは「`done` は開始直後の `RunRecord` をそのまま解決する（仮実装）」を固定していた。
   * `unusedClient` が投げる素の `Error` はループの外まで抜けるので、Task 8 の決定 33 が
   * これを握って実行を終端化するようになった。「reject しない」（決定 24）ことは変わらない。
   */
  it("X3: done は reject せず、想定外の例外では internal-error で終端化した実行に解決する（決定 24・33）", async () => {
    const { db } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: TEXT });
    const orchestrator = createOrchestrator(makeDeps(db));

    const { run, done } = orchestrator.startRun(baseInput());
    const settled = await done;

    expect(settled.id).toBe(run.id);
    expect(settled.status).toBe("stopped");
    expect(settled.stopReason).toBe("internal-error");
    // 例外のメッセージ（`unusedClient` の文言）を転記せず、定型文だけを残す（決定 33）。
    expect(settled.stopMessage).toBe("想定外のエラーで実行を停止しました");
  });
});
