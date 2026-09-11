/**
 * 採否と判断メモの操作子（`judgment-control.tsx`）の DOM テスト（Task 8、決定 13、R5）。
 *
 * `putJudgment` の呼び出しそのものは `results-page.tsx` の役割（状態の持ち主を 1 か所にする）
 * なので、ここでは `onSave` に渡す `vi.fn()` で代替し、以下だけを検査する：
 * - 4 状態（未判断・採用予定・却下・保留）がラジオで選べること
 * - メモの入力・空欄時に `null` を送ること
 * - 保存ボタンを押すまで `onSave` が呼ばれないこと、保存中はボタンが無効になること
 * - 失敗時にその場でエラーを出し、入力を保存前の値へ戻すこと
 * - 「採用予定を選んでも本文は書き換わりません」の趣旨の注記が常に見えること
 */

import type { JudgmentDto } from "@shuten/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JudgmentControlProps } from "./judgment-control.tsx";
import { JudgmentControl } from "./judgment-control.tsx";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function baseProps(overrides: Partial<JudgmentControlProps> = {}): JudgmentControlProps {
  return {
    judgment: {
      findingId: "finding-1",
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
    onSave: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe("JudgmentControl: 4 状態のラジオ", () => {
  it("未判断・採用予定・却下・保留の 4 つがラジオで選べ、現在値が選択されている", () => {
    render(
      <JudgmentControl
        {...baseProps({
          judgment: {
            findingId: "finding-1",
            status: "adopt-planned",
            note: null,
            updatedAt: "2026-09-10T00:00:00.000Z",
          },
        })}
      />,
    );

    const undecided = screen.getByRole("radio", { name: "未判断" });
    const adoptPlanned = screen.getByRole("radio", { name: "採用予定" });
    const rejected = screen.getByRole("radio", { name: "却下" });
    const held = screen.getByRole("radio", { name: "保留" });

    expect(undecided).not.toBeChecked();
    expect(adoptPlanned).toBeChecked();
    expect(rejected).not.toBeChecked();
    expect(held).not.toBeChecked();
  });
});

describe("JudgmentControl: 保存ボタンを押すまで送らない", () => {
  it("ラジオを選んでもメモを入力しても、保存ボタンを押すまで onSave は呼ばれない", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    render(<JudgmentControl {...baseProps({ onSave })} />);

    await user.click(screen.getByRole("radio", { name: "却下" }));
    await user.type(screen.getByRole("textbox"), "検討事項");

    expect(onSave).not.toHaveBeenCalled();
  });

  it("保存ボタンを押すと、選択中の状態とメモで onSave が呼ばれる", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    render(<JudgmentControl {...baseProps({ onSave })} />);

    await user.click(screen.getByRole("radio", { name: "却下" }));
    await user.type(screen.getByRole("textbox"), "検討事項");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("rejected", "検討事項");
  });

  it("メモが空欄のときは null を送る", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    render(<JudgmentControl {...baseProps({ onSave })} />);

    await user.click(screen.getByRole("radio", { name: "保留" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledWith("held", null);
  });
});

describe("JudgmentControl: メモの上限", () => {
  it("textarea は maxLength=2000 を持つ", () => {
    render(<JudgmentControl {...baseProps()} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.maxLength).toBe(2000);
  });
});

describe("JudgmentControl: 保存中の無効化", () => {
  it("保存中はボタンが無効になり、完了すると元に戻る", async () => {
    const user = userEvent.setup();
    const saveDeferred = deferred<void>();
    const onSave = vi.fn(() => saveDeferred.promise);
    render(<JudgmentControl {...baseProps({ onSave })} />);

    const button = screen.getByRole("button", { name: "保存" });
    await user.click(button);

    expect(screen.getByRole("button")).toBeDisabled();

    saveDeferred.resolve();
    await screen.findByRole("button", { name: "保存" });
    expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled();
  });
});

describe("JudgmentControl: 失敗時にエラーを出し、入力を保存前の値へ戻す", () => {
  it("onSave が reject したら、その場にエラーを出し、ラジオ・メモを保存前の値に戻す", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.reject(new Error("保存に失敗しました")));
    render(
      <JudgmentControl
        {...baseProps({
          judgment: {
            findingId: "finding-1",
            status: "undecided",
            note: "もとのメモ",
            updatedAt: "2026-09-10T00:00:00.000Z",
          },
          onSave,
        })}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "却下" }));
    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "変更後のメモ");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("保存に失敗しました")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "未判断" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "却下" })).not.toBeChecked();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("もとのメモ");
  });
});

describe("JudgmentControl: PR21 レビュー指摘 1 未編集なら新しい judgment に追従する", () => {
  it("ラジオ・メモのどちらも触っていなければ、judgment が更新されたら追従する", () => {
    const judgmentA: JudgmentDto = {
      findingId: "finding-1",
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    const { rerender } = render(<JudgmentControl {...baseProps({ judgment: judgmentA })} />);
    expect(screen.getByRole("radio", { name: "未判断" })).toBeChecked();

    // `updatedAt` が変わった（＝実際に値が変わった）新しい judgment で再レンダーする。
    // `results-page.tsx` が「最新の状態を取得」のたびに `findings` 配列ごと新しい参照で作り直す
    // のを模す（参照だけでなく `updatedAt` も変える——参照比較ではなく値で判定していることを
    // このテストで固定する）。
    const judgmentB: JudgmentDto = {
      findingId: "finding-1",
      status: "held",
      note: "サーバー側のメモ",
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    rerender(<JudgmentControl {...baseProps({ judgment: judgmentB })} />);

    expect(screen.getByRole("radio", { name: "保留" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "未判断" })).not.toBeChecked();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("サーバー側のメモ");
  });
});

describe("JudgmentControl: PR21 レビュー指摘 1 編集中は上書きせず、更新された旨を示す", () => {
  it("編集中に judgment が更新されても入力は保たれ、注記が出る", async () => {
    const user = userEvent.setup();
    const judgmentA: JudgmentDto = {
      findingId: "finding-1",
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    const { rerender } = render(<JudgmentControl {...baseProps({ judgment: judgmentA })} />);

    await user.click(screen.getByRole("radio", { name: "却下" }));
    expect(screen.queryByText(/採否が別の場所で更新されました/)).not.toBeInTheDocument();

    const judgmentB: JudgmentDto = {
      findingId: "finding-1",
      status: "held",
      note: null,
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    rerender(<JudgmentControl {...baseProps({ judgment: judgmentB })} />);

    // 編集中の入力（却下）を勝手に上書きしない。
    expect(screen.getByRole("radio", { name: "却下" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "保留" })).not.toBeChecked();
    // 別の場所で更新されたことは示す。
    expect(screen.getByText(/採否が別の場所で更新されました/)).toBeInTheDocument();
  });
});

describe("JudgmentControl: 採用予定の注記は常に表示される（決定 13）", () => {
  it("未判断を選んでいる状態でも、本文を書き換えない旨の注記が見える", () => {
    render(<JudgmentControl {...baseProps()} />);
    expect(screen.getByText(/採用予定.*本文.*書き換わりません/)).toBeInTheDocument();
  });

  it("採用予定を選んだ状態でも同じ注記が見える（選んだときだけ出す、にしない）", async () => {
    const user = userEvent.setup();
    render(<JudgmentControl {...baseProps()} />);
    await user.click(screen.getByRole("radio", { name: "採用予定" }));
    expect(screen.getByText(/採用予定.*本文.*書き換わりません/)).toBeInTheDocument();
  });
});
