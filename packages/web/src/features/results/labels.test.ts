/**
 * 検査結果閲覧画面向けラベル群の網羅性（PR12a Task 3）。
 *
 * shared 側の正本（`*_STATUSES` / `*_REASONS` / `*_VERDICTS` / `*_CATEGORIES` 定数配列）を回して、
 * すべての値に空でないラベルが付くこと、キー数が定数配列の長さと一致すること（＝定数配列にない
 * 余分なキーが無いこと）を確認する。1 つずつ手で並べて比較すると shared 側に値が増えても
 * このテストは気づけないので、必ず列挙を回す形にする。
 */

import {
  FAILURE_REASONS,
  FINDING_CATEGORIES,
  FINDING_LOCATE_STATUSES,
  INITIAL_VERDICTS,
  JUDGMENT_STATUSES,
  RECHECK_NOT_APPLICABLE_REASONS,
  RECHECK_REASON_KINDS,
  RECHECK_VERDICTS,
  RUN_STATUSES,
  RUN_STOP_REASONS,
  UNIT_STATUSES,
} from "@shuten/shared";
import { describe, expect, it } from "vitest";
import {
  FAILURE_REASON_LABELS,
  FINDING_CATEGORY_LABELS,
  FINDING_LOCATE_STATUS_LABELS,
  INITIAL_VERDICT_LABELS,
  JUDGMENT_STATUS_LABELS,
  RECHECK_NOT_APPLICABLE_REASON_LABELS,
  RECHECK_REASON_KIND_LABELS,
  RECHECK_VERDICT_LABELS,
  RUN_STATUS_LABELS,
  RUN_STOP_REASON_LABELS,
  UNIT_STATUS_LABELS,
} from "./labels.ts";

/** 定数配列を回して、各値に空でない文字列ラベルが付くことを確認する共通アサーション。 */
function expectCoversAllWithNonEmptyLabels<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
): void {
  expect(Object.keys(labels)).toEqual([...values]);
  for (const value of values) {
    const label = labels[value];
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
  }
}

describe("RUN_STATUS_LABELS", () => {
  it("RUN_STATUSES のすべての値に空でないラベルを持つ", () => {
    expectCoversAllWithNonEmptyLabels(RUN_STATUSES, RUN_STATUS_LABELS);
  });
});

describe("RUN_STOP_REASON_LABELS", () => {
  it("RUN_STOP_REASONS のすべての値に空でないラベルを持つ", () => {
    expectCoversAllWithNonEmptyLabels(RUN_STOP_REASONS, RUN_STOP_REASON_LABELS);
  });
});

describe("FINDING_CATEGORY_LABELS", () => {
  it("FINDING_CATEGORIES のすべての値に空でないラベルを持つ", () => {
    expectCoversAllWithNonEmptyLabels(FINDING_CATEGORIES, FINDING_CATEGORY_LABELS);
  });
});

describe("INITIAL_VERDICT_LABELS", () => {
  it("INITIAL_VERDICTS のすべての値に空でないラベルを持つ", () => {
    expectCoversAllWithNonEmptyLabels(INITIAL_VERDICTS, INITIAL_VERDICT_LABELS);
  });

  it("仕様 5.4 の語をそのまま使う", () => {
    expect(INITIAL_VERDICT_LABELS["likely-error"]).toBe("誤りの可能性が高い");
    expect(INITIAL_VERDICT_LABELS["confirm-with-author"]).toBe("作者への確認事項");
  });
});

describe("RECHECK_VERDICT_LABELS", () => {
  it("RECHECK_VERDICTS のすべての値に空でないラベルを持つ", () => {
    expectCoversAllWithNonEmptyLabels(RECHECK_VERDICTS, RECHECK_VERDICT_LABELS);
  });

  it("仕様 6.5 の語をそのまま使う", () => {
    expect(RECHECK_VERDICT_LABELS.keep).toBe("維持");
    expect(RECHECK_VERDICT_LABELS.withdraw).toBe("撤回");
    expect(RECHECK_VERDICT_LABELS["confirm-with-author"]).toBe("作者への確認事項");
  });
});

describe("RECHECK_REASON_KIND_LABELS", () => {
  it("RECHECK_REASON_KINDS のすべての値に空でないラベルを持つ", () => {
    expectCoversAllWithNonEmptyLabels(RECHECK_REASON_KINDS, RECHECK_REASON_KIND_LABELS);
  });
});

describe("JUDGMENT_STATUS_LABELS", () => {
  it("JUDGMENT_STATUSES のすべての値に空でないラベルを持つ", () => {
    expectCoversAllWithNonEmptyLabels(JUDGMENT_STATUSES, JUDGMENT_STATUS_LABELS);
  });

  it("仕様 5.3 の語をそのまま使う", () => {
    expect(JUDGMENT_STATUS_LABELS.undecided).toBe("未判断");
    expect(JUDGMENT_STATUS_LABELS["adopt-planned"]).toBe("採用予定");
    expect(JUDGMENT_STATUS_LABELS.rejected).toBe("却下");
    expect(JUDGMENT_STATUS_LABELS.held).toBe("保留");
  });
});

describe("FINDING_LOCATE_STATUS_LABELS", () => {
  it("FINDING_LOCATE_STATUSES のすべての値に空でないラベルを持つ", () => {
    expectCoversAllWithNonEmptyLabels(FINDING_LOCATE_STATUSES, FINDING_LOCATE_STATUS_LABELS);
  });

  it("ブリーフで指定された語をそのまま使う", () => {
    expect(FINDING_LOCATE_STATUS_LABELS.located).toBe("位置確定");
    expect(FINDING_LOCATE_STATUS_LABELS["not-found"]).toBe("本文に見つからない");
    expect(FINDING_LOCATE_STATUS_LABELS.ambiguous).toBe("候補が複数あり特定できない");
  });
});

describe("RECHECK_NOT_APPLICABLE_REASON_LABELS", () => {
  it("RECHECK_NOT_APPLICABLE_REASONS のすべての値に空でないラベルを持つ", () => {
    expectCoversAllWithNonEmptyLabels(
      RECHECK_NOT_APPLICABLE_REASONS,
      RECHECK_NOT_APPLICABLE_REASON_LABELS,
    );
  });

  it("ブリーフで指定された語をそのまま使う", () => {
    expect(RECHECK_NOT_APPLICABLE_REASON_LABELS.disabled).toBe("再確認なし（無効）");
    expect(RECHECK_NOT_APPLICABLE_REASON_LABELS.suppressed).toBe("再確認なし（許容語で抑制）");
    expect(RECHECK_NOT_APPLICABLE_REASON_LABELS.unlocated).toBe("再確認なし（位置未確定）");
  });
});

describe("UNIT_STATUS_LABELS", () => {
  it("UNIT_STATUSES のすべての値に空でないラベルを持つ", () => {
    expectCoversAllWithNonEmptyLabels(UNIT_STATUSES, UNIT_STATUS_LABELS);
  });
});

describe("FAILURE_REASON_LABELS", () => {
  it("FAILURE_REASONS のすべての値に空でないラベルを持つ", () => {
    expectCoversAllWithNonEmptyLabels(FAILURE_REASONS, FAILURE_REASON_LABELS);
  });
});
