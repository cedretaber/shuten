/**
 * 詳細設定の往復（PR11c 決定 5・7。計画書 S7-1）。
 *
 * **この PR でいちばん重要なテスト。** S4・S5 は「保存値」と「再マウント後の表示」しか見ないので、
 * 実装が `localStorage` だけを更新して React の state を放置していても通ってしまう。ここでは
 * `App` 全体を `MemoryRouter` で描き、画面をまたいだ 1 本の流れで決定 5・決定 7 の接合部を確かめる。
 *
 * 1. `/settings` で詳細設定（温度と初回検査のタイムアウト）を変える
 * 2. ヘッダーの「朱点」でホームへ戻る
 * 3. 要約に変更後の値が名前と値で出る
 * 4. そのまま開始し、`startRun` の要求本文に変更後の値が API の単位で入る
 * 5. 「既定値に戻す」を押す
 * 6. **再マウントせずに**要約が「既定値」になり、ボタンが disabled になる
 * 7. そのまま開始し、要求本文に既定値が入る
 * 8. 基本の持ち分（検査観点・分割長）は 1〜7 のあいだ変わらない
 *
 * `startRun` は要求本文を記録したうえで**確定した 4xx**（`ApiRequestError`）を返す。成功を返すと
 * ホーム画面が `/runs/:id` へ遷移してしまい、次の手順に進めない。4xx なら決定 15 のとおり
 * スナップショットは破棄され、再試行の案内も残らないので、そのまま次の開始に進める。
 *
 * 手順 8 のために、基本の持ち分は**既定値と違う値**を仕込んでおく。既定値のままだと、
 * 「戻す」が基本まで既定値へ踏みつぶす実装でもこのテストが通ってしまう。
 */

import type {
  ConnectionCheckDto,
  ConnectionSettingsDto,
  ManuscriptVersionDto,
  ModelInfoDto,
  RunDto,
  StartRunRequest,
} from "@shuten/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import type { ApiClient } from "./api/client.ts";
import { ApiRequestError } from "./api/errors.ts";
import { ROUTES } from "./app/routes.ts";
import { STORAGE_KEYS } from "./storage/keys.ts";
import { writeStored } from "./storage/local.ts";
import {
  BASIC_RUN_SETTINGS_DEFAULTS,
  readBasicRunSettings,
  writeBasicRunSettings,
} from "./storage/run-settings.ts";

const MODEL_ID = "model-a";
const MANUSCRIPT_VERSION_ID = "mv-1";

function makeModel(): ModelInfoDto {
  return {
    id: MODEL_ID,
    type: "llm",
    state: "loaded",
    quantization: null,
    maxContextLength: null,
    loadedContextLength: null,
  };
}

/** 選択モデルが `state: "loaded"` の `llm` として入った応答（`canStartWithModel` が true になる）。 */
function makeCheck(): ConnectionCheckDto {
  return {
    reachable: true,
    error: null,
    models: [makeModel()],
    model: { id: MODEL_ID, found: true, state: "loaded", loaded: true },
  };
}

function makeSettings(): ConnectionSettingsDto {
  return { endpointUrl: "http://127.0.0.1:1234", hasApiKey: false };
}

function makeVersion(): ManuscriptVersionDto {
  return {
    id: MANUSCRIPT_VERSION_ID,
    name: "原稿.txt",
    body: "山路を登りながら、こう考えた。",
    bodyHash: "hash-1",
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}

/** `startRun` に渡された要求本文の記録。応答は確定した 4xx で返す。 */
function makeClient(bodies: StartRunRequest[]): ApiClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`${name} は呼ばれない想定`);
  };
  return {
    getConnection: vi.fn(() => Promise.resolve(makeSettings())),
    putConnection: notImplemented("putConnection"),
    checkConnection: vi.fn(() => Promise.resolve(makeCheck())),
    createManuscript: notImplemented("createManuscript"),
    uploadManuscript: notImplemented("uploadManuscript"),
    getManuscript: vi.fn(() => Promise.resolve(makeVersion())),
    startRun: vi.fn((body: StartRunRequest): Promise<RunDto> => {
      bodies.push(body);
      return Promise.reject(new ApiRequestError(400, "invalid_request", "検査を開始できません"));
    }),
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
  };
}

