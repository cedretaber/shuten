/**
 * 状態を書く唯一の経路（決定 29）。
 *
 * PR9a で作った `state.ts` の `canTransitionRun` / `canTransitionUnit`（決定 3 の許容遷移表）は
 * まだどこからも呼ばれていない。ここでリポジトリの `claim*` / `finish*` を薄く包み、表にない
 * 遷移（`finish*` は `expectedStatus → status`）を `InvalidTransitionError` にする。表にあれば
 * リポジトリへそのまま委譲し、戻り値（条件付き更新の成否 boolean）をそのまま返す。
 *
 * 表にない遷移では **DB を 1 行も触らない**（リポジトリの呼び出し自体を行わない）。
 * オーケストレーター・ループ・`save.ts`・起動時照合は、リポジトリの `claim*` / `finish*` を
 * 直接呼ばず、必ずこの 7 関数を経由する（レビューの検査項目。W3 は Task 7 でテスト化する）。
 *
 * リポジトリ自身には検査を入れない（計画の代案として明示的に採らないと決めた形。
 * PR8 のテストが「表にないペアを渡して false が返ること」を確かめている箇所を壊さないため）。
 */

import type { AppDatabaseLike } from "../db/client.ts";
import {
  claimUnit,
  type FinishCheckUnitInput,
  finishCheckUnit,
} from "../db/repositories/check-units.ts";
import {
  claimRecheckUnit,
  type FinishRecheckUnitInput,
  finishRecheckUnit,
  reopenSuppressedRecheckUnit,
} from "../db/repositories/rechecks.ts";
import { claimRun, type FinishRunInput, finishRun } from "../db/repositories/runs.ts";
import { canTransitionRun, canTransitionUnit } from "./state.ts";
import type { RunStatus, UnitStatus } from "./status.ts";

/** 許容遷移表にない `from → to`（`finish*` は `expectedStatus → status`）を渡したときの例外。プログラミング誤り。 */
export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

/**
 * 検査単位の `claimUnit` を許容遷移表で検査してから呼ぶ。表にない `from → to` は
 * `InvalidTransitionError`（`db/repositories/check-units.ts` の `claimUnit` は呼ばない。DB 非接触）。
 */
export function claimUnitChecked(
  db: AppDatabaseLike,
  id: string,
  from: UnitStatus,
  to: UnitStatus,
  options?: { readonly startedAt?: Date },
): boolean {
  if (!canTransitionUnit(from, to)) {
    throw new InvalidTransitionError(
      `検査単位の遷移 ${from} → ${to} は許容表にありません（検査単位 ID: ${id}）`,
    );
  }
  return claimUnit(db, id, from, to, options);
}

/**
 * 再確認単位の `claimRecheckUnit` を許容遷移表で検査してから呼ぶ。検査単位・再確認単位は
 * 同じ `UnitStatus` の表を共有する（決定 3）。表にない `from → to` は `InvalidTransitionError`。
 */
export function claimRecheckUnitChecked(
  db: AppDatabaseLike,
  id: string,
  from: UnitStatus,
  to: UnitStatus,
  options?: { readonly startedAt?: Date },
): boolean {
  if (!canTransitionUnit(from, to)) {
    throw new InvalidTransitionError(
      `再確認単位の遷移 ${from} → ${to} は許容表にありません（再確認単位 ID: ${id}）`,
    );
  }
  return claimRecheckUnit(db, id, from, to, options);
}

/**
 * 検査単位の `finishCheckUnit` を許容遷移表で検査してから呼ぶ。`expectedStatus → status` が
 * 表にない場合は `InvalidTransitionError`。
 */
export function finishCheckUnitChecked(
  db: AppDatabaseLike,
  id: string,
  input: FinishCheckUnitInput,
): boolean {
  if (!canTransitionUnit(input.expectedStatus, input.status)) {
    throw new InvalidTransitionError(
      `検査単位の遷移 ${input.expectedStatus} → ${input.status} は許容表にありません` +
        `（検査単位 ID: ${id}）`,
    );
  }
  return finishCheckUnit(db, id, input);
}

/**
 * 再確認単位の `finishRecheckUnit` を許容遷移表で検査してから呼ぶ。`expectedStatus → status` が
 * 表にない場合は `InvalidTransitionError`。
 */
export function finishRecheckUnitChecked(
  db: AppDatabaseLike,
  id: string,
  input: FinishRecheckUnitInput,
): boolean {
  if (!canTransitionUnit(input.expectedStatus, input.status)) {
    throw new InvalidTransitionError(
      `再確認単位の遷移 ${input.expectedStatus} → ${input.status} は許容表にありません` +
        `（再確認単位 ID: ${id}）`,
    );
  }
  return finishRecheckUnit(db, id, input);
}

/**
 * 抑制が外れた再確認単位を `pending` に戻す `reopenSuppressedRecheckUnit` を、許容遷移表で
 * 検査してから呼ぶ（決定 45-4）。表にない `not-applicable → pending` は `InvalidTransitionError`。
 * リポジトリ側は `WHERE status = 'not-applicable' AND not_applicable_reason = 'suppressed'` の
 * 条件付き更新なので、`disabled` / `unlocated` は例外ではなく false で返る（決定 12）。
 */
export function reopenSuppressedRecheckUnitChecked(db: AppDatabaseLike, id: string): boolean {
  if (!canTransitionUnit("not-applicable", "pending")) {
    throw new InvalidTransitionError(
      `再確認単位の遷移 not-applicable → pending は許容表にありません（再確認単位 ID: ${id}）`,
    );
  }
  return reopenSuppressedRecheckUnit(db, id);
}

/**
 * 検査実行の `claimRun` を許容遷移表で検査してから呼ぶ。表にない `from → to` は
 * `InvalidTransitionError`。`options.clearStopState` はそのままリポジトリへ渡す（決定 36）。
 */
export function claimRunChecked(
  db: AppDatabaseLike,
  id: string,
  from: RunStatus,
  to: RunStatus,
  options?: { readonly clearStopState?: boolean },
): boolean {
  if (!canTransitionRun(from, to)) {
    throw new InvalidTransitionError(
      `検査実行の遷移 ${from} → ${to} は許容表にありません（検査実行 ID: ${id}）`,
    );
  }
  return claimRun(db, id, from, to, options);
}

/**
 * 検査実行の `finishRun` を許容遷移表で検査してから呼ぶ。`expectedStatus → status` が表にない
 * 場合は `InvalidTransitionError`。
 */
export function finishRunChecked(db: AppDatabaseLike, id: string, input: FinishRunInput): boolean {
  if (!canTransitionRun(input.expectedStatus, input.status)) {
    throw new InvalidTransitionError(
      `検査実行の遷移 ${input.expectedStatus} → ${input.status} は許容表にありません` +
        `（検査実行 ID: ${id}）`,
    );
  }
  return finishRun(db, id, input);
}
