/**
 * 検査の開始操作とスナップショット（決定 13・15）。
 *
 * `start()` の手順は決定 13 の 4 段：
 * 1. `connection.checkConnection(modelId)` を `try`/`catch` で包む。中断でない失敗（例外）なら
 *    開始せず終了する。`null`（意図した中断）でも開始せず終了する（エラーは出さない）。
 * 2. その戻り値で `canStartWithModel` が false なら開始しない。
 * 3. `StartRunRequest`（新しい `startOperationId` を添えて）を組み立て、
 *    `startRunRequestSchema.safeParse` → `validateChunkSettings` を通す。
 * 4. 通ったらスナップショットに固定して `startRun` を送る。
 *
 * 「結果不明」（`isStartOutcomeUnknown`）なら `startOperationId` とスナップショットを保持し、
 * `retry()` はそれを**そのまま**、接続確認をやり直さずに再送する（決定 15）。確定（成功 or 4xx）
 * ならスナップショットを破棄する。押し直しは `start()` を呼び直すことで新しい ID になる。
 */

import {
  type ConnectionCheckDto,
  InvalidChunkSettingsError,
  type StartRunRequest,
  startRunRequestSchema,
  validateChunkSettings,
} from "@shuten/shared";
import { useCallback, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.ts";
import { isStartOutcomeUnknown } from "../../api/errors.ts";
import type { ConnectionApi } from "../../app/connection-context.tsx";
import { canStartWithModel } from "../../app/model-selection.ts";

export type StartOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "failed"; readonly message: string; readonly retryable: boolean }
  | { readonly kind: "started"; readonly runId: string };

export interface StartRunApi {
  readonly outcome: StartOutcome;
  /** 新しい開始操作。startOperationId を作り、要求全体をスナップショットに固定する。 */
  start(request: Omit<StartRunRequest, "startOperationId">): Promise<void>;
  /**
   * 結果不明からの再試行。同じ ID と同じスナップショットを `startRun` へ**直接**再送する。
   * **接続確認をやり直さない**（決定 15）。
   */
  retry(): Promise<void>;
}

function errorMessageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "検査の開始に失敗しました";
}

const GENERIC_VALIDATION_MESSAGE =
  "入力内容が仕様に合いません。数値やタイムアウトの範囲を確認してください。";

const MODEL_NOT_READY_MESSAGE =
  "選択したモデルは検査を開始できる状態ではありません。LM Studio でロードしてください。";

export function useStartRun(deps: { client: ApiClient; connection: ConnectionApi }): StartRunApi {
  const { client, connection } = deps;

  const [outcome, setOutcome] = useState<StartOutcome>({ kind: "idle" });
  // 「結果不明」からの再試行に使うスナップショット。React state ではなく ref に持つ：
  // start()/retry() の非同期処理の途中でも常に最新の値を読めるようにするため。
  const snapshotRef = useRef<StartRunRequest | null>(null);
  // 送信中の二重呼び出しを防ぐ（連打防止はボタンの disabled が主だが、ここでも保険を掛ける）。
  const sendingRef = useRef(false);

  const send = useCallback(
    async (snapshot: StartRunRequest): Promise<void> => {
      setOutcome({ kind: "sending" });
      try {
        const run = await client.startRun(snapshot);
        snapshotRef.current = null; // 確定：使い切り
        setOutcome({ kind: "started", runId: run.id });
      } catch (cause) {
        if (isStartOutcomeUnknown(cause)) {
          // 不明：ID とスナップショットを保持する（決定 15）。snapshotRef はそのまま。
          setOutcome({ kind: "failed", message: errorMessageFrom(cause), retryable: true });
        } else {
          snapshotRef.current = null; // 確定（4xx）：破棄する
          setOutcome({ kind: "failed", message: errorMessageFrom(cause), retryable: false });
        }
      }
    },
    [client],
  );

  const start = useCallback(
    async (request: Omit<StartRunRequest, "startOperationId">): Promise<void> => {
      if (sendingRef.current) return; // 連打防止の保険
      sendingRef.current = true;
      snapshotRef.current = null; // 新しい開始操作：古いスナップショットは無効

      try {
        setOutcome({ kind: "sending" });

        let checkResult: ConnectionCheckDto | null;
        try {
          checkResult = await connection.checkConnection(request.modelId);
        } catch (cause) {
          // 中断でない失敗。context の error に理由が入る。startRun は呼ばない（決定 10）。
          setOutcome({ kind: "failed", message: errorMessageFrom(cause), retryable: false });
          return;
        }
        if (checkResult === null) {
          // 意図した中断。エラーは出さない。
          setOutcome({ kind: "idle" });
          return;
        }
        if (!canStartWithModel(checkResult, request.modelId)) {
          setOutcome({ kind: "failed", message: MODEL_NOT_READY_MESSAGE, retryable: false });
          return;
        }

        const startOperationId = crypto.randomUUID();
        const candidate: StartRunRequest = { ...request, startOperationId };

        const parsed = startRunRequestSchema.safeParse(candidate);
        if (!parsed.success) {
          setOutcome({ kind: "failed", message: GENERIC_VALIDATION_MESSAGE, retryable: false });
          return;
        }

        try {
          validateChunkSettings(parsed.data.chunkSettings);
        } catch (cause) {
          if (cause instanceof InvalidChunkSettingsError) {
            setOutcome({ kind: "failed", message: cause.message, retryable: false });
            return;
          }
          throw cause;
        }

        // parsed.data は zod が組み立てた新しいオブジェクト（呼び出し元の request とは別の参照）。
        // 呼び出し元がその後 request を書き換えても、このスナップショットは影響を受けない。
        snapshotRef.current = parsed.data;
        await send(parsed.data);
      } finally {
        sendingRef.current = false;
      }
    },
    [connection, send],
  );

  const retry = useCallback(async (): Promise<void> => {
    const snapshot = snapshotRef.current;
    if (snapshot === null) return; // 保持したスナップショットが無ければ何もしない
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      // 接続確認をやり直さない（決定 15）。保持したスナップショットをそのまま再送する。
      await send(snapshot);
    } finally {
      sendingRef.current = false;
    }
  }, [send]);

  return { outcome, start, retry };
}
