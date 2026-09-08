import type { ModelInfo } from "./types.ts";
import { LOADED_STATE } from "./types.ts";

/**
 * ロード済みで、かつ種別（type）が生成（chat）に使える（llm・vlm）ことを判定する。
 * 仕様書 7 節（v0.8）「モデル種別（llm、vlm、embeddings など）で生成に使えるモデルを絞る」に基づく
 * 絞り込みであり、`ensureLoaded` が種別を弾かない（未知の種別名でロード済みモデルを拒否しないため）
 * のとは別の判断として、明示指定・自動選択の両方に共通して適用する。
 */
export function isGenerationCapable(model: ModelInfo): boolean {
  return model.state === LOADED_STATE && (model.type === "llm" || model.type === "vlm");
}
