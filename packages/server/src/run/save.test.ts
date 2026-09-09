import type {
  LlmFinding,
  LocatedCandidate,
  Paragraph,
  Range,
  UnlocatedCandidate,
} from "@shuten/shared";
import { splitParagraphs } from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { createDatabase } from "../db/client.ts";
import { MalformedBodyError } from "../db/errors.ts";
import { applyMigrations } from "../db/migrate.ts";
import type {
  CheckUnitRecord,
  RecheckUnitRecord,
  RunRecord,
  RunTargetRecord,
} from "../db/records.ts";
import { findCheckUnit, insertCheckUnit } from "../db/repositories/check-units.ts";
import { listDiagnostics } from "../db/repositories/diagnostics.ts";
import {
  findFinding,
  listCandidates,
  listFindings,
  nextCandidateIndex,
} from "../db/repositories/findings.ts";
import { listJudgments } from "../db/repositories/judgments.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import {
  findRecheckUnitByFinding,
  insertRecheckUnit,
  listRecheckUnits,
} from "../db/repositories/rechecks.ts";
import { findRun, insertRun, insertRunTarget } from "../db/repositories/runs.ts";
import type { ModelInfo } from "../lmstudio/types.ts";
import { PersistBoundaryError } from "./persist.ts";
import type { SaveCheckUnitInput } from "./save.ts";
import { saveCheckUnitOutcome, saveRecheckOutcome } from "./save.ts";
import {
  claimRecheckUnitChecked,
  claimUnitChecked,
  finishCheckUnitChecked,
  finishRecheckUnitChecked,
} from "./transitions.ts";
import type { CheckUnitOutcome, RecheckUnitOutcome } from "./units.ts";

// 単一段落（改行なし）の本文。merge-store.test.ts と同じ組み立て方。
const BODY = "あいうえおかきくけこAねこB";
const PARAGRAPHS: readonly Paragraph[] = splitParagraphs(BODY);

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

interface RunOverrides {
  readonly recheckEnabled?: boolean;
  readonly modelInfo?: ModelInfo | null;
}

/** `findings` / `candidates` の外部キー先（原稿版・実行・対象）を作る。検査単位は呼び出し側が作る。 */
function setupRun(
  db: ReturnType<typeof setupDb>["db"],
  runId: string,
  targetId: string,
  overrides: RunOverrides = {},
): { readonly run: RunRecord; readonly target: RunTargetRecord } {
  insertManuscriptVersion(db, { id: `mv-${runId}`, name: "原稿", body: BODY });
  const run = insertRun(db, {
    id: runId,
    manuscriptVersionId: `mv-${runId}`,
    modelId: "model-a",
    modelInfo: overrides.modelInfo ?? null,
    endpointUrl: "http://127.0.0.1:1234",
    generationSettings: { maxTokens: 512, temperature: 0.2 },
    chunkSettings: {
      targetGraphemes: 1500,
      contextGraphemes: 1000,
      recheckContextGraphemes: 3000,
      roundingTolerance: 0.2,
      maxInputGraphemes: 8000,
    },
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo", "naturalness"],
    recheckEnabled: overrides.recheckEnabled ?? true,
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
    id: targetId,
    runId: run.id,
    targetIndex: 0,
    target: { start: 0, end: BODY.length },
    contextBefore: null,
    contextAfter: null,
    input: { start: 0, end: BODY.length },
    paragraphIds: [0],
  });
  return { run, target };
}

/**
 * `running`（claim 済み）の検査単位を 1 件作る。`attempts` は今回の要求より前の累計値。
 * `check_units` は `(target_id, perspective)` に一意制約があるため、同じ対象に 2 件目を
 * 作るとき（再開・複数観点を模す）は `perspective` を変える。
 */
function setupRunningCheckUnit(
  db: ReturnType<typeof setupDb>["db"],
  runId: string,
  targetId: string,
  checkUnitId: string,
  attempts = 0,
  perspective: "typo" | "naturalness" = "typo",
): CheckUnitRecord {
  insertCheckUnit(db, {
    id: checkUnitId,
    runId,
    targetId,
    perspective,
    status: "pending",
    attempts,
    failure: null,
    pendingNote: null,
    usage: null,
    inputGraphemes: null,
    elapsedMs: null,
    startedAt: null,
    finishedAt: null,
  });
  claimUnitChecked(db, checkUnitId, "pending", "running");
  const unit = findCheckUnit(db, checkUnitId);
  if (unit === null) {
    throw new Error("テストの組み立てミス：検査単位が見つかりません");
  }
  return unit;
}

