/**
 * `/` — 原稿と検査設定の画面。
 * 原稿（Task 7）は編集中／確定済みの 2 段階を `useManuscript` で切り替えて描画する。
 * 検査設定（Task 8）は後続タスクが埋める。
 */

import { useApiClient } from "../api/context.tsx";
import { ManuscriptConfirmed } from "../features/manuscript/manuscript-confirmed.tsx";
import { ManuscriptEditor } from "../features/manuscript/manuscript-editor.tsx";
import { useManuscript } from "../features/manuscript/use-manuscript.ts";

export function HomePage() {
  const client = useApiClient();
  const manuscript = useManuscript(client);

  return (
    <div>
      <h1>原稿と検査設定</h1>
      {manuscript.state.kind === "editing" ? (
        <ManuscriptEditor api={manuscript} />
      ) : (
        <ManuscriptConfirmed version={manuscript.state.version} onReset={manuscript.reset} />
      )}
    </div>
  );
}
