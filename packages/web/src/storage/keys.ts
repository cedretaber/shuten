/**
 * `localStorage` に置くキーの一覧（決定 6）。バージョン番号（`v1`）を含めておき、形を変えるときは
 * `v2` に切り替えて古い値を素通りさせない。
 */
export const STORAGE_KEYS = {
  selectedModelId: "shuten.v1.selectedModelId",
  runSettings: "shuten.v1.runSettings",
  allowedWords: "shuten.v1.allowedWords",
  manuscriptVersionId: "shuten.v1.manuscriptVersionId",
} as const;
