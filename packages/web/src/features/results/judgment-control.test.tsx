/**
 * 採否と判断メモの操作子（`judgment-control.tsx`）の DOM テスト（Task 8、決定 13、R5）。
 *
 * `putJudgment` の呼び出しそのものは `results-page.tsx` の役割（状態の持ち主を 1 か所にする）
 * なので、ここでは `onSave` に渡す `vi.fn()` で代替し、以下だけを検査する：
 * - 4 状態（未判断・採用予定・却下・保留）がラジオで選べること
 * - ラジオを選んだ時点で、その時点のメモと一緒に保存すること（保存ボタンは無い）
 * - メモは入力欄から離れた時点で、値が変わっていれば保存すること・空欄時に `null` を送ること
 * - 保存を直列にし、メモの入力中にラジオを選んでもその選択が失われないこと
 * - 失敗時にその場でエラーを出し、入力をサーバーの値へ戻し、送信待ちの値を送らないこと
 * - 保存の状況を「保存中…」「保存しました」で知らせること
 * - 「採用予定を選んでも本文は書き換わりません」の趣旨の注記が常に見えること
 */

import type { JudgmentDto, JudgmentStatus } from "@shuten/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import controls from "../../styles/controls.module.css";
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

type OnSave = (status: JudgmentStatus, note: string | null) => Promise<void>;

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

