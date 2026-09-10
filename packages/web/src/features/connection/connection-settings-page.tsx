/**
 * `/settings/connection` — 接続設定の画面（決定 9・18）。
 *
 * LM Studio の接続先 URL・API キーの設定と、生成に使うモデルの選択を扱う。
 * 接続先 URL を画面へ出してよいのはここだけ（決定 18）。他の画面（ヘッダーなど）には出さない。
 *
 * API キーは `input[type="password"]` の書き込み専用欄で受け取り、以下を守る（決定 18）。
 * - 入力値以外のテキストとして描画しない（エラー表示・接続済み表示に含めない）。
 * - `PUT /api/settings/connection` の要求本文以外へ送らない。
 * - 例外オブジェクトへ格納しない。
 * - `localStorage` へ保存しない。
 * - 保存成功後は入力欄を空に戻し、`hasApiKey` の表示だけを更新する。
 *
 * `PUT` の `apiKey` は三状態（空のまま保存＝維持／消去＝`null`／入力あり＝設定）で、
 * 維持のときは要求本文から `apiKey` キーごと落とす（空文字列を送らない）。
 *
 * 実行中は `PUT` が 409 `runs-active` を返す。このとき入力中の URL・API キー欄を消さず、
 * サーバーからのメッセージだけを出す（打ち直しを強いない）。
 */

import { isGenerationCapable, type ModelInfoDto } from "@shuten/shared";
import { type FormEvent, useEffect, useState } from "react";
import { useApiClient } from "../../api/context.tsx";
import { ApiRequestError } from "../../api/errors.ts";
import { useConnection } from "../../app/connection-context.tsx";
import styles from "./connection-settings-page.module.css";

/** モデル一覧の選択肢に出すのは `llm` / `vlm` だけ（決定 9）。`embeddings` と `null` は出さない。 */
function isSelectableModelType(model: ModelInfoDto): boolean {
  return model.type === "llm" || model.type === "vlm";
}

function errorMessageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "接続設定の取得に失敗しました";
}

export function ConnectionSettingsPage() {
  const apiClient = useApiClient();
  const connection = useConnection();

  const [endpointUrl, setEndpointUrl] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // 画面表示時に現在の接続設定を 1 回だけ取得する。
  useEffect(() => {
    let cancelled = false;
    apiClient
      .getConnection()
      .then((result) => {
        if (cancelled) return;
        setEndpointUrl(result.endpointUrl);
        setHasApiKey(result.hasApiKey);
      })
      .catch((cause) => {
        if (cancelled) return;
        setLoadError(errorMessageFrom(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  const handleClearApiKeyChange = (checked: boolean) => {
    setClearApiKey(checked);
    if (checked) {
      setApiKeyInput(""); // 「消去」と入力値の両方が立つ状態を作らない
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);

    // apiKey は三状態：消去＝null、空のまま＝キーごと省略（維持）、入力あり＝その文字列。
    const body = clearApiKey
      ? { endpointUrl, apiKey: null }
      : apiKeyInput === ""
        ? { endpointUrl }
        : { endpointUrl, apiKey: apiKeyInput };

    apiClient
      .putConnection(body)
      .then((result) => {
        setEndpointUrl(result.endpointUrl);
        setHasApiKey(result.hasApiKey);
        setApiKeyInput("");
        setClearApiKey(false);
        setSaving(false);
        setSaved(true);
        // 保存直後の接続確認（決定 8 の契機 2）。定期的なポーリングは行わない。
        connection.checkConnection(connection.selectedModelId ?? undefined).catch(() => {
          // 失敗は context の error に反映済み。ここでは何もしない。
        });
      })
      .catch((cause: unknown) => {
        setSaving(false);
        // 409 runs-active でも入力欄（endpointUrl・apiKeyInput）はここでは一切変更しない。
        if (cause instanceof ApiRequestError) {
          setSaveError(cause.message);
          return;
        }
        setSaveError(errorMessageFrom(cause));
      });
  };

  const models = (connection.check?.models ?? []).filter(isSelectableModelType);

  return (
    <div className={styles.page}>
      <h1>接続設定</h1>

      {loadError !== null && <p className={styles.error}>{loadError}</p>}

      <form onSubmit={handleSubmit}>
        <fieldset className={styles.section}>
          <legend className={styles.legend}>LM Studio への接続</legend>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="connection-url">
              接続先 URL
            </label>
            <input
              id="connection-url"
              className={styles.input}
              type="text"
              value={endpointUrl}
              onChange={(event) => setEndpointUrl(event.target.value)}
              required
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="connection-api-key">
              API キー
            </label>
            <input
              id="connection-api-key"
              className={styles.input}
              type="password"
              value={apiKeyInput}
              disabled={clearApiKey}
              onChange={(event) => setApiKeyInput(event.target.value)}
              placeholder="変更しない場合は空のまま"
              autoComplete="off"
            />
            <p className={styles.apiKeyStatus}>API キー：{hasApiKey ? "設定済み" : "未設定"}</p>
            <label className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={clearApiKey}
                onChange={(event) => handleClearApiKeyChange(event.target.checked)}
              />
              API キーを消去
            </label>
          </div>

          <button type="submit" className={styles.saveButton} disabled={saving}>
            保存
          </button>

          {saveError !== null && <p className={styles.error}>{saveError}</p>}
          {saved && <p className={styles.success}>保存しました</p>}
        </fieldset>

        <fieldset className={styles.section}>
          <legend className={styles.legend}>生成に使うモデル</legend>

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
                      {model.state ?? "不明"}）。ロードするまで検査を開始できません。
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      </form>
    </div>
  );
}
