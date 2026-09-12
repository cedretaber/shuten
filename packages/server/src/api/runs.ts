/**
 * 実行の口（PR10 決定 10・14・15）。
 *
 * 一覧・開始・詳細・単位・停止・再開・失敗単位の再試行。ハンドラーは「検証 → オーケストレーター／
 * リポジトリ呼び出し → DTO 射影 → 状態コード」だけを行い、実行の意味（再開・再試行を受け付ける
 * 条件、停止の写像）は 1 行も書き写さない（決定 10）。
 *
 * - `POST /api/runs` は**冪等判定を他のどの検証よりも先に**行う（決定 14。仕様 8.2
 *   「二重送信の防止は要求の同一性で判定し、条件の一致は判定に使わない」）。
 * - 意味の検証（`validateChunkSettings` / `validateHardTimeouts`）は `startRun` の**前**に置く。
 *   `startRun` は設定不正を例外にせず `stopped`（`settings`）の実行を**作る**（PR9b の設計）ので、
 *   事前に弾かないと入力の誤りごとに実行の行が増える。
 * - 201 は**作成直後のスナップショット**であって結末ではない（決定 14）。`startRun` は生成要求を
 *   送らずに同期で返り、ループは次のマイクロタスクから走る。
 * - 拒否は写すだけ：`stopRun` の `accepted: false` は 409 `run-not-active`、`resumeRun` /
 *   `retryFailedUnits` の `accepted: false` は 409 `run-rejected-<rejectReason>`（決定 10）。
 * - 実行が無い場合はハンドラーが先に `findRun` して 404 にする（オーケストレーターは例外を投げる）。
 * - 決定 15：絞り込み・ページングはサーバーでは行わない。クエリパラメーターを読まない。
 */

import {
  retryFailedRequestSchema,
  runDetailDtoSchema,
  runDtoSchema,
  runExportDtoSchema,
  runSummaryDtoSchema,
  runUnitsDtoSchema,
  startRunRequestSchema,
  validateChunkSettings,
} from "@shuten/shared";
import type { Context, Hono } from "hono";
import { z } from "zod";

import type { RunRecord } from "../db/records.ts";
import { findManuscriptVersion } from "../db/repositories/manuscripts.ts";
import { findRun, findRunByStartOperationId, listRuns } from "../db/repositories/runs.ts";
import type { RunRejectReason } from "../run/orchestrator.ts";
import { validateHardTimeouts } from "../run/timeouts.ts";
import type { ApiDeps } from "./deps.ts";
import { toRunDto, toRunSummaryDto } from "./dto.ts";
import { ApiError, notFound, readJson, respond } from "./errors.ts";
import { buildRunExport } from "./run-export.ts";
import { buildRunDetail, buildRunUnits } from "./run-view.ts";

/** `GET /api/runs` の応答。 */
const runSummaryListSchema = z.array(runSummaryDtoSchema);

/**
 * `stop` / `resume` / `retry-failed` の応答。`@shuten/shared` に同じ形は無いので、
 * `api/router.ts` の `healthDtoSchema` と同じくこのファイルにローカルで持つ。
 */
const runActionDtoSchema = z.object({ run: runDtoSchema }).strict();

/**
 * 冪等判定にだけ使う最小のスキーマ（決定 14 の 1）。**要求全体を検証してはならない**：
 * `startRunRequestSchema` を先に通すと、同じ `startOperationId` の 2 回目が「今は無効な設定値」で
 * 400 になり、二重送信の防止が条件の一致に依存してしまう（仕様 8.2 が禁じている）。
 * `.strict()` を付けないのは、残りの項目をここでは見ないため。
 */
const startOperationHeadSchema = z.object({
  startOperationId: startRunRequestSchema.shape.startOperationId,
});

/** 409 `run-rejected-<reason>` の本文。理由ごとの定型文で、ID 以外は入れない。 */
const REJECT_MESSAGES: Record<RunRejectReason, string> = {
  running: "実行中のため受け付けられません",
  settings:
    "設定エラーで停止した実行は再開できません（設定を見直して新しい検査を開始してください）",
  "stale-version": "アプリの更新で版が変わったため再開・再試行できません",
  connection: "接続先が実行開始時と異なるため再開・再試行できません",
  status: "現在の状態からは再開・再試行できません",
};

function rejectedError(runId: string, reason: RunRejectReason): ApiError {
  return new ApiError(409, `run-rejected-${reason}`, `${REJECT_MESSAGES[reason]}: ${runId}`);
}

