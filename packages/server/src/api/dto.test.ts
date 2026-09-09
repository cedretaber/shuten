import type { LlmFinding } from "@shuten/shared";
import {
  candidateDtoSchema,
  checkUnitDtoSchema,
  diagnosticDtoSchema,
  findingDtoSchema,
  judgmentDtoSchema,
  manuscriptVersionDtoSchema,
  modelInfoDtoSchema,
  recheckUnitDtoSchema,
  runDtoSchema,
  runSummaryDtoSchema,
  runTargetDtoSchema,
} from "@shuten/shared";
import { describe, expect, it } from "vitest";

import type {
  CandidateRecord,
  CheckUnitRecord,
  DiagnosticRecord,
  JudgmentRecord,
  ManuscriptVersionRecord,
  RecheckUnitRecord,
  RunRecord,
  RunTargetRecord,
  UnitFailureRecord,
} from "../db/records.ts";
import type { FindingWithReasons } from "../db/repositories/findings.ts";
import type { ModelInfo, Usage } from "../lmstudio/types.ts";
import {
  toCandidateDto,
  toCheckUnitDto,
  toDiagnosticDto,
  toFindingDto,
  toJudgmentDto,
  toManuscriptVersionDto,
  toModelInfoDto,
  toRecheckUnitDto,
  toRunDto,
  toRunSummaryDto,
  toRunTargetDto,
} from "./dto.ts";

/** 番兵。射影を通ったあとの DTO に現れてはならない（決定 3）。 */
const SENTINEL_URL = "http://sentinel.invalid:9";

const MODEL_INFO: ModelInfo = {
  id: "model-a",
  type: "llm",
  state: "loaded",
  quantization: "q4",
  maxContextLength: 4096,
  loadedContextLength: 2048,
};

const USAGE: Usage = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  reasoningTokens: null,
};

const FAILURE: UnitFailureRecord = {
  reason: "connection",
  message: "応答を受け取れずに切断した",
  finishReason: null,
  origin: "chat",
};

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    manuscriptVersionId: "mv-1",
    modelId: "model-a",
    modelInfo: MODEL_INFO,
    endpointUrl: SENTINEL_URL,
    generationSettings: { maxTokens: 16_000, temperature: 0 },
    chunkSettings: {
      targetGraphemes: 1500,
      contextGraphemes: 1000,
      recheckContextGraphemes: 3000,
      roundingTolerance: 0.2,
      maxInputGraphemes: 12_000,
    },
    timeouts: { checkMs: 300_000, recheckMs: 300_000 },
    perspectives: ["typo", "naturalness"],
    recheckEnabled: true,
    allowedWords: ["ゆらぎ"],
    allowedWordRuleVersion: "1",
    promptVersion: "1",
    diagnosticTransformVersion: "1",
    status: "running",
    stopReason: null,
    stopMessage: null,
    generationUnconfirmed: false,
    startOperationId: "op-1",
    stopRequestedAt: null,
    recoveryConfirmMs: 120_000,
    startedAt: new Date("2026-09-10T01:02:03.000Z"),
    finishedAt: null,
    recoveryConfirmedAt: null,
    ...overrides,
  };
}

const LLM_FINDING: LlmFinding = {
  paragraphId: 0,
  quote: "うえ",
  before: "",
  after: "",
  category: "notation",
  reason: "理由",
  suggestion: "ウエ",
  verdict: "likely-error",
};

