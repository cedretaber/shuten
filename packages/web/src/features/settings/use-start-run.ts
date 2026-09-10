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
 *
 * **再試行できるかどうか（`canRetry`）は `outcome` とは独立に持つ。** 結果不明のスナップショットを
 * 保持したまま利用者がもう一度「検査を開始する」を押し、その開始操作が送信前に失敗すると
 * （接続確認が例外・モデル未準備・入力検証で停止）、`outcome` は新しい失敗で上書きされる。
 * 再試行できるかどうかを `outcome` に持たせると、このとき再試行ボタンが画面から消え、
 * スナップショットは残っているのに同じ `startOperationId` を送る手段が失われる。最初の POST が
 * 実際には成功していて応答だけが失われていた場合、押し直しは重複実行を作りうる。そのため
 * `canRetry` は「結果不明のまま保持している開始操作があるか」だけを表し、`send()` の結末でしか動かない。
 *
 * スナップショットも新しい送信の直前（手順 4 の末尾）まで差し替えない。手順 1〜3 のどこで終了しても、
 * 直前に保持していたスナップショットは破棄されない。`outcome` は意図した中断のときだけ開始前の値へ
 * 戻す（中断は「何も起きなかった」ので、直前の失敗メッセージを消さない）。そのために
 * `outcomeRef`（state と同期する ref）を持つ。
 *
 * `failed` の `hint` は「**送信前に止まったか、送信後に決まったか**」の 1 本の規則で決める。
 * 送信前（`checkConnection` の例外、`canStartWithModel` が false、クライアント側の検証失敗）は
 * 設定画面で直せる可能性があるので `"settings"`。送信後（`send()` の結末。4xx でも結果不明でも）と
 * 想定外の例外（保険の catch-all）は、設定を直しても再現するとは限らないので `"none"`。
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

/** 失敗の原因が設定画面で直せるものかどうか。 */
export type StartFailureHint = "none" | "settings";

export type StartOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "failed"; readonly message: string; readonly hint: StartFailureHint }
  | { readonly kind: "started"; readonly runId: string };

export interface StartRunApi {
  readonly outcome: StartOutcome;
  /**
   * 結果不明のまま保持している開始操作があるか。`outcome` とは独立に動く：
   * この後の開始操作が送信前に失敗しても、再試行の手段を画面から消さないため。
   */
  readonly canRetry: boolean;
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
  // outcome state と同期する ref。開始操作が意図した中断で終わったとき、
  // 「開始する前の outcome」を読み直すために使う（state はクロージャに古い値が残るため）。
  const outcomeRef = useRef<StartOutcome>({ kind: "idle" });
  const updateOutcome = useCallback((next: StartOutcome) => {
    outcomeRef.current = next;
    setOutcome(next);
  }, []);

  // 「結果不明」からの再試行に使うスナップショット。React state ではなく ref に持つ：
  // start()/retry() の非同期処理の途中でも常に最新の値を読めるようにするため。
  const snapshotRef = useRef<StartRunRequest | null>(null);
  // 再試行できるか。`send()` の結末だけが動かす（`start()` の送信前の失敗では触らない）。
  const [canRetry, setCanRetry] = useState(false);
  // 送信中の二重呼び出しを防ぐ（連打防止はボタンの disabled が主だが、ここでも保険を掛ける）。
  const sendingRef = useRef(false);

  const send = useCallback(
    async (snapshot: StartRunRequest): Promise<void> => {
      updateOutcome({ kind: "sending" });
      try {
        const run = await client.startRun(snapshot);
        snapshotRef.current = null; // 確定：使い切り
        setCanRetry(false);
        updateOutcome({ kind: "started", runId: run.id });
      } catch (cause) {
        if (isStartOutcomeUnknown(cause)) {
          // 不明：ID とスナップショットを保持する（決定 15）。snapshotRef はそのまま。
          // 送信後に決まった失敗なので hint は "none"。
          setCanRetry(true);
          updateOutcome({ kind: "failed", message: errorMessageFrom(cause), hint: "none" });
        } else {
          snapshotRef.current = null; // 確定（4xx）：破棄する
          // 送信後に決まった失敗なので hint は "none"。
          setCanRetry(false);
          updateOutcome({ kind: "failed", message: errorMessageFrom(cause), hint: "none" });
        }
      }
    },
    [client, updateOutcome],
  );

