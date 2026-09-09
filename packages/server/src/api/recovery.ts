/**
 * 復旧の口（PR10 決定 11）。
 *
 * ゲートを直接触らず、確認の書き込みは常に `orchestrator.confirmRecovery` を通す
 * （確認時刻を先に書いてからゲートを開ける。決定 11）。実行の `status` は変えない
 * （再開は別の口、`POST /api/runs/:id/resume`。Task 7）。
 */

import { confirmRecoveryRequestSchema, type RecoveryDto, recoveryDtoSchema } from "@shuten/shared";
import type { Hono } from "hono";
import type { RecoveryGate } from "../run/recovery-gate.ts";
import type { ApiDeps } from "./deps.ts";
import { notFound, readJson, respond } from "./errors.ts";

function toRecoveryDto(recoveryGate: RecoveryGate): RecoveryDto {
  return { blocked: recoveryGate.blocked, runIds: [...recoveryGate.blockedRunIds] };
}

export function registerRecoveryRoutes(router: Hono, deps: ApiDeps): void {
  router.get("/recovery", (c) => respond(c, recoveryDtoSchema, toRecoveryDto(deps.recoveryGate)));

  router.post("/recovery/confirm", async (c) => {
    const body = confirmRecoveryRequestSchema.parse(await readJson(c));
    const run = deps.orchestrator.confirmRecovery(body.runId);
    if (run === null) {
      throw notFound("実行", body.runId);
    }
    // GET と同じ形（ゲートの現在値）を返す。実行そのもの（RunDto）は返さない（手順 4）。
    return respond(c, recoveryDtoSchema, toRecoveryDto(deps.recoveryGate));
  });
}