/** テスト用の `LlmFinding` を組み立てる。既定は `notation` / `likely-error`。 */
function makeLlm(overrides: Partial<LlmFinding> = {}): LlmFinding {
  return {
    paragraphId: 0,
    quote: "誤字",
    before: "",
    after: "",
    category: "notation",
    reason: "理由",
    suggestion: "訂正",
    verdict: "likely-error",
    ...overrides,
  };
}

/** `range` から本文の引用を取り出した位置確定済み候補。 */
function makeLocated(
  id: string,
  range: Range,
  llmOverrides: Partial<LlmFinding> = {},
): LocatedCandidate {
  return {
    id,
    perspective: "typo",
    llm: makeLlm({ quote: BODY.slice(range.start, range.end), ...llmOverrides }),
    locate: { status: "located", range },
  };
}

/** 位置特定失敗（`not-found`）の候補。引用は本文に存在しない文字列。 */
function makeNotFound(id: string, quote: string): UnlocatedCandidate {
  return {
    id,
    perspective: "typo",
    llm: makeLlm({ quote }),
    locate: { status: "failed", reason: "not-found", exactMatches: [], diagnostic: null },
  };
}

/** 孤立サロゲートを含む引用を持つ `not-found` 候補（境界検証の注入口）。 */
function makeMalformedNotFound(id: string): UnlocatedCandidate {
  return {
    id,
    perspective: "typo",
    llm: makeLlm({ quote: "\uD800不正な引用" }),
    locate: { status: "failed", reason: "not-found", exactMatches: [], diagnostic: null },
  };
}

/** `CheckUnitOutcome` を組み立てる。既定は `done`、候補 0 件。 */
function makeCheckUnitOutcome(
  overrides: {
    readonly candidates?: readonly (LocatedCandidate | UnlocatedCandidate)[];
    readonly attempts?: number;
  } = {},
): CheckUnitOutcome {
  return {
    unit: {
      status: "done",
      targetIndex: 0,
      perspective: "typo",
      attempts: overrides.attempts ?? 1,
      usage: null,
      inputGraphemes: 10,
      elapsedMs: 100,
      findingCount: overrides.candidates?.length ?? 0,
    },
    candidates: overrides.candidates ?? [],
    failure: null,
    halt: null,
    elapsedMs: 100,
    usage: null,
  };
}

function baseInput(
  overrides: Partial<SaveCheckUnitInput> & {
    readonly run: RunRecord;
    readonly target: RunTargetRecord;
    readonly unit: CheckUnitRecord;
  },
): SaveCheckUnitInput {
  return {
    body: BODY,
    paragraphs: PARAGRAPHS,
    allowedWords: [],
    now: new Date("2026-09-09T00:00:00.000Z"),
    outcome: makeCheckUnitOutcome(),
    modelInfo: null,
    ...overrides,
  };
}