  const start = useCallback(
    async (request: Omit<StartRunRequest, "startOperationId">): Promise<void> => {
      if (sendingRef.current) return; // 連打防止の保険
      sendingRef.current = true;
      // この開始操作を始める前の outcome を覚えておく。意図した中断で終わったときに戻すため
      // （レビュー対応：スナップショットを早期に破棄しない。手順 4 の末尾まで差し替えを待つ）。
      const outcomeBeforeStart = outcomeRef.current;

      try {
        updateOutcome({ kind: "sending" });

        let checkResult: ConnectionCheckDto | null;
        try {
          checkResult = await connection.checkConnection(request.modelId);
        } catch (cause) {
          // 中断でない失敗。context の error に理由が入る。startRun は呼ばない（決定 10）。
          // 送信前に止まった失敗なので hint は "settings"（接続先を見直す）。
          updateOutcome({ kind: "failed", message: errorMessageFrom(cause), hint: "settings" });
          return;
        }
        if (checkResult === null) {
          // 意図した中断：この開始操作は何も起きなかったものとして扱う。
          // スナップショットには一切触れていないので、直前に保持していた「結果不明」の
          // スナップショットはそのまま残る。outcome も開始前の値へ戻し、直前の失敗メッセージを
          // 消さない（再試行ボタンを出すかどうかは `canRetry` が持つので、ここでは動かない）。
          updateOutcome(outcomeBeforeStart);
          return;
        }
        if (!canStartWithModel(checkResult, request.modelId)) {
          // 送信前に止まった失敗なので hint は "settings"（モデルの節がある）。
          updateOutcome({ kind: "failed", message: MODEL_NOT_READY_MESSAGE, hint: "settings" });
          return;
        }

        const startOperationId = crypto.randomUUID();
        const candidate: StartRunRequest = { ...request, startOperationId };

        const parsed = startRunRequestSchema.safeParse(candidate);
        if (!parsed.success) {
          // 送信前に止まった失敗なので hint は "settings"。
          updateOutcome({ kind: "failed", message: GENERIC_VALIDATION_MESSAGE, hint: "settings" });
          return;
        }

        try {
          validateChunkSettings(parsed.data.chunkSettings);
        } catch (cause) {
          if (cause instanceof InvalidChunkSettingsError) {
            // 送信前に止まった失敗なので hint は "settings"。
            updateOutcome({ kind: "failed", message: cause.message, hint: "settings" });
            return;
          }
          throw cause;
        }

        // ここまで来て初めてスナップショットを差し替える（レビュー対応）。それより前のどの経路で
        // 終了しても、直前に保持していたスナップショット（あれば）は破棄されない。
        // parsed.data は zod が組み立てた新しいオブジェクト（呼び出し元の request とは別の参照）。
        // 呼び出し元がその後 request を書き換えても、このスナップショットは影響を受けない。
        snapshotRef.current = parsed.data;
        await send(parsed.data);
      } catch {
        // 保険の catch-all（レビュー対応）。`crypto.randomUUID()` や `validateChunkSettings` の
        // 想定外の例外（`InvalidChunkSettingsError` 以外）はここまで素通りする。無ければ
        // `outcome` が "sending" のまま固まり、開始ボタンが再読み込みまで disabled になる。
        // 例外の中身は画面に出さない（決定 18）。想定外の例外なので hint は "none"
        // （設定を直しても再現するとは限らない）。
        updateOutcome({
          kind: "failed",
          message: "検査の開始に失敗しました。もう一度お試しください。",
          hint: "none",
        });
      } finally {
        sendingRef.current = false;
      }
    },
    [connection, send, updateOutcome],
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

  return { outcome, canRetry, start, retry };
}
