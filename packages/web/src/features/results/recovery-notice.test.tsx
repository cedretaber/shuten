/**
 * `RecoveryNotice`（Task 7、決定 7）の検査。
 *
 * - `recovery-waiting`：仕様 8.2 の定型文がそのまま出ること、主・副の 2 ボタンが正しい API
 *   （`onResume`／`onConfirmRecovery`）を呼ぶこと、「時間経過は終了の証拠にならない」の注記が
 *   出ること、確認済み（`canConfirmRecovery` 偽）で副ボタンが消えて「復旧の確認を記録済みです。」
 *   が出ること、`disabled` で両ボタンが disabled になること。
 * - `stopReason === "recovery-blocked"`：`GET /api/recovery`（`useApiClient()`）を取り、
 *   `runIds` のうち自分の実行 ID 以外へのリンクが出ること、`runIds` が空・取得失敗のいずれでも
 *   リンクを出さずに文言だけ出て落ちないこと。
 * - それ以外の状態では何も描かない。
 */

import type { RecoveryDto, RunDto } from "@shuten/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.ts";
import { ApiClientProvider } from "../../api/context.tsx";
import { RecoveryNotice, type RecoveryNoticeProps } from "./recovery-notice.tsx";

const SPEC_SENTENCE = "生成の停止を確認できません。LM Studio側を確認して再開してください";
// 仕様 8.2 の逐語引用ではなく本 PR 独自の文言なので「LM Studio 側」（スペース有り）に揃える
// （レビュー指摘 I-2）。SPEC_SENTENCE（仕様 8.2 の逐語引用）はスペース無しのまま混ぜない。
const TIME_NOTE =
  "時間が経ったことは終了の証拠になりません。LM Studio 側で生成が止まったことを確かめてから押してください。";
const PRIMARY_LABEL = "LM Studio 側で生成が止まったことを確認した → 再開する";
const SECONDARY_LABEL = "確認だけ記録する（この検査は再開しない）";
/** 仕様 8.2「『再開』と『新規検査の開始』を区別する」の注記（最終レビュー Minor 5）。 */
const RESUME_SCOPE_NOTE = "同じ検査の続きから再開します（実行 ID は変わりません）";
const BLOCKED_NOTICE = "別の検査の復旧待ちのため停止しています。先にそちらを確認してください。";

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
    status: "recovery-waiting",
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

/** `notImplemented` パターン（`results-page.test.tsx` と同じ流儀）。呼ばれない口は例外にする。 */
function makeApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`${name} は呼ばれない想定`);
  };
  return {
    getConnection: notImplemented("getConnection"),
    putConnection: notImplemented("putConnection"),
    checkConnection: notImplemented("checkConnection"),
    createManuscript: notImplemented("createManuscript"),
    uploadManuscript: notImplemented("uploadManuscript"),
    getManuscript: notImplemented("getManuscript"),
    startRun: notImplemented("startRun"),
    getRun: notImplemented("getRun"),
    getRuns: notImplemented("getRuns"),
    getRunUnits: notImplemented("getRunUnits"),
    stopRun: notImplemented("stopRun"),
    resumeRun: notImplemented("resumeRun"),
    retryFailedUnits: notImplemented("retryFailedUnits"),
    getRecovery: notImplemented("getRecovery"),
    confirmRecovery: notImplemented("confirmRecovery"),
    getFindings: notImplemented("getFindings"),
    getFinding: notImplemented("getFinding"),
    putJudgment: notImplemented("putJudgment"),
    subscribeRunEvents: notImplemented("subscribeRunEvents"),
    ...overrides,
  };
}

function baseProps(overrides: Partial<RecoveryNoticeProps> = {}): RecoveryNoticeProps {
  return {
    run: makeRun(),
    canConfirmRecovery: true,
    onResume: vi.fn(),
    onConfirmRecovery: vi.fn(),
    disabled: false,
    ...overrides,
  };
}