describe("saveCheckUnitOutcome", () => {
  it("T1: トランザクションの途中（境界違反の候補）で例外を起こすと、candidates・diagnostics・findings・judgments・recheck_units のどれにも行が残らず、check_units は running のままである", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1");
    setupRunningCheckUnit(db, run.id, target.id, "cu1");
    const unit = findCheckUnit(db, "cu1");
    if (unit === null) throw new Error("組み立てミス");

    // 1件目：位置確定済み（正常）。2件目：位置特定失敗だが正常（not-found）。
    // 3件目：孤立サロゲートを含む引用（assertUnlocatedFindingBoundary が MalformedBodyError を投げる）。
    // 1・2件目が先に候補・指摘・判断・（2件目は）診断・再確認単位を作ってから例外が起きることを確かめる。
    const outcome = makeCheckUnitOutcome({
      candidates: [
        makeLocated("cand-1", { start: 0, end: 2 }),
        makeNotFound("cand-2", "存在しない引用"),
        makeMalformedNotFound("cand-3"),
      ],
    });

    expect(() => saveCheckUnitOutcome(db, baseInput({ run, target, unit, outcome }))).toThrow(
      MalformedBodyError,
    );

    expect(listCandidates(db, run.id)).toHaveLength(0);
    expect(listDiagnostics(db, run.id)).toHaveLength(0);
    expect(listFindings(db, run.id)).toHaveLength(0);
    expect(listJudgments(db, run.id)).toHaveLength(0);
    expect(listRecheckUnits(db, run.id)).toHaveLength(0);
    expect(findCheckUnit(db, "cu1")?.status).toBe("running");
    close();
  });

  it("P: 境界違反（段落表と本文の不整合）の候補を渡すと PersistBoundaryError が出て DB に 1 行も残らない", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1");
    setupRunningCheckUnit(db, run.id, target.id, "cu1");
    const unit = findCheckUnit(db, "cu1");
    if (unit === null) throw new Error("組み立てミス");

    // 1件目は正常に保存されるはず。2件目の range.start が本文長ちょうど（どの段落にも含まれない）
    // なので deriveParagraphId が PersistBoundaryError を投げる。1件目が本当に書き込まれてから
    // ロールバックされることを確認する（空のトランザクションで「残らない」が自明に成り立つのを避ける）。
    const outcome = makeCheckUnitOutcome({
      candidates: [
        makeLocated("cand-1", { start: 0, end: 2 }),
        makeLocated("cand-2", { start: BODY.length, end: BODY.length }),
      ],
    });

    expect(() => saveCheckUnitOutcome(db, baseInput({ run, target, unit, outcome }))).toThrow(
      PersistBoundaryError,
    );

    expect(listCandidates(db, run.id)).toHaveLength(0);
    expect(listFindings(db, run.id)).toHaveLength(0);
    expect(listJudgments(db, run.id)).toHaveLength(0);
    expect(findCheckUnit(db, "cu1")?.status).toBe("running");
    close();
  });

  it("T3: finishCheckUnit が 0 行を返す状況（先に別経路で done にしておく）では rolledBack: true が返り、候補が 1 行も残らない", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1");
    const unit = setupRunningCheckUnit(db, run.id, target.id, "cu1", 1);

    // 別経路（例えば起動時照合や停止処理）が先にこの単位を running → done にしてしまった状況を再現する。
    const decided = finishCheckUnitChecked(db, "cu1", {
      expectedStatus: "running",
      status: "done",
      attempts: 1,
      failure: null,
      pendingNote: null,
      usage: null,
      inputGraphemes: null,
      elapsedMs: null,
      finishedAt: new Date("2026-09-09T00:00:00.000Z"),
    });
    expect(decided).toBe(true);

    // 呼び出し元は依然として running の古いスナップショット（unit）を持っている。
    const outcome = makeCheckUnitOutcome({
      candidates: [makeLocated("cand-1", { start: 0, end: 2 })],
    });
    const result = saveCheckUnitOutcome(db, baseInput({ run, target, unit, outcome }));

    expect(result.rolledBack).toBe(true);
    expect(result.findingIds).toHaveLength(0);
    expect(listCandidates(db, run.id)).toHaveLength(0);
    // 先に決着していた done は上書きされない。
    expect(findCheckUnit(db, "cu1")?.status).toBe("done");
    close();
  });

  it("T4: 再開後に保存された候補は、既存候補より後の番号になる", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1");
    const unit1 = setupRunningCheckUnit(db, run.id, target.id, "cu1");
    saveCheckUnitOutcome(
      db,
      baseInput({
        run,
        target,
        unit: unit1,
        outcome: makeCheckUnitOutcome({
          candidates: [makeLocated("cand-1", { start: 0, end: 2 })],
        }),
      }),
    );

    const unit2 = setupRunningCheckUnit(db, run.id, target.id, "cu2", 0, "naturalness");
    const result = saveCheckUnitOutcome(
      db,
      baseInput({
        run,
        target,
        unit: unit2,
        outcome: makeCheckUnitOutcome({
          candidates: [makeLocated("cand-2", { start: 2, end: 4 })],
        }),
      }),
    );

    expect(result.rolledBack).toBe(false);
    const all = listCandidates(db, run.id);
    const first = all.find((c) => c.id === "cand-1");
    const second = all.find((c) => c.id === "cand-2");
    expect(first?.candidateIndex).toBe(0);
    expect(second?.candidateIndex).toBe(1);
    close();
  });

  it("T5: 1 応答に複数候補があるとき、LLM の応答順（位置確定済み・失敗が混在しても）に連番になる", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1");
    const unit = setupRunningCheckUnit(db, run.id, target.id, "cu1");

    // 位置確定済み → 失敗 → 位置確定済みの順（partitionCandidates で並べ替えると壊れる）。
    const outcome = makeCheckUnitOutcome({
      candidates: [
        makeLocated("cand-a", { start: 0, end: 2 }),
        makeNotFound("cand-b", "存在しない引用"),
        makeLocated("cand-c", { start: 2, end: 4 }),
      ],
    });
    saveCheckUnitOutcome(db, baseInput({ run, target, unit, outcome }));

    const all = listCandidates(db, run.id);
    const byId = new Map(all.map((c) => [c.id, c.candidateIndex]));
    expect(byId.get("cand-a")).toBe(0);
    expect(byId.get("cand-b")).toBe(1);
    expect(byId.get("cand-c")).toBe(2);
    close();
  });

  it("T6: ロールバックされたとき、中途半端な番号の候補が残らず nextCandidateIndex も元に戻る", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1");
    const unit1 = setupRunningCheckUnit(db, run.id, target.id, "cu1");
    saveCheckUnitOutcome(
      db,
      baseInput({
        run,
        target,
        unit: unit1,
        outcome: makeCheckUnitOutcome({
          candidates: [makeLocated("cand-1", { start: 0, end: 2 })],
        }),
      }),
    );
    const before = nextCandidateIndex(db, run.id);
    expect(before).toBe(1);

    const unit2 = setupRunningCheckUnit(db, run.id, target.id, "cu2", 0, "naturalness");
    const outcome = makeCheckUnitOutcome({
      candidates: [
        makeLocated("cand-2", { start: 2, end: 4 }),
        makeLocated("cand-3", { start: BODY.length, end: BODY.length }), // 境界違反で例外
      ],
    });
    expect(() =>
      saveCheckUnitOutcome(db, baseInput({ run, target, unit: unit2, outcome })),
    ).toThrow(PersistBoundaryError);

    expect(nextCandidateIndex(db, run.id)).toBe(before);
    expect(listCandidates(db, run.id).map((c) => c.id)).toEqual(["cand-1"]);
    close();
  });

  it("T7: 2 つの実行を交互に保存しても、それぞれの候補番号は 0 から連続する", () => {
    const { db, close } = setupDb();
    const { run: runA, target: targetA } = setupRun(db, "rA", "tA");
    const { run: runB, target: targetB } = setupRun(db, "rB", "tB");

    const unitA1 = setupRunningCheckUnit(db, runA.id, targetA.id, "cuA1");
    saveCheckUnitOutcome(
      db,
      baseInput({
        run: runA,
        target: targetA,
        unit: unitA1,
        outcome: makeCheckUnitOutcome({ candidates: [makeLocated("a-1", { start: 0, end: 2 })] }),
      }),
    );

    const unitB1 = setupRunningCheckUnit(db, runB.id, targetB.id, "cuB1");
    saveCheckUnitOutcome(
      db,
      baseInput({
        run: runB,
        target: targetB,
        unit: unitB1,
        outcome: makeCheckUnitOutcome({ candidates: [makeLocated("b-1", { start: 0, end: 2 })] }),
      }),
    );

    const unitA2 = setupRunningCheckUnit(db, runA.id, targetA.id, "cuA2", 0, "naturalness");
    saveCheckUnitOutcome(
      db,
      baseInput({
        run: runA,
        target: targetA,
        unit: unitA2,
        outcome: makeCheckUnitOutcome({ candidates: [makeLocated("a-2", { start: 2, end: 4 })] }),
      }),
    );

    const candidatesA = listCandidates(db, runA.id);
    const candidatesB = listCandidates(db, runB.id);
    expect(candidatesA.find((c) => c.id === "a-1")?.candidateIndex).toBe(0);
    expect(candidatesA.find((c) => c.id === "a-2")?.candidateIndex).toBe(1);
    expect(candidatesB.find((c) => c.id === "b-1")?.candidateIndex).toBe(0);
    close();
  });

  it("T8: attempts は実行をまたいで累積する（2 要求で失敗 → 個別再試行 1 要求で成功 → 3）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1");
    // 最初の実行で 2 要求送って failed になった、という前提（attempts=2 で running に再度 claim された想定）。
    const unit = setupRunningCheckUnit(db, run.id, target.id, "cu1", 2);

    const outcome = makeCheckUnitOutcome({ attempts: 1, candidates: [] });
    const result = saveCheckUnitOutcome(db, baseInput({ run, target, unit, outcome }));

    expect(result.rolledBack).toBe(false);
    expect(findCheckUnit(db, "cu1")?.attempts).toBe(3);
    close();
  });

  it("位置特定失敗（not-found）で指摘ができたら not-applicable(unlocated) の再確認単位を作る（recheckEnabled: true）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1", { recheckEnabled: true });
    const unit = setupRunningCheckUnit(db, run.id, target.id, "cu1");

    const outcome = makeCheckUnitOutcome({
      candidates: [makeNotFound("cand-1", "存在しない引用")],
    });
    const result = saveCheckUnitOutcome(db, baseInput({ run, target, unit, outcome }));

    expect(result.rolledBack).toBe(false);
    expect(result.findingIds).toHaveLength(1);
    const findingId = result.findingIds[0];
    if (findingId === undefined) {
      throw new Error("テストの組み立てミス");
    }
    const recheck = findRecheckUnitByFinding(db, findingId);
    expect(recheck?.status).toBe("not-applicable");
    expect(recheck?.notApplicableReason).toBe("unlocated");
    close();
  });

  it("位置特定失敗（not-found）で指摘ができても recheckEnabled: false なら not-applicable(disabled) になる", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1", { recheckEnabled: false });
    const unit = setupRunningCheckUnit(db, run.id, target.id, "cu1");

    const outcome = makeCheckUnitOutcome({
      candidates: [makeNotFound("cand-1", "存在しない引用")],
    });
    const result = saveCheckUnitOutcome(db, baseInput({ run, target, unit, outcome }));

    const findingId = result.findingIds[0];
    if (findingId === undefined) {
      throw new Error("テストの組み立てミス");
    }
    const recheck = findRecheckUnitByFinding(db, findingId);
    expect(recheck?.notApplicableReason).toBe("disabled");
    close();
  });

  it("runs.model_info が null で modelInfo が取れていれば updateRunModelInfo を呼ぶ", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1", { modelInfo: null });
    const unit = setupRunningCheckUnit(db, run.id, target.id, "cu1");

    const modelInfo: ModelInfo = {
      id: "model-a",
      type: "llm",
      state: "loaded",
      quantization: null,
      maxContextLength: 8192,
      loadedContextLength: 4096,
    };
    const result = saveCheckUnitOutcome(
      db,
      baseInput({ run, target, unit, outcome: makeCheckUnitOutcome(), modelInfo }),
    );

    expect(result.rolledBack).toBe(false);
    expect(findRun(db, run.id)?.modelInfo).toEqual(modelInfo);
    close();
  });

  it("runs.model_info が既に非 null なら modelInfo を渡しても上書きしない", () => {
    const { db, close } = setupDb();
    const existing: ModelInfo = {
      id: "model-old",
      type: "llm",
      state: "loaded",
      quantization: null,
      maxContextLength: 4096,
      loadedContextLength: 2048,
    };
    const { run, target } = setupRun(db, "r1", "t1", { modelInfo: existing });
    const unit = setupRunningCheckUnit(db, run.id, target.id, "cu1");

    const newer: ModelInfo = { ...existing, id: "model-new" };
    saveCheckUnitOutcome(
      db,
      baseInput({ run, target, unit, outcome: makeCheckUnitOutcome(), modelInfo: newer }),
    );

    expect(findRun(db, run.id)?.modelInfo).toEqual(existing);
    close();
  });

  it("位置確定済みの候補を保存すると指摘が作られる（基本の正常系）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1");
    const unit = setupRunningCheckUnit(db, run.id, target.id, "cu1");

    const outcome = makeCheckUnitOutcome({
      candidates: [makeLocated("cand-1", { start: 0, end: 2 })],
    });
    const result = saveCheckUnitOutcome(db, baseInput({ run, target, unit, outcome }));

    expect(result.rolledBack).toBe(false);
    const findingId = result.findingIds[0];
    if (findingId === undefined) {
      throw new Error("テストの組み立てミス");
    }
    expect(findFinding(db, findingId)?.locateStatus).toBe("located");
    expect(findCheckUnit(db, "cu1")?.status).toBe("done");
    close();
  });
});

