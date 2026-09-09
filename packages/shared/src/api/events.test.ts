import { describe, expect, it } from "vitest";

import { runEventDtoSchema } from "./events.ts";

describe("runEventDtoSchema", () => {
  it("target-planned を受け入れる", () => {
    const result = runEventDtoSchema.safeParse({
      type: "target-planned",
      targetIndex: 0,
      target: { start: 0, end: 10 },
      input: { start: 0, end: 10 },
    });
    expect(result.success).toBe(true);
  });

  it("check-finished を受け入れる", () => {
    const result = runEventDtoSchema.safeParse({
      type: "check-finished",
      targetIndex: 0,
      perspective: "typo",
      status: "done",
    });
    expect(result.success).toBe(true);
  });

  it("recheck-finished を受け入れる（notApplicableReason あり）", () => {
    const result = runEventDtoSchema.safeParse({
      type: "recheck-finished",
      findingId: "finding-1",
      status: "not-applicable",
      notApplicableReason: "suppressed",
    });
    expect(result.success).toBe(true);
  });

  it("recheck-finished の notApplicableReason: null を受け入れる（disabled / suppressed 以外）", () => {
    const result = runEventDtoSchema.safeParse({
      type: "recheck-finished",
      findingId: "finding-1",
      status: "done",
      notApplicableReason: null,
    });
    expect(result.success).toBe(true);
  });

  it("recheck-finished の notApplicableReason 欠落を拒む（.optional() ではなく必須）", () => {
    const result = runEventDtoSchema.safeParse({
      type: "recheck-finished",
      findingId: "finding-1",
      status: "done",
    });
    expect(result.success).toBe(false);
  });

  it("stop-requested は type だけを受け入れる", () => {
    const result = runEventDtoSchema.safeParse({ type: "stop-requested" });
    expect(result.success).toBe(true);
  });

  it("stop-requested に余分なキーがあれば拒む", () => {
    const result = runEventDtoSchema.safeParse({ type: "stop-requested", extra: 1 });
    expect(result.success).toBe(false);
  });

  it("run-settled を受け入れる（stopReason: null）", () => {
    const result = runEventDtoSchema.safeParse({
      type: "run-settled",
      status: "completed",
      stopReason: null,
    });
    expect(result.success).toBe(true);
  });

  it("run-finished は判別子として未知（オーケストレーターは出さない。PR9b 決定 37）", () => {
    const result = runEventDtoSchema.safeParse({ type: "run-finished" });
    expect(result.success).toBe(false);
  });

  it("未知の type を拒む", () => {
    const result = runEventDtoSchema.safeParse({ type: "unknown-event" });
    expect(result.success).toBe(false);
  });
});
