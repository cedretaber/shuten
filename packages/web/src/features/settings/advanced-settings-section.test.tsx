/**
 * 設定画面の「詳細な検査設定」節（PR11c 決定 1。計画書 S4-6 と、メイン画面から移した W7-1 の
 * 詳細 8 項目分）。
 *
 * この節は入力欄しか持たない（見出しと説明は `app/settings-page.tsx` 側）。`<Link>` も無いので
 * `MemoryRouter` は要らない。保存ボタンも無く、変更した時点で `localStorage` へ書く。
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { readAdvancedRunSettings } from "../../storage/run-settings.ts";
import { AdvancedSettingsSection } from "./advanced-settings-section.tsx";

beforeEach(() => {
  localStorage.clear();
});

describe("AdvancedSettingsSection: 初期値と単位表示（W7-1）", () => {
  it("初期値が RUN_SETTINGS_DEFAULTS と一致する（タイムアウトは秒、丸め許容はパーセントで表示）", () => {
    render(<AdvancedSettingsSection />);

    expect(screen.getByLabelText("初回検査のタイムアウト（秒）")).toHaveValue(300); // 秒表示
    expect(screen.getByLabelText("再確認のタイムアウト（秒）")).toHaveValue(300);
    expect(screen.getByLabelText("段落境界への丸め許容（%）")).toHaveValue(20); // パーセント表示
    expect(screen.getByLabelText("最大トークン数")).toHaveValue(16_000);
    expect(screen.getByLabelText("温度")).toHaveValue(0);
    expect(screen.getByLabelText("入力上限（字）")).toHaveValue(12_000);
    // type="number" の空欄は jest-dom の toHaveValue では null になる。
    expect(screen.getByLabelText("シード（空欄で省略）")).toHaveValue(null);
    expect(screen.getByLabelText("思考の強さ")).toHaveValue("none");
  });
});

describe("AdvancedSettingsSection: 保存と復元（S4-6）", () => {
  it("詳細の入力を変えると保存され、再マウントで復元される", () => {
    const { unmount } = render(<AdvancedSettingsSection />);

    fireEvent.change(screen.getByLabelText("温度"), { target: { value: "0.8" } });
    fireEvent.change(screen.getByLabelText("初回検査のタイムアウト（秒）"), {
      target: { value: "600" },
    });
    fireEvent.change(screen.getByLabelText("シード（空欄で省略）"), { target: { value: "42" } });

    // 保存形式（ミリ秒）で書かれていること。
    expect(readAdvancedRunSettings().timeouts.checkMs).toBe(600_000);

    unmount();
    render(<AdvancedSettingsSection />);

    expect(screen.getByLabelText("温度")).toHaveValue(0.8);
    expect(screen.getByLabelText("初回検査のタイムアウト（秒）")).toHaveValue(600); // 秒に戻る
    expect(screen.getByLabelText("シード（空欄で省略）")).toHaveValue(42);
  });

  it("丸め許容はパーセント入力を 0〜1 で保存する", () => {
    render(<AdvancedSettingsSection />);

    fireEvent.change(screen.getByLabelText("段落境界への丸め許容（%）"), {
      target: { value: "30" },
    });

    expect(readAdvancedRunSettings().roundingTolerance).toBe(0.3);
  });

  it("シードを空欄に戻すと保存値から seed がキーごと消える", () => {
    render(<AdvancedSettingsSection />);

    fireEvent.change(screen.getByLabelText("シード（空欄で省略）"), { target: { value: "42" } });
    expect(readAdvancedRunSettings().generation.seed).toBe(42);

    fireEvent.change(screen.getByLabelText("シード（空欄で省略）"), { target: { value: "" } });
    expect("seed" in readAdvancedRunSettings().generation).toBe(false);
  });
});