describe("toRunDto", () => {
  it("決定 3: endpointUrl / startOperationId のキーが存在しない", () => {
    const dto = toRunDto(runRecord());
    expect("endpointUrl" in dto).toBe(false);
    expect("startOperationId" in dto).toBe(false);
    expect(JSON.stringify(dto)).not.toContain("sentinel");
  });

  it("日時が ISO 文字列になる", () => {
    const dto = toRunDto(
      runRecord({
        finishedAt: new Date("2026-09-10T02:03:04.000Z"),
        stopRequestedAt: new Date("2026-09-10T02:00:00.000Z"),
        recoveryConfirmedAt: new Date("2026-09-10T02:01:00.000Z"),
      }),
    );
    expect(dto.startedAt).toBe("2026-09-10T01:02:03.000Z");
    expect(dto.finishedAt).toBe("2026-09-10T02:03:04.000Z");
    expect(dto.stopRequestedAt).toBe("2026-09-10T02:00:00.000Z");
    expect(dto.recoveryConfirmedAt).toBe("2026-09-10T02:01:00.000Z");
  });

  it("時刻が null ならそのまま null", () => {
    const dto = toRunDto(runRecord());
    expect(dto.finishedAt).toBeNull();
    expect(dto.stopRequestedAt).toBeNull();
    expect(dto.recoveryConfirmedAt).toBeNull();
  });

  it("runDtoSchema の parse を通る", () => {
    expect(() => runDtoSchema.parse(toRunDto(runRecord()))).not.toThrow();
  });

  it("modelInfo が null でも parse を通る", () => {
    const dto = toRunDto(runRecord({ modelInfo: null }));
    expect(dto.modelInfo).toBeNull();
    expect(() => runDtoSchema.parse(dto)).not.toThrow();
  });

  it("seed / reasoningEffort が無いときはキー自体を作らない", () => {
    const dto = toRunDto(runRecord());
    expect("seed" in dto.generationSettings).toBe(false);
    expect("reasoningEffort" in dto.generationSettings).toBe(false);
  });

  it("seed / reasoningEffort があれば写す", () => {
    const dto = toRunDto(
      runRecord({
        generationSettings: {
          maxTokens: 16_000,
          temperature: 0,
          seed: 7,
          reasoningEffort: "low",
        },
      }),
    );
    expect(dto.generationSettings.seed).toBe(7);
    expect(dto.generationSettings.reasoningEffort).toBe("low");
    expect(() => runDtoSchema.parse(dto)).not.toThrow();
  });

  it("配列はコピーする（レコードの参照を貸さない）", () => {
    const record = runRecord();
    const dto = toRunDto(record);
    expect(dto.perspectives).not.toBe(record.perspectives);
    expect(dto.allowedWords).not.toBe(record.allowedWords);
  });
});

describe("toRunSummaryDto", () => {
  it("原稿名を添えて runSummaryDtoSchema の parse を通り、接続先を含まない", () => {
    const dto = toRunSummaryDto({ run: runRecord(), manuscriptName: "原稿" });
    expect(() => runSummaryDtoSchema.parse(dto)).not.toThrow();
    expect("endpointUrl" in dto).toBe(false);
    expect(JSON.stringify(dto)).not.toContain("sentinel");
    expect(dto.manuscriptName).toBe("原稿");
  });
});

describe("toManuscriptVersionDto", () => {
  it("manuscriptVersionDtoSchema の parse を通り、日時が ISO 文字列になる", () => {
    const record: ManuscriptVersionRecord = {
      id: "mv-1",
      name: "原稿",
      body: "あいうえお",
      bodyHash: "hash",
      createdAt: new Date("2026-09-10T01:02:03.000Z"),
    };
    const dto = toManuscriptVersionDto(record);
    expect(dto.createdAt).toBe("2026-09-10T01:02:03.000Z");
    expect(() => manuscriptVersionDtoSchema.parse(dto)).not.toThrow();
  });
});

describe("toModelInfoDto", () => {
  it("modelInfoDtoSchema の parse を通る", () => {
    expect(() => modelInfoDtoSchema.parse(toModelInfoDto(MODEL_INFO))).not.toThrow();
  });
});

describe("toRunTargetDto", () => {
  it("runId を落とし、runTargetDtoSchema の parse を通る", () => {
    const record: RunTargetRecord = {
      id: "t-1",
      runId: "run-1",
      targetIndex: 0,
      target: { start: 0, end: 10 },
      contextBefore: null,
      contextAfter: { start: 10, end: 20 },
      input: { start: 0, end: 20 },
      paragraphIds: [0, 1],
    };
    const dto = toRunTargetDto(record);
    expect("runId" in dto).toBe(false);
    expect(dto.paragraphIds).not.toBe(record.paragraphIds);
    expect(() => runTargetDtoSchema.parse(dto)).not.toThrow();
  });
});

