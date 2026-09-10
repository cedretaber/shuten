import { useState } from "react";
import { Route, Routes } from "react-router";
import { createApiClient } from "./api/client.ts";
import { ApiClientProvider } from "./api/context.tsx";
import { ConnectionProvider } from "./app/connection-context.tsx";
import { HomePage } from "./app/home-page.tsx";
import { Layout } from "./app/layout.tsx";
import { NotFound } from "./app/not-found.tsx";
import { ROUTES } from "./app/routes.ts";
import { ConnectionSettingsPage } from "./features/connection/connection-settings-page.tsx";
import { RunReceiptPage } from "./features/run-receipt/run-receipt-page.tsx";

export function App() {
  // `createApiClient()` はここで 1 回だけ呼ぶ（Task 5）。
  const [client] = useState(() => createApiClient());

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
