/**
 * 原稿の状態（編集中／確定済み）と、起動時の復元（決定 6・11）。
 *
 * 画面の状態は 2 段階（「検査受付済み」は Task 8 が扱う）。
 * - 編集中：貼り付けた本文または選択した `File` を保持する（サーバーへは送らない）。この hook 自体は
 *   下書きを持たない（`manuscript-editor.tsx` が持つ）。ここでは「確定済みでない」ことだけを表す。
 * - 原稿確定済み：`createManuscript` / `uploadManuscript` の結果（原稿版）を保持する。
 *
 * 起動時は `STORAGE_KEYS.manuscriptVersionId` を読み、`getManuscript` で確かめる（決定 6）。
 * - 404 → キーを消して編集中のままにする（その原稿版はもう無い）。
 * - 5xx・通信失敗（`ApiTransportError` を含む） → **キーを消さず**、再試行できるエラーを
 *   `restoreError` に入れる（ページを再読み込みすれば復元を再試行する）。
 *
 * **復元 GET と確定操作／reset のレース（レビュー Important 1）。** 起動時の復元 GET が
 * 飛んだ直後に、その応答が返る前に利用者が新しい原稿を確定したり「別の原稿を選ぶ」を押したり
 * できる。復元の `AbortController` をアンマウント時のクリーンアップだけに結び付けていると、
 * 遅れて届いた復元の応答が `confirmPaste` / `confirmFile` / `reset` の結果を後から上書きしてしまう
 * （最悪のケースでは、確定直後に書いた新しい `manuscriptVersionId` を、遅れて届いた古い復元の
 * 404 が消してしまう）。これを防ぐため、復元の `AbortController` を `useRef` に持たせ、
 * `confirmPaste` / `confirmFile` / `reset` の先頭で必ず中断する。中断された応答は
 * `controller.signal.aborted` を見て `setState` も `removeStored` もしない。
 */

import type { ManuscriptVersionDto } from "@shuten/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { ApiClient } from "../../api/client.ts";
import { ApiRequestError } from "../../api/errors.ts";
import { STORAGE_KEYS } from "../../storage/keys.ts";
import { readStored, removeStored, writeStored } from "../../storage/local.ts";

export type ManuscriptState =
  | { readonly kind: "editing" }
  | { readonly kind: "confirmed"; readonly version: ManuscriptVersionDto };

export interface ManuscriptApi {
  readonly state: ManuscriptState;
  readonly restoreError: string | null;
  /**
   * 起動時の復元 GET が進行中かどうか（裁定 T7-1）。`state` の 2 段階は変えず、このフラグだけを
   * 足す。この PR では `HomePage` 側の出し分け（復元が終わるまでエディタを描画しない、等）までは
   * 行わない：Task 8 が開始ボタンの制御と合わせて使う。
   */
  readonly restoring: boolean;
  confirmPaste(input: { name: string; body: string }): Promise<void>;
  confirmFile(input: { name: string; file: File }): Promise<void>;
  reset(): void; // 「別の原稿を選ぶ」。選択解除だけで削除はしない
}

/** `localStorage` の値は素の文字列（`JSON.stringify` された文字列）か未保存（null）。 */
const manuscriptVersionIdSchema = z.string().nullable();

function readStoredManuscriptVersionId(): string | null {
  return readStored(STORAGE_KEYS.manuscriptVersionId, manuscriptVersionIdSchema, null);
}

function restoreErrorMessageFrom(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : null;
  const base = "確定済みの原稿を読み込めませんでした。ページを再読み込みすると再試行します。";
  return detail === null ? base : `${base}（${detail}）`;
}

export function useManuscript(client: ApiClient): ManuscriptApi {
  const [state, setState] = useState<ManuscriptState>({ kind: "editing" });
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  // 起動時の復元 GET に渡した controller。確定操作／reset から中断できるよう ref に持つ
  // （effect のクリーンアップ＝アンマウント時の中断だけでは、確定操作・reset とのレースを防げない）。
  const restoreControllerRef = useRef<AbortController | null>(null);

  /** 進行中の復元 GET があれば中断し、`restoring` を即座に false へ戻す。 */
  const abortRestore = useCallback(() => {
    const controller = restoreControllerRef.current;
    if (controller === null) return;
    restoreControllerRef.current = null;
    controller.abort();
    setRestoring(false);
  }, []);

  // 起動時に 1 回だけ、保存済みの原稿版 ID を確かめる（決定 6）。
  useEffect(() => {
    const storedId = readStoredManuscriptVersionId();
    if (storedId === null) return;

    const controller = new AbortController();
    restoreControllerRef.current = controller;
    setRestoring(true);

    client
      .getManuscript(storedId, { signal: controller.signal })
      .then((version) => {
        if (controller.signal.aborted) return; // 意図した中断：状態を触らない
        restoreControllerRef.current = null;
        setState({ kind: "confirmed", version });
        setRestoring(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return; // 意図した中断（AbortError を包んだものを含む）
        restoreControllerRef.current = null;
        setRestoring(false);
        if (cause instanceof ApiRequestError && cause.status === 404) {
          removeStored(STORAGE_KEYS.manuscriptVersionId); // その原稿版はもう無い：キーを消す
          return; // 編集中のまま
        }
        // 5xx・通信失敗：キーは残し、再試行できるエラーとして扱う。
        setRestoreError(restoreErrorMessageFrom(cause));
      });

    return () => {
      controller.abort();
    };
    // `client` は呼び出し元（App）の生存期間中は不変。実質マウント時 1 回だけ実行される。
  }, [client]);

  const confirmPaste = useCallback(
    async (input: { name: string; body: string }): Promise<void> => {
      abortRestore(); // 進行中の復元 GET を中断する（レース防止）
      const version = await client.createManuscript(input);
      setState({ kind: "confirmed", version });
      setRestoreError(null);
      writeStored(STORAGE_KEYS.manuscriptVersionId, version.id);
    },
    [client, abortRestore],
  );

  const confirmFile = useCallback(
    async (input: { name: string; file: File }): Promise<void> => {
      abortRestore(); // 進行中の復元 GET を中断する（レース防止）
      const version = await client.uploadManuscript(input);
      setState({ kind: "confirmed", version });
      setRestoreError(null);
      writeStored(STORAGE_KEYS.manuscriptVersionId, version.id);
    },
    [client, abortRestore],
  );

  const reset = useCallback((): void => {
    abortRestore(); // 進行中の復元 GET を中断する（レース防止）
    setState({ kind: "editing" });
    removeStored(STORAGE_KEYS.manuscriptVersionId);
  }, [abortRestore]);

  return useMemo<ManuscriptApi>(
    () => ({ state, restoreError, restoring, confirmPaste, confirmFile, reset }),
    [state, restoreError, restoring, confirmPaste, confirmFile, reset],
  );
}
