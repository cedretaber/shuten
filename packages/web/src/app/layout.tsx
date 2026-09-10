import { Outlet } from "react-router";
import { Header } from "./header.tsx";

/** 全画面共通のヘッダーと本文領域。 */
export function Layout() {
  return (
    <div>
      <Header />
      <main>
        <Outlet />
      </main>
    </div>
  );
}
