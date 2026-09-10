/**
 * LM Studio への接続状態と選択モデルを画面全体で共有する context（決定 8・9・10）。
 *
 * - 接続確認を投げる契機は 3 つだけ（決定 8）。ここではそのうち「起動時に 1 回」を実装する。
 *   定期的な再確認（`setInterval` / ポーリング）は行わない。
 * - 競合は世代番号（`useRef<number>`）と `AbortController` で防ぐ（決定 10）。新しい要求を出す
 *   たびに前の要求を中断し、応答は最新の要求のものだけを状態へ反映する。
 * - 中断の判別は例外名ではなく、その要求に渡した `controller.signal.aborted` で行う。API クライアントは
 *   `fetch` の `AbortError` も `ApiTransportError` に包むため、例外の型では区別できない（決定 10）。
 */

import type { ConnectionCheckDto } from "@shuten/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import type { ApiClient } from "../api/client.ts";
import { STORAGE_KEYS } from "../storage/keys.ts";
import { readStored, removeStored, writeStored } from "../storage/local.ts";
import { nextSelectedModelId } from "./model-selection.ts";

export interface ConnectionState {
  readonly check: ConnectionCheckDto | null;
  readonly checkedAt: Date | null;
  readonly selectedModelId: string | null;
  readonly error: string | null; // AbortError はここに入れない（決定 10）
  readonly checking: boolean;
}

export interface ConnectionApi extends ConnectionState {
  /**
   * 接続確認を投げ、結果をそのまま返す。呼び出し側は戻り値で判定する（決定 10）。
   * 意図して中断した要求では `null` を返す（`error` にも入れない）。
   * 中断していない失敗（サーバーが落ちている等）は、context の `error` を更新したうえで
   * 例外として再送出する。呼び出し側で使わないなら握りつぶしてよい。
   */
  checkConnection(modelId?: string): Promise<ConnectionCheckDto | null>;
  selectModel(modelId: string): void;
}

const ConnectionContext = createContext<ConnectionApi | null>(null);

/** `localStorage` の値は素の文字列（`JSON.stringify` された文字列）。未選択は null。 */
const selectedModelIdSchema = z.string().nullable();

function errorMessageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "接続の確認に失敗しました";
}

function readStoredSelectedModelId(): string | null {
  return readStored(STORAGE_KEYS.selectedModelId, selectedModelIdSchema, null);
}

export function ConnectionProvider(props: {
  client: ApiClient;
  children: ReactNode;
}): React.JSX.Element {
  const { client } = props;

  const [check, setCheck] = useState<ConnectionCheckDto | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(readStoredSelectedModelId);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // 世代番号：最新の要求の応答だけを状態へ反映する（決定 10）。
  const generationRef = useRef(0);
  // 直前の要求。新しい要求を出すときに中断し、アンマウント時にも中断する。
  const controllerRef = useRef<AbortController | null>(null);

  const checkConnection = useCallback(
    async (modelId?: string): Promise<ConnectionCheckDto | null> => {
      controllerRef.current?.abort(); // 前の要求を中断する
      const controller = new AbortController();
      controllerRef.current = controller;
      const generation = ++generationRef.current;
      setChecking(true);

      try {
        const result = await client.checkConnection(modelId, { signal: controller.signal });
        if (controller.signal.aborted) return null; // 意図した中断：状態を触らない
        if (generation === generationRef.current) {
          setCheck(result);
          setCheckedAt(new Date());
          setError(null);
          setChecking(false);
        }
        return result;
      } catch (cause) {
        if (controller.signal.aborted) return null; // 意図した中断（AbortError を包んだものを含む）
        if (generation === generationRef.current) {
          setError(errorMessageFrom(cause));
          setChecking(false);
        }
        throw cause; // 中断していない失敗は呼び出し側が判定できるよう例外にする
      }
    },
    [client],
  );

  const selectModel = useCallback((modelId: string) => {
    setSelectedModelId(modelId);
    writeStored(STORAGE_KEYS.selectedModelId, modelId);
  }, []);

  // 起動時に 1 回だけ、保存済みモデル ID を添えて確認する（決定 8）。
  useEffect(() => {
    const storedId = readStoredSelectedModelId();

    checkConnection(storedId ?? undefined)
      .then((result) => {
        if (result === null) return; // 中断された：選択には触れない
        const next = nextSelectedModelId(result, storedId);
        setSelectedModelId(next);
        if (next === null) {
          removeStored(STORAGE_KEYS.selectedModelId);
        } else {
          writeStored(STORAGE_KEYS.selectedModelId, next);
        }
      })
      .catch(() => {
        // 中断していない失敗は checkConnection 内で `error` に反映済み。
        // 決定 6 のとおり、接続失敗時は保存済みの選択を維持する（何もしない）。
      });
    // `checkConnection` は `client`（Provider の生存期間中は不変）にのみ依存するため、
    // 実質的にマウント時 1 回だけ実行される。
  }, [checkConnection]);

  // アンマウント時に進行中の要求を中断する（決定 10）。
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const value = useMemo<ConnectionApi>(
    () => ({
      check,
      checkedAt,
      selectedModelId,
      error,
      checking,
      checkConnection,
      selectModel,
    }),
    [check, checkedAt, selectedModelId, error, checking, checkConnection, selectModel],
  );

  return <ConnectionContext.Provider value={value}>{props.children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionApi {
  const value = useContext(ConnectionContext);
  if (value === null) {
    throw new Error("useConnection は ConnectionProvider の内側で呼び出してください");
  }
  return value;
}
