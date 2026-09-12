/**
 * エクスポート（`GET /api/runs/:id/export`）の組み立て（PR13a-2 Task 9。決定 16・23・24・25・26）。
 *
 * **HTTP に依存しない**（Hono を import しない）。`api/run-view.ts` と同じ姿勢で、DB と
 * `RunRecord` を受け取って `RunExportDto` を返すだけなので、`app.request` を通さずに
 * 組み立てだけを検査できる。ハンドラー（`api/runs.ts`）は 404 の判定と `respond` だけを行う。
 *
 * 決定 25：**指摘の件数に比例する問い合わせを作らない。** 使うのは次の 9 本だけで、1 実行につき
 * 各 1 回（`findRun` は呼び出し元（ハンドラー）が行う。`listFindings` が内部で使う
 * `listReasonsByRun` を含めても実行スコープの定数本）：
 * `findRun` / `findManuscriptVersion` / `listRunTargets` / `listCheckUnits` / `listFindings` /
 * `listRecheckUnits` / `listJudgments` / `listCandidates` / `listDiagnostics`。
 * `api/findings.ts` の `requirePerspective` / `findDiagnostic`（候補 1 件ごとの問い合わせ）は
 * 使わない。観点・診断・再確認・採否・検査対象の連番は、すべて実行スコープの一括取得を
 * `Map` に畳んで引く。
 *
 * 決定 23（PR8 決定 4 の保存規則）：`not-found` / `ambiguous` の候補は位置 null の指摘として
 * `listFindings` に出るので `findings[]` 側（`candidates` / `diagnostics`）に入る。
 * `finding_id` が null なのは `outside-target` の候補だけで、`unlocatedCandidates` /
 * `unlocatedDiagnostics` に入る。
 *
 * 並び順は各一括取得の並びをそのまま使う（再ソートしない）。
 */

import type { Perspective, RunExportDto } from "@shuten/shared";