function renderNotice(props: RecoveryNoticeProps, client: ApiClient = makeApiClient()) {
  return render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <RecoveryNotice {...props} />
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("RecoveryNotice: recovery-waiting・未確認", () => {
  it("仕様 8.2 の定型文をそのまま出す（スペースの有無も含めて一次資料どおり）", () => {
    renderNotice(baseProps());
    expect(screen.getByText(SPEC_SENTENCE)).toBeInTheDocument();
  });

  it("主・副の 2 ボタンと『時間経過は証拠にならない』の注記を出す", () => {
    renderNotice(baseProps());
    expect(screen.getByRole("button", { name: PRIMARY_LABEL })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SECONDARY_LABEL })).toBeInTheDocument();
    expect(screen.getByText(TIME_NOTE)).toBeInTheDocument();
    expect(screen.queryByText("復旧の確認を記録済みです。")).not.toBeInTheDocument();
  });

  // 最終レビュー Minor 5：仕様 8.2 は「再開」と「新規開始」の区別を求めている。復旧待ちの主
  // ボタンは「確認した → 再開する」という長い文言で、作り直しと誤解しやすい場面そのものなので、
  // 汎用の「再開」（`run-control.tsx`）と同じ注記を添える。注記を落とす実装は赤になる。
  it("主ボタンには『新規開始ではない』ことを示す注記が添えられている（仕様 8.2）", () => {
    renderNotice(baseProps());
    expect(screen.getByText(RESUME_SCOPE_NOTE)).toBeInTheDocument();
  });

  it("主ボタンを押すと onResume だけが呼ばれる", async () => {
    const onResume = vi.fn();
    const onConfirmRecovery = vi.fn();
    renderNotice(baseProps({ onResume, onConfirmRecovery }));
    await userEvent.click(screen.getByRole("button", { name: PRIMARY_LABEL }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onConfirmRecovery).not.toHaveBeenCalled();
  });

  it("副ボタンを押すと onConfirmRecovery だけが呼ばれる", async () => {
    const onResume = vi.fn();
    const onConfirmRecovery = vi.fn();
    renderNotice(baseProps({ onResume, onConfirmRecovery }));
    await userEvent.click(screen.getByRole("button", { name: SECONDARY_LABEL }));
    expect(onConfirmRecovery).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("disabled のとき両方のボタンが disabled になる", () => {
    renderNotice(baseProps({ disabled: true }));
    expect(screen.getByRole("button", { name: PRIMARY_LABEL })).toBeDisabled();
    expect(screen.getByRole("button", { name: SECONDARY_LABEL })).toBeDisabled();
  });
});

describe("RecoveryNotice: recovery-waiting・確認済み（決定 7）", () => {
  it("副ボタンが消え『復旧の確認を記録済みです。』が出る。主ボタンは残る", () => {
    renderNotice(baseProps({ canConfirmRecovery: false }));
    expect(screen.getByRole("button", { name: PRIMARY_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: SECONDARY_LABEL })).not.toBeInTheDocument();
    expect(screen.getByText("復旧の確認を記録済みです。")).toBeInTheDocument();
  });
});

describe("RecoveryNotice: recovery-blocked", () => {
  function makeRecovery(overrides: Partial<RecoveryDto> = {}): RecoveryDto {
    return { blocked: true, runIds: [], ...overrides };
  }

  it("文言と、表示中の実行以外への runPath リンクが出る", async () => {
    const getRecovery = vi.fn(() =>
      Promise.resolve(makeRecovery({ runIds: ["run-1", "run-2", "run-3"] })),
    );
    renderNotice(
      baseProps({
        run: makeRun({ id: "run-1", status: "stopped", stopReason: "recovery-blocked" }),
      }),
      makeApiClient({ getRecovery }),
    );

    expect(screen.getByText(BLOCKED_NOTICE)).toBeInTheDocument();
    const run2Link = await screen.findByRole("link", { name: /run-2/ });
    expect(run2Link).toHaveAttribute("href", "/runs/run-2");
    expect(screen.getByRole("link", { name: /run-3/ })).toHaveAttribute("href", "/runs/run-3");
    // 表示中の実行（run-1）へのリンクは出ない。
    expect(screen.queryByRole("link", { name: /run-1/ })).not.toBeInTheDocument();
  });

  it("runIds が空ならリンクを出さず、文言だけ出す", async () => {
    const getRecovery = vi.fn(() => Promise.resolve(makeRecovery({ runIds: [] })));
    renderNotice(
      baseProps({
        run: makeRun({ id: "run-1", status: "stopped", stopReason: "recovery-blocked" }),
      }),
      makeApiClient({ getRecovery }),
    );

    await waitFor(() => expect(getRecovery).toHaveBeenCalledTimes(1));
    expect(screen.getByText(BLOCKED_NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    // 再開の操作が無い側なので、再開の注記も出さない（最終レビュー Minor 5）。
    expect(screen.queryByText(RESUME_SCOPE_NOTE)).not.toBeInTheDocument();
  });

  it("取得に失敗しても投げず、リンクを出さないだけにする（結果画面を落とさない）", async () => {
    const getRecovery = vi.fn(() => Promise.reject(new Error("network down")));
    renderNotice(
      baseProps({
        run: makeRun({ id: "run-1", status: "stopped", stopReason: "recovery-blocked" }),
      }),
      makeApiClient({ getRecovery }),
    );

    await waitFor(() => expect(getRecovery).toHaveBeenCalledTimes(1));
    expect(screen.getByText(BLOCKED_NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("stopReason === 'recovery-blocked' 以外では GET /api/recovery を呼ばない（常時取得にしない）", () => {
    const getRecovery = vi.fn(() => Promise.resolve(makeRecovery()));
    renderNotice(
      baseProps({ run: makeRun({ status: "stopped", stopReason: "aborted" }) }),
      makeApiClient({ getRecovery }),
    );
    expect(getRecovery).not.toHaveBeenCalled();
  });
});

describe("RecoveryNotice: それ以外の状態では何も描かない", () => {
  it.each(["running", "completed", "partially-failed"] as const)("status = %s", (status) => {
    const { container } = renderNotice(baseProps({ run: makeRun({ status }) }));
    expect(container.firstChild).toBeNull();
  });

  it("stopped だが recovery-blocked ではない", () => {
    const { container } = renderNotice(
      baseProps({ run: makeRun({ status: "stopped", stopReason: "aborted" }) }),
    );
    expect(container.firstChild).toBeNull();
  });
});
