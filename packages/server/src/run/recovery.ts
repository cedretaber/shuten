/**
 * 停止ゲート（決定 26）。
 *
 * `AbortController` は通信の中断であって「LM Studio 側の生成が終わった証拠」ではない。
 * 停止操作を受けたときも、実行中の生成要求（`beginRequest()` 〜 `endRequest()` の区間）だけは
 * `recoveryConfirmMs` まで自然な完了を待ってから中断する。この待ち時間の管理を 1 か所に
 * 閉じ込めるのが `StopGate` の役目で、停止から実行の終了状態（`stopped` / `recovery-waiting`）
 * への写像そのものは持たない（それは決定 23 の表と executor・呼び出し元に任せる）。
 */

export interface StopGate {
  readonly signal: AbortSignal;
  /** 停止要求を受けたか。ループは各単位の手前でこれを見る。 */
  readonly stopRequested: boolean;
  /** 停止要求。冪等（2 回目以降は何もしない）。例外を投げない。 */
  requestStop(): void;
  /**
   * 生成要求の送信直前・完了直後に executor が呼ぶ（決定 27 のフック経由）。
   * ループからは呼ばない。キュー待ちと `ensureLoaded` を含めてしまうと、生成を送っていない
   * 停止でも `recoveryConfirmMs` だけ待つことになるため。例外を投げない。
   */
  beginRequest(): void;
  endRequest(): void;
  /** タイマーを解除する。ループの終了時に必ず呼ぶ。 */
  dispose(): void;
}

export function createStopGate(recoveryConfirmMs: number): StopGate {
  const controller = new AbortController();
  let stopRequested = false;
  /** 送信中（beginRequest 済み・endRequest 未了）の要求数。executor の直列化により通常は 0 か 1。 */
  let activeRequests = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function abortNow(): void {
    clearTimer();
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }

  function requestStop(): void {
    if (stopRequested) {
      // 冪等：2 回目以降は何もしない（タイマーを 2 本立てない）。
      return;
    }
    stopRequested = true;
    if (activeRequests > 0) {
      // 実行中の要求があれば、上限まで自然な完了を待ってから中断する。
      timer = setTimeout(abortNow, recoveryConfirmMs);
    } else {
      // 送信していない（キュー待ち・ensureLoaded 中を含む）ので、待たずに中断してよい。
      abortNow();
    }
  }

  function beginRequest(): void {
    activeRequests += 1;
  }

  function endRequest(): void {
    activeRequests = Math.max(0, activeRequests - 1);
    if (stopRequested) {
      // 決定 26：この要求は応答が届いて終わった（生成終了は確認できた）が、executor 内部の
      // 自動再試行はループに制御を戻さずに次の chat を送ってしまう。停止要求後に新しい要求を
      // 送らない（仕様 8.2）を守れるのは、ここで signal を落としておく形だけなので、
      // 予約された abort() を解除するのではなく、その場で abort() する。
      abortNow();
    }
  }

  function dispose(): void {
    clearTimer();
  }

  return {
    signal: controller.signal,
    get stopRequested(): boolean {
      return stopRequested;
    },
    requestStop,
    beginRequest,
    endRequest,
    dispose,
  };
}
