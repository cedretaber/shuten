import { Route, Routes } from "react-router";
import { HomePage } from "./app/home-page.tsx";
import { Layout } from "./app/layout.tsx";
import { NotFound } from "./app/not-found.tsx";
import { ROUTES } from "./app/routes.ts";
import { ConnectionSettingsPage } from "./features/connection/connection-settings-page.tsx";
import { RunReceiptPage } from "./features/run-receipt/run-receipt-page.tsx";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path={ROUTES.home} element={<HomePage />} />
        <Route path={ROUTES.connectionSettings} element={<ConnectionSettingsPage />} />
        <Route path={ROUTES.run} element={<RunReceiptPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