describe("JudgmentControl: 操作した時点で保存する", () => {
  it("保存ボタンは無い", () => {
    render(<JudgmentControl {...baseProps()} />);
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("ラジオを選ぶと、その場で onSave が呼ばれる", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<OnSave>(() => Promise.resolve());
    render(<JudgmentControl {...baseProps({ onSave })} />);

    await user.click(screen.getByRole("radio", { name: "却下" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("rejected", null);
  });

  it("ラジオだけを選んだときも、入力欄の現在のメモを一緒に送る（メモを消さない）", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<OnSave>(() => Promise.resolve());
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

    await user.click(screen.getByRole("radio", { name: "保留" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("held", "もとのメモ");
  });

  it("メモは入力中には送らず、入力欄から離れた時点で保存する", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<OnSave>(() => Promise.resolve());
    render(<JudgmentControl {...baseProps({ onSave })} />);

    await user.type(screen.getByRole("textbox"), "検討事項");
    expect(onSave).not.toHaveBeenCalled();

    await user.tab();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("undecided", "検討事項");
  });

  it("メモを変えずに入力欄から離れても onSave は呼ばれない", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<OnSave>(() => Promise.resolve());
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

    await user.click(screen.getByRole("textbox"));
    await user.tab();

    expect(onSave).not.toHaveBeenCalled();
  });

  it("保存済みと同じ値に戻してから離れても onSave は呼ばれない", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<OnSave>(() => Promise.resolve());
    render(<JudgmentControl {...baseProps({ onSave })} />);

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "あ");
    await user.tab();
    expect(onSave).toHaveBeenCalledTimes(1);

    await user.type(textarea, "い");
    await user.type(textarea, "{Backspace}");
    await user.tab();

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("メモを空欄にして離れたときは null を送る", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<OnSave>(() => Promise.resolve());
    render(
      <JudgmentControl
        {...baseProps({
          judgment: {
            findingId: "finding-1",
            status: "held",
            note: "もとのメモ",
            updatedAt: "2026-09-10T00:00:00.000Z",
          },
          onSave,
        })}
      />,
    );

    await user.clear(screen.getByRole("textbox"));
    await user.tab();

    expect(onSave).toHaveBeenCalledWith("held", null);
  });
});

describe("JudgmentControl: 保存の直列化", () => {
  it("保存中もラジオと入力欄は無効にならない", async () => {
    const user = userEvent.setup();
    const saveDeferred = deferred<void>();
    const onSave = vi.fn<OnSave>(() => saveDeferred.promise);
    render(<JudgmentControl {...baseProps({ onSave })} />);

    await user.click(screen.getByRole("radio", { name: "却下" }));

    expect(screen.getByRole("radio", { name: "保留" })).not.toBeDisabled();
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    await act(async () => saveDeferred.resolve());
  });

  it("メモを入力したままラジオを選ぶと、メモが先に保存され、ラジオの選択も失われずに後から保存される", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const onSave = vi
      .fn<OnSave>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => Promise.resolve());
    render(<JudgmentControl {...baseProps({ onSave })} />);

    await user.type(screen.getByRole("textbox"), "検討事項");
    // ラジオのクリックで、先に入力欄の blur が起きてメモの保存が始まる。
    await user.click(screen.getByRole("radio", { name: "却下" }));

    // 同時に送るのは 1 つまで。ラジオの保存は実行中の保存が終わるまで待つ。
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenNthCalledWith(1, "undecided", "検討事項");
    expect(screen.getByRole("radio", { name: "却下" })).toBeChecked();

    await act(async () => first.resolve());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenNthCalledWith(2, "rejected", "検討事項");
    expect(screen.getByRole("radio", { name: "却下" })).toBeChecked();
  });

  it("保存中に続けて求められた保存は、最後のものだけを送る", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const onSave = vi
      .fn<OnSave>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => Promise.resolve());
    render(<JudgmentControl {...baseProps({ onSave })} />);

    await user.click(screen.getByRole("radio", { name: "却下" }));
    await user.click(screen.getByRole("radio", { name: "保留" }));
    await user.click(screen.getByRole("radio", { name: "採用予定" }));
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenNthCalledWith(2, "adopt-planned", null);
    await screen.findByText("保存しました");
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("保存中に、保存中の値へ戻したら、送信待ちを取り消して余分に送らない", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const onSave = vi
      .fn<OnSave>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => Promise.resolve());
    render(<JudgmentControl {...baseProps({ onSave })} />);

    await user.click(screen.getByRole("radio", { name: "却下" }));
    await user.click(screen.getByRole("radio", { name: "保留" }));
    await user.click(screen.getByRole("radio", { name: "却下" }));

    await act(async () => first.resolve());

    await screen.findByText("保存しました");
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe("JudgmentControl: メモの上限", () => {
  it("textarea は maxLength=2000 を持つ", () => {
    render(<JudgmentControl {...baseProps()} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.maxLength).toBe(2000);
  });
});

describe("JudgmentControl: 保存の状況の表示", () => {
  it("保存中は「保存中…」、成功すると「保存しました」を出し、メモを書き換えると消える", async () => {
    const user = userEvent.setup();
    const saveDeferred = deferred<void>();
    const onSave = vi
      .fn<OnSave>()
      .mockImplementationOnce(() => saveDeferred.promise)
      .mockImplementation(() => Promise.resolve());
    render(<JudgmentControl {...baseProps({ onSave })} />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");

    await user.click(screen.getByRole("radio", { name: "却下" }));
    expect(status).toHaveTextContent("保存中…");

    await act(async () => saveDeferred.resolve());
    await waitFor(() => expect(status).toHaveTextContent("保存しました"));

    await user.type(screen.getByRole("textbox"), "あ");
    expect(status).not.toHaveTextContent("保存しました");
  });
});

describe("JudgmentControl: 失敗時にエラーを出し、入力をサーバーの値へ戻す", () => {
  it("onSave が reject したら、その場にエラーを出し、ラジオ・メモをサーバーの値に戻す", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<OnSave>(() => Promise.reject(new Error("保存に失敗しました")));
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

    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "変更後のメモ");
    await user.click(screen.getByRole("radio", { name: "却下" }));

    expect(await screen.findByText("保存に失敗しました")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "未判断" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "却下" })).not.toBeChecked();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("もとのメモ");
    expect(screen.getByRole("status")).not.toHaveTextContent("保存しました");
  });

  it("実行中の保存が失敗したら、送信待ちの値は送らない", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const onSave = vi
      .fn<OnSave>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => Promise.resolve());
    render(<JudgmentControl {...baseProps({ onSave })} />);

    await user.click(screen.getByRole("radio", { name: "却下" }));
    await user.click(screen.getByRole("radio", { name: "保留" }));

    await act(async () => first.reject(new Error("保存に失敗しました")));

    expect(await screen.findByText("保存に失敗しました")).toBeInTheDocument();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("radio", { name: "未判断" })).toBeChecked();
  });

  it("直列化した 1 本目が成功し 2 本目が失敗したら、1 本目の値へ戻す（PR #41 レビュー指摘 1）", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const second = deferred<void>();
    const onSave = vi
      .fn<OnSave>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    // 親は judgment prop を更新しない（resolve の前に新しい prop が届く保証は無い）。
    render(<JudgmentControl {...baseProps({ onSave })} />);

    await user.click(screen.getByRole("radio", { name: "却下" }));
    await user.click(screen.getByRole("radio", { name: "保留" }));

    await act(async () => first.resolve());
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith("held", null);

    await act(async () => second.reject(new Error("保存に失敗しました")));

    expect(await screen.findByText("保存に失敗しました")).toBeInTheDocument();
    // サーバーに保存済みなのは 1 本目の「却下」。初期値の「未判断」へは戻さない。
    expect(screen.getByRole("radio", { name: "却下" })).toBeChecked();
  });
});

