import { countGraphemes } from "@shuten/shared";
import { useEffect, useState } from "react";

interface Health {
  status: string;
  node: string;
  graphemeCheck: number;
}

/** scaffold の動作確認用の最小画面。実装設計後に置き換える。 */
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<Health>)
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main>
      <h1>朱点</h1>
      <p>ブラウザ側の書記素計数: {countGraphemes("👨‍👩‍👧")}</p>
      {health ? (
        <p>
          サーバー: {health.status} / Node {health.node} / サーバー側の書記素計数:{" "}
          {health.graphemeCheck}
        </p>
      ) : error ? (
        <p>サーバーに接続できません: {error}</p>
      ) : (
        <p>サーバーに接続中…</p>
      )}
    </main>
  );
}
