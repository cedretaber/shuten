/**
 * 復旧ゲート（決定 39）。
 *
 * 「復旧待ち」（生成が LM Studio 側で走り続けている可能性があり、終了を確認できていない状態）は
 * 実行単位の性質ではなく、プロセス全体の送信ゲートにする。仕様 8.2 の「前の生成が継続している
 * 可能性がある場合は後続生成を送信しない」は LM Studio への送信全体に効く要件であり、
 * 「バックエンド全体で同時実行数 1」（仕様 2 節）を守るには、復旧待ちの実行が 1 件でもある間、
 * 別の実行を含めて新しい生成要求を送らない必要がある。
 *
 * ブロックの出入りは呼び出し元（オーケストレーター）の責務。開ける側はすべて
 * `markRecoveryConfirmed`（PR10 決定 11。確認時刻を書いてから unblock）を通る：
 * - 実行が recovery-waiting になったとき → block(runId)
 * - resumeRun が recovery-waiting の実行の claimRunChecked に成功したとき → unblock(runId)
 * - resumeRun が版の食い違い（決定 45-1）・接続先の食い違い（PR10 決定 6）で
 *   recovery-waiting の実行を拒否したとき → unblock(runId)
 *   （ゲートを開ける意味は「利用者が生成終了を確認した」ことで、その実行を続けられるかとは独立）
 * - confirmRecovery（PR10 決定 11。復旧の確認だけを行い、実行の status は変えない）→ unblock(runId)。
 *   ただし**走っているループがある実行では unblock まで進まない**（レジストリで判定する。
 *   レビュー裁定 R11）。ゲートは実行が recovery-waiting になる前から閉じるので、running の
 *   実行 ID が blockedRunIds に入っている間にも確認操作が届きうる
 * - reconcileOnStartup が起動時に status = "recovery-waiting" の実行を読み、
 *   **まだ確認されていない（recovery_confirmed_at IS NULL）ものだけ** block する
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
