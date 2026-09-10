/**
 * メイン画面に残す詳細設定の要約（PR11c 決定 6、計画書 S5-3・S5-4）。
 *
 * この部品は表示だけを持つ。状態は `run-settings-form.tsx` が持つので、ここでは
 * 「渡した設定がどう文章になるか」と「既定値のままなら戻すボタンが押せないこと」を見る。
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ADVANCED_RUN_SETTINGS_DEFAULTS } from "../../storage/run-settings.ts";
import { AdvancedSettingsSummary } from "./advanced-settings-summary.tsx";

function renderSummary(settings = ADVANCED_RUN_SETTINGS_DEFAULTS, onReset = vi.fn()) {
  render(
    <MemoryRouter>
      <AdvancedSettingsSummary settings={settings} onReset={onReset} />
    </MemoryRouter>,
  );
  return { onReset };
}

describe("AdvancedSettingsSummary", () => {
  it("S5-3: 変更が 3 件以上のとき、先頭 2 件が名前と値で出て、残りは「ほか N 項目」に畳まれる", () => {
    renderSummary({
      generation: {
        ...ADVANCED_RUN_SETTINGS_DEFAULTS.generation,
        temperature: 0.8,
        reasoningEffort: "high",
      },
      roundingTolerance: 0.3,
      maxInputGraphemes: 20_000,
      timeouts: ADVANCED_RUN_SETTINGS_DEFAULTS.timeouts,
    });

    expect(
      screen.getByText("詳細設定：温度 0.8、思考の強さ 強い、ほか 2 項目"),
    ).toBeInTheDocument();
  });

  it("S5-3: 変更が 2 件までなら「ほか N 項目」を付けない", () => {
    renderSummary({
      ...ADVANCED_RUN_SETTINGS_DEFAULTS,
      generation: { ...ADVANCED_RUN_SETTINGS_DEFAULTS.generation, temperature: 0.8 },
      timeouts: { ...ADVANCED_RUN_SETTINGS_DEFAULTS.timeouts, checkMs: 600_000 },
    });

    expect(
      screen.getByText("詳細設定：温度 0.8、初回検査のタイムアウト 600 秒"),
    ).toBeInTheDocument();
  });

  it("S5-4: 変更が 0 件なら「既定値」と出て、「既定値に戻す」は disabled", () => {
    renderSummary();

    expect(screen.getByText("詳細設定：既定値")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "既定値に戻す" })).toBeDisabled();
  });

  it("S5-4: 変更があれば「既定値に戻す」は押せて、onReset を呼ぶだけ", () => {
    const { onReset } = renderSummary({
      ...ADVANCED_RUN_SETTINGS_DEFAULTS,
      generation: { ...ADVANCED_RUN_SETTINGS_DEFAULTS.generation, temperature: 0.8 },
    });

    const button = screen.getByRole("button", { name: "既定値に戻す" });
    expect(button).not.toBeDisabled();

    fireEvent.click(button);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("設定画面への入口が出る", () => {
    renderSummary();

    expect(screen.getByRole("link", { name: "設定を開く" })).toHaveAttribute("href", "/settings");
  });
});
