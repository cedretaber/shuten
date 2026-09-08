import type { LlmFinding, LocatedCandidate, Range } from "@shuten/shared";
import { mergeCandidates, splitParagraphs } from "@shuten/shared";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db/client.ts";
import { applyMigrations } from "../db/migrate.ts";
import { insertCheckUnit } from "../db/repositories/check-units.ts";
import {
  findFinding,
  listCandidates,
  listCandidatesForFinding,
  listFindings,
} from "../db/repositories/findings.ts";
import { findJudgment, listJudgments, setJudgment } from "../db/repositories/judgments.ts";
import { insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { insertRun, insertRunTarget } from "../db/repositories/runs.ts";
import { type MergeCandidateInput, mergeCandidateIntoRun } from "./merge-store.ts";
import { PersistBoundaryError } from "./persist.ts";

// 単一段落（改行なし）の本文。範囲 [0,2)/[2,4)/[4,6)/[6,8)/[8,10)/[10,14) を候補の引用に使う。
const BODY = "あいうえおかきくけこAねこB";
const PARAGRAPHS = splitParagraphs(BODY);

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

/** `findings` / `candidates` の外部キー先を 1 実行ぶんだけ作る。 */
function setupRun(
  db: ReturnType<typeof setupDb>["db"],
  runId: string,
  targetId: string,
  checkUnitId: string,
) {
  const run = insertRun(db, {
    id: runId,
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
    id: targetId,
    runId: run.id,
    targetIndex: 0,
    target: { start: 0, end: BODY.length },
    contextBefore: null,
    contextAfter: null,
    input: { start: 0, end: BODY.length },
    paragraphIds: [0],
  });
  const checkUnit = insertCheckUnit(db, {
    id: checkUnitId,
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
  return { run, target, checkUnit };
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

/** `range` から本文の引用を取り出した `LocatedCandidate` を組み立てる。 */
function makeCandidate(
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

/** `mergeCandidateIntoRun` の共通入力を組み立てる（`candidate` と `candidateIndex` だけ都度変える）。 */
function makeInput(
  base: { readonly runId: string; readonly targetId: string; readonly checkUnitId: string },
  candidate: LocatedCandidate,
  candidateIndex: number,
  overrides: Partial<MergeCandidateInput> = {},
): MergeCandidateInput {
  return {
    runId: base.runId,
    manuscriptVersionId: "mv1",
    targetId: base.targetId,
    checkUnitId: base.checkUnitId,
    candidateIndex,
    candidate,
    paragraphId: 0,
    allowedWords: [],
    now: new Date("2026-09-09T00:00:00.000Z"),
    body: BODY,
    paragraphs: PARAGRAPHS,
    ...overrides,
  };
}

describe("run/merge-store", () => {
  it("M1: オラクル：一括統合（mergeCandidates）と1件ずつの統合（mergeCandidateIntoRun）でグルーピング・category・initialVerdictが一致する", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const { run, target, checkUnit } = setupRun(db, "r1", "t1", "cu1");
    const base = { runId: run.id, targetId: target.id, checkUnitId: checkUnit.id };

    // G1: 同じ mergeKey が3件（category・verdict とも一致 → 素直に1指摘へ統合）。
    const g1a = makeCandidate(
      "g1a",
      { start: 0, end: 2 },
      { category: "particle", suggestion: "訂正1" },
    );
    const g1b = makeCandidate(
      "g1b",
      { start: 0, end: 2 },
      { category: "particle", suggestion: "訂正1" },
    );
    const g1c = makeCandidate(
      "g1c",
      { start: 0, end: 2 },
      { category: "particle", suggestion: "訂正1" },
    );
    // G2: 同じ mergeKey だが category が食い違う（→ unclear になる）。verdict は揃えて category だけを見る。
    const g2a = makeCandidate(
      "g2a",
      { start: 2, end: 4 },
      { category: "notation", suggestion: "訂正2" },
    );
    const g2b = makeCandidate(
      "g2b",
      { start: 2, end: 4 },
      { category: "grammar", suggestion: "訂正2" },
    );
    // G3: 同じ mergeKey だが verdict が食い違う（→ confirm-with-author になる）。category は揃える。
    const g3a = makeCandidate(
      "g3a",
      { start: 4, end: 6 },
      {
        category: "context-misuse",
        suggestion: "訂正3",
        verdict: "likely-error",
      },
    );
    const g3b = makeCandidate(
      "g3b",
      { start: 4, end: 6 },
      {
        category: "context-misuse",
        suggestion: "訂正3",
        verdict: "confirm-with-author",
      },
    );
    // G4: 修正案なし（mergeKey が null）が2件。互いに統合されず、常に別の指摘になる。
    const g4a = makeCandidate(
      "g4a",
      { start: 6, end: 8 },
      { category: "notation", suggestion: null },
    );
    const g4b = makeCandidate(
      "g4b",
      { start: 8, end: 10 },
      { category: "grammar", suggestion: null },
    );

    // 到着順をわざとグループ横断で混ぜる（統合が到着順に依存しないことも兼ねて検査する）。
    const located: readonly LocatedCandidate[] = [g1a, g2a, g3a, g4a, g1b, g2b, g3b, g4b, g1c];

    // (a) 一括統合。
    let idCounter = 0;
    const merged = mergeCandidates(located, () => `merged-${idCounter++}`);

    // (b) 1件ずつ統合し、DB から読み直す。
    const results = located.map((candidate, index) =>
      mergeCandidateIntoRun(db, makeInput(base, candidate, index)),
    );

    type Group = {
      readonly memberIds: readonly string[];
      readonly category: string;
      readonly initialVerdict: string;
    };

    const canonical = (groups: readonly Group[]) =>
      groups
        .map((g) => ({ ...g, memberIds: [...g.memberIds].sort() }))
        .sort((x, y) => x.memberIds.join(",").localeCompare(y.memberIds.join(",")));

    const aGroups: Group[] = merged.map((m) => ({
      memberIds: m.sources.map((s) => s.id),
      category: m.category,
      initialVerdict: m.verdict,
    }));

    const findingIds = [...new Set(results.map((r) => r.finding.id))];
    const bGroups: Group[] = findingIds.map((findingId) => {
      const members = listCandidatesForFinding(db, findingId);
      const finding = findFinding(db, findingId);
      if (finding === null) {
        throw new Error(`統合先の指摘が見つかりません（id: ${findingId}）`);
      }
      return {
        memberIds: members.map((c) => c.id),
        category: finding.category,
        initialVerdict: finding.initialVerdict,
      };
    });

    expect(canonical(bGroups)).toEqual(canonical(aGroups));
    // グループ数（5：G1, G2, G3, G4a, G4b）も一致することを明示的に確認する。
    expect(bGroups).toHaveLength(5);
    expect(aGroups).toHaveLength(5);
    close();
  });

  it("M2: 修正案なし（mergeKey が null）の候補は常に別の指摘になる", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const { run, target, checkUnit } = setupRun(db, "r1", "t1", "cu1");
    const base = { runId: run.id, targetId: target.id, checkUnitId: checkUnit.id };

    // range・quote・category・verdict まで完全に同じでも、suggestion が null なら統合しない。
    const c1 = makeCandidate("c1", { start: 0, end: 2 }, { suggestion: null });
    const c2 = makeCandidate("c2", { start: 0, end: 2 }, { suggestion: null });

    const r1 = mergeCandidateIntoRun(db, makeInput(base, c1, 0));
    const r2 = mergeCandidateIntoRun(db, makeInput(base, c2, 1));

    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(r1.finding.id).not.toBe(r2.finding.id);
    expect(listCandidatesForFinding(db, r1.finding.id)).toHaveLength(1);
    expect(listCandidatesForFinding(db, r2.finding.id)).toHaveLength(1);
    close();
  });

  it("M3: 実行 ID が違う同じ mergeKey の候補は統合されない", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const runA = setupRun(db, "rA", "tA", "cuA");
    const runB = setupRun(db, "rB", "tB", "cuB");

    // 2つの実行に、range・quote・suggestion まで完全に同じ候補を1件ずつ投入する。
    const candidateA = makeCandidate("ca", { start: 0, end: 2 }, { suggestion: "同じ修正案" });
    const candidateB = makeCandidate("cb", { start: 0, end: 2 }, { suggestion: "同じ修正案" });

    const resultA = mergeCandidateIntoRun(
      db,
      makeInput(
        { runId: runA.run.id, targetId: runA.target.id, checkUnitId: runA.checkUnit.id },
        candidateA,
        0,
      ),
    );
    const resultB = mergeCandidateIntoRun(
      db,
      makeInput(
        { runId: runB.run.id, targetId: runB.target.id, checkUnitId: runB.checkUnit.id },
        candidateB,
        0,
      ),
    );

    expect(resultA.created).toBe(true);
    expect(resultB.created).toBe(true);
    expect(resultA.finding.id).not.toBe(resultB.finding.id);
    expect(resultA.finding.runId).toBe("rA");
    expect(resultB.finding.runId).toBe("rB");
    close();
  });

  it("M4: 既存指摘に候補を足しても judgments の行は増えず、内容も変わらない", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const { run, target, checkUnit } = setupRun(db, "r1", "t1", "cu1");
    const base = { runId: run.id, targetId: target.id, checkUnitId: checkUnit.id };

    const c1 = makeCandidate(
      "c1",
      { start: 0, end: 2 },
      { category: "notation", suggestion: "訂正" },
    );
    const first = mergeCandidateIntoRun(db, makeInput(base, c1, 0));
    expect(first.created).toBe(true);

    // 作者が実際に採否を記録した状態を作る（仕様 5.4「再確認や統合は作者の採否を上書きしない」）。
    // 統合のたびに judgments 行を undecided に初期化し直すバグは、行が最初から undecided の
    // ままだと（1回目の insertFinding が作る初期値と区別が付かず）検出できない。加えて
    // updatedAt も 1 回目の insertFinding と別の値にし、「同じ Date で上書きし直す」バグも検出する。
    setJudgment(db, first.finding.id, {
      status: "adopt-planned",
      note: "作者のメモ",
      updatedAt: new Date("2026-09-09T01:00:00.000Z"),
    });
    const before = findJudgment(db, first.finding.id);
    expect(before).toEqual({
      findingId: first.finding.id,
      status: "adopt-planned",
      note: "作者のメモ",
      updatedAt: new Date("2026-09-09T01:00:00.000Z"),
    });

    // 同じ mergeKey・category が食い違う候補を追加する（集約は変わるが judgments には触れない）。
    // now も 1 回目と別の値にする（同じ固定 Date だと初期化し直すバグと偶然一致しうるため）。
    const c2 = makeCandidate(
      "c2",
      { start: 0, end: 2 },
      { category: "grammar", suggestion: "訂正" },
    );
    const second = mergeCandidateIntoRun(
      db,
      makeInput(base, c2, 1, { now: new Date("2026-09-09T02:00:00.000Z") }),
    );
    expect(second.created).toBe(false);
    expect(second.finding.id).toBe(first.finding.id);
    // 集約は実際に変わっている（category が unclear になる）ことを確認し、
    // それでも judgments が変わらないことに意味を持たせる。
    expect(second.finding.category).toBe("unclear");

    const after = findJudgment(db, first.finding.id);
    expect(after).toEqual(before);
    expect(after?.status).toBe("adopt-planned");
    expect(after?.note).toBe("作者のメモ");
    expect(after?.updatedAt).toEqual(new Date("2026-09-09T01:00:00.000Z"));
    expect(listJudgments(db, run.id)).toHaveLength(1);
    close();
  });

  it("M5: 呼び出し元が db.transaction で包んでロールバックすると、指摘・候補・判断のいずれも残らない", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const { run, target, checkUnit } = setupRun(db, "r1", "t1", "cu1");
    const base = { runId: run.id, targetId: target.id, checkUnitId: checkUnit.id };
    const c1 = makeCandidate("c1", { start: 0, end: 2 }, { suggestion: "訂正" });

    expect(() => {
      db.transaction((tx) => {
        mergeCandidateIntoRun(tx, makeInput(base, c1, 0));
        throw new Error("わざとロールバックする");
      });
    }).toThrow("わざとロールバックする");

    expect(listFindings(db, run.id)).toHaveLength(0);
    expect(listCandidates(db, run.id)).toHaveLength(0);
    expect(listJudgments(db, run.id)).toHaveLength(0);
    close();
  });

  it("新規指摘の作成時：paragraphId が range から導いた値と食い違うと PersistBoundaryError になり、何も書き込まれない", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const { run, target, checkUnit } = setupRun(db, "r1", "t1", "cu1");
    const base = { runId: run.id, targetId: target.id, checkUnitId: checkUnit.id };

    // BODY は単一段落（id 0）。range.start = 0 から導かれる段落 ID は 0 なので、99 は明らかに食い違う。
    const c1 = makeCandidate("c1", { start: 0, end: 2 }, { suggestion: "訂正" });
    expect(() => mergeCandidateIntoRun(db, makeInput(base, c1, 0, { paragraphId: 99 }))).toThrow(
      PersistBoundaryError,
    );

    expect(listFindings(db, run.id)).toHaveLength(0);
    expect(listCandidates(db, run.id)).toHaveLength(0);
    close();
  });

  it("既存指摘への統合時：paragraphId が食い違うと PersistBoundaryError になり、候補は書き込まれない（検査 → 書き込みの順序を守る）", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const { run, target, checkUnit } = setupRun(db, "r1", "t1", "cu1");
    const base = { runId: run.id, targetId: target.id, checkUnitId: checkUnit.id };

    const c1 = makeCandidate(
      "c1",
      { start: 0, end: 2 },
      { category: "notation", suggestion: "訂正" },
    );
    const first = mergeCandidateIntoRun(db, makeInput(base, c1, 0));
    expect(first.created).toBe(true);
    expect(listCandidatesForFinding(db, first.finding.id)).toHaveLength(1);

    // 同じ mergeKey（range・quote・suggestion 完全一致）だが paragraphId だけ間違えて渡す。
    // insertCandidate → assertFindingBoundary の順（検査より先に書き込む）だと、この検査は
    // 例外発生後に候補が既に書き込まれた状態を見逃す。検査 → 書き込みの順を守っていれば、
    // 例外発生時に候補は書き込まれない。
    const c2 = makeCandidate(
      "c2",
      { start: 0, end: 2 },
      { category: "notation", suggestion: "訂正" },
    );
    expect(() => mergeCandidateIntoRun(db, makeInput(base, c2, 1, { paragraphId: 99 }))).toThrow(
      PersistBoundaryError,
    );

    const members = listCandidatesForFinding(db, first.finding.id);
    expect(members).toHaveLength(1);
    expect(members.map((c) => c.id)).toEqual(["c1"]);
    close();
  });

  it("統合後に category が notation から外れると、既に適用した抑制が解除される（DB にも反映される）", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const { run, target, checkUnit } = setupRun(db, "r1", "t1", "cu1");
    const base = { runId: run.id, targetId: target.id, checkUnitId: checkUnit.id };
    // "AねこB" 相当の範囲。"ねこ" を許容語として登録し、"AイヌB" への置き換えで抑制が掛かる。
    const range = { start: 10, end: 14 };
    expect(BODY.slice(range.start, range.end)).toBe("AねこB");

    const suppressed = makeCandidate("s1", range, {
      category: "notation",
      suggestion: "AイヌB",
    });
    const first = mergeCandidateIntoRun(
      db,
      makeInput(base, suppressed, 0, { allowedWords: ["ねこ"] }),
    );
    expect(first.finding.suppression).toEqual({ word: "ねこ", ruleVersion: expect.any(String) });

    // 同じ mergeKey（range・quote・suggestion が同一）だが category が違う候補を追加する。
    const disagreeing = makeCandidate("s2", range, { category: "grammar", suggestion: "AイヌB" });
    const second = mergeCandidateIntoRun(
      db,
      makeInput(base, disagreeing, 1, { allowedWords: ["ねこ"] }),
    );

    expect(second.finding.category).toBe("unclear");
    expect(second.finding.suppression).toBeNull();
    const persisted = findFinding(db, first.finding.id);
    expect(persisted?.suppression).toBeNull();
    close();
  });

  it("到着順が逆でも最終的な抑制の有無は一致する（順序非依存）", () => {
    const { db, close } = setupDb();
    insertManuscriptVersion(db, { id: "mv1", name: "原稿", body: BODY });
    const { run, target, checkUnit } = setupRun(db, "r1", "t1", "cu1");
    const base = { runId: run.id, targetId: target.id, checkUnitId: checkUnit.id };
    const range = { start: 10, end: 14 };

    const disagreeing = makeCandidate("s2", range, { category: "grammar", suggestion: "AイヌB" });
    const suppressible = makeCandidate("s1", range, { category: "notation", suggestion: "AイヌB" });

    const first = mergeCandidateIntoRun(
      db,
      makeInput(base, disagreeing, 0, { allowedWords: ["ねこ"] }),
    );
    expect(first.finding.category).toBe("grammar");
    expect(first.finding.suppression).toBeNull();

    const second = mergeCandidateIntoRun(
      db,
      makeInput(base, suppressible, 1, { allowedWords: ["ねこ"] }),
    );
    expect(second.finding.category).toBe("unclear");
    expect(second.finding.suppression).toBeNull();
    close();
  });
});
