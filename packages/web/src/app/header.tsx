/**
 * 全画面共通のヘッダー。接続状態・選択モデル・最終確認時刻・「再確認」・設定画面へのリンクを出す。
 * 接続先 URL はここには出さない（接続設定画面だけが持つ、決定 18）。
 *
 * 表示は「最後に確認した時点の状態」であり、ポーリングはしない（決定 8）。
 * 「再確認」は手動でその場の `checkConnection` を呼ぶだけで、定期的な再確認ではない。
 */

import { Link } from "react-router";
import { useConnection } from "./connection-context.tsx";
import styles from "./header.module.css";
import { ROUTES } from "./routes.ts";

function formatCheckedAt(checkedAt: Date | null): string {
  if (checkedAt === null) return "未確認";
  return `${checkedAt.toLocaleTimeString()} 時点`;
}

function connectionStatusLabel(state: {
  checking: boolean;
  error: string | null;
  check: { reachable: boolean } | null;
}): string {
  if (state.error !== null) return "確認できませんでした";
  if (state.check === null) return state.checking ? "確認中…" : "未確認";
  return state.check.reachable ? "接続できています" : "接続できません";
}

export function Header() {
  const connection = useConnection();

  const handleRecheck = () => {
    connection.checkConnection(connection.selectedModelId ?? undefined).catch(() => {
      // 失敗は context の error に反映済み。ここでは何もしない。
    });
  };

  return (
    <header className={styles.header}>
      <Link to={ROUTES.home} className={styles.title}>
        朱点
      </Link>
      <div className={styles.status}>
        <span>{connectionStatusLabel(connection)}</span>
        <span>選択モデル：{connection.selectedModelId ?? "未選択"}</span>
        <span>最後に確認：{formatCheckedAt(connection.checkedAt)}</span>
        {connection.error !== null && <span className={styles.error}>{connection.error}</span>}
        <button
          type="button"
          className={styles.recheckButton}
          onClick={handleRecheck}
          disabled={connection.checking}
        >
          再確認
        </button>
        <Link to={ROUTES.settings} className={styles.settingsLink}>
          設定
        </Link>
      </div>
    </header>
  );
}
