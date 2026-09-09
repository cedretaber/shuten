import { z } from "zod";

/** API のエラー応答の共通形。 */
export const apiErrorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }).strict() })
  .strict();

export type ApiError = z.infer<typeof apiErrorSchema>;
