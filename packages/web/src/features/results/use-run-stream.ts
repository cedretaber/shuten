/**
 * 実行イベント（SSE）の購読を画面に結ぶ hook（Task 8、決定 1・2・4・10）。
 *
 * この hook が持つのは 2 つだけ：
 *
 * 1. **購読を張る条件**（決定 1 の規則 2）。`enabled`（＝ `ResultsPage` が計算する
 *    `run.status === "running" && !streamEnded`）が真のときだけ 1 本張る。依存は
 *    `[runId, enabled]` だけにする——コールバックを依存に入れると、親が再描画するたびに
 *    購読し直し、そのたびに `onOpen` が「重い取り直し」を要求して再描画を呼ぶ、という
 *    無限ループになる。だからコールバックは ref 経由で読む。
 * 2. **イベント 1 件を何の合図に写すか**（決定 2 の表）。`RunEventDto` の中身は画面の状態に
 *    積まない（サーバーは再送しないので、到着数を数えると取りこぼしぶん恒久的にずれる）。
 *    受け取った `data` の中身はログにも画面にも出さない（`events.ts` と同じ規律）。
 *
 * 状態（`streamEnded` / `streamDisconnected`）と実際の取り直しは持たない。どちらも
 * `ResultsPage` の責務で、この hook は `onSettled` / `onConnectionStateChange` / `onRefresh` /
 * `onGenerationSlow` で知らせるだけにする（決定 1：規則 4 の「取り直しの成功だけで
 * `streamEnded` を下ろす」判定は REST の成否を知る `ResultsPage` にしか書けない）。
 *
 * `run-settled` の購読を閉じる責任は `subscribeRunEvents`（`api/events.ts`）側にあり、
 * ハンドラーが呼ばれた時点で既に閉じている。ここでは `onSettled()` を呼んでから
 * 重い取り直しを求めるだけ（決定 2 の表の最終行）。
 */

import type { RunEventDto } from "@shuten/shared";
import { useEffect, useRef } from "react";
import { useApiClient } from "../../api/context.tsx";

export type RefreshKind = "light" | "heavy";

export interface RunStreamOptions {
  readonly runId: string;
  /**
   * 決定 1：購読するかどうか。`ResultsPage` が
   * `run.status === "running" && !streamEnded` を計算して渡す。
   */
  readonly enabled: boolean;
  /** 合図。実際の取得は呼び出し元が行う（決定 2・3）。 */
  readonly onRefresh: (kind: RefreshKind) => void;
  /** 決定 1 の規則 3：`run-settled` を受けた（購読は既に閉じてある）。 */
  readonly onSettled: () => void;
  /** 決定 4：SSE の接続状態。`open` は再接続の成功も含む。 */
  readonly onConnectionStateChange: (state: "open" | "disconnected") => void;
  /** 決定 10：遅延通知の unitId。 */
  readonly onGenerationSlow: (unitId: string) => void;
}

/**
 * 決定 2 の表。`generation-slow` だけは取り直さない（通知だけ）ので null を返す。
 * `switch` を網羅で書き、`shared` にイベントが増えたら型検査で落ちるようにする。
 */
function refreshKindOf(event: RunEventDto): RefreshKind | null {
  switch (event.type) {
    case "target-planned":
    case "check-started":
    case "recheck-started":
    case "stop-requested":
      return "light";
    case "check-finished":
    case "target-merged":
    case "recheck-finished":
    // 保存の巻き戻しで指摘が消えうるので重い側（決定 2）。
    case "save-rolled-back":
    case "run-settled":
      return "heavy";
    case "generation-slow":
      return null;
  }
}

export function useRunStream(options: RunStreamOptions): void {
  const apiClient = useApiClient();
  // コールバックは依存に入れない（上記 1 の理由）。毎レンダー同期するだけの ref で渡す
  // （`results-page.tsx` の `selectedFindingIdRef` と同じ流儀）。
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const { runId, enabled } = options;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    // cleanup の後に遅れて届いたイベントでハンドラーを呼ばない（`subscribeRunEvents` 側でも
    // 同じ守りをしているが、fake を差し込んだときにも効くようここでも持つ）。
    let closed = false;
    const unsubscribe = apiClient.subscribeRunEvents(runId, {
      onOpen() {
        if (closed) return;
        const current = optionsRef.current;
        current.onConnectionStateChange("open");
        // 初回・再接続とも、購読が確立するまでの取りこぼしを埋める（決定 2）。
        current.onRefresh("heavy");
      },
      onEvent(event) {
        if (closed) return;
        const current = optionsRef.current;
        if (event.type === "generation-slow") {
          current.onGenerationSlow(event.unitId);
          return;
        }
        if (event.type === "run-settled") {
          current.onSettled();
        }
        const kind = refreshKindOf(event);
        if (kind !== null) {
          current.onRefresh(kind);
        }
      },
      onUnknownEvent() {
        if (closed) return;
        // 中身が読めないので安全側に倒す（決定 2 の表の最終行）。値は一切見ない。
        optionsRef.current.onRefresh("heavy");
      },
      onError() {
        if (closed) return;
        // 決定 4：切断の印を立てるだけ。切れている間に取り直しても意味が無い。
        optionsRef.current.onConnectionStateChange("disconnected");
      },
    });

    return () => {
      closed = true;
      unsubscribe();
    };
  }, [apiClient, runId, enabled]);
}
