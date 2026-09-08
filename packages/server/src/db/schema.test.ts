import type { ChunkSettings, LlmFinding } from "@shuten/shared";
import { describe, expect, it } from "vitest";
import { createDatabase } from "./client.ts";
import { applyMigrations } from "./migrate.ts";
import {
  candidates,
  checkUnits,
  diagnostics,
  findings,
  manuscriptVersions,
  recheckUnits,
  runs,
  runTargets,
  type SchemaPerspective,
} from "./schema.ts";

/** テスト用の最小の生成設定。値そのものに意味はない。 */
function generationSettings(): { readonly maxTokens: number; readonly temperature: number } {
  return { maxTokens: 512, temperature: 0.2 };
}

const CHUNK_SETTINGS: ChunkSettings = {
  targetGraphemes: 1500,
  contextGraphemes: 1000,
  recheckContextGraphemes: 3000,
  roundingTolerance: 0.2,
  maxInputGraphemes: 8000,
};

const LLM_FINDING: LlmFinding = {
  paragraphId: 0,
  quote: "誤字",
  before: "",
  after: "",
  category: "notation",
  reason: "テスト用の理由",
  suggestion: "修正案",
  verdict: "likely-error",
};

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

/** manuscript_versions に 1 行入れて id を返す。 */
function insertManuscriptVersion(db: ReturnType<typeof setupDb>["db"], id: string): void {
  db.insert(manuscriptVersions)
    .values({ id, name: "原稿", body: "本文", bodyHash: "hash", createdAt: new Date(0) })
    .run();
}

/** runs に 1 行入れる。start_operation_id は省略可能（null）。 */
function insertRun(
  db: ReturnType<typeof setupDb>["db"],
  args: {
    readonly id: string;
    readonly manuscriptVersionId: string;
    readonly startOperationId?: string;
  },
): void {
  db.insert(runs)
    .values({
      id: args.id,
      manuscriptVersionId: args.manuscriptVersionId,
      modelId: "model-a",
      endpointUrl: "http://127.0.0.1:1234",
      generationSettings: generationSettings(),
      chunkSettings: CHUNK_SETTINGS,
      timeouts: { checkMs: 60_000, recheckMs: 60_000 },
      perspectives: ["typo"],
      recheckEnabled: false,
      allowedWords: [],
      allowedWordRuleVersion: "1",
      promptVersion: "1",
      diagnosticTransformVersion: "1",
      status: "running",
      startOperationId: args.startOperationId ?? null,
      startedAt: new Date(0),
    })
    .run();
}

function insertRunTarget(
  db: ReturnType<typeof setupDb>["db"],
  args: { readonly id: string; readonly runId: string; readonly targetIndex: number },
): void {
  db.insert(runTargets)
    .values({
      id: args.id,
      runId: args.runId,
      targetIndex: args.targetIndex,
      targetStart: 0,
      targetEnd: 10,
      inputStart: 0,
      inputEnd: 10,
      paragraphIds: [0],
    })
    .run();
}

function insertCheckUnit(
  db: ReturnType<typeof setupDb>["db"],
  args: {
    readonly id: string;
    readonly runId: string;
    readonly targetId: string;
    readonly perspective: SchemaPerspective;
  },
): void {
  db.insert(checkUnits)
    .values({
      id: args.id,
      runId: args.runId,
      targetId: args.targetId,
      perspective: args.perspective,
      status: "pending",
    })
    .run();
}

function insertFinding(
  db: ReturnType<typeof setupDb>["db"],
  args: {
    readonly id: string;
    readonly runId: string;
    readonly manuscriptVersionId: string;
    readonly targetId: string;
    readonly mergeKey?: string | null;
  },
): void {
  db.insert(findings)
    .values({
      id: args.id,
      runId: args.runId,
      manuscriptVersionId: args.manuscriptVersionId,
      targetId: args.targetId,
      locateStatus: "located",
      start: 0,
      end: 2,
      paragraphId: 0,
      quote: "誤字",
      suggestion: "修正案",
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: args.mergeKey ?? null,
      createdAt: new Date(0),
    })
    .run();
}

function insertCandidate(
  db: ReturnType<typeof setupDb>["db"],
  args: {
    readonly id: string;
    readonly runId: string;
    readonly checkUnitId: string;
    readonly findingId: string | null;
    readonly candidateIndex: number;
  },
): void {
  db.insert(candidates)
    .values({
      id: args.id,
      runId: args.runId,
      checkUnitId: args.checkUnitId,
      findingId: args.findingId,
      candidateIndex: args.candidateIndex,
      llm: LLM_FINDING,
      locateStatus: args.findingId === null ? "outside-target" : "located",
      start: args.findingId === null ? null : 0,
      end: args.findingId === null ? null : 2,
      mergeKey: null,
      createdAt: new Date(0),
    })
    .run();
}

