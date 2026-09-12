import { buildRunExport } from "@shuten/server/api/run-export.ts";
import { createDatabase } from "@shuten/server/db/client.ts";
import { applyMigrations } from "@shuten/server/db/migrate.ts";
import { findCheckUnit, insertCheckUnit } from "@shuten/server/db/repositories/check-units.ts";
import { listFindings } from "@shuten/server/db/repositories/findings.ts";
import { insertManuscriptVersion } from "@shuten/server/db/repositories/manuscripts.ts";
import {
  findRecheckUnitByFinding,
  insertRecheckUnit,
} from "@shuten/server/db/repositories/rechecks.ts";
import {
  findRun,
  finishRun,
  insertRun,
  insertRunTarget,
} from "@shuten/server/db/repositories/runs.ts";
import { hashBody } from "@shuten/server/hash.ts";
import type { PipelineResult } from "@shuten/server/run/result.ts";
import { saveCheckUnitOutcome, saveRecheckOutcome } from "@shuten/server/run/save.ts";
import { claimRecheckUnitChecked, claimUnitChecked } from "@shuten/server/run/transitions.ts";
import type { CheckUnitOutcome, RecheckUnitOutcome } from "@shuten/server/run/units.ts";
import {
  ALLOWED_WORD_RULE_VERSION,
  type LlmFinding,
  type LocatedCandidate,
  type Range,
  type RunExportDto,
  splitParagraphs,
  type UnlocatedCandidate,
} from "@shuten/shared";
import { describe, expect, it } from "vitest";

import { checkRunConditions } from "./aggregate.ts";
import { adaptExportToResult, parseExportJson } from "./export-adapter.ts";
import { scoreRun } from "./score.ts";
import type { ResolvedTruthEntry } from "./truth.ts";

// すべて合成の値（実原稿・実行結果の断片を含まない）。

/**
 * 最小構成の有効なエクスポート JSON（`RunExportDto`）。`targets` / `checkUnits` / `findings` /
 * `unlocatedCandidates` / `unlocatedDiagnostics` はすべて空。`parseExportJson` が
 * `runExportDtoSchema`（形の正本）をそのまま使っていることの確認が目的で、写像
 * （`adaptExportToResult`）は別ファイルで検証する。
 */
function validExportJson(): RunExportDto {
  return {
    formatVersion: "1",
    exportedAt: "2026-01-01T00:00:00.000Z",
    run: {
      id: "r1",
      manuscriptVersionId: "mv1",
      modelId: "model-a",
      modelInfo: null,
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
      recheckEnabled: true,
      allowedWords: [],
      allowedWordRuleVersion: "1",
      promptVersion: "1",
      diagnosticTransformVersion: "1",
      status: "completed",
      stopReason: null,
      stopMessage: null,
      generationUnconfirmed: false,
      stopRequestedAt: null,
      recoveryConfirmedAt: null,
      recoveryConfirmMs: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
    },
    manuscript: {
      id: "mv1",
      name: "原稿",
      body: "あいうえお",
      bodyHash: "a".repeat(64),
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    targets: [],
    checkUnits: [],
    recheckUnits: [],
    findings: [],
    unlocatedCandidates: [],
    unlocatedDiagnostics: [],
  };
}

describe("export-adapter: parseExportJson", () => {
  it("runExportDtoSchema を満たす値をそのまま受け入れる", () => {
    const json = validExportJson();

    const result = parseExportJson(json);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(json);
    }
  });

  it("必須項目が欠けていれば拒否する", () => {
    const json = validExportJson() as unknown as Record<string, unknown>;
    delete json.manuscript;

    const result = parseExportJson(json);

    expect(result.ok).toBe(false);
  });

  it("`.strict()` により未知のキーを持つ値を拒否する（余分なキーを黙って落とさない）", () => {
    const json = { ...validExportJson(), endpointUrl: "http://127.0.0.1:1234" };

    const result = parseExportJson(json);

    expect(result.ok).toBe(false);
  });

  it("エラーメッセージに path と code だけを含み、値そのものは含めない", () => {
    const json = { ...validExportJson(), formatVersion: "2" };

    const result = parseExportJson(json);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((message) => message.startsWith("formatVersion: "))).toBe(true);
      expect(result.errors.join(" ")).not.toContain("2");
    }
  });
});

// --- adaptExportToResult：組み立てヘルパー（T23・T25・T26 共通） -------------------------------

/** T23・T25・T26 で使う合成本文。実原稿は使わない。 */
const REJECT_BODY = "あいうえお";

type RunDto = RunExportDto["run"];
type ManuscriptDto = RunExportDto["manuscript"];
type TargetDto = RunExportDto["targets"][number];
type CheckUnitDto = RunExportDto["checkUnits"][number];
type RecheckUnitDto = RunExportDto["recheckUnits"][number];
type FindingDetailDto = RunExportDto["findings"][number];
type CandidateDto = RunExportDto["unlocatedCandidates"][number];
type DiagnosticDto = RunExportDto["unlocatedDiagnostics"][number];
type JudgmentDto = FindingDetailDto["judgment"];

