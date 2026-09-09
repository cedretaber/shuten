import { describe, expect, it } from "vitest";

import { createRecoveryGate } from "./recovery-gate.ts";

describe("createRecoveryGate", () => {
  it("初期状態では blocked が false で blockedRunIds が空", () => {
    const gate = createRecoveryGate();

    expect(gate.blocked).toBe(false);
    expect(gate.blockedRunIds.size).toBe(0);
  });

  it("block(runId) で blocked が true になり、blockedRunIds に含まれる", () => {
    const gate = createRecoveryGate();

    gate.block("run-a");

    expect(gate.blocked).toBe(true);
    expect(gate.blockedRunIds.has("run-a")).toBe(true);
  });

  it("同じ ID の二重 block は無害（blockedRunIds が 1 件のまま）", () => {
    const gate = createRecoveryGate();

    gate.block("run-a");
    gate.block("run-a");

    expect(gate.blockedRunIds.size).toBe(1);
    expect(gate.blocked).toBe(true);
  });

  it("block していない ID の unblock は無害（例外を投げず、状態も変わらない）", () => {
    const gate = createRecoveryGate();

    expect(() => {
      gate.unblock("run-nonexistent");
    }).not.toThrow();
    expect(gate.blocked).toBe(false);
    expect(gate.blockedRunIds.size).toBe(0);
  });

  it("複数 ID が block されている間は、1 件を unblock しても blocked は true のまま", () => {
    const gate = createRecoveryGate();

    gate.block("run-a");
    gate.block("run-b");
    gate.unblock("run-a");

    expect(gate.blockedRunIds.has("run-a")).toBe(false);
    expect(gate.blockedRunIds.has("run-b")).toBe(true);
    expect(gate.blocked).toBe(true);
  });

  it("最後の 1 件を unblock すると blocked が false に戻る", () => {
    const gate = createRecoveryGate();

    gate.block("run-a");
    gate.unblock("run-a");

    expect(gate.blocked).toBe(false);
    expect(gate.blockedRunIds.size).toBe(0);
  });
});