describe("toCheckUnitDto", () => {
  const record: CheckUnitRecord = {
    id: "cu-1",
    runId: "run-1",
    targetId: "t-1",
    perspective: "typo",
    status: "failed",
    attempts: 2,
    failure: FAILURE,
    pendingNote: null,
    usage: USAGE,
    inputGraphemes: 1200,
    elapsedMs: 1234,
    startedAt: new Date("2026-09-10T01:02:03.000Z"),
    finishedAt: new Date("2026-09-10T01:02:05.000Z"),
  };

  it("usage / inputGraphemes / runId を落とし、checkUnitDtoSchema の parse を通る", () => {
    const dto = toCheckUnitDto(record, 3);
    expect("usage" in dto).toBe(false);
    expect("inputGraphemes" in dto).toBe(false);
    expect("runId" in dto).toBe(false);
    expect(dto.targetIndex).toBe(3);
    expect(dto.startedAt).toBe("2026-09-10T01:02:03.000Z");
    expect(() => checkUnitDtoSchema.parse(dto)).not.toThrow();
  });

  it("失敗を落とさずに返す（決定：失敗を指摘ゼロに置き換えない）", () => {
    const dto = toCheckUnitDto(record, 0);
    expect(dto.failure).toEqual({
      reason: "connection",
      message: "応答を受け取れずに切断した",
      finishReason: null,
      origin: "chat",
    });
  });

  it("failure が null ならそのまま null", () => {
    const dto = toCheckUnitDto({ ...record, failure: null }, 0);
    expect(dto.failure).toBeNull();
  });
});

function recheckRecord(overrides: Partial<RecheckUnitRecord> = {}): RecheckUnitRecord {
  return {
    id: "ru-1",
    runId: "run-1",
    findingId: "f-1",
    inputRange: { start: 0, end: 20 },
    status: "done",
    notApplicableReason: null,
    attempts: 1,
    failure: null,
    pendingNote: null,
    verdict: "keep",
    reasonKind: "error-confirmed",
    reason: "誤りである",
    suggestionValid: true,
    usage: USAGE,
    inputGraphemes: 20,
    elapsedMs: 100,
    startedAt: new Date("2026-09-10T01:02:03.000Z"),
    finishedAt: new Date("2026-09-10T01:02:04.000Z"),
    ...overrides,
  };
}

describe("toRecheckUnitDto", () => {
  it("usage / inputGraphemes / runId を落とし、recheckUnitDtoSchema の parse を通る", () => {
    const dto = toRecheckUnitDto(recheckRecord());
    expect("usage" in dto).toBe(false);
    expect("inputGraphemes" in dto).toBe(false);
    expect("runId" in dto).toBe(false);
    expect(() => recheckUnitDtoSchema.parse(dto)).not.toThrow();
  });

  it("inputRange が null でも parse を通る", () => {
    const dto = toRecheckUnitDto(recheckRecord({ inputRange: null }));
    expect(dto.inputRange).toBeNull();
    expect(() => recheckUnitDtoSchema.parse(dto)).not.toThrow();
  });
});

describe("toJudgmentDto", () => {
  it("judgmentDtoSchema の parse を通り、日時が ISO 文字列になる", () => {
    const record: JudgmentRecord = {
      findingId: "f-1",
      status: "undecided",
      note: null,
      updatedAt: new Date("2026-09-10T01:02:03.000Z"),
    };
    const dto = toJudgmentDto(record);
    expect(dto.updatedAt).toBe("2026-09-10T01:02:03.000Z");
    expect(() => judgmentDtoSchema.parse(dto)).not.toThrow();
  });
});