export function registerRunRoutes(router: Hono, deps: ApiDeps): void {
  /** 404 の判定はハンドラーが行う（決定 10）。オーケストレーターを呼ぶ前に必ず通す。 */
  function requireRun(id: string): RunRecord {
    const run = findRun(deps.db, id);
    if (run === null) {
      throw notFound("実行", id);
    }
    return run;
  }

  router.get("/runs", (c) =>
    respond(c, runSummaryListSchema, listRuns(deps.db).map(toRunSummaryDto)),
  );

  router.post("/runs", async (c) => {
    const raw = await readJson(c);

    // 決定 14 の順序。1：本文が JSON のオブジェクトで、`startOperationId` が有効な文字列であることだけ見る。
    const head = startOperationHeadSchema.parse(raw);

    // 2：既存があれば**残りの入力を検証も比較もせず** 200 で返す（PR9b 決定 12。409 にしない）。
    const existing = findRunByStartOperationId(deps.db, head.startOperationId);
    if (existing !== null) {
      return respond(c, runDtoSchema, toRunDto(existing));
    }

    // 3：既存が無いときだけ、要求全体と設定の意味を検証する。
    const request = startRunRequestSchema.parse(raw);
    validateChunkSettings(request.chunkSettings); // InvalidChunkSettingsError → 400 invalid-run-settings
    const timeoutError = validateHardTimeouts(request.timeouts, deps.recoveryConfirmMs);
    if (timeoutError !== null) {
      throw new ApiError(400, "invalid-run-settings", timeoutError);
    }

    // 4：原稿版なしは 404（オーケストレーターは例外を投げるので、ハンドラーが先に弾く。決定 10）。
    if (findManuscriptVersion(deps.db, request.manuscriptVersionId) === null) {
      throw notFound("原稿", request.manuscriptVersionId);
    }

    // 観点の重複はここで除く（`startRun` は受け取った並びをそのまま保存する）。
    const perspectives = [...new Set(request.perspectives)];
    const { run } = deps.orchestrator.startRun({ ...request, perspectives });
    // 201 は作成直後のスナップショット。この後の結末（モデル未ロードなど）は含まない（決定 14）。
    return respond(c, runDtoSchema, toRunDto(run), 201);
  });

  router.get("/runs/:id", (c) => {
    const run = requireRun(c.req.param("id"));
    return respond(c, runDetailDtoSchema, buildRunDetail(deps.db, run));
  });

  router.get("/runs/:id/units", (c) => {
    const run = requireRun(c.req.param("id"));
    return respond(c, runUnitsDtoSchema, buildRunUnits(deps.db, run));
  });

  // 実行の状態では出し分けない。常に 1 実行ぶんの全量を返す（決定 26）。クエリパラメーターは読まない。
  router.get("/runs/:id/export", (c) => {
    const run = requireRun(c.req.param("id"));
    return respond(c, runExportDtoSchema, buildRunExport(deps.db, run));
  });

  router.post("/runs/:id/stop", (c) => {
    const id = requireRun(c.req.param("id")).id;
    const result = deps.orchestrator.stopRun(id);
    if (!result.accepted) {
      // 走っているループが無い（レジストリに無い）。DB は 1 行も変わっていない（決定 7）。
      throw new ApiError(409, "run-not-active", `実行中ではありません: ${id}`);
    }
    if (result.run === null) {
      // `accepted` が true なら行は存在する。理論上到達しない防御的分岐。
      throw notFound("実行", id);
    }
    return respondRun(c, result.run);
  });

  router.post("/runs/:id/resume", (c) => {
    const id = requireRun(c.req.param("id")).id;
    const result = deps.orchestrator.resumeRun(id);
    if (!result.accepted) {
      throw rejectedError(id, requireRejectReason(result.rejectReason));
    }
    return respondRun(c, result.run);
  });

  router.post("/runs/:id/retry-failed", async (c) => {
    const id = requireRun(c.req.param("id")).id;
    // 本文なし・空本文は「全件」（決定 14 の `readJson` の `optional`）。空配列は zod が弾く（400 validation）。
    const body = retryFailedRequestSchema.parse(await readJson(c, { optional: true }));
    const result = deps.orchestrator.retryFailedUnits(
      id,
      body.unitIds === undefined ? undefined : { unitIds: body.unitIds },
    );
    if (!result.accepted) {
      throw rejectedError(id, requireRejectReason(result.rejectReason));
    }
    return respondRun(c, result.run);
  });
}

/** `accepted: false` なら `rejectReason` は必ず非 null（`RunLaunchResult` の不変条件）。 */
function requireRejectReason(reason: RunRejectReason | null): RunRejectReason {
  if (reason === null) {
    // 理論上到達しない防御的分岐。判別子が無いと 409 の `code` を決められない。
    throw new Error("受け付けなかった要求に拒否理由がありません");
  }
  return reason;
}

/** `stop` / `resume` / `retry-failed` の 202（「受け付けた」。結末は SSE か `GET` で追う）。 */
function respondRun(c: Context, run: RunRecord): Response {
  return respond(c, runActionDtoSchema, { run: toRunDto(run) }, 202);
}
