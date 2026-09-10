/**
 * API クライアントを画面へ配る context。`createApiClient()` はここでは呼ばない：
 * `App.tsx` が 1 回だけ呼び、`client` を props で渡す（Task 5）。画面のテストは fake の
 * `fetch` で作ったクライアントを渡せばよい。
 */

import { createContext, type ReactNode, useContext } from "react";

import type { ApiClient } from "./client.ts";

const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider(props: {
  client: ApiClient;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <ApiClientContext.Provider value={props.client}>{props.children}</ApiClientContext.Provider>
  );
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === null) {
    throw new Error("useApiClient は ApiClientProvider の内側で呼び出してください");
  }
  return client;
}
