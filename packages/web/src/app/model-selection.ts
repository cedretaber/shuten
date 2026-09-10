/**
 * モデル選択に関する純粋な判定（決定 6・9）。API クライアントにも React にも依存しない。
 */

import { type ConnectionCheckDto, isGenerationCapable } from "@shuten/shared";

/**
 * 検査を開始してよいか（決定 9）。`check.models` から該当モデルを引き、
 * ロード済みかつ生成に使える種別（`llm` / `vlm`）であることまで確認する。
 * `check.model`（`{ id, found, state, loaded }`）は `type` を持たないため、種別判定には使えない。
 */
export function canStartWithModel(check: ConnectionCheckDto, modelId: string | null): boolean {
  if (modelId === null) return false;

  const selected = check.models.find((model) => model.id === modelId);

  return (
    check.reachable &&
    check.model?.found === true &&
    selected !== undefined &&
    isGenerationCapable(selected)
  );
}

/**
 * 接続確認の結果を受けて、保存済みのモデル選択を維持するか解除するかを決める（決定 6 の表）。
 *
 * | 接続確認の結果                         | 保存済みの選択 |
 * | -------------------------------------- | -------------- |
 * | 接続に失敗した（`reachable: false`）   | 維持する       |
 * | 一覧は取れたが、その ID が無い         | 解除する       |
 * | ID はあるが種別が `llm` / `vlm` でない | 解除する       |
 * | `llm` / `vlm` だが未ロード             | 維持する       |
 * | ロード済みの `llm` / `vlm`             | 維持する       |
 *
 * 保存済みの選択がそもそも無ければ（`stored === null`）常に `null` を返す。
 */
export function nextSelectedModelId(
  check: ConnectionCheckDto,
  stored: string | null,
): string | null {
  if (stored === null) return null;
  if (!check.reachable) return stored; // 接続失敗：モデルの情報が得られていないので維持する

  const found = check.models.find((model) => model.id === stored);
  if (found === undefined) return null; // 一覧は取れたが ID が無い：解除する
  if (found.type !== "llm" && found.type !== "vlm") return null; // 種別違い：解除する

  return stored; // 未ロードでもロード済みでも維持する
}