describe("saveRecheckOutcome", () => {
  /** 位置確定済みの指摘を 1 件作り、再確認単位（`pending`、外部から `running` へ claim 済み）を用意する。 */
  function setupPendingRecheckUnit(
    db: ReturnType<typeof setupDb>["db"],
    run: RunRecord,
    target: RunTargetRecord,
    checkUnitId: string,
    recheckUnitId: string,
  ): RecheckUnitRecord {
    const unit = setupRunningCheckUnit(db, run.id, target.id, checkUnitId);
    const outcome = makeCheckUnitOutcome({
      candidates: [makeLocated("seed-cand", { start: 0, end: 2 })],
    });
    const result = saveCheckUnitOutcome(db, baseInput({ run, target, unit, outcome }));
    const findingId = result.findingIds[0];
    if (findingId === undefined) {
      throw new Error("テストの組み立てミス");
    }
    insertRecheckUnit(db, {
      id: recheckUnitId,
      runId: run.id,
      findingId,
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
    claimRecheckUnitChecked(db, recheckUnitId, "pending", "running");
    const recheckUnit = findRecheckUnitByFinding(db, findingId);
    if (recheckUnit === null) {
      throw new Error("テストの組み立てミス");
    }
    return recheckUnit;
  }

  it("T2: 再確認の結果保存と recheck_units の状態更新が 1 トランザクションである（正常系）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1");
    const recheckUnit = setupPendingRecheckUnit(db, run, target, "cu1", "rc1");

    const outcome: RecheckUnitOutcome = {
      result: {
        status: "done",
        attempts: 1,
        output: {
          reason: "検討の結果、指摘は妥当",
          reasonKind: "error-confirmed",
          verdict: "keep",
          suggestionValid: true,
        },
        usage: null,
        inputRange: { start: 0, end: BODY.length },
        inputGraphemes: 10,
        elapsedMs: 200,
      },
      failure: null,
      halt: null,
      elapsedMs: 200,
      usage: null,
    };

    const result = saveRecheckOutcome(db, {
      run,
      unit: recheckUnit,
      outcome,
      now: new Date("2026-09-09T00:00:00.000Z"),
    });

    expect(result.rolledBack).toBe(false);
    const saved = findRecheckUnitByFinding(db, recheckUnit.findingId);
    expect(saved?.status).toBe("done");
    expect(saved?.verdict).toBe("keep");
    expect(saved?.reasonKind).toBe("error-confirmed");
    expect(saved?.suggestionValid).toBe(true);
    close();
  });

  it("finishRecheckUnit が 0 行を返す状況では rolledBack: true が返る", () => {
    const { db, close } = setupDb();
    const { run, target } = setupRun(db, "r1", "t1");
    const recheckUnit = setupPendingRecheckUnit(db, run, target, "cu1", "rc1");

    // 別経路が先に failed にしていた状況を再現する。
    finishRecheckUnitChecked(db, recheckUnit.id, {
      expectedStatus: "running",
      status: "failed",
      attempts: 1,
      failure: {
        reason: "connection",
        message: "接続エラー",
        finishReason: null,
        origin: "chat",
      },
      pendingNote: null,
      notApplicableReason: null,
      verdict: null,
      reasonKind: null,
      reason: null,
      suggestionValid: null,
      usage: null,
      inputGraphemes: null,
      elapsedMs: null,
      finishedAt: new Date("2026-09-09T00:00:00.000Z"),
    });

    const outcome: RecheckUnitOutcome = {
      result: { status: "pending", attempts: 1, inputRange: null, note: "停止した" },
      failure: null,
      halt: null,
      elapsedMs: 0,
      usage: null,
    };
    const result = saveRecheckOutcome(db, {
      run,
      unit: recheckUnit,
      outcome,
      now: new Date("2026-09-09T00:00:00.000Z"),
    });
    expect(result.rolledBack).toBe(true);
    close();
  });
});
