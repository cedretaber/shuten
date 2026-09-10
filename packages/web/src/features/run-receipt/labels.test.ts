/**
 * `RUN_STATUS_LABELS` / `RUN_STOP_REASON_LABELS` の網羅性（W8-2〜3、決定 16）。
 *
 * `RUN_STATUSES` / `RUN_STOP_REASONS`（shared の正本）を回して、すべての値に空でない
 * ラベルが付くことを確認する。1 つずつ手で並べて比較すると、shared 側に値が増えても
 * このテストは気づけないので、必ず列挙を回す形にする。
 */

import { RUN_STATUSES, RUN_STOP_REASONS } from "@shuten/shared";
import { describe, expect, it } from "vitest";
import { RUN_STATUS_LABELS, RUN_STOP_REASON_LABELS } from "./labels.ts";

describe("RUN_STATUS_LABELS", () => {
  it("W8-2: RUN_STATUSES のすべての値に空でないラベルを持つ", () => {
    for (const status of RUN_STATUSES) {
      const label = RUN_STATUS_LABELS[status];
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("RUN_STOP_REASON_LABELS", () => {
  it("W8-3: RUN_STOP_REASONS のすべての値に空でないラベルを持つ", () => {
    for (const reason of RUN_STOP_REASONS) {
      const label = RUN_STOP_REASON_LABELS[reason];
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