describe("JudgmentControl: PR21 レビュー指摘 1 未編集なら新しい judgment に追従する", () => {
  it("メモを書きかけていなければ、judgment が更新されたら追従する", () => {
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

  it("追従したあとは、追従した値を基準に送るかどうかを決める", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<OnSave>(() => Promise.resolve());
    const judgmentA: JudgmentDto = {
      findingId: "finding-1",
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    const { rerender } = render(
      <JudgmentControl {...baseProps({ judgment: judgmentA, onSave })} />,
    );
    const judgmentB: JudgmentDto = {
      findingId: "finding-1",
      status: "held",
      note: "サーバー側のメモ",
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    rerender(<JudgmentControl {...baseProps({ judgment: judgmentB, onSave })} />);

    await user.click(screen.getByRole("textbox"));
    await user.tab();

    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("JudgmentControl: PR21 レビュー指摘 1 編集中は上書きせず、更新された旨を示す", () => {
  it("メモの書きかけ中に judgment が更新されても入力は保たれ、注記が出る", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<OnSave>(() => Promise.resolve());
    const judgmentA: JudgmentDto = {
      findingId: "finding-1",
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    const { rerender } = render(
      <JudgmentControl {...baseProps({ judgment: judgmentA, onSave })} />,
    );

    await user.type(screen.getByRole("textbox"), "書きかけ");
    expect(screen.queryByText(/採否が別の場所で更新されました/)).not.toBeInTheDocument();

    const judgmentB: JudgmentDto = {
      findingId: "finding-1",
      status: "held",
      note: null,
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    rerender(<JudgmentControl {...baseProps({ judgment: judgmentB, onSave })} />);

    // 編集中の入力を勝手に上書きしない。
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("書きかけ");
    expect(screen.getByRole("radio", { name: "未判断" })).toBeChecked();
    // 別の場所で更新されたことは示す。
    expect(screen.getByText(/採否が別の場所で更新されました/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("自分の保存の応答が反映されただけなら、メモの書きかけ中でも注記を出さない", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<OnSave>(() => Promise.resolve());
    const judgmentA: JudgmentDto = {
      findingId: "finding-1",
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    const { rerender } = render(
      <JudgmentControl {...baseProps({ judgment: judgmentA, onSave })} />,
    );

    await user.click(screen.getByRole("radio", { name: "却下" }));
    await user.type(screen.getByRole("textbox"), "書きかけ");

    // 却下の保存の応答（呼び出し側が反映した judgment）が、書きかけの最中に届く。
    const judgmentB: JudgmentDto = {
      findingId: "finding-1",
      status: "rejected",
      note: null,
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    rerender(<JudgmentControl {...baseProps({ judgment: judgmentB, onSave })} />);

    expect(screen.queryByText(/採否が別の場所で更新されました/)).not.toBeInTheDocument();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("書きかけ");
    expect(screen.getByRole("radio", { name: "却下" })).toBeChecked();
  });

  it("書きかけのメモと同じ値の更新が届いたあと、メモから離れたら注記を下ろす（PR #41 レビュー指摘 2）", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<OnSave>(() => Promise.resolve());
    const judgmentA: JudgmentDto = {
      findingId: "finding-1",
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    const { rerender } = render(
      <JudgmentControl {...baseProps({ judgment: judgmentA, onSave })} />,
    );

    await user.type(screen.getByRole("textbox"), "同じメモ");
    const judgmentB: JudgmentDto = {
      findingId: "finding-1",
      status: "undecided",
      note: "同じメモ",
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    rerender(<JudgmentControl {...baseProps({ judgment: judgmentB, onSave })} />);
    expect(screen.getByText(/採否が別の場所で更新されました/)).toBeInTheDocument();

    await user.tab(); // メモから離れる

    // 入力はサーバーの値と同じなので送らず、注記も消える。
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByText(/採否が別の場所で更新されました/)).not.toBeInTheDocument();
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

describe("JudgmentControl: 共通の部品（PR14c）", () => {
  it("判断メモは入力欄の部品を使う", () => {
    render(<JudgmentControl {...baseProps()} />);
    expect(screen.getByRole("textbox").className).toContain(controls.input);
  });

  it("保存の失敗はエラーの枠で出る", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<OnSave>(() => Promise.reject(new Error("保存に失敗しました")));
    render(<JudgmentControl {...baseProps({ onSave })} />);
    await user.click(screen.getByRole("radio", { name: "却下" }));
    expect((await screen.findByText("保存に失敗しました")).className).toContain(controls.errorBox);
  });
});
