/**
 * `/` — 原稿と検査設定の画面。
 * 原稿（Task 7）は編集中／確定済みの 2 段階を `useManuscript` で切り替えて描画する。
 * 検査設定と開始（Task 8）は `RunSettingsForm` に委ねる。`useStartRun` はここで所有し
 * （`useManuscript` と同じ形）、成功（`outcome.kind === "started"`）したら `/runs/:id` へ遷移する。
 */

import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useApiClient } from "../api/context.tsx";
import { ManuscriptConfirmed } from "../features/manuscript/manuscript-confirmed.tsx";
import { ManuscriptEditor } from "../features/manuscript/manuscript-editor.tsx";
import { useManuscript } from "../features/manuscript/use-manuscript.ts";
import { RunSettingsForm } from "../features/settings/run-settings-form.tsx";
import { useStartRun } from "../features/settings/use-start-run.ts";
import { useConnection } from "./connection-context.tsx";
import { runPath } from "./routes.ts";

export function HomePage() {
  const client = useApiClient();
  const connection = useConnection();
  const manuscript = useManuscript(client);
  const startApi = useStartRun({ client, connection });
  const navigate = useNavigate();

  useEffect(() => {
    if (startApi.outcome.kind === "started") {
      navigate(runPath(startApi.outcome.runId));
    }
  }, [startApi.outcome, navigate]);

  const manuscriptVersionId =
    manuscript.state.kind === "confirmed" ? manuscript.state.version.id : null;

  return (
    <div>
      <h1>原稿と検査設定</h1>
      {manuscript.state.kind === "editing" ? (
        <ManuscriptEditor api={manuscript} />
      ) : (
        <ManuscriptConfirmed version={manuscript.state.version} onReset={manuscript.reset} />
      )}
      <RunSettingsForm
        manuscriptVersionId={manuscriptVersionId}
        modelId={connection.selectedModelId}
        restoring={manuscript.restoring}
        startApi={startApi}
      />
    </div>
  );
}
