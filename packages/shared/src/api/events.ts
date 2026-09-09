import { z } from "zod";

// `../index.ts` から import しない（index.ts が `api/` を再エクスポートするので循環になる）。
// 各ソースから直接引く。
import { RUN_STATUSES, UNIT_STATUSES } from "../run/status.ts";
import { RECHECK_NOT_APPLICABLE_REASONS, RUN_STOP_REASONS } from "../run/stop-reason.ts";

/**
 * SSE イベント（本書「SSE」節。決定 12）。`RunEvent`（server 内部）からの射影は
 * `server/src/api/events.ts` に置く（このファイルはスキーマだけを持つ）。
 */

const rangeSchema = z.object({ start: z.int().min(0), end: z.int().min(0) }).strict();
const perspectiveSchema = z.enum(["typo", "naturalness"]);

const targetPlannedEventSchema = z
  .object({
    type: z.literal("target-planned"),
    targetIndex: z.number(),
    target: rangeSchema,
    input: rangeSchema,
  })
  .strict();

const checkStartedEventSchema = z
  .object({
    type: z.literal("check-started"),
    targetIndex: z.number(),
    perspective: perspectiveSchema,
  })
  .strict();

const checkFinishedEventSchema = z
  .object({
    type: z.literal("check-finished"),
    targetIndex: z.number(),
    perspective: perspectiveSchema,
    status: z.enum(UNIT_STATUSES),
  })
  .strict();

const targetMergedEventSchema = z
  .object({
    type: z.literal("target-merged"),
    targetIndex: z.number(),
    findingCount: z.number(),
  })
  .strict();

const recheckStartedEventSchema = z
  .object({
    type: z.literal("recheck-started"),
    findingId: z.string(),
  })
  .strict();

const recheckFinishedEventSchema = z
  .object({
    type: z.literal("recheck-finished"),
    findingId: z.string(),
    status: z.enum(UNIT_STATUSES),
    notApplicableReason: z.enum(RECHECK_NOT_APPLICABLE_REASONS).nullable(),
  })
  .strict();

const generationSlowEventSchema = z
  .object({
    type: z.literal("generation-slow"),
    unitId: z.string(),
    elapsedMs: z.number(),
  })
  .strict();

const saveRolledBackEventSchema = z
  .object({
    type: z.literal("save-rolled-back"),
    unitId: z.string(),
    kind: z.enum(["check", "recheck"]),
  })
  .strict();

const stopRequestedEventSchema = z
  .object({
    type: z.literal("stop-requested"),
  })
  .strict();

const runSettledEventSchema = z
  .object({
    type: z.literal("run-settled"),
    status: z.enum(RUN_STATUSES),
    stopReason: z.enum(RUN_STOP_REASONS).nullable(),
  })
  .strict();

export const runEventDtoSchema = z.discriminatedUnion("type", [
  targetPlannedEventSchema,
  checkStartedEventSchema,
  checkFinishedEventSchema,
  targetMergedEventSchema,
  recheckStartedEventSchema,
  recheckFinishedEventSchema,
  generationSlowEventSchema,
  saveRolledBackEventSchema,
  stopRequestedEventSchema,
  runSettledEventSchema,
]);

export type RunEventDto = z.infer<typeof runEventDtoSchema>;