describe("db/schema", () => {
  it("S1: 存在しない run_id で check_units を挿入すると外部キー違反", () => {
    const { db, close } = setupDb();
    expect(() =>
      insertCheckUnit(db, {
        id: "cu1",
        runId: "no-such-run",
        targetId: "no-such-target",
        perspective: "typo",
      }),
    ).toThrow();
    close();
  });

  it("S2: 同じ run_id・同じ merge_key の findings を 2 行入れると一意制約違反", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    insertRun(db, { id: "r1", manuscriptVersionId: "mv1" });
    insertRunTarget(db, { id: "t1", runId: "r1", targetIndex: 0 });
    insertFinding(db, {
      id: "f1",
      runId: "r1",
      manuscriptVersionId: "mv1",
      targetId: "t1",
      mergeKey: "k",
    });
    expect(() =>
      insertFinding(db, {
        id: "f2",
        runId: "r1",
        manuscriptVersionId: "mv1",
        targetId: "t1",
        mergeKey: "k",
      }),
    ).toThrow();
    close();
  });

  it("S3: 別の run_id なら同じ merge_key を入れられる", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    insertRun(db, { id: "r1", manuscriptVersionId: "mv1" });
    insertRun(db, { id: "r2", manuscriptVersionId: "mv1" });
    insertRunTarget(db, { id: "t1", runId: "r1", targetIndex: 0 });
    insertRunTarget(db, { id: "t2", runId: "r2", targetIndex: 0 });
    insertFinding(db, {
      id: "f1",
      runId: "r1",
      manuscriptVersionId: "mv1",
      targetId: "t1",
      mergeKey: "k",
    });
    expect(() =>
      insertFinding(db, {
        id: "f2",
        runId: "r2",
        manuscriptVersionId: "mv1",
        targetId: "t2",
        mergeKey: "k",
      }),
    ).not.toThrow();
    close();
  });

  it("S4: merge_key が null の findings は同じ実行に何行でも入る", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    insertRun(db, { id: "r1", manuscriptVersionId: "mv1" });
    insertRunTarget(db, { id: "t1", runId: "r1", targetIndex: 0 });
    insertFinding(db, {
      id: "f1",
      runId: "r1",
      manuscriptVersionId: "mv1",
      targetId: "t1",
      mergeKey: null,
    });
    expect(() =>
      insertFinding(db, {
        id: "f2",
        runId: "r1",
        manuscriptVersionId: "mv1",
        targetId: "t1",
        mergeKey: null,
      }),
    ).not.toThrow();
    close();
  });

  it("S5: 同じ target_id と同じ perspective の check_units を 2 行入れると一意制約違反", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    insertRun(db, { id: "r1", manuscriptVersionId: "mv1" });
    insertRunTarget(db, { id: "t1", runId: "r1", targetIndex: 0 });
    insertCheckUnit(db, { id: "cu1", runId: "r1", targetId: "t1", perspective: "typo" });
    expect(() =>
      insertCheckUnit(db, { id: "cu2", runId: "r1", targetId: "t1", perspective: "typo" }),
    ).toThrow();
    close();
  });

  it("S6: 同じ finding_id の recheck_units を 2 行入れると一意制約違反", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    insertRun(db, { id: "r1", manuscriptVersionId: "mv1" });
    insertRunTarget(db, { id: "t1", runId: "r1", targetIndex: 0 });
    insertFinding(db, { id: "f1", runId: "r1", manuscriptVersionId: "mv1", targetId: "t1" });
    db.insert(recheckUnits)
      .values({ id: "ru1", runId: "r1", findingId: "f1", status: "pending" })
      .run();
    expect(() =>
      db
        .insert(recheckUnits)
        .values({ id: "ru2", runId: "r1", findingId: "f1", status: "pending" })
        .run(),
    ).toThrow();
    close();
  });

  it("S6b: 同じ start_operation_id の runs を 2 行入れると一意制約違反。null は何行でも入る", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    insertRun(db, { id: "r1", manuscriptVersionId: "mv1", startOperationId: "op-1" });
    expect(() =>
      insertRun(db, { id: "r2", manuscriptVersionId: "mv1", startOperationId: "op-1" }),
    ).toThrow();
    expect(() => insertRun(db, { id: "r3", manuscriptVersionId: "mv1" })).not.toThrow();
    expect(() => insertRun(db, { id: "r4", manuscriptVersionId: "mv1" })).not.toThrow();
    close();
  });

  it("S8: 実行 A の候補に実行 B の指摘の ID を入れると外部キー違反", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    insertRun(db, { id: "rA", manuscriptVersionId: "mv1" });
    insertRun(db, { id: "rB", manuscriptVersionId: "mv1" });
    insertRunTarget(db, { id: "tA", runId: "rA", targetIndex: 0 });
    insertRunTarget(db, { id: "tB", runId: "rB", targetIndex: 0 });
    insertFinding(db, { id: "fB", runId: "rB", manuscriptVersionId: "mv1", targetId: "tB" });
    insertCheckUnit(db, { id: "cuA", runId: "rA", targetId: "tA", perspective: "typo" });
    expect(() =>
      insertCandidate(db, {
        id: "candA",
        runId: "rA",
        checkUnitId: "cuA",
        findingId: "fB",
        candidateIndex: 0,
      }),
    ).toThrow();
    close();
  });

  it("S9: 実行 A の検査単位に実行 B の検査対象の ID を入れると外部キー違反", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    insertRun(db, { id: "rA", manuscriptVersionId: "mv1" });
    insertRun(db, { id: "rB", manuscriptVersionId: "mv1" });
    insertRunTarget(db, { id: "tB", runId: "rB", targetIndex: 0 });
    expect(() =>
      insertCheckUnit(db, { id: "cuA", runId: "rA", targetId: "tB", perspective: "typo" }),
    ).toThrow();
    close();
  });

  it("S10: findings.manuscript_version_id に runs と違う原稿版 ID を入れると外部キー違反", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    insertManuscriptVersion(db, "mv2");
    insertRun(db, { id: "r1", manuscriptVersionId: "mv1" });
    insertRunTarget(db, { id: "t1", runId: "r1", targetIndex: 0 });
    expect(() =>
      insertFinding(db, { id: "f1", runId: "r1", manuscriptVersionId: "mv2", targetId: "t1" }),
    ).toThrow();
    close();
  });

  it("S11: candidates.finding_id が null なら（outside-target）複合外部キーを通る", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    insertRun(db, { id: "r1", manuscriptVersionId: "mv1" });
    insertRunTarget(db, { id: "t1", runId: "r1", targetIndex: 0 });
    insertCheckUnit(db, { id: "cu1", runId: "r1", targetId: "t1", perspective: "typo" });
    expect(() =>
      insertCandidate(db, {
        id: "cand1",
        runId: "r1",
        checkUnitId: "cu1",
        findingId: null,
        candidateIndex: 0,
      }),
    ).not.toThrow();
    close();
  });

  it("S12: 同じ run_id で同じ candidate_index の候補を 2 行入れると一意制約違反。別実行なら入る", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    insertRun(db, { id: "r1", manuscriptVersionId: "mv1" });
    insertRun(db, { id: "r2", manuscriptVersionId: "mv1" });
    insertRunTarget(db, { id: "t1", runId: "r1", targetIndex: 0 });
    insertRunTarget(db, { id: "t2", runId: "r2", targetIndex: 0 });
    insertCheckUnit(db, { id: "cu1", runId: "r1", targetId: "t1", perspective: "typo" });
    insertCheckUnit(db, { id: "cu2", runId: "r2", targetId: "t2", perspective: "typo" });
    insertCandidate(db, {
      id: "cand1",
      runId: "r1",
      checkUnitId: "cu1",
      findingId: null,
      candidateIndex: 0,
    });
    expect(() =>
      insertCandidate(db, {
        id: "cand2",
        runId: "r1",
        checkUnitId: "cu1",
        findingId: null,
        candidateIndex: 0,
      }),
    ).toThrow();
    expect(() =>
      insertCandidate(db, {
        id: "cand3",
        runId: "r2",
        checkUnitId: "cu2",
        findingId: null,
        candidateIndex: 0,
      }),
    ).not.toThrow();
    close();
  });

  it("S7: runs の挿入型に API キーの列がない（型レベル）", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    type RunInsert = typeof runs.$inferInsert;
    const values: RunInsert = {
      id: "r-s7",
      manuscriptVersionId: "mv1",
      modelId: "model-a",
      endpointUrl: "http://127.0.0.1:1234",
      generationSettings: generationSettings(),
      chunkSettings: CHUNK_SETTINGS,
      timeouts: { checkMs: 60_000, recheckMs: 60_000 },
      perspectives: ["typo"],
      recheckEnabled: false,
      allowedWords: [],
      allowedWordRuleVersion: "1",
      promptVersion: "1",
      diagnosticTransformVersion: "1",
      status: "running",
      startedAt: new Date(0),
      // @ts-expect-error runs の挿入型に apiKey 列はない（決定 10）
      apiKey: "secret",
    };
    expect(() => db.insert(runs).values(values).run()).not.toThrow();
    close();
  });

  it("参考: diagnostics も複合外部キーで実行をまたげない", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, "mv1");
    insertRun(db, { id: "rA", manuscriptVersionId: "mv1" });
    insertRun(db, { id: "rB", manuscriptVersionId: "mv1" });
    insertRunTarget(db, { id: "tA", runId: "rA", targetIndex: 0 });
    insertCheckUnit(db, { id: "cuA", runId: "rA", targetId: "tA", perspective: "typo" });
    insertCandidate(db, {
      id: "candA",
      runId: "rA",
      checkUnitId: "cuA",
      findingId: null,
      candidateIndex: 0,
    });
    expect(() =>
      db
        .insert(diagnostics)
        .values({
          candidateId: "candA",
          runId: "rB",
          quote: "誤字",
          reason: "not-found",
          searchStart: 0,
          searchEnd: 2,
          exactMatches: [],
        })
        .run(),
    ).toThrow();
    close();
  });
});
