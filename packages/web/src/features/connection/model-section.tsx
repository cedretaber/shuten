/**
 * 設定画面（`/settings`）の「生成に使うモデル」節（決定 9）。
 *
 * `ConnectionProvider` が持つ接続確認結果（`useConnection().check`）からモデル一覧を出し、
 * 選択は `useConnection().selectModel` を通じて `localStorage` へ即時保存する。
 * 保存先も効く時期もサーバー保存の接続設定（`ConnectionSection`）とは異なるため、
 * `<form>` の外に置き、接続設定の保存ボタンとは無関係に選べるようにする。
 */

import { isGenerationCapable, type ModelInfoDto } from "@shuten/shared";
import { useConnection } from "../../app/connection-context.tsx";
import styles from "./connection.module.css";

/** モデル一覧の選択肢に出すのは `llm` / `vlm` だけ（決定 9）。`embeddings` と `null` は出さない。 */
function isSelectableModelType(model: ModelInfoDto): boolean {
  return model.type === "llm" || model.type === "vlm";
}

/**
 * モデル状態の画面向け文言。LM Studio の内部の生文字列（`"not-loaded"` など）を
 * そのまま日本語の画面へ出さない（画面の文言は日本語、という規約に合わせる）。
 */
function modelStateLabel(state: string | null): string {
  return state === "not-loaded" ? "未ロード" : "不明";
}

export function ModelSection() {
  const connection = useConnection();

  const models = (connection.check?.models ?? []).filter(isSelectableModelType);

  return (
    <section className={styles.section}>
      <h2>生成に使うモデル</h2>
      <p className={styles.description}>選んだ時点でこのブラウザに保存します。</p>

      {models.length === 0 ? (
        <p className={styles.empty}>選べるモデルがありません。接続を確認してください。</p>
      ) : (
        <ul className={styles.modelList}>
          {models.map((model) => (
            <li key={model.id} className={styles.modelItem}>
              <label className={styles.modelLabel}>
                <input
                  type="radio"
                  name="selected-model"
                  value={model.id}
                  checked={connection.selectedModelId === model.id}
                  onChange={() => connection.selectModel(model.id)}
                />
                {model.id}
              </label>
              {!isGenerationCapable(model) && (
                <p className={styles.modelNote}>
                  LM Studio でロードしてください（現在の状態：
                  {modelStateLabel(model.state)}）。ロードするまで検査を開始できません。
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
