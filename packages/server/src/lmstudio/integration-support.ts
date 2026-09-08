import { parseLmStudioApiKey } from "../config.ts";
import { isGenerationCapable } from "./models.ts";
import type { ModelInfo } from "./types.ts";

/**
 * 実 LM Studio を使う統合テスト（`*.integration.test.ts`）が共通で使うヘルパー。
 * `vitest` は import しない（`src` 配下は typecheck とビルドに入るため）。
 * `describe.skipIf` と `ctx.skip()` は各テストファイル側に残す。
 */

/** 本番経路（`run/executor.ts`）と共用するため実体は `models.ts` に置き、ここでは再輸出する。 */
export { isGenerationCapable };

/** 統合テストの接続設定。`SHUTEN_LM_STUDIO_URL` は trim 済みの生値のまま返す（URL としての検証はしない）。 */
export interface IntegrationEnv {
  /** 未設定・空白のみなら undefined（呼び出し元がファイルごと skip する）。 */
  readonly rawUrl: string | undefined;
  readonly apiKey: string | null;
  /** 未設定・空白のみなら undefined（自動選択に倒す）。 */
  readonly requestedModelId: string | undefined;
}

/** `SHUTEN_LM_STUDIO_URL` / `SHUTEN_LM_STUDIO_API_KEY` / `SHUTEN_LM_STUDIO_MODEL` を読む。 */
export function readIntegrationEnv(env: NodeJS.ProcessEnv = process.env): IntegrationEnv {
  return {
    rawUrl: env.SHUTEN_LM_STUDIO_URL?.trim(),
    apiKey: parseLmStudioApiKey(env.SHUTEN_LM_STUDIO_API_KEY),
    requestedModelId: env.SHUTEN_LM_STUDIO_MODEL?.trim(),
  };
}

/**
 * モデル一覧から生成用モデル ID を選ぶ。`requestedModelId` が指定されていればそれが
 * `isGenerationCapable` を満たすときだけ採用し、満たさなければ null（該当テストは ctx.skip()）。
 * 未指定なら一覧の先頭から `isGenerationCapable` を満たすモデルを選ぶ。
 */
export function selectGenerationModelId(
  models: readonly ModelInfo[],
  requestedModelId: string | undefined,
): string | null {
  if (requestedModelId !== undefined && requestedModelId !== "") {
    // 指定されたモデルが生成に使えなければ（未ロード、または embeddings など生成に使えない種別）、
    // 自動選択と同じく null（＝該当テストは ctx.skip()）に倒す（仕様書 7 節、invariants.md）。
    const requested = models.find((model) => model.id === requestedModelId);
    return requested !== undefined && isGenerationCapable(requested) ? requested.id : null;
  }
  const found = models.find(isGenerationCapable);
  return found?.id ?? null;
}
