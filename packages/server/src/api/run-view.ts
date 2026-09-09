/**
 * 実行の詳細・単位の組み立て（PR10 Task 7）。
 *
 * **HTTP に依存しない**（Hono を import しない）。DB と `RunRecord` を受け取って DTO を返すだけなので、
 * `app.request` を通さずに組み立てだけを検査できる。ハンドラー（`api/runs.ts`）は 404 の判定と
 * `respond` だけを行い、読み出しと組み立てはここに置く。
 *
 * 決定 15：絞り込み・ページングはサーバーでは行わない。実行に属する検査対象・検査単位・再確認単位を
 * そのまま全件返す。
 */

import type {
  ProgressDto,
  RunDetailDto,
  RunUnitsDto,
  UnitStatus,
  UnitStatusCounts,
} from "@shuten/shared";
import { UNIT_STATUSES } from "@shuten/shared";

import type { AppDatabaseLike } from "../db/client.ts";
import type { RunRecord, RunTargetRecord } from "../db/records.ts";
import { listCheckUnits } from "../db/repositories/check-units.ts";
import { listRecheckUnits } from "../db/repositories/rechecks.ts";
import { listRunTargets } from "../db/repositories/runs.ts";
import { toCheckUnitDto, toRecheckUnitDto, toRunDto, toRunTargetDto } from "./dto.ts";

/** 5 状態すべてを 0 で初期化した件数表（仕様 9。0 件の状態もキーごと落とさない）。 */
function emptyCounts(): Record<UnitStatus, number> {
  const counts = {} as Record<UnitStatus, number>;
  for (const status of UNIT_STATUSES) {
    counts[status] = 0;
  }
  return counts;
}

/** 単位の並びから状態別件数を数える。合計は必ず単位数に一致する。 */
function countByStatus(units: readonly { readonly status: UnitStatus }[]): UnitStatusCounts {
  const counts = emptyCounts();
  for (const unit of units) {
    counts[unit.status] += 1;
  }
  return counts;
}

/**
 * 検査対象の `id → targetIndex` の対応表。検査単位の行は対象の連番を持たないので、
 * `toCheckUnitDto` に渡す `targetIndex` をここから引く。
 */
function targetIndexById(targets: readonly RunTargetRecord[]): Map<string, number> {
  return new Map(targets.map((target) => [target.id, target.targetIndex]));
}

/**
 * 検査単位が指す検査対象の連番を引く。対応する対象が無いのは外部キーが守るはずの不変条件が
 * 壊れているということなので、既定値（-1 など）に丸めずに例外にする
 * （`docs/reference/invariants.md`「失敗・形式不正を正常な値に置き換えない」）。
 * メッセージには ID だけを入れる。
 *
 * `check_units` は `(target_id, run_id)` の複合外部キーで `run_targets` を参照する（決定 16）ので、
 * この分岐はスキーマ上到達しない（テストからも作れない）。多重防御として残す。
 */
function requireTargetIndex(indexById: ReadonlyMap<string, number>, targetId: string): number {
  const targetIndex = indexById.get(targetId);
  if (targetIndex === undefined) {
    throw new Error(`検査単位が指す検査対象が見つかりません（検査対象 ID: ${targetId}）`);
  }
  return targetIndex;
}

/** 実行の進捗（検査単位・再確認単位の状態別件数）。 */
export function buildRunProgress(db: AppDatabaseLike, run: RunRecord): ProgressDto {
  return {
    checkUnits: countByStatus(listCheckUnits(db, run.id)),
    recheckUnits: countByStatus(listRecheckUnits(db, run.id)),
  };
}

/**
 * `GET /api/runs/:id` の本体。実行の射影・進捗・保存済みの検査対象を返す。
 * 検査対象の範囲は保存した UTF-16 範囲をそのまま返す（不変条件）。
 */
export function buildRunDetail(db: AppDatabaseLike, run: RunRecord): RunDetailDto {
  return {
    run: toRunDto(run),
    progress: buildRunProgress(db, run),
    targets: listRunTargets(db, run.id).map(toRunTargetDto),
  };
}

/** `GET /api/runs/:id/units` の本体。検査単位（対象の連番付き）と再確認単位を全件返す。 */
export function buildRunUnits(db: AppDatabaseLike, run: RunRecord): RunUnitsDto {
  const indexById = targetIndexById(listRunTargets(db, run.id));
  return {
    checkUnits: listCheckUnits(db, run.id).map((unit) =>
      toCheckUnitDto(unit, requireTargetIndex(indexById, unit.targetId)),
    ),
    recheckUnits: listRecheckUnits(db, run.id).map(toRecheckUnitDto),
  };
}
