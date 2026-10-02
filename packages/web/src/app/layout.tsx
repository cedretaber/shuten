import { Outlet } from "react-router";
import { Header } from "./header.tsx";
import styles from "./layout.module.css";

/** 全画面共通のヘッダーと本文領域。`main` は残りの高さに収まり、はみ出したらその中でスクロールする。 */
export function Layout() {
  return (
    <div className={styles.shell}>
      <Header />
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
