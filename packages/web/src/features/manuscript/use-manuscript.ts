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
 */

import type { ManuscriptVersionDto } from "@shuten/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
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

  // 起動時に 1 回だけ、保存済みの原稿版 ID を確かめる（決定 6）。
  useEffect(() => {
    const storedId = readStoredManuscriptVersionId();
    if (storedId === null) return;

    const controller = new AbortController();

    client
      .getManuscript(storedId, { signal: controller.signal })
      .then((version) => {
        if (controller.signal.aborted) return; // 意図した中断：状態を触らない
        setState({ kind: "confirmed", version });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return; // 意図した中断（AbortError を包んだものを含む）
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
      const version = await client.createManuscript(input);
      setState({ kind: "confirmed", version });
      setRestoreError(null);
      writeStored(STORAGE_KEYS.manuscriptVersionId, version.id);
    },
    [client],
  );

  const confirmFile = useCallback(
    async (input: { name: string; file: File }): Promise<void> => {
      const version = await client.uploadManuscript(input);
      setState({ kind: "confirmed", version });
      setRestoreError(null);
      writeStored(STORAGE_KEYS.manuscriptVersionId, version.id);
    },
    [client],
  );

  const reset = useCallback((): void => {
    setState({ kind: "editing" });
    removeStored(STORAGE_KEYS.manuscriptVersionId);
  }, []);

  return useMemo<ManuscriptApi>(
    () => ({ state, restoreError, confirmPaste, confirmFile, reset }),
    [state, restoreError, confirmPaste, confirmFile, reset],
  );
}