/** 開始ボタンを押し、`startRun` が n 回呼ばれるまで待つ。 */
async function clickStart(bodies: StartRunRequest[], expectedCalls: number) {
  const button = screen.getByRole("button", { name: "検査を開始する" });
  await waitFor(() => expect(button).not.toBeDisabled());

  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(bodies).toHaveLength(expectedCalls));
}

beforeEach(() => {
  localStorage.clear();
});

describe("詳細設定の往復（S7-1）", () => {
  it("設定画面で変えた詳細設定が、要約と開始要求に届き、「既定値に戻す」が再マウント無しで両方に効く", async () => {
    // 準備：確定済みの原稿版と選択モデル、そして**既定値と違う**基本設定。
    writeStored(STORAGE_KEYS.manuscriptVersionId, MANUSCRIPT_VERSION_ID);
    writeStored(STORAGE_KEYS.selectedModelId, MODEL_ID);
    const basic = {
      ...BASIC_RUN_SETTINGS_DEFAULTS,
      perspectives: ["typo"] as const,
      targetGraphemes: 2_000,
    };
    writeBasicRunSettings(basic);

    const bodies: StartRunRequest[] = [];
    render(
      <MemoryRouter initialEntries={[ROUTES.settings]}>
        <App client={makeClient(bodies)} />
      </MemoryRouter>,
    );

    // --- 手順 1：設定画面で詳細設定を変える ---
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "詳細な検査設定" })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("温度"), { target: { value: "0.8" } });
    fireEvent.change(screen.getByLabelText("初回検査のタイムアウト（秒）"), {
      target: { value: "600" },
    });

    // --- 手順 2：ヘッダーの「朱点」でホームへ戻る ---
    fireEvent.click(screen.getByRole("link", { name: "朱点" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "原稿と検査設定" })).toBeInTheDocument(),
    );

    // --- 手順 3：要約に変更後の値が名前と値で出る ---
    expect(
      screen.getByText("詳細設定：温度 0.8、初回検査のタイムアウト 600 秒"),
    ).toBeInTheDocument();

    // --- 手順 4：そのまま開始する。要求本文は API の単位（ミリ秒・0〜1） ---
    await clickStart(bodies, 1);
    const first = bodies[0];
    expect(first?.generation.temperature).toBe(0.8);
    expect(first?.timeouts).toEqual({ checkMs: 600_000, recheckMs: 300_000 });
    expect(first?.chunkSettings.roundingTolerance).toBe(0.2);
    // 手順 8：基本の持ち分は仕込んだ値のまま。
    expect(first?.chunkSettings.targetGraphemes).toBe(2_000);
    expect(first?.perspectives).toEqual(["typo"]);

    // --- 手順 5：「既定値に戻す」を押す ---
    const resetButton = screen.getByRole("button", { name: "既定値に戻す" });
    expect(resetButton).not.toBeDisabled();
    fireEvent.click(resetButton);

    // --- 手順 6：再マウントせずに要約が「既定値」になり、ボタンが disabled になる ---
    // ここが決定 5 の要。`resetAdvancedRunSettings()` の戻り値を捨てて `localStorage` だけを
    // 書く実装だと、画面の state は古いままなのでこの 2 行が落ちる。
    expect(screen.getByText("詳細設定：既定値")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "既定値に戻す" })).toBeDisabled();

    // --- 手順 7：そのまま開始すると、要求本文には既定値が入る ---
    await clickStart(bodies, 2);
    const second = bodies[1];
    expect(second?.generation.temperature).toBe(0);
    expect(second?.timeouts).toEqual({ checkMs: 300_000, recheckMs: 300_000 });
    expect(second?.chunkSettings.roundingTolerance).toBe(0.2);

    // --- 手順 8：基本の持ち分は 1〜7 のあいだ変わらない ---
    expect(second?.chunkSettings.targetGraphemes).toBe(2_000);
    expect(second?.perspectives).toEqual(["typo"]);
    expect(screen.getByLabelText("検査対象の分割長（字）")).toHaveValue(2_000);
    expect(screen.getByLabelText("誤字・脱字")).toBeChecked();
    expect(screen.getByLabelText("日本語の自然さ")).not.toBeChecked();
    expect(readBasicRunSettings()).toEqual(basic);
  });
});