describe("toFindingDto", () => {
  const finding: FindingWithReasons = {
    id: "f-1",
    runId: "run-1",
    manuscriptVersionId: "mv-1",
    targetId: "t-1",
    locateStatus: "located",
    range: { start: 2, end: 4 },
    paragraphId: 0,
    quote: "うえ",
    suggestion: "ウエ",
    category: "notation",
    initialVerdict: "likely-error",
    mergeKey: "merge-key",
    suppression: { word: "うえ", ruleVersion: "1" },
    createdAt: new Date("2026-09-10T01:02:03.000Z"),
    reasons: [{ candidateId: "c-1", perspective: "typo", reason: "理由" }],
  };
  const judgment: JudgmentRecord = {
    findingId: "f-1",
    status: "undecided",
    note: null,
    updatedAt: new Date("2026-09-10T01:02:03.000Z"),
  };

  it("manuscriptVersionId / mergeKey を落とし、findingDtoSchema の parse を通る", () => {
    const dto = toFindingDto(finding, recheckRecord(), judgment);
    expect("manuscriptVersionId" in dto).toBe(false);
    expect("mergeKey" in dto).toBe(false);
    expect(() => findingDtoSchema.parse(dto)).not.toThrow();
  });

  it("再確認の要約は時刻・回数を含まない", () => {
    const dto = toFindingDto(finding, recheckRecord(), judgment);
    expect(dto.recheck).toEqual({
      id: "ru-1",
      status: "done",
      notApplicableReason: null,
      verdict: "keep",
      reasonKind: "error-confirmed",
      reason: "誤りである",
      suggestionValid: true,
      failure: null,
    });
  });

  it("再確認が無ければ recheck は null", () => {
    const dto = toFindingDto(finding, null, judgment);
    expect(dto.recheck).toBeNull();
    expect(() => findingDtoSchema.parse(dto)).not.toThrow();
  });

  it("位置未確定（range が null）でも parse を通る", () => {
    const dto = toFindingDto(
      { ...finding, locateStatus: "not-found", range: null, suppression: null },
      null,
      judgment,
    );
    expect(dto.range).toBeNull();
    expect(dto.suppression).toBeNull();
    expect(() => findingDtoSchema.parse(dto)).not.toThrow();
  });
});

describe("toCandidateDto", () => {
  const record: CandidateRecord = {
    id: "c-1",
    runId: "run-1",
    checkUnitId: "cu-1",
    findingId: "f-1",
    candidateIndex: 0,
    llm: LLM_FINDING,
    locateStatus: "located",
    range: { start: 2, end: 4 },
    mergeKey: "merge-key",
    createdAt: new Date("2026-09-10T01:02:03.000Z"),
  };

  it("findingId / mergeKey / runId を落とし、candidateDtoSchema の parse を通る", () => {
    const dto = toCandidateDto(record, "typo");
    expect("findingId" in dto).toBe(false);
    expect("mergeKey" in dto).toBe(false);
    expect("runId" in dto).toBe(false);
    expect(dto.perspective).toBe("typo");
    expect(() => candidateDtoSchema.parse(dto)).not.toThrow();
  });
});

describe("toDiagnosticDto", () => {
  const record: DiagnosticRecord = {
    candidateId: "c-1",
    runId: "run-1",
    quote: "ぬ",
    reason: "not-found",
    searchRange: { start: 0, end: 20 },
    exactMatches: [{ start: 1, end: 2 }],
    transformVersion: "1",
    transformCandidates: [{ transform: "nfc", text: "ぬ", range: { start: 1, end: 2 } }],
    omitted: 0,
    tied: false,
  };

  it("runId を落とし、diagnosticDtoSchema の parse を通る", () => {
    const dto = toDiagnosticDto(record);
    expect("runId" in dto).toBe(false);
    expect(dto.exactMatches).not.toBe(record.exactMatches);
    expect(() => diagnosticDtoSchema.parse(dto)).not.toThrow();
  });

  it("transformCandidates が null でも parse を通る", () => {
    const dto = toDiagnosticDto({ ...record, transformCandidates: null, transformVersion: null });
    expect(dto.transformCandidates).toBeNull();
    expect(() => diagnosticDtoSchema.parse(dto)).not.toThrow();
  });
});
