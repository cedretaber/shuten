/**
 * 復旧ゲート（決定 39）。
 *
 * 「復旧待ち」（生成が LM Studio 側で走り続けている可能性があり、終了を確認できていない状態）は
 * 実行単位の性質ではなく、プロセス全体の送信ゲートにする。仕様 8.2 の「前の生成が継続している
 * 可能性がある場合は後続生成を送信しない」は LM Studio への送信全体に効く要件であり、
 * 「バックエンド全体で同時実行数 1」（仕様 2 節）を守るには、復旧待ちの実行が 1 件でもある間、
 * 別の実行を含めて新しい生成要求を送らない必要がある。
 *
 * ブロックの出入りは呼び出し元（オーケストレーター）の責務：
 * - 実行が recovery-waiting になったとき → block(runId)
 * - resumeRun が recovery-waiting の実行の claimRunChecked に成功したとき → unblock(runId)
 * - reconcileOnStartup が起動時に status = "recovery-waiting" の実行を読み、全件 block する
 */
export interface RecoveryGate {
  /** 復旧待ちの実行 ID。1 件でもあれば送信を止める（単一 boolean にしない）。 */
  readonly blockedRunIds: ReadonlySet<string>;
  readonly blocked: boolean;
  /** 冪等：同じ runId を 2 回 block しても害はない。 */
  block(runId: string): void;
  /** block していない runId を unblock しても害はない。 */
  unblock(runId: string): void;
}

export function createRecoveryGate(): RecoveryGate {
  const blockedRunIds = new Set<string>();

  return {
    get blockedRunIds(): ReadonlySet<string> {
      return blockedRunIds;
    },
    get blocked(): boolean {
      return blockedRunIds.size > 0;
    },
    block(runId: string): void {
      blockedRunIds.add(runId);
    },
    unblock(runId: string): void {
      blockedRunIds.delete(runId);
    },
  };
}
