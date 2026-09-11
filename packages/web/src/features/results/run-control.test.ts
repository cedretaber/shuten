/**
 * 実行制御の出し分けと案内（Task 4、決定 6・7・8・9）の純関数の検査。
 *
 * 決定 6 の表（`status` × `stopReason` の 6 通り）× `units`（null／失敗単位あり／なしの別）で
 * `controlAvailability` と `retryableUnitIds` を検査し、決定 8 の `code` 7 種＋未知の `code`＋
 * `ApiRequestError` でない例外で `controlFailureOf` を検査する。決定 9 の 5 条件は
 * `statusNotice` で優先順（`stopRequestedAt` が最優先）を含めて検査する。
 */

import type { CheckUnitDto, RecheckUnitDto, RunDto, RunUnitsDto } from "@shuten/shared";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../api/errors.ts";
import {
  controlAvailability,
  controlFailureOf,
  retryableUnitIds,
  showStopButton,
  statusNotice,
} from "./run-control.ts";

function makeRun(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: "run-1",
    manuscriptVersionId: "manuscript-1",
    modelId: "model-a",
    modelInfo: null,
    generationSettings: { maxTokens: 512, temperature: 0 },
    chunkSettings: {
      targetGraphemes: 1500,
      contextGraphemes: 200,
      recheckContextGraphemes: 200,
      roundingTolerance: 0.1,
      maxInputGraphemes: 12000,
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
    stopRequestedAt: null,
    recoveryConfirmedAt: null,
    recoveryConfirmMs: 60_000,
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function makeCheckUnit(overrides: Partial<CheckUnitDto> = {}): CheckUnitDto {
  return {
    id: "check-1",
    targetId: "target-1",
    targetIndex: 0,
    perspective: "typo",
    status: "pending",
    attempts: 0,
    failure: null,
    pendingNote: null,
    elapsedMs: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeRecheckUnit(overrides: Partial<RecheckUnitDto> = {}): RecheckUnitDto {
  return {
    id: "recheck-1",
    findingId: "finding-1",
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
    elapsedMs: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeUnits(overrides: Partial<RunUnitsDto> = {}): RunUnitsDto {
  return { checkUnits: [], recheckUnits: [], ...overrides };
}

describe("retryableUnitIds", () => {
  it("units が null なら空配列（決定 6）", () => {
    expect(retryableUnitIds(null)).toEqual([]);
  });

  it("input-too-long の検査単位を除く（決定 6・36）", () => {
    const units = makeUnits({
      checkUnits: [
        makeCheckUnit({
          id: "c-timeout",
          status: "failed",
          failure: { reason: "timeout", message: "", finishReason: null, origin: "chat" },
        }),
        makeCheckUnit({
          id: "c-too-long",
          status: "failed",
          failure: { reason: "input-too-long", message: "", finishReason: null, origin: "local" },
        }),
        makeCheckUnit({ id: "c-pending", status: "pending" }),
      ],
    });
    expect(retryableUnitIds(units)).toEqual(["c-timeout"]);
  });

  it("再確認単位は input-too-long でも除外しない（決定 36 の非対称）", () => {
    const units = makeUnits({
      recheckUnits: [
        makeRecheckUnit({
          id: "r-too-long",
          status: "failed",
          failure: { reason: "input-too-long", message: "", finishReason: null, origin: "local" },
        }),
        makeRecheckUnit({ id: "r-pending", status: "pending" }),
      ],
    });
    expect(retryableUnitIds(units)).toEqual(["r-too-long"]);
  });
});

describe("controlAvailability", () => {
  it("running・停止要求なし：停止だけ○", () => {
    const run = makeRun({ status: "running", stopRequestedAt: null });
    expect(controlAvailability(run, null)).toEqual({
      canStop: true,
      canResume: false,
      canRetryFailed: false,
      canConfirmRecovery: false,
    });
  });

  it("running・停止要求あり：停止も×（2 回目以降は押せない）", () => {
    const run = makeRun({ status: "running", stopRequestedAt: "2026-09-10T00:01:00.000Z" });
    expect(controlAvailability(run, null)).toEqual({
      canStop: false,
      canResume: false,
      canRetryFailed: false,
      canConfirmRecovery: false,
    });
  });

  it("recovery-waiting：再開○・復旧確認○（未確認）、失敗単位の再試行は×", () => {
    const run = makeRun({ status: "recovery-waiting", recoveryConfirmedAt: null });
    const units = makeUnits({
      checkUnits: [
        makeCheckUnit({
          status: "failed",
          failure: { reason: "timeout", message: "", finishReason: null, origin: "chat" },
        }),
      ],
    });
    expect(controlAvailability(run, units)).toEqual({
      canStop: false,
      canResume: true,
      canRetryFailed: false,
      canConfirmRecovery: true,
    });
  });

  it("recovery-waiting・確認済み：復旧確認は×（副ボタンを隠す）が再開は○のまま（決定 7）", () => {
    const run = makeRun({
      status: "recovery-waiting",
      recoveryConfirmedAt: "2026-09-10T00:02:00.000Z",
    });
    expect(controlAvailability(run, null)).toEqual({
      canStop: false,
      canResume: true,
      canRetryFailed: false,
      canConfirmRecovery: false,
    });
  });

  it("stopped（settings）：再開×、失敗単位があれば再試行○", () => {
    const run = makeRun({ status: "stopped", stopReason: "settings" });
    const units = makeUnits({
      checkUnits: [
        makeCheckUnit({
          status: "failed",
          failure: { reason: "malformed", message: "", finishReason: null, origin: "chat" },
        }),
      ],
    });
    expect(controlAvailability(run, units)).toEqual({
      canStop: false,
      canResume: false,
      canRetryFailed: true,
      canConfirmRecovery: false,
    });
  });

  it("stopped（settings）：失敗単位が無ければ再試行×", () => {
    const run = makeRun({ status: "stopped", stopReason: "settings" });
    const units = makeUnits({ checkUnits: [makeCheckUnit({ status: "pending" })] });
    expect(controlAvailability(run, units).canRetryFailed).toBe(false);
  });

  it("stopped（settings 以外）：再開○、失敗単位があれば再試行○", () => {
    const run = makeRun({ status: "stopped", stopReason: "connection-lost" });
    const units = makeUnits({
      checkUnits: [
        makeCheckUnit({
          status: "failed",
          failure: { reason: "connection", message: "", finishReason: null, origin: "chat" },
        }),
      ],
    });
    expect(controlAvailability(run, units)).toEqual({
      canStop: false,
      canResume: true,
      canRetryFailed: true,
      canConfirmRecovery: false,
    });
  });

  it("stopped（settings 以外）・units が null：失敗単位が分からないので再試行×", () => {
    const run = makeRun({ status: "stopped", stopReason: "connection-lost" });
    expect(controlAvailability(run, null).canRetryFailed).toBe(false);
  });

  it("partially-failed：失敗単位があれば再試行○、再開は×", () => {
    const run = makeRun({ status: "partially-failed" });
    const units = makeUnits({
      checkUnits: [
        makeCheckUnit({
          status: "failed",
          failure: { reason: "timeout", message: "", finishReason: null, origin: "chat" },
        }),
      ],
    });
    expect(controlAvailability(run, units)).toEqual({
      canStop: false,
      canResume: false,
      canRetryFailed: true,
      canConfirmRecovery: false,
    });
  });

  it("partially-failed・units が null：失敗単位が分からないので再試行×", () => {
    const run = makeRun({ status: "partially-failed" });
    expect(controlAvailability(run, null).canRetryFailed).toBe(false);
  });

  it("completed：すべて×", () => {
    const run = makeRun({ status: "completed" });
    const units = makeUnits({
      checkUnits: [
        makeCheckUnit({
          status: "failed",
          failure: { reason: "timeout", message: "", finishReason: null, origin: "chat" },
        }),
      ],
    });
    expect(controlAvailability(run, units)).toEqual({
      canStop: false,
      canResume: false,
      canRetryFailed: false,
      canConfirmRecovery: false,
    });
  });
});

describe("showStopButton（レビュー指摘 M-1：表示条件を run-control.ts に揃える）", () => {
  it("running なら真（停止要求の有無を問わない）", () => {
    expect(showStopButton(makeRun({ status: "running", stopRequestedAt: null }))).toBe(true);
    expect(
      showStopButton(makeRun({ status: "running", stopRequestedAt: "2026-09-10T00:01:00.000Z" })),
    ).toBe(true);
  });

  it("running 以外は偽", () => {
    expect(showStopButton(makeRun({ status: "stopped" }))).toBe(false);
    expect(showStopButton(makeRun({ status: "recovery-waiting" }))).toBe(false);
    expect(showStopButton(makeRun({ status: "partially-failed" }))).toBe(false);
    expect(showStopButton(makeRun({ status: "completed" }))).toBe(false);
  });
});

describe("statusNotice", () => {
  it("停止要求中（running・stopRequestedAt !== null）が最優先", () => {
    const run = makeRun({
      status: "running",
      stopRequestedAt: "2026-09-10T00:01:00.000Z",
      generationUnconfirmed: true,
    });
    expect(statusNotice(run)).toBe("停止を要求しました。実行中の要求の終了を待っています。");
  });

  it("generationUnconfirmed が真なら、recovery-waiting 以外では出す", () => {
    const run = makeRun({ status: "stopped", generationUnconfirmed: true });
    expect(statusNotice(run)).toBe("LM Studio 側の生成が終了したか確認できていません。");
  });

  it("recovery-waiting・generationUnconfirmed 偽は null（決定 7 の仕様文は recovery-notice.tsx が出す）", () => {
    const run = makeRun({ status: "recovery-waiting", generationUnconfirmed: false });
    expect(statusNotice(run)).toBeNull();
  });

  it("recovery-waiting・generationUnconfirmed 真（サーバー側の不変条件どおり実運用で必ず起きる組み合わせ）も null（レビュー指摘 I-1）", () => {
    // `packages/server/src/run/state.ts` の不変条件：`recovery-waiting` は必ず
    // `generationUnconfirmed === true` を伴って書かれる。この組み合わせで
    // `generationUnconfirmed` の文に奪われて仕様 8.2 の定型文が出なくなる、という
    // 誤りが無いことを確かめる（`recovery-waiting` を `generationUnconfirmed` より先に判定する）。
    const run = makeRun({ status: "recovery-waiting", generationUnconfirmed: true });
    expect(statusNotice(run)).toBeNull();
  });

  it("partially-failed の案内文", () => {
    const run = makeRun({ status: "partially-failed" });
    expect(statusNotice(run)).toBe("一部の検査が失敗しました。未処理の範囲があります。");
  });

  it("stopped の案内文", () => {
    const run = makeRun({ status: "stopped", stopReason: "aborted" });
    expect(statusNotice(run)).toBe("停止中です。未処理の範囲が残っている可能性があります。");
  });

  it("running・停止要求なしは null", () => {
    const run = makeRun({ status: "running", stopRequestedAt: null });
    expect(statusNotice(run)).toBeNull();
  });

  it("completed は null（指摘 0 件の文言を前提にしてよい）", () => {
    const run = makeRun({ status: "completed" });
    expect(statusNotice(run)).toBeNull();
  });
});

describe("controlFailureOf（B10：決定 8 の案内文）", () => {
  it("run-not-active", () => {
    const error = new ApiRequestError(409, "run-not-active", "実行中ではありません: run-1");
    expect(controlFailureOf(error)).toEqual({
      message: "この検査はすでに動いていません。最新の状態を取得しました。",
      links: [],
    });
  });

  it("run-rejected-running", () => {
    const error = new ApiRequestError(
      409,
      "run-rejected-running",
      "実行中のため受け付けられません: run-1",
    );
    expect(controlFailureOf(error)).toEqual({
      message: "すでに実行中です。最新の状態を取得しました。",
      links: [],
    });
  });

  it("run-rejected-settings は / へのリンクを添える", () => {
    const error = new ApiRequestError(
      409,
      "run-rejected-settings",
      "設定エラーで停止した実行は再開できません: run-1",
    );
    expect(controlFailureOf(error)).toEqual({
      message:
        "設定エラーで停止した検査は再開できません。設定を見直して新しい検査を開始してください。",
      links: ["home"],
    });
  });

  it("run-rejected-stale-version は / へのリンクを添える", () => {
    const error = new ApiRequestError(
      409,
      "run-rejected-stale-version",
      "アプリの更新で版が変わったため再開・再試行できません: run-1",
    );
    expect(controlFailureOf(error)).toEqual({
      message:
        "アプリの更新で版が変わったため、この検査は再開・再試行できません。新しい検査を開始してください。",
      links: ["home"],
    });
  });

  it("run-rejected-connection は /settings と / へのリンクを添える", () => {
    const error = new ApiRequestError(
      409,
      "run-rejected-connection",
      "接続先が実行開始時と異なるため再開・再試行できません: run-1",
    );
    expect(controlFailureOf(error)).toEqual({
      message:
        "接続先が検査開始時と異なるため再開・再試行できません。接続設定を戻すか、新しい検査を開始してください。",
      links: ["settings", "home"],
    });
  });

  it("run-rejected-status", () => {
    const error = new ApiRequestError(
      409,
      "run-rejected-status",
      "現在の状態からは再開・再試行できません: run-1",
    );
    expect(controlFailureOf(error)).toEqual({
      message: "現在の状態からは受け付けられません。最新の状態を取得しました。",
      links: [],
    });
  });

  it("invalid-retry-target", () => {
    const error = new ApiRequestError(
      400,
      "invalid-retry-target",
      "再試行できる失敗単位がありません（実行 ID: run-1）",
    );
    expect(controlFailureOf(error)).toEqual({
      message: "再試行できる失敗単位がありません。",
      links: [],
    });
  });

  it("未知の code は既定の文に落ちる（サーバーが code を増やしても落ちない）", () => {
    const error = new ApiRequestError(500, "internal", "サーバー内部でエラーが発生しました");
    expect(controlFailureOf(error)).toEqual({
      message: "操作を受け付けられませんでした。時間をおいて試してください。",
      links: [],
    });
  });

  it("ApiRequestError でない例外（通信の失敗など）も既定の文に落ちる", () => {
    expect(controlFailureOf(new TypeError("Failed to fetch"))).toEqual({
      message: "操作を受け付けられませんでした。時間をおいて試してください。",
      links: [],
    });
  });

  it("Error ですらない cause（unknown）も既定の文に落ちる", () => {
    expect(controlFailureOf("network down")).toEqual({
      message: "操作を受け付けられませんでした。時間をおいて試してください。",
      links: [],
    });
  });

  it("message を転記しない（決定 8。実行 ID などサーバー都合の文面を画面に出さない）", () => {
    const error = new ApiRequestError(
      409,
      "run-not-active",
      "実行中ではありません: some-secret-run-id",
    );
    expect(controlFailureOf(error).message).not.toContain("some-secret-run-id");
  });
});
