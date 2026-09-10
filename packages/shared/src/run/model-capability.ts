/**
 * モデルが生成（chat）に使えるかどうかの判定（決定 9）。
 *
 * server の LM Studio クライアント（`lmstudio/models.ts` からの再エクスポート）と
 * web の画面（PR11）が同じ判定を二重に持たないよう、ここに実体を置く。
 */

/** `state` がこの値のときだけ生成を許す。 */
export const LOADED_STATE = "loaded";

/**
 * ロード済みで、かつ種別が生成（chat）に使える（llm・vlm）ことを判定する。
 * 仕様書 7 節（v0.8）「モデル種別（llm、vlm、embeddings など）で生成に使えるモデルを絞る」に基づく
 * 絞り込みであり、`ensureLoaded` が種別を弾かない（未知の種別名でロード済みモデルを拒否しないため）
 * のとは別の判断として、明示指定・自動選択の両方に共通して適用する。
 *
 * 構造的な引数にしているのは、server の `ModelInfo`（`lmstudio/types.ts`）と
 * shared の `ModelInfoDto`（`api/dto.ts`）の両方をそのまま渡せるようにするため。
 * どちらも `state` / `type` が `string | null`。
 */
export function isGenerationCapable(model: {
  readonly state: string | null;
  readonly type: string | null;
}): boolean {
  return model.state === LOADED_STATE && (model.type === "llm" || model.type === "vlm");
}