function makeRun(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: "r1",
    manuscriptVersionId: "mv1",
    modelId: "model-a",
    modelInfo: null,
    generationSettings: { maxTokens: 512, temperature: 0 },
    chunkSettings: {
      targetGraphemes: 1500,
      contextGraphemes: 1000,
      recheckContextGraphemes: 3000,
      roundingTolerance: 0.2,
      maxInputGraphemes: 8000,
    },
    timeouts: { checkMs: 60_000, recheckMs: 60_000 },
    perspectives: ["typo"],
    recheckEnabled: true,
    allowedWords: [],
    allowedWordRuleVersion: "1",
    promptVersion: "1",
    diagnosticTransformVersion: "1",
    status: "completed",
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    stopRequestedAt: null,
    recoveryConfirmedAt: null,
    recoveryConfirmMs: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

function makeManuscript(overrides: Partial<ManuscriptDto> = {}): ManuscriptDto {
  return {
    id: "mv1",
    name: "原稿",
    body: REJECT_BODY,
    bodyHash: hashBody(REJECT_BODY),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTarget(overrides: Partial<TargetDto> = {}): TargetDto {
  return {
    id: "t1",
    targetIndex: 0,
    target: { start: 0, end: 5 },
    contextBefore: null,
    contextAfter: null,
    input: { start: 0, end: 5 },
    paragraphIds: [0],
    ...overrides,
  };
}

function makeCheckUnit(overrides: Partial<CheckUnitDto> = {}): CheckUnitDto {
  return {
    id: "cu1",
    targetId: "t1",
    targetIndex: 0,
    perspective: "typo",
    status: "done",
    attempts: 1,
    failure: null,
    pendingNote: null,
    elapsedMs: 10,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeRecheckUnit(overrides: Partial<RecheckUnitDto> = {}): RecheckUnitDto {
  return {
    id: "rc1",
    findingId: "f1",
    inputRange: { start: 0, end: 2 },
    status: "done",
    notApplicableReason: null,
    attempts: 1,
    failure: null,
    pendingNote: null,
    verdict: "keep",
    reasonKind: "error-confirmed",
    reason: "検討の結果、指摘は妥当",
    suggestionValid: true,
    elapsedMs: 10,
    startedAt: null,
    finishedAt: "2026-01-01T00:00:30.000Z",
    ...overrides,
  };
}

function makeLlm(overrides: Partial<LlmFinding> = {}): LlmFinding {
  return {
    paragraphId: 0,
    quote: "あい",
    before: "",
    after: "うえ",
    category: "notation",
    reason: "理由",
    suggestion: "あい(訂正)",
    verdict: "likely-error",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<CandidateDto> = {}): CandidateDto {
  return {
    id: "c1",
    checkUnitId: "cu1",
    perspective: "typo",
    candidateIndex: 0,
    llm: makeLlm(),
    locateStatus: "located",
    range: { start: 0, end: 2 },
    ...overrides,
  };
}

function makeDiagnostic(overrides: Partial<DiagnosticDto> = {}): DiagnosticDto {
  return {
    candidateId: "c1",
    quote: "あい",
    reason: "not-found",
    searchRange: { start: 0, end: 5 },
    exactMatches: [],
    transformVersion: null,
    transformCandidates: null,
    omitted: null,
    tied: null,
    ...overrides,
  };
}

function makeJudgment(overrides: Partial<JudgmentDto> = {}): JudgmentDto {
  return {
    findingId: "f1",
    status: "undecided",
    note: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeFindingDetail(overrides: Partial<FindingDetailDto> = {}): FindingDetailDto {
  return {
    id: "f1",
    runId: "r1",
    targetId: "t1",
    locateStatus: "located",
    range: { start: 0, end: 2 },
    paragraphId: 0,
    quote: "あい",
    suggestion: "あい(訂正)",
    category: "notation",
    initialVerdict: "likely-error",
    suppression: null,
    reasons: [],
    recheck: null,
    judgment: makeJudgment(),
    createdAt: "2026-01-01T00:00:00.000Z",
    candidates: [makeCandidate()],
    diagnostics: [],
    ...overrides,
  };
}

/**
 * 「素直に受理される」最小のエクスポート。located の指摘 f1（候補 c1・再確認単位 rc1）だけを持つ。
 * T23 の各ケースはここから 1 か所だけを崩す。
 */
function makeValidExport(overrides: Partial<RunExportDto> = {}): RunExportDto {
  return {
    formatVersion: "1",
    exportedAt: "2026-01-01T00:02:00.000Z",
    run: makeRun(),
    manuscript: makeManuscript(),
    targets: [makeTarget()],
    checkUnits: [makeCheckUnit()],
    recheckUnits: [makeRecheckUnit()],
    findings: [makeFindingDetail()],
    unlocatedCandidates: [],
    unlocatedDiagnostics: [],
    ...overrides,
  };
}

/** エラー文言にパス・接続先・原稿の断片が出ないことを確かめる（決定 9・30 の共通検査）。 */
function assertNoLeakedContent(errors: readonly string[]): void {
  const joined = errors.join(" ");
  expect(joined).not.toContain(REJECT_BODY);
  expect(joined).not.toContain("http://");
  expect(joined).not.toContain(".json");
}

describe("export-adapter: adaptExportToResult（T23：決定 30 の拒否。19 例 + 決定 32 の追加 2 例）", () => {
  it("素直な最小構成は受理される（以下の拒否ケースの基準）", () => {
    const result = adaptExportToResult(makeValidExport());
    expect(result.ok).toBe(true);
  });

  it("1. run.status が完走していない（running）", () => {
    const result = adaptExportToResult(makeValidExport({ run: makeRun({ status: "running" }) }));
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("2. run.finishedAt が null", () => {
    const result = adaptExportToResult(makeValidExport({ run: makeRun({ finishedAt: null }) }));
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("3. run.stopReason が backend-restarted", () => {
    const result = adaptExportToResult(
      makeValidExport({
        run: makeRun({ status: "stopped", stopReason: "backend-restarted", stopMessage: "停止" }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("4. 検査単位に running がある", () => {
    const result = adaptExportToResult(
      makeValidExport({ checkUnits: [makeCheckUnit({ status: "running" })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("5. 再確認単位に running がある", () => {
    const result = adaptExportToResult(
      makeValidExport({
        recheckUnits: [
          makeRecheckUnit({
            status: "running",
            verdict: null,
            reasonKind: null,
            reason: null,
            suggestionValid: null,
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("6. status: done の再確認で 4 項目のいずれかが null（reason）", () => {
    const result = adaptExportToResult(
      makeValidExport({ recheckUnits: [makeRecheckUnit({ reason: null })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("7. located の指摘の range が null", () => {
    const result = adaptExportToResult(
      makeValidExport({ findings: [makeFindingDetail({ range: null })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("8. hashBody(manuscript.body) !== manuscript.bodyHash", () => {
    const result = adaptExportToResult(
      makeValidExport({ manuscript: makeManuscript({ bodyHash: "0".repeat(64) }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("9. 参照先が見つからない（finding.targetId が targets のどれとも一致しない）", () => {
    const result = adaptExportToResult(
      makeValidExport({ findings: [makeFindingDetail({ targetId: "missing-target" })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("10. completed なのに stopReason が非 null", () => {
    const result = adaptExportToResult(
      makeValidExport({ run: makeRun({ stopReason: "aborted" }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("11. stopped なのに stopReason が null", () => {
    const result = adaptExportToResult(
      makeValidExport({
        run: makeRun({ status: "stopped", stopReason: null, stopMessage: "停止" }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("12a. not-found/ambiguous の指摘の候補が 0 件", () => {
    const result = adaptExportToResult(
      makeValidExport({
        recheckUnits: [],
        findings: [makeFindingDetail({ locateStatus: "not-found", range: null, candidates: [] })],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("12b. not-found/ambiguous の指摘の候補が 2 件以上", () => {
    const result = adaptExportToResult(
      makeValidExport({
        recheckUnits: [],
        findings: [
          makeFindingDetail({
            locateStatus: "not-found",
            range: null,
            candidates: [
              makeCandidate({ id: "c1", locateStatus: "not-found", range: null }),
              makeCandidate({ id: "c1b", locateStatus: "not-found", range: null }),
            ],
            diagnostics: [
              makeDiagnostic({ candidateId: "c1", reason: "not-found" }),
              makeDiagnostic({ candidateId: "c1b", reason: "not-found" }),
            ],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("13. 指摘と候補の locateStatus が食い違う", () => {
    const result = adaptExportToResult(
      makeValidExport({
        recheckUnits: [],
        findings: [
          makeFindingDetail({
            locateStatus: "not-found",
            range: null,
            candidates: [makeCandidate({ locateStatus: "ambiguous", range: null })],
            diagnostics: [makeDiagnostic({ reason: "ambiguous" })],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("14. 位置未確定の候補に対応する診断が無い", () => {
    const result = adaptExportToResult(
      makeValidExport({
        recheckUnits: [],
        findings: [
          makeFindingDetail({
            locateStatus: "not-found",
            range: null,
            candidates: [makeCandidate({ locateStatus: "not-found", range: null })],
            diagnostics: [],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("15. 同じ候補を指す診断が 2 行以上ある", () => {
    const result = adaptExportToResult(
      makeValidExport({
        recheckUnits: [],
        findings: [
          makeFindingDetail({
            locateStatus: "not-found",
            range: null,
            candidates: [makeCandidate({ locateStatus: "not-found", range: null })],
            diagnostics: [
              makeDiagnostic({ reason: "not-found" }),
              makeDiagnostic({ reason: "not-found" }),
            ],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("16. どの候補にも紐づかない診断がある", () => {
    const result = adaptExportToResult(
      makeValidExport({
        findings: [
          makeFindingDetail({ diagnostics: [makeDiagnostic({ candidateId: "ghost-candidate" })] }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("17a. located の指摘に候補が 0 件", () => {
    const result = adaptExportToResult(
      makeValidExport({ findings: [makeFindingDetail({ candidates: [] })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("17b. located の指摘に located でない候補が混じる", () => {
    const result = adaptExportToResult(
      makeValidExport({
        findings: [
          makeFindingDetail({
            candidates: [makeCandidate({ locateStatus: "not-found", range: null })],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("18（決定 32 の追加）. どの指摘にも紐づかない再確認単位がある", () => {
    const result = adaptExportToResult(
      makeValidExport({ recheckUnits: [makeRecheckUnit({ findingId: "ghost-finding" })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("19（決定 32 の追加）. 同じ指摘を指す再確認単位が 2 つ以上ある", () => {
    const result = adaptExportToResult(
      makeValidExport({
        recheckUnits: [makeRecheckUnit({ id: "rc1" }), makeRecheckUnit({ id: "rc2" })],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) assertNoLeakedContent(result.errors);
  });

  it("複数の違反を 1 つのエクスポートに入れると、すべて列挙される（段をまたぐ組み合わせ）", () => {
    // 本文ハッシュ（manuscript 段）・検査単位（checkUnits 段）・指摘の候補（findings 段）の
    // 3 段にまたがる違反を同時に入れる。早期打ち切りがあれば 1 件しか出ない。
    const result = adaptExportToResult(
      makeValidExport({
        manuscript: makeManuscript({ bodyHash: "0".repeat(64) }),
        checkUnits: [makeCheckUnit({ status: "running" })],
        findings: [
          makeFindingDetail({
            candidates: [makeCandidate({ locateStatus: "not-found", range: null })],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    assertNoLeakedContent(result.errors);
  });
});

describe("export-adapter: adaptExportToResult（T25：決定 31 の実効上限）", () => {
  /** timeouts / recoveryConfirmMs 以外は共通の最小構成（findings も無し）。 */
  function makeTimeoutExport(checkMs: number, recoveryConfirmMs: number): RunExportDto {
    return makeValidExport({
      run: makeRun({ timeouts: { checkMs, recheckMs: checkMs }, recoveryConfirmMs }),
      checkUnits: [],
      recheckUnits: [],
      findings: [],
    });
  }

  it("実効上限が等しい組（60,000/0 と 30,000/30,000）は条件一致として通る", () => {
    const a = adaptExportToResult(makeTimeoutExport(60_000, 0));
    const b = adaptExportToResult(makeTimeoutExport(30_000, 30_000));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.value.conditions.timeouts).toEqual({ checkMs: 60_000, recheckMs: 60_000 });
    expect(b.value.conditions.timeouts).toEqual({ checkMs: 60_000, recheckMs: 60_000 });

    const check = checkRunConditions([a.value, b.value]);
    expect(check.errors).toEqual([]);
  });

  it("recoveryConfirmMs だけが違う組（設定値は同じ）は条件不一致で拒否される", () => {
    const a = adaptExportToResult(makeTimeoutExport(60_000, 0));
    const b = adaptExportToResult(makeTimeoutExport(60_000, 30_000));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const check = checkRunConditions([a.value, b.value]);
    expect(check.errors.length).toBeGreaterThan(0);
  });
});

describe("export-adapter: adaptExportToResult（T26：stop.failure）", () => {
  it("停止した実行の stop.failure は常に null で、停止に至った検査単位の失敗は totals.checkUnits.failed に数えられる", () => {
    const stoppedExport = makeValidExport({
      run: makeRun({
        status: "stopped",
        stopReason: "connection-lost",
        stopMessage: "接続が切れたため停止した",
        generationUnconfirmed: false,
      }),
      checkUnits: [
        makeCheckUnit({
          id: "cu-failed",
          status: "failed",
          attempts: 1,
          failure: {
            reason: "timeout",
            message: "応答がタイムアウトした",
            finishReason: null,
            origin: "chat",
          },
        }),
        makeCheckUnit({ id: "cu-pending", status: "pending", attempts: 0 }),
      ],
      recheckUnits: [],
      findings: [],
    });

    const result = adaptExportToResult(stoppedExport);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("stopped");
    expect(result.value.stop).toEqual({
      reason: "connection-lost",
      message: "接続が切れたため停止した",
      failure: null,
      generationUnconfirmed: false,
    });
    expect(result.value.totals.checkUnits.failed).toBe(1);
    expect(result.value.totals.checkUnits.pending).toBe(1);
  });
});

// --- T20：runPipeline（CLI）と DB 経由（サーバー）の指標が一致すること ---------------------------

describe("export-adapter: adaptExportToResult（T20：runPipeline と DB 経由の指標の一致）", () => {
  const START = new Date("2026-01-01T00:00:00.000Z");
  const FINISH = new Date("2026-01-01T00:05:00.000Z");
  const T20_BODY = "あいうリュシアかきくさしす";
  const T20_CHUNK_SETTINGS = {
    targetGraphemes: 20,
    contextGraphemes: 0,
    recheckContextGraphemes: 0,
    roundingTolerance: 0,
    maxInputGraphemes: 50,
  };

  function t20Llm(overrides: Partial<LlmFinding> = {}): LlmFinding {
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

  function locatedCandidate(
    id: string,
    range: Range,
    llmOverrides: Partial<LlmFinding> = {},
  ): LocatedCandidate {
    return {
      id,
      perspective: "typo",
      llm: t20Llm({ quote: T20_BODY.slice(range.start, range.end), ...llmOverrides }),
      locate: { status: "located", range },
    };
  }

  function unlocatedCandidateFor(
    id: string,
    quote: string,
    reason: "not-found" | "ambiguous" | "outside-target",
    exactMatches: readonly Range[],
  ): UnlocatedCandidate {
    return {
      id,
      perspective: "typo",
      llm: t20Llm({ quote, suggestion: null, verdict: "confirm-with-author" }),
      locate: { status: "failed", reason, exactMatches, diagnostic: null },
    };
  }

  function setupT20Db() {
    const { db, close } = createDatabase(":memory:");
    applyMigrations(db);
    return { db, close };
  }

  /** `run/loop.ts` の `issueRechecks` を手で再現する：pending の再確認単位を起票して claim する。 */
  function issuePendingRecheck(
    db: ReturnType<typeof setupT20Db>["db"],
    recheckUnitId: string,
    runId: string,
    findingId: string,
  ): void {
    insertRecheckUnit(db, {
      id: recheckUnitId,
      runId,
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
  }

  it("元候補2件が統合された指摘・抑制・not-found/ambiguous/outside-targetの候補・failed/pendingの再確認・再送のある検査単位を含む実行で、adaptExportToResult 経由の指標が runPipeline 相当の PipelineResult と一致する", () => {
    const { db, close } = setupT20Db();
    const runId = "r-t20";
    const manuscriptVersionId = `mv-${runId}`;
    insertManuscriptVersion(db, { id: manuscriptVersionId, name: "原稿", body: T20_BODY });

    const run = insertRun(db, {
      id: runId,
      manuscriptVersionId,
      modelId: "model-a",
      modelInfo: null,
      endpointUrl: "http://127.0.0.1:1234",
      generationSettings: { maxTokens: 512, temperature: 0 },
      chunkSettings: T20_CHUNK_SETTINGS,
      timeouts: { checkMs: 60_000, recheckMs: 60_000 },
      perspectives: ["typo"],
      recheckEnabled: true,
      allowedWords: ["リュシア"],
      allowedWordRuleVersion: "1",
      promptVersion: "1",
      diagnosticTransformVersion: "1",
      status: "running",
      stopReason: null,
      stopMessage: null,
      generationUnconfirmed: false,
      startOperationId: `seed-${runId}`,
      startedAt: START,
      finishedAt: null,
    });

    const targetId = `t-${runId}`;
    const target = insertRunTarget(db, {
      id: targetId,
      runId,
      targetIndex: 0,
      target: { start: 0, end: T20_BODY.length },
      contextBefore: null,
      contextAfter: null,
      input: { start: 0, end: T20_BODY.length },
      paragraphIds: [0],
    });

    const checkUnitId = `cu-${runId}`;
    insertCheckUnit(db, {
      id: checkUnitId,
      runId,
      targetId,
      perspective: "typo",
      status: "pending",
      attempts: 0,
      failure: null,
      pendingNote: null,
      usage: null,
      inputGraphemes: null,
      elapsedMs: null,
      startedAt: null,
      finishedAt: null,
    });
    claimUnitChecked(db, checkUnitId, "pending", "running");
    const claimedUnit = findCheckUnit(db, checkUnitId);
    if (claimedUnit === null) throw new Error("テストの組み立てミス：検査単位が見つかりません");

    const mergeA = locatedCandidate(
      "c-mergeA",
      { start: 0, end: 3 },
      { suggestion: "あいう(訂正)" },
    );
    const mergeB = locatedCandidate(
      "c-mergeB",
      { start: 0, end: 3 },
      { suggestion: "あいう(訂正)", reason: "別の観点からも同じ誤り" },
    );
    const suppressedCand = locatedCandidate(
      "c-suppressed",
      { start: 3, end: 7 },
      { suggestion: "ルシア" },
    );
    const failedSourceCand = locatedCandidate(
      "c-failedsrc",
      { start: 7, end: 10 },
      { suggestion: "かきく(訂正)" },
    );
    const pendingSourceCand = locatedCandidate(
      "c-pendingsrc",
      { start: 10, end: 13 },
      { suggestion: "さしす(訂正)" },
    );
    const notFoundCand = unlocatedCandidateFor("c-notfound", "なにぬ", "not-found", []);
    const ambiguousCand = unlocatedCandidateFor("c-ambiguous", "たちつ", "ambiguous", [
      { start: 0, end: 3 },
      { start: 5, end: 8 },
    ]);
    const outsideCand = unlocatedCandidateFor("c-outside", "はひふ", "outside-target", [
      { start: 0, end: 3 },
    ]);

    const outcome: CheckUnitOutcome = {
      unit: {
        status: "done",
        targetIndex: 0,
        perspective: "typo",
        attempts: 2,
        usage: null,
        inputGraphemes: T20_BODY.length,
        elapsedMs: 500,
        findingCount: 8,
      },
      candidates: [
        mergeA,
        mergeB,
        suppressedCand,
        failedSourceCand,
        pendingSourceCand,
        notFoundCand,
        ambiguousCand,
        outsideCand,
      ],
      failure: null,
      halt: null,
      elapsedMs: 500,
      usage: null,
    };

    saveCheckUnitOutcome(db, {
      run,
      target,
      unit: claimedUnit,
      outcome,
      body: T20_BODY,
      paragraphs: splitParagraphs(T20_BODY),
      allowedWords: ["リュシア"],
      now: START,
      modelInfo: null,
    });

    const allFindings = listFindings(db, runId);
    const findByQuote = (quote: string) => {
      const found = allFindings.find((f) => f.quote === quote);
      if (found === undefined) {
        throw new Error(`テストの組み立てミス：quote ${quote} の指摘が見つかりません`);
      }
      return found;
    };
    const mergedFinding = findByQuote("あいう");
    const suppressedFinding = findByQuote("リュシア");
    const failedFinding = findByQuote("かきく");
    const pendingFinding = findByQuote("さしす");

    issuePendingRecheck(db, "rc-merged", runId, mergedFinding.id);
    const mergedRecheckOutcome: RecheckUnitOutcome = {
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
        inputRange: { start: 0, end: 3 },
        inputGraphemes: 10,
        elapsedMs: 200,
      },
      failure: null,
      halt: null,
      elapsedMs: 200,
      usage: null,
    };
    const mergedRecheckUnit = findRecheckUnitByFinding(db, mergedFinding.id);
    if (mergedRecheckUnit === null) throw new Error("テストの組み立てミス");
    saveRecheckOutcome(db, {
      run,
      unit: mergedRecheckUnit,
      outcome: mergedRecheckOutcome,
      now: FINISH,
    });

    insertRecheckUnit(db, {
      id: "rc-suppressed",
      runId,
      findingId: suppressedFinding.id,
      inputRange: null,
      status: "not-applicable",
      notApplicableReason: "suppressed",
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
      finishedAt: FINISH,
    });

    issuePendingRecheck(db, "rc-failed", runId, failedFinding.id);
    const failedFailure = {
      reason: "malformed" as const,
      message: "JSON として解析できなかった",
      finishReason: null,
      origin: "chat" as const,
    };
    const failedRecheckOutcome: RecheckUnitOutcome = {
      result: {
        status: "failed",
        attempts: 1,
        failure: failedFailure,
        usage: null,
        inputRange: { start: 7, end: 10 },
        elapsedMs: 150,
      },
      failure: failedFailure,
      halt: null,
      elapsedMs: 150,
      usage: null,
    };
    const failedRecheckUnit = findRecheckUnitByFinding(db, failedFinding.id);
    if (failedRecheckUnit === null) throw new Error("テストの組み立てミス");
    saveRecheckOutcome(db, {
      run,
      unit: failedRecheckUnit,
      outcome: failedRecheckOutcome,
      now: FINISH,
    });

    issuePendingRecheck(db, "rc-pending", runId, pendingFinding.id);
    const pendingRecheckOutcome: RecheckUnitOutcome = {
      result: {
        status: "pending",
        attempts: 1,
        inputRange: { start: 10, end: 13 },
        note: "応答が上限内に届かなかった",
      },
      failure: null,
      halt: null,
      elapsedMs: 80,
      usage: null,
    };
    const pendingRecheckUnit = findRecheckUnitByFinding(db, pendingFinding.id);
    if (pendingRecheckUnit === null) throw new Error("テストの組み立てミス");
    saveRecheckOutcome(db, {
      run,
      unit: pendingRecheckUnit,
      outcome: pendingRecheckOutcome,
      now: FINISH,
    });

    // 検査単位・再確認単位に failed があるので partially-failed（run/pipeline.ts の判定と同じ）。
    finishRun(db, runId, {
      expectedStatus: "running",
      status: "partially-failed",
      stopReason: null,
      stopMessage: null,
      generationUnconfirmed: false,
      finishedAt: FINISH,
    });
    const finishedRun = findRun(db, runId);
    if (finishedRun === null) throw new Error("テストの組み立てミス");

    const exported = buildRunExport(db, finishedRun);
    const adapted = adaptExportToResult(exported);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;

    // --- 同じ内容を手で組み立てた PipelineResult（runPipeline 相当） --------------------------
    const pipelineResult: PipelineResult = {
      status: "partially-failed",
      stop: null,
      conditions: {
        startedAt: START.toISOString(),
        finishedAt: FINISH.toISOString(),
        mode: "split-recheck",
        perspectives: ["typo"],
        generation: { model: "model-a", maxTokens: 512, temperature: 0 },
        model: null,
        chunkSettings: T20_CHUNK_SETTINGS,
        timeouts: { checkMs: 60_000, recheckMs: 60_000 },
        allowedWords: ["リュシア"],
        versions: { result: "1", prompt: "1", allowedWordRule: "1", diagnosticTransform: "1" },
        manuscript: {
          utf16Length: T20_BODY.length,
          graphemeCount: T20_BODY.length,
          paragraphCount: 1,
          targetCount: 1,
          bodyHash: hashBody(T20_BODY),
        },
      },
      targets: [
        {
          target: { index: 0, range: { start: 0, end: T20_BODY.length }, paragraphIds: [0] },
          input: {
            target: { index: 0, range: { start: 0, end: T20_BODY.length }, paragraphIds: [0] },
            context: { before: null, after: null },
            inputRange: { start: 0, end: T20_BODY.length },
          },
        },
      ],
      checkUnits: [
        {
          status: "done",
          targetIndex: 0,
          perspective: "typo",
          attempts: 2,
          usage: null,
          inputGraphemes: T20_BODY.length,
          elapsedMs: 500,
          findingCount: 8,
        },
      ],
      findings: [
        {
          targetIndex: 0,
          finding: {
            id: mergedFinding.id,
            range: { start: 0, end: 3 },
            quote: "あいう",
            category: "notation",
            suggestion: "あいう(訂正)",
            verdict: "likely-error",
            sources: [mergeA, mergeB],
          },
          suppression: null,
          recheck: {
            status: "done",
            attempts: 1,
            output: {
              reason: "検討の結果、指摘は妥当",
              reasonKind: "error-confirmed",
              verdict: "keep",
              suggestionValid: true,
            },
            usage: null,
            inputRange: { start: 0, end: 3 },
            inputGraphemes: 10,
            elapsedMs: 200,
          },
        },
        {
          targetIndex: 0,
          finding: {
            id: suppressedFinding.id,
            range: { start: 3, end: 7 },
            quote: "リュシア",
            category: "notation",
            suggestion: "ルシア",
            verdict: "likely-error",
            sources: [suppressedCand],
          },
          suppression: { word: "リュシア", ruleVersion: ALLOWED_WORD_RULE_VERSION },
          recheck: { status: "suppressed" },
        },
        {
          targetIndex: 0,
          finding: {
            id: failedFinding.id,
            range: { start: 7, end: 10 },
            quote: "かきく",
            category: "notation",
            suggestion: "かきく(訂正)",
            verdict: "likely-error",
            sources: [failedSourceCand],
          },
          suppression: null,
          recheck: {
            status: "failed",
            attempts: 1,
            failure: failedFailure,
            usage: null,
            inputRange: { start: 7, end: 10 },
            elapsedMs: 150,
          },
        },
        {
          targetIndex: 0,
          finding: {
            id: pendingFinding.id,
            range: { start: 10, end: 13 },
            quote: "さしす",
            category: "notation",
            suggestion: "さしす(訂正)",
            verdict: "likely-error",
            sources: [pendingSourceCand],
          },
          suppression: null,
          recheck: {
            status: "pending",
            attempts: 1,
            inputRange: { start: 10, end: 13 },
            note: "応答が上限内に届かなかった",
          },
        },
      ],
      unlocated: [
        { targetIndex: 0, candidate: notFoundCand },
        { targetIndex: 0, candidate: ambiguousCand },
        { targetIndex: 0, candidate: outsideCand },
      ],
      totals: {
        targets: 1,
        checkUnits: { done: 1, failed: 0, pending: 0 },
        // checkUnits[].attempts(2) + rechecks[].attempts(merged1+failed1+pending1、suppressedは0)。
        requests: 5,
        candidates: 8,
        located: 5,
        unlocated: { notFound: 1, ambiguous: 1, outsideTarget: 1 },
        findings: 4,
        suppressed: 1,
        rechecks: { done: 1, failed: 1, pending: 1, suppressed: 1, disabled: 0 },
        elapsedMs: 300_000,
      },
    };

    const truthEntries: readonly ResolvedTruthEntry[] = [];
    const pipelineMetrics = scoreRun(truthEntries, pipelineResult);
    const adaptedMetrics = scoreRun(truthEntries, adapted.value);

    expect(adaptedMetrics).toEqual(pipelineMetrics);

    close();
  });

  it("止まった実行（issueRechecks 起票前に停止）：位置確定済みの指摘に再確認単位がまだ無くても pending / suppressed に復元される", () => {
    const { db, close } = setupT20Db();
    const runId = "r-t20-stopped";
    const manuscriptVersionId = `mv-${runId}`;
    insertManuscriptVersion(db, { id: manuscriptVersionId, name: "原稿", body: T20_BODY });

    const run = insertRun(db, {
      id: runId,
      manuscriptVersionId,
      modelId: "model-a",
      modelInfo: null,
      endpointUrl: "http://127.0.0.1:1234",
      generationSettings: { maxTokens: 512, temperature: 0 },
      chunkSettings: T20_CHUNK_SETTINGS,
      timeouts: { checkMs: 60_000, recheckMs: 60_000 },
      perspectives: ["typo"],
      recheckEnabled: true,
      allowedWords: ["リュシア"],
      allowedWordRuleVersion: "1",
      promptVersion: "1",
      diagnosticTransformVersion: "1",
      status: "running",
      stopReason: null,
      stopMessage: null,
      generationUnconfirmed: false,
      startOperationId: `seed-${runId}`,
      startedAt: START,
      finishedAt: null,
    });
    const targetId = `t-${runId}`;
    const target = insertRunTarget(db, {
      id: targetId,
      runId,
      targetIndex: 0,
      target: { start: 0, end: T20_BODY.length },
      contextBefore: null,
      contextAfter: null,
      input: { start: 0, end: T20_BODY.length },
      paragraphIds: [0],
    });
    const checkUnitId = `cu-${runId}`;
    insertCheckUnit(db, {
      id: checkUnitId,
      runId,
      targetId,
      perspective: "typo",
      status: "pending",
      attempts: 0,
      failure: null,
      pendingNote: null,
      usage: null,
      inputGraphemes: null,
      elapsedMs: null,
      startedAt: null,
      finishedAt: null,
    });
    claimUnitChecked(db, checkUnitId, "pending", "running");
    const claimedUnit = findCheckUnit(db, checkUnitId);
    if (claimedUnit === null) throw new Error("テストの組み立てミス");

    // 位置確定済みの指摘を 2 件だけ作る（抑制されるものと、されないもの）。issueRechecks
    // （起票）はまだ走っていないので recheck_units の行は無い。
    const plainCand = locatedCandidate(
      "c-plain",
      { start: 7, end: 10 },
      { suggestion: "かきく(訂正)" },
    );
    const suppressedCand2 = locatedCandidate(
      "c-suppressed2",
      { start: 3, end: 7 },
      { suggestion: "ルシア" },
    );

    const outcome: CheckUnitOutcome = {
      unit: {
        status: "done",
        targetIndex: 0,
        perspective: "typo",
        attempts: 1,
        usage: null,
        inputGraphemes: T20_BODY.length,
        elapsedMs: 100,
        findingCount: 2,
      },
      candidates: [plainCand, suppressedCand2],
      failure: null,
      halt: null,
      elapsedMs: 100,
      usage: null,
    };
    saveCheckUnitOutcome(db, {
      run,
      target,
      unit: claimedUnit,
      outcome,
      body: T20_BODY,
      paragraphs: splitParagraphs(T20_BODY),
      allowedWords: ["リュシア"],
      now: START,
      modelInfo: null,
    });

    finishRun(db, runId, {
      expectedStatus: "running",
      status: "stopped",
      stopReason: "aborted",
      stopMessage: "利用者が停止を要求した",
      generationUnconfirmed: false,
      finishedAt: FINISH,
    });
    const finishedRun = findRun(db, runId);
    if (finishedRun === null) throw new Error("テストの組み立てミス");

    const exported = buildRunExport(db, finishedRun);
    const adapted = adaptExportToResult(exported);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;

    const plainFinding = adapted.value.findings.find((f) => f.finding.quote === "かきく");
    const suppressedFindingResult = adapted.value.findings.find(
      (f) => f.finding.quote === "リュシア",
    );
    expect(plainFinding?.recheck).toEqual({ status: "pending" });
    expect(suppressedFindingResult?.recheck).toEqual({ status: "suppressed" });

    close();
  });
});
