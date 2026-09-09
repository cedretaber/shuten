/**
 * API のハンドラーが使う依存（PR10 決定 1）。
 *
 * `index.ts` がプロセス内に 1 個ずつ作って渡す。サービス層は作らず、ハンドラーはここから
 * オーケストレーターとリポジトリを直接呼ぶ。**生成要求のキュー（`RequestQueue`）は入れない**
 * ——HTTP 層は生成要求を送る経路を新設しないため（決定 8）。
 */

import type { ConnectionManager } from "../connection.ts";
import type { AppDatabase } from "../db/client.ts";
import type { RunEventHub } from "../run/event-hub.ts";
import type { Orchestrator } from "../run/orchestrator.ts";
import type { RecoveryGate } from "../run/recovery-gate.ts";

/** SSE の心拍の既定間隔（決定 12）。`ApiDeps.ssePingIntervalMs` を省略したときの値。 */
export const DEFAULT_SSE_PING_INTERVAL_MS = 15_000;

export interface ApiDeps {
  readonly db: AppDatabase;
  readonly connection: ConnectionManager;
  readonly recoveryGate: RecoveryGate;
  readonly orchestrator: Orchestrator;
  readonly hub: RunEventHub;
  /** `validateHardTimeouts` に渡す（決定 14）。`config.recoveryConfirmMs` と同じ値。 */
  readonly recoveryConfirmMs: number;
  /** 既定 `DEFAULT_SSE_PING_INTERVAL_MS`。テストが短い値を渡せるようにする。 */
  readonly ssePingIntervalMs?: number | undefined;
}
