/**
 * 指摘と採否の口（PR10 決定 15）。
 *
 * 一覧（`GET /api/runs/:id/findings`）と詳細（`GET /api/findings/:id`）を分ける（決定 15）。
 * 一覧は理由・再確認要約・採否まで含め、元候補と位置診断は詳細だけに入れる（診断は大きく、
 * 詳細パネルでしか使わない）。採否（`PUT /api/findings/:id/judgment`）は `judgments` への
 * 記録だけで、本文（原稿版）には一切触れない（不変条件）。
 *
 * - `judgment` は常に非 null（PR8 決定 5：指摘の作成と同時に `undecided` の行ができる）。行が
 *   無ければ DB 不整合であり、既定値に丸めず例外にする（マップされない例外は 500 `internal` に
 *   写る。`docs/reference/invariants.md`「失敗・形式不正を正常な値に置き換えない」）。
 * - 一覧の並びは `listFindings` の並びをそのまま使う（本文位置 `start` 昇順、位置未確定は最後、
 *   同順位は `createdAt` → `id`）。ハンドラーで再ソートしない。
 * - `CandidateDto.perspective` は候補の行に無いので `check_units` から導く（PR8 決定 19）。
 * - クエリパラメーターは読まない（絞り込みはクライアント側。決定 15）。
 */

import {
  findingDetailDtoSchema,
  findingDtoSchema,
  judgmentDtoSchema,
  putJudgmentRequestSchema,
} from "@shuten/shared";
import type { Hono } from "hono";
import { z } from "zod";

import type { AppDatabase } from "../db/client.ts";
import type { CandidateRecord, JudgmentRecord } from "../db/records.ts";
import { findCheckUnit } from "../db/repositories/check-units.ts";
import { findDiagnostic } from "../db/repositories/diagnostics.ts";
import {
  type FindingWithReasons,
  findFinding,
  listCandidatesForFinding,
  listFindings,
} from "../db/repositories/findings.ts";
import { findJudgment, setJudgment } from "../db/repositories/judgments.ts";
import { findRecheckUnitByFinding } from "../db/repositories/rechecks.ts";
import { findRun } from "../db/repositories/runs.ts";
import type { ApiDeps } from "./deps.ts";
import { toCandidateDto, toDiagnosticDto, toFindingDto, toJudgmentDto } from "./dto.ts";
import { notFound, readJson, respond } from "./errors.ts";

/** `GET /api/runs/:id/findings` の応答。 */
const findingListSchema = z.array(findingDtoSchema);

/**
 * 指摘の `judgment` を読む。無ければ DB 不整合として例外にする（指摘の作成と同時に `undecided`
 * の行が作られるはずなので、正常経路では必ず見つかる。丸めずに 500 にする）。
 */
function requireJudgment(db: AppDatabase, findingId: string): JudgmentRecord {
  const judgment = findJudgment(db, findingId);
  if (judgment === null) {
    throw new Error(`judgments の行がありません（指摘 ID: ${findingId}）`);
  }
  return judgment;
}

/**
 * 候補が指す検査単位の観点を導く（決定 19）。単位が見つからないのは外部キーが守るはずの
 * 不変条件が壊れているということなので、既定値に丸めず例外にする。
 */
function requirePerspective(db: AppDatabase, candidate: CandidateRecord) {
  const unit = findCheckUnit(db, candidate.checkUnitId);
  if (unit === null) {
    throw new Error(
      `候補が指す検査単位が見つかりません（候補 ID: ${candidate.id}、検査単位 ID: ${candidate.checkUnitId}）`,
    );
  }
  return unit.perspective;
}

/** 一覧・詳細に共通の `FindingDto` を組み立てる（再確認要約・採否を添える）。 */
function buildFindingDto(db: AppDatabase, finding: FindingWithReasons) {
  const recheck = findRecheckUnitByFinding(db, finding.id);
  const judgment = requireJudgment(db, finding.id);
  return toFindingDto(finding, recheck, judgment);
}

export function registerFindingRoutes(router: Hono, deps: ApiDeps): void {
  router.get("/runs/:id/findings", (c) => {
    const runId = c.req.param("id");
    if (findRun(deps.db, runId) === null) {
      throw notFound("実行", runId);
    }
    const dtos = listFindings(deps.db, runId).map((finding) => buildFindingDto(deps.db, finding));
    return respond(c, findingListSchema, dtos);
  });

  router.get("/findings/:id", (c) => {
    const id = c.req.param("id");
    const finding = findFinding(deps.db, id);
    if (finding === null) {
      throw notFound("指摘", id);
    }
    const base = buildFindingDto(deps.db, finding);
    const candidates = listCandidatesForFinding(deps.db, finding.id);
    const candidateDtos = candidates.map((candidate) =>
      toCandidateDto(candidate, requirePerspective(deps.db, candidate)),
    );
    const diagnosticDtos = candidates
      .map((candidate) => findDiagnostic(deps.db, candidate.id))
      .filter((diagnostic) => diagnostic !== null)
      .map(toDiagnosticDto);
    return respond(c, findingDetailDtoSchema, {
      ...base,
      candidates: candidateDtos,
      diagnostics: diagnosticDtos,
    });
  });

  router.put("/findings/:id/judgment", async (c) => {
    const id = c.req.param("id");
    if (findFinding(deps.db, id) === null) {
      throw notFound("指摘", id);
    }
    const body = putJudgmentRequestSchema.parse(await readJson(c));
    const judgment = setJudgment(deps.db, id, { status: body.status, note: body.note ?? null });
    return respond(c, judgmentDtoSchema, toJudgmentDto(judgment));
  });
}
