import type { UnitFailureRecord } from "./records.ts";

/**
 * `failure_*` 4 列（`failure_reason` / `failure_message` / `failure_finish_reason` /
 * `failure_origin`）の行の形。`check_units` と `recheck_units` の両方がこの 4 列を持つ。
 */
export interface FailureColumnsRow {
  readonly failureReason: UnitFailureRecord["reason"] | null;
  readonly failureMessage: string | null;
  readonly failureFinishReason: string | null;
  readonly failureOrigin: UnitFailureRecord["origin"] | null;
}

/**
 * `UnitFailureRecord` を `failure_*` 4 列に分解する。`failure` が null なら 4 列とも null にする。
 * `check_units` / `recheck_units` の両方の insert・update で共有する。
 */
export function toFailureColumns(failure: UnitFailureRecord | null): FailureColumnsRow {
  if (failure === null) {
    return {
      failureReason: null,
      failureMessage: null,
      failureFinishReason: null,
      failureOrigin: null,
    };
  }
  return {
    failureReason: failure.reason,
    failureMessage: failure.message,
    failureFinishReason: failure.finishReason,
    failureOrigin: failure.origin,
  };
}

/**
 * `failure_*` 4 列から `UnitFailureRecord | null` を組み立てる。
 *
 * `failure_reason` が null なら他の 3 列も null のはずで、それ以外は保存時の不変条件が
 * 壊れているということなので、既定値に丸めず例外にする
 * （`docs/reference/invariants.md`「失敗・形式不正を正常な値に置き換えない」）。
 * `failure_reason` が非 null なら `failure_message` / `failure_origin` は必ず埋まっている
 * （`failure_finish_reason` だけは LM Studio から取れないことがあるので null を許す）。
 *
 * `check_units` / `recheck_units` の両方の読み出しで共有する。エラーメッセージに出す
 * テーブル名（`tableName`）と ID の呼称（`idLabel`）は呼び出し側が渡す。
 */
export function toFailureOrNull(
  row: FailureColumnsRow,
  unitId: string,
  tableName: string,
  idLabel: string,
): UnitFailureRecord | null {
  if (row.failureReason === null) {
    if (
      row.failureMessage !== null ||
      row.failureFinishReason !== null ||
      row.failureOrigin !== null
    ) {
      throw new Error(
        `${tableName} の failure_* が failure_reason なしで部分的に埋まっています（${idLabel}: ${unitId}）`,
      );
    }
    return null;
  }
  if (row.failureMessage === null || row.failureOrigin === null) {
    throw new Error(
      `${tableName} の failure_message / failure_origin が failure_reason ありで null です（${idLabel}: ${unitId}）`,
    );
  }
  return {
    reason: row.failureReason,
    message: row.failureMessage,
    finishReason: row.failureFinishReason,
    origin: row.failureOrigin,
  };
}
