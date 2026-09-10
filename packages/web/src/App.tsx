import { useState } from "react";
import { Route, Routes } from "react-router";
import { type ApiClient, createApiClient } from "./api/client.ts";
import { ApiClientProvider } from "./api/context.tsx";
import { ConnectionProvider } from "./app/connection-context.tsx";
import { HomePage } from "./app/home-page.tsx";
import { Layout } from "./app/layout.tsx";
import { NotFound } from "./app/not-found.tsx";
import { ROUTES } from "./app/routes.ts";
import { ConnectionSettingsPage } from "./features/connection/connection-settings-page.tsx";
import { RunReceiptPage } from "./features/run-receipt/run-receipt-page.tsx";

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
            <Route path={ROUTES.connectionSettings} element={<ConnectionSettingsPage />} />
            <Route path={ROUTES.run} element={<RunReceiptPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </ConnectionProvider>
    </ApiClientProvider>
  );
}
