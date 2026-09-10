/**
 * 編集中の原稿入力（決定 11）。
 *
 * 入力方法は「貼り付け」と「ファイル」のラジオ。**ファイルの中身は確定操作まで読まない**：
 * 選んだ `File` をそのまま保持し、確定時に `ManuscriptApi.confirmFile` へ渡す。
 * `File.text()` も `FileReader` も、ここでは一切使わない（textarea へ読み込むことも含めて）。
 *
 * 「この原稿を確定する」の無効化条件は決定 11 の 3 つ。**`trim()` はしない**：
 * 空白だけの本文も無加工で保存する対象なので、空判定は必ず `length === 0`。
 */

import type { ChangeEvent } from "react";
import { useState } from "react";
import { ApiRequestError } from "../../api/errors.ts";
import styles from "./manuscript.module.css";
import type { ManuscriptApi } from "./use-manuscript.ts";

type InputMethod = "paste" | "file";

const MAX_NAME_LENGTH = 200;

/** 400 `invalid-utf8` は文字コードの問題として表示する（黙って置換しない、決定 11）。 */
function confirmErrorMessageFrom(cause: unknown): string {
  if (cause instanceof ApiRequestError && cause.code === "invalid-utf8") {
    return `ファイルの文字コードが UTF-8 ではありません（${cause.message}）`;
  }
  if (cause instanceof Error) return cause.message;
  return "原稿の確定に失敗しました";
}

export function ManuscriptEditor(props: { api: ManuscriptApi }): React.JSX.Element {
  const { api } = props;

  const [method, setMethod] = useState<InputMethod>("paste");
  const [pasteBody, setPasteBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    if (selected !== null) {
      // ファイル選択時はファイル名を原稿名の初期値に入れる（編集できる）。
      setName(selected.name);
    }
  };

  const bodyEmpty = method === "paste" && pasteBody.length === 0; // trim() しない
  const fileMissing = method === "file" && file === null;
  const nameInvalid = name.length === 0 || name.length > MAX_NAME_LENGTH;
  const confirmDisabled = bodyEmpty || fileMissing || nameInvalid || confirming;

  const handleConfirm = async () => {
    setConfirming(true);
    setConfirmError(null);
    try {
      if (method === "paste") {
        await api.confirmPaste({ name, body: pasteBody });
      } else if (file !== null) {
        await api.confirmFile({ name, file });
      }
    } catch (cause) {
      setConfirmError(confirmErrorMessageFrom(cause));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className={styles.editor}>
      <h2>原稿</h2>

      {api.restoreError !== null && <p className={styles.error}>{api.restoreError}</p>}

      <fieldset className={styles.section}>
        <legend className={styles.legend}>入力方法</legend>
        <div className={styles.methodChoice}>
          <label className={styles.methodLabel}>
            <input
              type="radio"
              name="manuscript-input-method"
              value="paste"
              checked={method === "paste"}
              onChange={() => setMethod("paste")}
            />
            貼り付け
          </label>
          <label className={styles.methodLabel}>
            <input
              type="radio"
              name="manuscript-input-method"
              value="file"
              checked={method === "file"}
              onChange={() => setMethod("file")}
            />
            ファイル
          </label>
        </div>
      </fieldset>

      {method === "paste" ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="manuscript-body">
            本文
          </label>
          <textarea
            id="manuscript-body"
            className={styles.textarea}
            value={pasteBody}
            onChange={(event) => setPasteBody(event.target.value)}
          />
        </div>
      ) : (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="manuscript-file">
            ファイル（UTF-8 のテキストファイル）
          </label>
          <input id="manuscript-file" type="file" onChange={handleFileChange} />
          {file !== null && <p className={styles.fileName}>選択中のファイル：{file.name}</p>}
        </div>
      )}

      <div className={styles.field}>
        <label className={styles.label} htmlFor="manuscript-name">
          原稿名
        </label>
        <input
          id="manuscript-name"
          className={styles.input}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <button
        type="button"
        className={styles.confirmButton}
        disabled={confirmDisabled}
        onClick={() => {
          void handleConfirm();
        }}
      >
        この原稿を確定する
      </button>

      {confirmError !== null && <p className={styles.error}>{confirmError}</p>}
    </div>
  );
}
