import { useParams } from "react-router";

/**
 * `/runs/:id` — 実行の受付表示画面。
 * 見出しと実行 ID だけの最小の中身。状態取得・表示は Task 9 が埋める。
 */
export function RunReceiptPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div>
      <h1>実行状況</h1>
      <p>実行 ID: {id}</p>
    </div>
  );
}
