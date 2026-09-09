/**
 * ハード上限（タイムアウト設定）の検証（決定 44）。
 *
 * オーケストレーター（`run/orchestrator.ts` の `planStart`）と HTTP ハンドラーの両方が呼ぶので、
 * 式を複製しないようにここへ切り出してある（PR10 決定 14）。DB にも接続にも触れない純粋関数。
 */

import { MAX_TIMEOUT_MS } from "../config.ts";

/**
 * `checkMs` / `recheckMs` が 1 以上の安全な整数であり、`recoveryConfirmMs` を加算した値が
 * 32bit 符号付き整数の上限を超えないことを検証する（決定 44）。違反したらエラーメッセージを、
 * 問題なければ null を返す。`stopMessage` に使うため、接続先 URL・API キーを含めない定型文。
 */
export function validateHardTimeouts(
  timeouts: { readonly checkMs: number; readonly recheckMs: number },
  recoveryConfirmMs: number,
): string | null {
  if (!Number.isSafeInteger(timeouts.checkMs) || timeouts.checkMs < 1) {
    return "タイムアウト設定が不正なため実行を開始できなかった（checkMs は 1 以上の整数である必要がある）";
  }
  if (!Number.isSafeInteger(timeouts.recheckMs) || timeouts.recheckMs < 1) {
    return "タイムアウト設定が不正なため実行を開始できなかった（recheckMs は 1 以上の整数である必要がある）";
  }
  if (timeouts.checkMs + recoveryConfirmMs > MAX_TIMEOUT_MS) {
    return "タイムアウト設定が不正なため実行を開始できなかった（checkMs + recoveryConfirmMs が上限を超えている）";
  }
  if (timeouts.recheckMs + recoveryConfirmMs > MAX_TIMEOUT_MS) {
    return "タイムアウト設定が不正なため実行を開始できなかった（recheckMs + recoveryConfirmMs が上限を超えている）";
  }
  return null;
}
