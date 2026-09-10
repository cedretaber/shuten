/**
 * 設定画面（`/settings`）の「LM Studio への接続」節（決定 9・18）。
 *
 * LM Studio の接続先 URL・API キーの設定を扱う。接続先 URL を画面へ出してよいのはここだけ
 * （決定 18）。他の画面（ヘッダーなど）には出さない。
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

import { type SubmitEvent, useEffect, useRef, useState } from "react";
import { useApiClient } from "../../api/context.tsx";
import { ApiRequestError } from "../../api/errors.ts";
import { useConnection } from "../../app/connection-context.tsx";
import styles from "./connection.module.css";

function errorMessageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "接続設定の取得に失敗しました";
}

export function ConnectionSection() {
  const apiClient = useApiClient();
  const connection = useConnection();

  const [endpointUrl, setEndpointUrl] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 初回 GET の結果を、利用者の編集や保存成功後の値へ上書きさせないための印（レビュー対応）。
  // GET が古い設定を読んで応答だけ遅れている間に、利用者が新しい URL を入力して PUT に成功すると、
  // 遅れて届いた GET が `endpointUrl` と `hasApiKey` を古い値へ戻してしまう。そのまま保存し直すと
  // 接続先まで元へ戻る。API キー欄の入力ではこの印を立てない：初回 GET が決着する前にキーだけを
  // 打ち始めた利用者が、URL 欄が空のまま（`required`）保存できなくなるため。
  const settingsDirtyRef = useRef(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // 画面表示時に現在の接続設定を 1 回だけ取得する。
  useEffect(() => {
    let cancelled = false;
    apiClient
      .getConnection()
      .then((result) => {
        if (cancelled || settingsDirtyRef.current) return;
        setEndpointUrl(result.endpointUrl);
        setHasApiKey(result.hasApiKey);
      })
      .catch((cause) => {
        if (cancelled || settingsDirtyRef.current) return;
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

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);

    // apiKey は三状態：消去＝null、空のまま（空白のみを含む）＝キーごと省略（維持）、
    // それ以外の入力あり＝その文字列。空白のみをここで「維持」に倒すのは、サーバー側の
    // `resolveNextApiKey` / `parseLmStudioApiKey` が空白のみの文字列を消去（null）として
    // 扱うため（決定 18）：ここで弾かずに送ると、消去を選んでいないのに気づかず消えてしまう。
    const body = clearApiKey
      ? { endpointUrl, apiKey: null }
      : apiKeyInput.trim() === ""
        ? { endpointUrl }
        : { endpointUrl, apiKey: apiKeyInput };

    apiClient
      .putConnection(body)
      .then((result) => {
        settingsDirtyRef.current = true; // 遅れて届く初回 GET に保存後の値を戻させない
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

  return (
    <section className={styles.section}>
      <h2>LM Studio への接続</h2>
      <p className={styles.description}>
        「保存」を押した時点でサーバーへ反映します。検査の実行中は変更できません。
      </p>

      {loadError !== null && <p className={styles.error}>{loadError}</p>}

      <form onSubmit={handleSubmit}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="connection-url">
            接続先 URL
          </label>
          <input
            id="connection-url"
            className={styles.input}
            type="text"
            value={endpointUrl}
            onChange={(event) => {
              settingsDirtyRef.current = true;
              setEndpointUrl(event.target.value);
            }}
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
      </form>
    </section>
  );
}
