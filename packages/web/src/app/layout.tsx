import { Outlet } from "react-router";

/**
 * 全画面共通のヘッダー枠と本文領域。
 * ヘッダーの中身（接続状態・選択モデルなど）は後続タスクで埋める。
 */
export function Layout() {
  return (
    <div>
      <header>
        <p>朱点</p>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
