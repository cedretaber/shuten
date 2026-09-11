import type { LlmFinding } from "@shuten/shared";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDatabase } from "../client.ts";
import { applyMigrations } from "../migrate.ts";
import { candidates, judgments } from "../schema.ts";
import { insertCheckUnit } from "./check-units.ts";
import { listDiagnostics } from "./diagnostics.ts";
import {
  attachCandidateToFinding,
  findCandidate,
  findFinding,
  insertCandidate,
  insertFinding,
  listCandidateSourcesForFinding,
  listCandidates,
  listFindings,
  listFindingsForTarget,
  nextCandidateIndex,
  saveUnlocatedCandidate,
  type UnlocatedLocateResult,
  updateFindingAggregate,
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

    // findCandidate 経由で読み戻し、引用が 1 文字も変わっていないことを確認する。
    const found = findCandidate(db, "c1");
    expect(found).not.toBeNull();
    expect(found?.llm).toEqual(llm);
    expect(found?.llm.quote).toBe(quote);
    close();
  });

  it("findCandidate: 存在しない候補 ID は null を返す", () => {
    const { db, close } = setupDb();
    expect(findCandidate(db, "no-such-id")).toBeNull();
    close();
  });

  it("listCandidates は検査実行に属する元候補を candidate_index の昇順で列挙する（ID の辞書順とは逆にして検査する）", () => {
    const { db, close } = setupDb();
    const { run, typoUnit } = setupTargets(db);

    // ID の辞書順（c-a < c-b）と candidate_index の順（c-b が 0、c-a が 1）をわざと逆にする。
    // orderBy を asc(candidates.id) に取り違えても検出できるように（A-5-1 と同じ姿勢。
    // レビュアーが実際に asc(candidates.id) へ変異させて本テストが落ちることを確認済み）。
    insertCandidate(db, {
      id: "c-a",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: null,
      candidateIndex: 1,
      llm: makeLlm({ reason: "2番目" }),
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });
    insertCandidate(db, {
      id: "c-b",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: null,
      candidateIndex: 0,
      llm: makeLlm({ reason: "1番目" }),
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });

    const listed = listCandidates(db, run.id);
    // candidate_index の昇順（c-b が 0、c-a が 1）なので id の辞書順（c-a, c-b）とは逆になる。
    expect(listed.map((c) => c.id)).toEqual(["c-b", "c-a"]);
    expect(listed.map((c) => c.llm.reason)).toEqual(["1番目", "2番目"]);
    close();
  });

  it("candidates の start / end が片方だけ null の行は読み出しで例外になる（不変条件の防御）", () => {
    const { db, close } = setupDb();
    const { run, typoUnit } = setupTargets(db);

    // insertCandidate は同一の Range から start/end を導出するため、片方だけ null の行は
    // リポジトリ経由では作れない。不変条件が壊れた行を模すため SQL で直接書き込む。
    db.run(sql`
      INSERT INTO candidates (
        id, run_id, check_unit_id, finding_id, candidate_index, llm, locate_status,
        start, end, merge_key, created_at
      ) VALUES (
        'c-broken', ${run.id}, ${typoUnit.id}, NULL, 0,
        ${JSON.stringify(makeLlm())}, 'located',
        10, NULL, NULL, ${Date.now()}
      )
    `);

    expect(() => findCandidate(db, "c-broken")).toThrow(/candidates の start \/ end/);
    expect(() => listCandidates(db, run.id)).toThrow(/candidates の start \/ end/);
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

    // 挿入の順序を逆（index 1 → index 0）にし、かつ ID の辞書順を candidate_index の順とは
    // 逆にする（candidate_index 0 の候補が "c-b"、1 の候補が "c-a"）。ID の辞書順（c-a < c-b）で
    // 並べても候補が 2 件なので偶然一致しないよう、orderBy を asc(candidates.id) に取り違えても
    // 本テストが落ちることを確認済み（レビュー対応）。
    insertCandidate(db, {
      id: "c-a",
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
      id: "c-b",
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
    // candidate_index の昇順（挿入順でも ID の辞書順でもない）。
    expect(found?.reasons).toEqual([
      { candidateId: "c-b", perspective: "typo", reason: "誤字の理由" },
      { candidateId: "c-a", perspective: "naturalness", reason: "自然さの理由" },
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

  it("findings の start / end が片方だけ null の行は読み出しで例外になる（不変条件の防御。runs.ts の run_targets と同型のテスト）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTargets(db);

    // insertFinding は Range から start/end を導出するため、片方だけ null の行はリポジトリ経由
    // では作れない。不変条件が壊れた行を模すため SQL で直接書き込む。
    db.run(sql`
      INSERT INTO findings (
        id, run_id, manuscript_version_id, target_id, locate_status,
        start, end, paragraph_id, quote, category, initial_verdict, created_at
      ) VALUES (
        'f-broken', ${run.id}, 'mv1', ${target.id}, 'located',
        10, NULL, 0, '引用', 'notation', 'likely-error', ${Date.now()}
      )
    `);

    expect(() => findFinding(db, "f-broken")).toThrow(/findings の start \/ end/);
    expect(() => listFindings(db, run.id)).toThrow(/findings の start \/ end/);
    close();
  });

  it("findings の suppression_word / suppression_rule_version が片方だけ null の行は読み出しで例外になる（不変条件の防御）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTargets(db);

    db.run(sql`
      INSERT INTO findings (
        id, run_id, manuscript_version_id, target_id, locate_status,
        start, end, paragraph_id, quote, category, initial_verdict, suppression_word, created_at
      ) VALUES (
        'f-broken-suppression', ${run.id}, 'mv1', ${target.id}, 'located',
        0, 2, 0, '引用', 'notation', 'likely-error', '許容語', ${Date.now()}
      )
    `);

    expect(() => findFinding(db, "f-broken-suppression")).toThrow(
      /findings の suppression_word \/ suppression_rule_version/,
    );
    close();
  });

  /**
   * A-6：入れ子トランザクションの検証。
   *
   * `insertFinding` / `saveUnlocatedCandidate` は内部で自分の `db.transaction` を開く。
   * 決定 16 は「1 つの検査対象分をまとめて 1 トランザクションで書く」ことを前提にしており、
   * PR9 がこれらを外側のトランザクションの中で呼ぶと入れ子になる。drizzle + better-sqlite3 の
   * 組み合わせで `db.transaction` の入れ子が SAVEPOINT として正しく振る舞うかは型では分からない
   * ため、実行時に確かめる（`saveUnlocatedCandidate` も同じ `db.transaction` の仕組みを使うので、
   * ここでは代表として `insertFinding` で検証する）。
   */
  it("入れ子トランザクション：insertFinding を外側の db.transaction から呼んでも正常に完了し、行が書かれる", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTargets(db);

    db.transaction((tx) => {
      insertFinding(tx, {
        id: "f-nested-ok",
        runId: run.id,
        manuscriptVersionId: "mv1",
        targetId: target.id,
        locateStatus: "located",
        range: { start: 0, end: 2 },
        paragraphId: 0,
        quote: "誤字",
        suggestion: null,
        category: "notation",
        initialVerdict: "likely-error",
        mergeKey: "key-nested-ok",
        suppression: null,
      });
    });

    expect(findFinding(db, "f-nested-ok")).not.toBeNull();
    const judgment = db
      .select()
      .from(judgments)
      .where(eq(judgments.findingId, "f-nested-ok"))
      .get();
    expect(judgment).toBeDefined();
    expect(judgment?.status).toBe("undecided");
    close();
  });

  it("入れ子トランザクション：外側の db.transaction が例外を投げると、内側の insertFinding が書いた行も巻き戻る（SAVEPOINT の検証）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTargets(db);

    expect(() =>
      db.transaction((tx) => {
        insertFinding(tx, {
          id: "f-nested-rollback",
          runId: run.id,
          manuscriptVersionId: "mv1",
          targetId: target.id,
          locateStatus: "located",
          range: { start: 0, end: 2 },
          paragraphId: 0,
          quote: "誤字",
          suggestion: null,
          category: "notation",
          initialVerdict: "likely-error",
          mergeKey: "key-nested-rollback",
          suppression: null,
        });
        throw new Error("外側のトランザクションで失敗");
      }),
    ).toThrow("外側のトランザクションで失敗");

    // 内側の insertFinding が書いた findings・judgments の両方が巻き戻っている。
    expect(findFinding(db, "f-nested-rollback")).toBeNull();
    const judgment = db
      .select()
      .from(judgments)
      .where(eq(judgments.findingId, "f-nested-rollback"))
      .get();
    expect(judgment).toBeUndefined();

    // 接続がロールバック後も使える（トランザクション途中で詰まっていない）ことを、
    // もう一度別の指摘を書いて確認する。
    insertFinding(db, {
      id: "f-after-rollback",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 0, end: 2 },
      paragraphId: 0,
      quote: "誤字",
      suggestion: null,
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: "key-after-rollback",
      suppression: null,
    });
    expect(findFinding(db, "f-after-rollback")).not.toBeNull();
    close();
  });

  it("updateFindingAggregate は category / initialVerdict を更新し、他の列は変えない（決定 9）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTargets(db);

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

    updateFindingAggregate(db, finding.id, {
      category: "unclear",
      initialVerdict: "confirm-with-author",
    });

    const found = findFinding(db, finding.id);
    expect(found?.category).toBe("unclear");
    expect(found?.initialVerdict).toBe("confirm-with-author");
    // category・initialVerdict 以外の列は変わらない。
    expect(found?.quote).toBe("誤字");
    expect(found?.suggestion).toBe("修正案");
    expect(found?.mergeKey).toBe("key1");
    expect(found?.range).toEqual({ start: 0, end: 2 });
    close();
  });

  it("T4b: nextCandidateIndex は 0 から始まり、候補を保存するたびに増える", () => {
    const { db, close } = setupDb();
    const { run, typoUnit } = setupTargets(db);

    expect(nextCandidateIndex(db, run.id)).toBe(0);

    insertCandidate(db, {
      id: "c0",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: null,
      candidateIndex: nextCandidateIndex(db, run.id),
      llm: makeLlm(),
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });
    expect(nextCandidateIndex(db, run.id)).toBe(1);

    insertCandidate(db, {
      id: "c1",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: null,
      candidateIndex: nextCandidateIndex(db, run.id),
      llm: makeLlm(),
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });
    expect(nextCandidateIndex(db, run.id)).toBe(2);
    close();
  });

  it("T4c: nextCandidateIndex は歯抜けの candidate_index があっても MAX+1 を返す（count(*) ではないことの固定。決定 22）", () => {
    const { db, close } = setupDb();
    const { run, typoUnit } = setupTargets(db);

    // candidate_index を 0 と 5 の2件だけにし、間（1〜4）を歯抜けにする。個別再試行などで
    // 途中の番号が別経路（別トランザクション）で使われず、まだ埋まっていないケースを模す。
    // count(*) を使う実装ならここで 2（歯抜けの件数）を返してしまうが、MAX+1 の実装なら
    // 歯抜けと無関係に 6 を返す。
    insertCandidate(db, {
      id: "c0",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: null,
      candidateIndex: 0,
      llm: makeLlm(),
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });
    insertCandidate(db, {
      id: "c5",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: null,
      candidateIndex: 5,
      llm: makeLlm(),
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });

    // 件数（2）ではなく最大値+1（6）を返す。
    expect(nextCandidateIndex(db, run.id)).toBe(6);
    close();
  });

  it("T6: ロールバックすると nextCandidateIndex が元の値に戻る（決定 22。外部カウンターを持たない理由）", () => {
    const { db, close } = setupDb();
    const { run, typoUnit } = setupTargets(db);

    insertCandidate(db, {
      id: "c0",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: null,
      candidateIndex: nextCandidateIndex(db, run.id),
      llm: makeLlm(),
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });
    expect(nextCandidateIndex(db, run.id)).toBe(1);

    expect(() =>
      db.transaction((tx) => {
        insertCandidate(tx, {
          id: "c-rollback",
          runId: run.id,
          checkUnitId: typoUnit.id,
          findingId: null,
          candidateIndex: nextCandidateIndex(tx, run.id),
          llm: makeLlm(),
          locateStatus: "outside-target",
          range: null,
          mergeKey: null,
        });
        throw new Error("外側のトランザクションで失敗");
      }),
    ).toThrow("外側のトランザクションで失敗");

    // c-rollback はロールバックされているので候補は増えておらず、次の番号は元のまま。
    expect(findCandidate(db, "c-rollback")).toBeNull();
    expect(nextCandidateIndex(db, run.id)).toBe(1);
    close();
  });

  it("T7: 実行が2つあるとき、それぞれの nextCandidateIndex が互いに影響しない（決定 22）", () => {
    const { db, close } = setupDb();
    const { run: run1, typoUnit: unit1 } = setupTargets(db);

    // 2つ目の実行を別 ID で組み立てる（setupTargets は id "r1" 固定のため）。
    const run2 = insertRun(db, {
      id: "r2",
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
    });
    const target2 = insertRunTarget(db, {
      id: "t2",
      runId: run2.id,
      targetIndex: 0,
      target: { start: 0, end: 10 },
      contextBefore: null,
      contextAfter: null,
      input: { start: 0, end: 10 },
      paragraphIds: [0],
    });
    const unit2 = insertCheckUnit(db, {
      id: "cu-r2-typo",
      runId: run2.id,
      targetId: target2.id,
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

    expect(nextCandidateIndex(db, run1.id)).toBe(0);
    expect(nextCandidateIndex(db, run2.id)).toBe(0);

    insertCandidate(db, {
      id: "c-r1-0",
      runId: run1.id,
      checkUnitId: unit1.id,
      findingId: null,
      candidateIndex: nextCandidateIndex(db, run1.id),
      llm: makeLlm(),
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });
    // run1 に候補を1件足しても run2 の採番には影響しない。
    expect(nextCandidateIndex(db, run1.id)).toBe(1);
    expect(nextCandidateIndex(db, run2.id)).toBe(0);

    insertCandidate(db, {
      id: "c-r2-0",
      runId: run2.id,
      checkUnitId: unit2.id,
      findingId: null,
      candidateIndex: nextCandidateIndex(db, run2.id),
      llm: makeLlm(),
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });
    insertCandidate(db, {
      id: "c-r2-1",
      runId: run2.id,
      checkUnitId: unit2.id,
      findingId: null,
      candidateIndex: nextCandidateIndex(db, run2.id),
      llm: makeLlm(),
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });
    expect(nextCandidateIndex(db, run2.id)).toBe(2);
    // run2 側の書き込みは run1 の採番に影響しない。
    expect(nextCandidateIndex(db, run1.id)).toBe(1);
    close();
  });

  it("listFindingsForTarget は listFindings と同じ並びを target_id で絞って返す（決定 38）", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTargets(db);
    const target2 = insertRunTarget(db, {
      id: "t2",
      runId: run.id,
      targetIndex: 1,
      target: { start: 10, end: 20 },
      contextBefore: null,
      contextAfter: null,
      input: { start: 10, end: 20 },
      paragraphIds: [1],
    });

    // t1 に位置特定失敗（start null）と位置確定済み（start 昇順の逆順で作る）を混ぜる。
    insertFinding(db, {
      id: "f-t1-located-2",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 5, end: 7 },
      paragraphId: 0,
      quote: "誤字2",
      suggestion: null,
      category: "grammar",
      initialVerdict: "confirm-with-author",
      mergeKey: null,
      suppression: null,
    });
    insertFinding(db, {
      id: "f-t1-located-1",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 0, end: 2 },
      paragraphId: 0,
      quote: "誤字1",
      suggestion: null,
      category: "grammar",
      initialVerdict: "confirm-with-author",
      mergeKey: null,
      suppression: null,
    });
    insertFinding(db, {
      id: "f-t1-unlocated",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "not-found",
      range: null,
      paragraphId: 0,
      quote: "見つからない",
      suggestion: null,
      category: "grammar",
      initialVerdict: "confirm-with-author",
      mergeKey: null,
      suppression: null,
    });
    // t2 の指摘は listFindingsForTarget(db, target.id) の結果に含まれてはならない。
    insertFinding(db, {
      id: "f-t2",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target2.id,
      locateStatus: "located",
      range: { start: 12, end: 14 },
      paragraphId: 1,
      quote: "別対象",
      suggestion: null,
      category: "grammar",
      initialVerdict: "confirm-with-author",
      mergeKey: null,
      suppression: null,
    });

    const forTarget = listFindingsForTarget(db, target.id);
    // start 昇順（0, 5）の後に start null（unlocated）が最後に来る（listFindings と同じ並び）。
    expect(forTarget.map((f) => f.id)).toEqual([
      "f-t1-located-1",
      "f-t1-located-2",
      "f-t1-unlocated",
    ]);

    // listFindings（run 全体）は対象をまたいで start 昇順に並べる。f-t2（start: 12）は
    // 非 null なので、null（f-t1-unlocated）より前、start 5 の後に来る。
    const all = listFindings(db, run.id);
    expect(all.map((f) => f.id)).toEqual([
      "f-t1-located-1",
      "f-t1-located-2",
      "f-t2",
      "f-t1-unlocated",
    ]);

    expect(listFindingsForTarget(db, target2.id).map((f) => f.id)).toEqual(["f-t2"]);
    close();
  });

  it("listFindingsForTarget: 指摘のない対象には空配列を返す", () => {
    const { db, close } = setupDb();
    const { target } = setupTargets(db);
    expect(listFindingsForTarget(db, target.id)).toEqual([]);
    close();
  });

  it("listCandidateSourcesForFinding は指摘に統合された候補を candidate_index 昇順で返し、観点を check_units から引く（決定 38）", () => {
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
      initialVerdict: "confirm-with-author",
      mergeKey: null,
      suppression: null,
    });

    // ID の辞書順（c-a < c-b）と candidate_index の順（c-b が 0、c-a が 1）をわざと逆にする
    // （`listCandidates` のテストと同じ姿勢：orderBy の取り違えを検出できるように）。
    insertCandidate(db, {
      id: "c-a",
      runId: run.id,
      checkUnitId: naturalnessUnit.id,
      findingId: finding.id,
      candidateIndex: 1,
      llm: makeLlm({ reason: "2番目・自然さ観点" }),
      locateStatus: "located",
      range: { start: 0, end: 2 },
      mergeKey: "mk",
    });
    insertCandidate(db, {
      id: "c-b",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: finding.id,
      candidateIndex: 0,
      llm: makeLlm({ reason: "1番目・誤字観点" }),
      locateStatus: "located",
      range: { start: 0, end: 2 },
      mergeKey: "mk",
    });
    // 別の指摘に属する候補は結果に含まれない。
    insertCandidate(db, {
      id: "c-other",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: null,
      candidateIndex: 2,
      llm: makeLlm({ reason: "無関係" }),
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });

    const sources = listCandidateSourcesForFinding(db, finding.id);
    expect(sources.map((s) => s.candidate.id)).toEqual(["c-b", "c-a"]);
    expect(sources.map((s) => s.perspective)).toEqual(["typo", "naturalness"]);
    expect(sources.map((s) => s.candidate.llm.reason)).toEqual([
      "1番目・誤字観点",
      "2番目・自然さ観点",
    ]);
    close();
  });

  it("C1: listFindings は飛び番・交互の candidate_index でも各指摘の reasons を昇順で返す（決定 10）", () => {
    const { db, close } = setupDb();
    const { run, target, typoUnit } = setupTargets(db);

    const findingA = insertFinding(db, {
      id: "f-a",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 0, end: 2 },
      paragraphId: 0,
      quote: "誤字A",
      suggestion: "修正案A",
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: "key-a",
      suppression: null,
    });
    const findingB = insertFinding(db, {
      id: "f-b",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 3, end: 5 },
      paragraphId: 0,
      quote: "誤字B",
      suggestion: "修正案B",
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: "key-b",
      suppression: null,
    });
    const findingC = insertFinding(db, {
      id: "f-c",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 6, end: 8 },
      paragraphId: 0,
      quote: "誤字C",
      suggestion: "修正案C",
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: "key-c",
      suppression: null,
    });

    // A に candidate_index 0・4、B に 1・2、C に 3 を与える（飛び番かつ交互）。
    // ID の辞書順を candidate_index の順とは指摘ごとに逆にする（各指摘内で "-z" が先、"-a" が後の
    // candidate_index を持つ）。orderBy を asc(candidates.id) に取り違えても、この逆転がなければ
    // 偶然一致してテストが通ってしまうため（R18b と同じ姿勢）。
    //
    // さらに、insert の順序（したがって SQLite の rowid 順）を candidate_index の昇順とは
    // 逆にする（candidate_index 4 → 3 → 2 → 1 → 0 の順で insert する）。挿入順のままだと
    // orderBy を丸ごと外す取り違えでも SQLite が偶然 rowid 順（≒挿入順）で返し、たまたま
    // candidate_index の昇順と一致して見分けられなくなるため（レビュー Minor 2）。
    insertCandidate(db, {
      id: "c-a-a",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: findingA.id,
      candidateIndex: 4,
      llm: makeLlm({ reason: "A-4" }),
      locateStatus: "located",
      range: { start: 0, end: 2 },
      mergeKey: "key-a",
    });
    insertCandidate(db, {
      id: "c-c3",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: findingC.id,
      candidateIndex: 3,
      llm: makeLlm({ reason: "C-3" }),
      locateStatus: "located",
      range: { start: 6, end: 8 },
      mergeKey: "key-c",
    });
    insertCandidate(db, {
      id: "c-b-a",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: findingB.id,
      candidateIndex: 2,
      llm: makeLlm({ reason: "B-2" }),
      locateStatus: "located",
      range: { start: 3, end: 5 },
      mergeKey: "key-b",
    });
    insertCandidate(db, {
      id: "c-b-z",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: findingB.id,
      candidateIndex: 1,
      llm: makeLlm({ reason: "B-1" }),
      locateStatus: "located",
      range: { start: 3, end: 5 },
      mergeKey: "key-b",
    });
    insertCandidate(db, {
      id: "c-a-z",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: findingA.id,
      candidateIndex: 0,
      llm: makeLlm({ reason: "A-0" }),
      locateStatus: "located",
      range: { start: 0, end: 2 },
      mergeKey: "key-a",
    });

    const listed = listFindings(db, run.id);
    const byId = new Map(listed.map((f) => [f.id, f]));

    // A は candidate_index 0 → 4 の順（c-a-z が先、c-a-a が後。ID の辞書順とは逆）。
    expect(byId.get("f-a")?.reasons.map((r) => r.candidateId)).toEqual(["c-a-z", "c-a-a"]);
    // B は 1 → 2 の順（c-b-z が先、c-b-a が後。ID の辞書順とは逆）。
    expect(byId.get("f-b")?.reasons.map((r) => r.candidateId)).toEqual(["c-b-z", "c-b-a"]);
    close();
  });

  it("C2: listFindings は観点の違う複数候補を1指摘のreasonsに正しく並べる（決定 10）", () => {
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

    insertCandidate(db, {
      id: "c-typo",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: finding.id,
      candidateIndex: 0,
      llm: makeLlm({ reason: "誤字の理由" }),
      locateStatus: "located",
      range: { start: 0, end: 2 },
      mergeKey: "key1",
    });
    insertCandidate(db, {
      id: "c-naturalness",
      runId: run.id,
      checkUnitId: naturalnessUnit.id,
      findingId: finding.id,
      candidateIndex: 1,
      llm: makeLlm({ reason: "自然さの理由" }),
      locateStatus: "located",
      range: { start: 0, end: 2 },
      mergeKey: "key1",
    });

    const listed = listFindings(db, run.id);
    expect(listed).toHaveLength(1);
    // check_units との結合が指摘単位に潰れておらず、候補ごとに正しい perspective が付く。
    expect(listed[0]?.reasons).toEqual([
      { candidateId: "c-typo", perspective: "typo", reason: "誤字の理由" },
      { candidateId: "c-naturalness", perspective: "naturalness", reason: "自然さの理由" },
    ]);
    close();
  });

  it("C3: listFindings は指摘A・Bのreasonsがそれぞれ自分の候補だけであることを完全一致で検査し、outside-targetの候補がどちらにも混ざらない（決定 2・10）", () => {
    const { db, close } = setupDb();
    const { run, target, typoUnit } = setupTargets(db);

    const findingA = insertFinding(db, {
      id: "f-a",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 0, end: 2 },
      paragraphId: 0,
      quote: "誤字A",
      suggestion: "修正案A",
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: "key-a",
      suppression: null,
    });
    const findingB = insertFinding(db, {
      id: "f-b",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 3, end: 5 },
      paragraphId: 0,
      quote: "誤字B",
      suggestion: "修正案B",
      category: "notation",
      initialVerdict: "likely-error",
      mergeKey: "key-b",
      suppression: null,
    });

    insertCandidate(db, {
      id: "c-a0",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: findingA.id,
      candidateIndex: 0,
      llm: makeLlm({ reason: "Aの理由" }),
      locateStatus: "located",
      range: { start: 0, end: 2 },
      mergeKey: "key-a",
    });
    insertCandidate(db, {
      id: "c-b1",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: findingB.id,
      candidateIndex: 1,
      llm: makeLlm({ reason: "Bの理由" }),
      locateStatus: "located",
      range: { start: 3, end: 5 },
      mergeKey: "key-b",
    });
    // outside-target（finding_id が null）の候補を同じ実行に混ぜる。
    insertCandidate(db, {
      id: "c-outside",
      runId: run.id,
      checkUnitId: typoUnit.id,
      findingId: null,
      candidateIndex: 2,
      llm: makeLlm({ reason: "統合先の無い理由" }),
      locateStatus: "outside-target",
      range: null,
      mergeKey: null,
    });

    const listed = listFindings(db, run.id);
    const byId = new Map(listed.map((f) => [f.id, f]));

    // A の reasons は A のものだけ、B の reasons は B のものだけ（完全一致）。
    expect(byId.get("f-a")?.reasons).toEqual([
      { candidateId: "c-a0", perspective: "typo", reason: "Aの理由" },
    ]);
    expect(byId.get("f-b")?.reasons).toEqual([
      { candidateId: "c-b1", perspective: "typo", reason: "Bの理由" },
    ]);
    close();
  });

  it("listCandidateSourcesForFinding: 候補のない指摘には空配列を返す", () => {
    const { db, close } = setupDb();
    const { run, target } = setupTargets(db);
    const finding = insertFinding(db, {
      id: "f-empty",
      runId: run.id,
      manuscriptVersionId: "mv1",
      targetId: target.id,
      locateStatus: "located",
      range: { start: 0, end: 2 },
      paragraphId: 0,
      quote: "誤字",
      suggestion: null,
      category: "grammar",
      initialVerdict: "confirm-with-author",
      mergeKey: null,
      suppression: null,
    });
    expect(listCandidateSourcesForFinding(db, finding.id)).toEqual([]);
    close();
  });
});
