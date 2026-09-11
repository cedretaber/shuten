import { useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { type ApiClient, createApiClient } from "./api/client.ts";
import { ApiClientProvider } from "./api/context.tsx";
import { ConnectionProvider } from "./app/connection-context.tsx";
import { HomePage } from "./app/home-page.tsx";
import { Layout } from "./app/layout.tsx";
import { NotFound } from "./app/not-found.tsx";
import { ROUTES } from "./app/routes.ts";
import { SettingsPage } from "./app/settings-page.tsx";
import { ResultsPage } from "./features/results/results-page.tsx";
import { RunListPage } from "./features/run-list/run-list-page.tsx";

export interface AppProps {
  /** 省略時は `createApiClient()`（既定の `globalThis.fetch`）。テストは fake を注入する。 */
  client?: ApiClient;
}

export function App({ client: injectedClient }: AppProps = {}) {
  // `createApiClient()` はここで 1 回だけ呼ぶ（Task 5）。
  const [client] = useState(() => injectedClient ?? createApiClient());

  return (
    <ApiClientProvider client={client}>
      <ConnectionProvider client={client}>
        <Routes>
          <Route element={<Layout />}>
            <Route path={ROUTES.home} element={<HomePage />} />
            <Route path={ROUTES.settings} element={<SettingsPage />} />
            {/* replace を付けるのは、戻るボタンで旧パス → 新パスの往復に落ちないようにするため。 */}
            <Route
              path={ROUTES.legacyConnectionSettings}
              element={<Navigate to={ROUTES.settings} replace />}
            />
            {/* react-router 8 系はセグメント数で特異性を判定するため、`/runs` と `/runs/:id` の
                順序に競合は無い（どちらを先に書いても一致する方へ解決する）。ここでは静的パスを
                先に書く並びが読みやすいというだけの理由で `/runs` を先に置く。 */}
            <Route path={ROUTES.runs} element={<RunListPage />} />
            <Route path={ROUTES.run} element={<ResultsPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </ConnectionProvider>
    </ApiClientProvider>
  );
}