import type { AppDatabaseLike } from "../db/client.ts";
import type {
  CandidateRecord,
  DiagnosticRecord,
  JudgmentRecord,
  RunRecord,
  RunTargetRecord,
} from "../db/records.ts";
import { listCheckUnits } from "../db/repositories/check-units.ts";
import { listDiagnostics } from "../db/repositories/diagnostics.ts";
import { listCandidates, listFindings } from "../db/repositories/findings.ts";
import { listJudgments } from "../db/repositories/judgments.ts";
import { findManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { listRecheckUnits } from "../db/repositories/rechecks.ts";
import { listRunTargets } from "../db/repositories/runs.ts";
import {
  toCandidateDto,
  toCheckUnitDto,
  toDiagnosticDto,
  toFindingDto,
  toManuscriptVersionDto,
  toRunDto,
  toRunTargetDto,
} from "./dto.ts";

/**
 * 実行が指す原稿版を引く。見つからないのは外部キーが守るはずの不変条件が壊れているという
 * ことなので、既定値に丸めず例外にする（`docs/reference/invariants.md`
 * 「失敗・形式不正を正常な値に置き換えない」、`run-view.ts` の `requireTargetIndex` と同じ姿勢）。
 * メッセージには ID だけを入れる。
 */
function requireManuscriptVersion(db: AppDatabaseLike, run: RunRecord) {
  const manuscript = findManuscriptVersion(db, run.manuscriptVersionId);
  if (manuscript === null) {
    throw new Error(
      `検査実行が指す原稿版が見つかりません（原稿版 ID: ${run.manuscriptVersionId}）`,
    );
  }
  return manuscript;
}

/**
 * 検査対象の `id → targetIndex` の対応表（`run-view.ts` の `targetIndexById` と同じ形）。
 * 検査単位の行は対象の連番を持たないので、`toCheckUnitDto` に渡す `targetIndex` をここから引く。
 */
function targetIndexById(targets: readonly RunTargetRecord[]): Map<string, number> {
  return new Map(targets.map((target) => [target.id, target.targetIndex]));
}

/**
 * 検査単位が指す検査対象の連番を引く。対応する対象が無いのは外部キーが守るはずの不変条件が
 * 壊れているということなので、既定値に丸めず例外にする（`run-view.ts` の
 * `requireTargetIndex` と同じ姿勢・同じ文言）。
 */
function requireTargetIndex(indexById: ReadonlyMap<string, number>, targetId: string): number {
  const targetIndex = indexById.get(targetId);
  if (targetIndex === undefined) {
    throw new Error(`検査単位が指す検査対象が見つかりません（検査対象 ID: ${targetId}）`);
  }
  return targetIndex;
}

/** `check_units` の `id → perspective` の対応表。候補の観点をここから引く（決定 25）。 */
function perspectiveByCheckUnitId(
  units: readonly { readonly id: string; readonly perspective: Perspective }[],
): Map<string, Perspective> {
  return new Map(units.map((unit) => [unit.id, unit.perspective]));
}

/**
 * 候補が指す検査単位の観点を `Map` から引く（決定 19・25）。単位が見つからないのは外部キーが
 * 守るはずの不変条件が壊れているということなので、既定値に丸めず例外にする
 * （`api/findings.ts` の `requirePerspective` と同じ文言・同じ姿勢。候補 1 件ごとに
 * 問い合わせない点だけが異なる）。
 */
function requirePerspective(
  byCheckUnitId: ReadonlyMap<string, Perspective>,
  candidate: CandidateRecord,
): Perspective {
  const perspective = byCheckUnitId.get(candidate.checkUnitId);
  if (perspective === undefined) {
    throw new Error(
      `候補が指す検査単位が見つかりません（候補 ID: ${candidate.id}、検査単位 ID: ${candidate.checkUnitId}）`,
    );
  }
  return perspective;
}

/**
 * 指摘の `judgment` を `Map` から読む。見つからなければ例外にする（`api/findings.ts` の
 * `requireJudgmentFromMap` と同じ文言・同じ姿勢。指摘の作成と同時に `undecided` の行が
 * 作られるはずなので、正常経路では必ず見つかる）。
 */
function requireJudgment(
  byFindingId: ReadonlyMap<string, JudgmentRecord>,
  findingId: string,
): JudgmentRecord {
  const judgment = byFindingId.get(findingId);
  if (judgment === undefined) {
    throw new Error(`judgments の行がありません（指摘 ID: ${findingId}）`);
  }
  return judgment;
}

/**
 * 候補を `findingId` で畳む（決定 25）。`findingId` が null（`outside-target`。決定 23）の
 * ものは指摘に配らず別に持つ。`listCandidates` の並び（`candidateIndex` 昇順）をそのまま保つ。
 */
function groupCandidates(candidates: readonly CandidateRecord[]): {
  readonly byFindingId: ReadonlyMap<string, readonly CandidateRecord[]>;
  readonly unlocated: readonly CandidateRecord[];
} {
  const byFindingId = new Map<string, CandidateRecord[]>();
  const unlocated: CandidateRecord[] = [];
  for (const candidate of candidates) {
    if (candidate.findingId === null) {
      unlocated.push(candidate);
      continue;
    }
    const bucket = byFindingId.get(candidate.findingId);
    if (bucket) {
      bucket.push(candidate);
    } else {
      byFindingId.set(candidate.findingId, [candidate]);
    }
  }
  return { byFindingId, unlocated };
}

/** 候補の列から、対応する診断（あるものだけ）を候補と同じ順で取り出す。 */
function diagnosticsFor(
  candidates: readonly CandidateRecord[],
  byCandidateId: ReadonlyMap<string, DiagnosticRecord>,
): DiagnosticRecord[] {
  const diagnostics: DiagnosticRecord[] = [];
  for (const candidate of candidates) {
    const diagnostic = byCandidateId.get(candidate.id);
    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

/**
 * `GET /api/runs/:id/export` の本体。実行 1 件ぶんの全量を、既存の DTO 射影（`api/dto.ts`）
 * だけを使って組み立てる（決定 16・23）。クエリパラメーターは読まない。実行の状態（`running`
 * など）で出し分けない（決定 26。途中の実行を評価に使わせない判断は CLI 側で行う）。
 */
export function buildRunExport(db: AppDatabaseLike, run: RunRecord): RunExportDto {
  const manuscript = requireManuscriptVersion(db, run);
  const targets = listRunTargets(db, run.id);
  const checkUnits = listCheckUnits(db, run.id);
  const findings = listFindings(db, run.id);
  const recheckUnits = listRecheckUnits(db, run.id);
  const judgments = listJudgments(db, run.id);
  const candidates = listCandidates(db, run.id);
  const diagnostics = listDiagnostics(db, run.id);

  const indexByTargetId = targetIndexById(targets);
  const perspectiveByUnitId = perspectiveByCheckUnitId(checkUnits);
  const diagnosticByCandidateId = new Map(diagnostics.map((d) => [d.candidateId, d] as const));
  const recheckByFindingId = new Map(recheckUnits.map((unit) => [unit.findingId, unit] as const));
  const judgmentByFindingId = new Map(
    judgments.map((judgment) => [judgment.findingId, judgment] as const),
  );
  const { byFindingId: candidatesByFindingId, unlocated: unlocatedCandidates } =
    groupCandidates(candidates);

  const findingDtos = findings.map((finding) => {
    const findingCandidates = candidatesByFindingId.get(finding.id) ?? [];
    return {
      ...toFindingDto(
        finding,
        recheckByFindingId.get(finding.id) ?? null,
        requireJudgment(judgmentByFindingId, finding.id),
      ),
      candidates: findingCandidates.map((candidate) =>
        toCandidateDto(candidate, requirePerspective(perspectiveByUnitId, candidate)),
      ),
      diagnostics: diagnosticsFor(findingCandidates, diagnosticByCandidateId).map(toDiagnosticDto),
    };
  });

  return {
    formatVersion: "1",
    exportedAt: new Date().toISOString(),
    run: toRunDto(run),
    manuscript: toManuscriptVersionDto(manuscript),
    targets: targets.map(toRunTargetDto),
    checkUnits: checkUnits.map((unit) =>
      toCheckUnitDto(unit, requireTargetIndex(indexByTargetId, unit.targetId)),
    ),
    findings: findingDtos,
    unlocatedCandidates: unlocatedCandidates.map((candidate) =>
      toCandidateDto(candidate, requirePerspective(perspectiveByUnitId, candidate)),
    ),
    unlocatedDiagnostics: diagnosticsFor(unlocatedCandidates, diagnosticByCandidateId).map(
      toDiagnosticDto,
    ),
  };
}
