import { describe, expect, it, vi } from "vitest";

import { createStopGate } from "./recovery.ts";

describe("createStopGate", () => {
  it("R1: 実行中の要求が無いときの requestStop() はただちに abort する", () => {
    const gate = createStopGate(500);

    gate.requestStop();

    expect(gate.stopRequested).toBe(true);
    expect(gate.signal.aborted).toBe(true);
    gate.dispose();
  });

  it("R2: beginRequest() 中の requestStop() は abort を予約し、recoveryConfirmMs 未満では abort しない", async () => {
    vi.useFakeTimers();
    try {
      const gate = createStopGate(500);
      gate.beginRequest();

      gate.requestStop();
      expect(gate.stopRequested).toBe(true);
      expect(gate.signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(499);
      expect(gate.signal.aborted).toBe(false);

      gate.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("R3: requestStop() を呼ばずに beginRequest()/endRequest() を終えても、recoveryConfirmMs を過ぎて abort しない", async () => {
    vi.useFakeTimers();
    try {
      const gate = createStopGate(500);
      gate.beginRequest();
      gate.endRequest();

      await vi.advanceTimersByTimeAsync(1000);
      expect(gate.signal.aborted).toBe(false);
      expect(gate.stopRequested).toBe(false);

      gate.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("R4: stopRequested が立っているときの endRequest() はその場で abort する（決定 26）", async () => {
    vi.useFakeTimers();
    try {
      const gate = createStopGate(500);
      gate.beginRequest();
      gate.requestStop();
      expect(gate.signal.aborted).toBe(false);

      // recoveryConfirmMs（500ms）にまだ達していない時点で応答が届いて終わった状況。
      await vi.advanceTimersByTimeAsync(100);
      gate.endRequest();

      // タイマーの発火（t=500）を待たずに、t=100 の endRequest() の時点でその場で
      // abort している（abort は不可逆なので、この後の dispose()/時間経過では
      // 「予約されていたタイマーが残っていないこと」自体は検査できない。それは R7 の役目）。
      expect(gate.signal.aborted).toBe(true);

      gate.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("R5: recoveryConfirmMs の経過で abort する", async () => {
    vi.useFakeTimers();
    try {
      const gate = createStopGate(500);
      gate.beginRequest();
      gate.requestStop();

      await vi.advanceTimersByTimeAsync(500);
      expect(gate.signal.aborted).toBe(true);

      gate.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("R6: requestStop() は冪等（2 回呼んでもタイマーが 2 本にならない）", async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const gate = createStopGate(500);
      gate.beginRequest();

      gate.requestStop();
      gate.requestStop();
      gate.requestStop();

      // タイマーを張るのは最初の requestStop() だけ。2 回目・3 回目が「冪等」と言えるのは、
      // ここで setTimeout が複数回呼ばれず 1 回だけであること（＝タイマーが 2 本以上に
      // ならないこと）で確かめられる。
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      // 2 回目・3 回目の requestStop() が（冪等ではなく）即座に abort してしまう変異も、
      // ここでまだ abort していないことを確かめれば検出できる。
      expect(gate.signal.aborted).toBe(false);

      setTimeoutSpy.mockRestore();
      gate.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("R7: dispose() がタイマーを解除する", async () => {
    vi.useFakeTimers();
    try {
      const gate = createStopGate(500);
      gate.beginRequest();
      gate.requestStop();

      gate.dispose();
      await vi.advanceTimersByTimeAsync(500);

      // dispose() でタイマーが解除されているので、recoveryConfirmMs を過ぎても abort しない。
      expect(gate.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
