import type { LlmFinding } from "@shuten/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDatabase } from "../client.ts";
import { candidateLlmSchema, parseJsonColumn } from "../json.ts";
import { applyMigrations } from "../migrate.ts";
import { candidates, judgments } from "../schema.ts";
import { insertCheckUnit } from "./check-units.ts";
import { listDiagnostics } from "./diagnostics.ts";
import {
  attachCandidateToFinding,
  findFinding,
  insertCandidate,
  insertFinding,
  listFindings,
  saveUnlocatedCandidate,
  type UnlocatedLocateResult,
} from "./findings.ts";
import { insertManuscriptVersion } from "./manuscripts.ts";
import { insertRun, insertRunTarget } from "./runs.ts";

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

/**
 * `findings` / `candidates` の外部キー先（原稿版・検査実行・検査対象・観点ごとの検査単位）を
 * 最小限だけ作る。`typo` / `naturalness` の検査単位を 1 つずつ用意する。
 */
function setupTargets(db: ReturnType<typeof setupDb>["db"]) {
  insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: "本文" });
  const run = insertRun(db, {
    id: "r1",
    manuscriptVersionId: "mv1",
    modelId: "model-a",
    modelInfo: null,
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
  });
  const target = insertRunTarget(db, {
    id: "t1",
    runId: run.id,
    targetIndex: 0,
    target: { start: 0, end: 10 },
    contextBefore: null,
    contextAfter: null,
    input: { start: 0, end: 10 },
    paragraphIds: [0],
  });
  const typoUnit = insertCheckUnit(db, {
    id: "cu-typo",
    runId: run.id,
    targetId: target.id,
    perspective: "typo",
    status: "done",
    attempts: 1,
    failure: null,
    pendingNote: null,
    usage: null,
    inputGraphemes: null,
    elapsedMs: null,
    startedAt: null,
    finishedAt: null,
  });
  const naturalnessUnit = insertCheckUnit(db, {
    id: "cu-naturalness",
    runId: run.id,
    targetId: target.id,
    perspective: "naturalness",
    status: "done",
    attempts: 1,
    failure: null,
    pendingNote: null,
    usage: null,
    inputGraphemes: null,
    elapsedMs: null,
    startedAt: null,
    finishedAt: null,
  });
  return { run, target, typoUnit, naturalnessUnit };
}

/** テスト用の `LlmFinding` を組み立てる。 */
function makeLlm(overrides: Partial<LlmFinding> = {}): LlmFinding {
  return {
    paragraphId: 0,
    quote: "誤字",
    before: "",
    after: "",
    category: "notation",
    reason: "理由",
    suggestion: "修正案",
    verdict: "likely-error",
    ...overrides,
  };
}

describe("db/repositories/findings", () => {
  it("R8: 元候補：llm（LlmFinding）が往復し、引用が1文字も変わらない", () => {
    const { db, close } = setupDb();
    const { run, typoUnit } = setupTargets(db);

    // サロゲートペア（𠮷）・異体字セレクタ（葛󠄀）・ZWJ 絵文字（👨‍👩‍👧）を含む引用。
    // ZWJ は \u escape で明示する（規約：`manuscripts.test.ts` と同じ書き方）。
    const quote = "\u{20BB7}葛\u{E0100}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const llm = makeLlm({ quote, before: "前", after: "後" });

    insertCandidate(db, {
      id: "c1",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: null,
      candidateIndex: 0,
      llm,
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });

    // 実際に DB へ書いた行を読み戻し、引用が 1 文字も変わっていないことを確認する。
    const row = db.select().from(candidates).where(eq(candidates.id, "c1")).get();
    expect(row).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: 直前で toBeDefined() を確認済み
    const roundTripped = parseJsonColumn(candidateLlmSchema, row!.llm, "llm");
    expect(roundTripped).toEqual(llm);
    expect(roundTripped.quote).toBe(quote);
    close();
  });

  it("R9: 指摘：位置特定失敗（not-found）で start / end が null のまま保存・取得できる", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTargets(db);

    const inserted = insertFinding(db, {
      id: "f1",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "not-found",
      range: null,
      paragraphId: 0,
      quote: "見つからない引用",
      suggestion: null,
      category: "notation",
      initialVerdict: "confirm-with-author",
      mergeKey: null,
      suppression: null,
    });
    expect(inserted.range).toBeNull();

    const found = findFinding(db, "f1");
    expect(found).not.toBeNull();
    expect(found?.locateStatus).toBe("not-found");
    expect(found?.range).toBeNull();
    close();
  });

  it("insertFinding は指摘の作成と同時に judgments へ undecided の行を必ず作る（決定 5）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTargets(db);

    insertFinding(db, {
      id: "f1",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 0, end: 2 },
      paragraphId: 0,
      quote: "誤字",
      suggestion: "修正案",
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: "key1",
      suppression: null,
    });

    const judgment = db.select().from(judgments).where(eq(judgments.findingId, "f1")).get();
    expect(judgment).toBeDefined();
    expect(judgment?.status).toBe("undecided");
    expect(judgment?.note).toBeNull();
    close();
  });

  it("R10: saveUnlocatedCandidate は outside-target で candidates だけを増やし、findings は作らない（決定 4 の表どおりに書く関数の検査）", () => {
    const { db, close } = setupDb();
    const { run, target, typoUnit } = setupTargets(db);

    const findingsBefore = listFindings(db, run.id).length;
    const diagnosticsBefore = listDiagnostics(db, run.id).length;

    const locate: UnlocatedLocateResult = {
      status: "failed",
      reason: "outside-target",
      exactMatches: [{ start: 20, end: 22 }],
      diagnostic: null,
    };
    const result = saveUnlocatedCandidate(db, {
      runId: run.id,
      checkUnitId: typoUnit.id,
      candidateIndex: 0,
      llm: makeLlm(),
      manuscriptVersionId: "mv1",
      targetId: target.id,
      searchRange: { start: 0, end: 10 },
      locate,
      candidateId: "c-outside",
    });

    // candidates は 1 行増える。finding_id は null（決定 4）。
    const candidateRow = db.select().from(candidates).where(eq(candidates.id, "c-outside")).get();
    expect(candidateRow).toBeDefined();
    expect(candidateRow?.findingId).toBeNull();
    expect(candidateRow?.locateStatus).toBe("outside-target");
    expect(result.candidate.findingId).toBeNull();
    expect(result.finding).toBeNull();

    // findings は増えない（outside-target は指摘を作らない）。
    expect(listFindings(db, run.id)).toHaveLength(findingsBefore);

    // diagnostics は 1 行増え、変換候補 4 列はすべて null（ambiguous / outside-target の規則）。
    const diagnosticsAfter = listDiagnostics(db, run.id);
    expect(diagnosticsAfter).toHaveLength(diagnosticsBefore + 1);
    expect(result.diagnostic.transformVersion).toBeNull();
    expect(result.diagnostic.transformCandidates).toBeNull();
    expect(result.diagnostic.omitted).toBeNull();
    expect(result.diagnostic.tied).toBeNull();
    close();
  });

  it("saveUnlocatedCandidate は not-found で findings を 1 行作り、judgments に undecided、diagnostics に変換候補を残す", () => {
    const { db, close } = setupDb();
    const { run, target, typoUnit } = setupTargets(db);

    const findingsBefore = listFindings(db, run.id).length;

    const locate: UnlocatedLocateResult = {
      status: "failed",
      reason: "not-found",
      exactMatches: [],
      diagnostic: {
        transformVersion: "1",
        candidates: [{ transform: "newline", text: "候補", range: { start: 3, end: 5 } }],
        omitted: 1,
        tied: false,
      },
    };
    const result = saveUnlocatedCandidate(db, {
      runId: run.id,
      checkUnitId: typoUnit.id,
      candidateIndex: 0,
      llm: makeLlm({ paragraphId: 2 }),
      manuscriptVersionId: "mv1",
      targetId: target.id,
      searchRange: { start: 0, end: 10 },
      locate,
      candidateId: "c-not-found",
      findingId: "f-not-found",
    });

    expect(listFindings(db, run.id)).toHaveLength(findingsBefore + 1);
    expect(result.finding).not.toBeNull();
    expect(result.finding?.range).toBeNull();
    expect(result.finding?.mergeKey).toBeNull();
    expect(result.finding?.paragraphId).toBe(2);
    expect(result.candidate.findingId).toBe("f-not-found");

    const judgment = db
      .select()
      .from(judgments)
      .where(eq(judgments.findingId, "f-not-found"))
      .get();
    expect(judgment).toBeDefined();
    expect(judgment?.status).toBe("undecided");

    expect(result.diagnostic.transformVersion).toBe("1");
    expect(result.diagnostic.transformCandidates).toEqual([
      { transform: "newline", text: "候補", range: { start: 3, end: 5 } },
    ]);
    close();
  });

  it("saveUnlocatedCandidate は ambiguous で findings を 1 行作るが、diagnostics の変換候補 4 列は null", () => {
    const { db, close } = setupDb();
    const { run, target, typoUnit } = setupTargets(db);

    const findingsBefore = listFindings(db, run.id).length;

    const locate: UnlocatedLocateResult = {
      status: "failed",
      reason: "ambiguous",
      exactMatches: [
        { start: 1, end: 3 },
        { start: 5, end: 7 },
      ],
      diagnostic: null,
    };
    const result = saveUnlocatedCandidate(db, {
      runId: run.id,
      checkUnitId: typoUnit.id,
      candidateIndex: 0,
      llm: makeLlm(),
      manuscriptVersionId: "mv1",
      targetId: target.id,
      searchRange: { start: 0, end: 10 },
      locate,
      candidateId: "c-ambiguous",
      findingId: "f-ambiguous",
    });

    expect(listFindings(db, run.id)).toHaveLength(findingsBefore + 1);
    expect(result.finding).not.toBeNull();
    expect(result.finding?.range).toBeNull();
    expect(result.diagnostic.transformVersion).toBeNull();
    expect(result.diagnostic.transformCandidates).toBeNull();
    expect(result.diagnostic.omitted).toBeNull();
    expect(result.diagnostic.tied).toBeNull();
    close();
  });

  it.each(["ambiguous", "outside-target"] as const)(
    "saveUnlocatedCandidate は %s に変換候補を渡すと例外になる（不変条件：黙って捨てない）",
    (reason) => {
      const { db, close } = setupDb();
      const { run, target, typoUnit } = setupTargets(db);

      const locate: UnlocatedLocateResult = {
        status: "failed",
        reason,
        exactMatches: [],
        // ambiguous / outside-target では本来 null のはずの診断を、呼び出し側の組み立てミスとして渡す。
        diagnostic: {
          transformVersion: "1",
          candidates: [{ transform: "nfc", text: "候補", range: null }],
          omitted: 0,
          tied: false,
        },
      };

      expect(() =>
        saveUnlocatedCandidate(db, {
          runId: run.id,
          checkUnitId: typoUnit.id,
          candidateIndex: 0,
          llm: makeLlm(),
          manuscriptVersionId: "mv1",
          targetId: target.id,
          searchRange: { start: 0, end: 10 },
          locate,
          candidateId: `c-${reason}-invalid`,
        }),
      ).toThrow(/not-found のときだけ/);
      close();
    },
  );

  it("R18・R18b: reasons が理由の異なる2候補で2要素になり、candidate_index の昇順に並ぶ（perspective は check_units 由来）", () => {
    const { db, close } = setupDb();
    const { run, target, typoUnit, naturalnessUnit } = setupTargets(db);

    const finding = insertFinding(db, {
      id: "f1",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 0, end: 2 },
      paragraphId: 0,
      quote: "誤字",
      suggestion: "修正案",
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: "key1",
      suppression: null,
    });

    // 挿入の順序を逆（index 1 → index 0）にする。candidate_index を持つ理由の検査。
    insertCandidate(db, {
      id: "c-index1",
      runId: run.id,
      checkUnitId: naturalnessUnit.id,
      findingId: finding.id,
      candidateIndex: 1,
      llm: makeLlm({ reason: "自然さの理由" }),
      locateStatus: "located",
      range: { start: 0, end: 2 },
      mergeKey: "key1",
    });
    insertCandidate(db, {
      id: "c-index0",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: finding.id,
      candidateIndex: 0,
      llm: makeLlm({ reason: "誤字の理由" }),
      locateStatus: "located",
      range: { start: 0, end: 2 },
      mergeKey: "key1",
    });

    const found = findFinding(db, "f1");
    expect(found).not.toBeNull();
    expect(found?.reasons).toHaveLength(2);
    // candidate_index の昇順（挿入順ではない）。
    expect(found?.reasons).toEqual([
      { candidateId: "c-index0", perspective: "typo", reason: "誤字の理由" },
      { candidateId: "c-index1", perspective: "naturalness", reason: "自然さの理由" },
    ]);

    const listed = listFindings(db, run.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.reasons).toEqual(found?.reasons);
    close();
  });

  it("attachCandidateToFinding は候補を後から指摘に紐づけ、他の列を変えない", () => {
    const { db, close } = setupDb();
    const { run, target, typoUnit } = setupTargets(db);

    const finding = insertFinding(db, {
      id: "f1",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 0, end: 2 },
      paragraphId: 0,
      quote: "誤字",
      suggestion: "修正案",
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: "key1",
      suppression: null,
    });

    const candidate = insertCandidate(db, {
      id: "c1",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: null,
      candidateIndex: 0,
      llm: makeLlm(),
      locateStatus: "located",
      range: { start: 0, end: 2 },
      mergeKey: "key1",
    });
    expect(candidate.findingId).toBeNull();

    attachCandidateToFinding(db, "c1", finding.id);

    const row = db.select().from(candidates).where(eq(candidates.id, "c1")).get();
    expect(row?.findingId).toBe(finding.id);
    expect(row?.locateStatus).toBe("located");
    close();
  });

  it("listFindings は start の昇順で並び、位置特定失敗（start が null）は最後になる", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTargets(db);

    insertFinding(db, {
      id: "f-start5",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 5, end: 6 },
      paragraphId: 0,
      quote: "五",
      suggestion: null,
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: "key-5",
      suppression: null,
    });
    insertFinding(db, {
      id: "f-null",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "not-found",
      range: null,
      paragraphId: 0,
      quote: "見つからない",
      suggestion: null,
      category: "notation",
      initialVerdict: "confirm-with-author",
      mergeKey: null,
      suppression: null,
    });
    insertFinding(db, {
      id: "f-start2",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 2, end: 3 },
      paragraphId: 0,
      quote: "二",
      suggestion: null,
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: "key-2",
      suppression: null,
    });

    const listed = listFindings(db, run.id);
    expect(listed.map((f) => f.id)).toEqual(["f-start2", "f-start5", "f-null"]);
    close();
  });
});
