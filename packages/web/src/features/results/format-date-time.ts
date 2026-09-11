/**
 * ISO 8601 の日時文字列を `YYYY-MM-DD HH:mm:ss` の形に決定的に整形する（`run-header.tsx` が使う）。
 *
 * `toLocaleString` 等のロケール依存の整形は、実行環境（開発機・CI）のタイムゾーン設定によって
 * 結果が変わりテストが揺れるため使わない。`Date` は `Z` 付き・オフセット付きのどちらの入力も
 * 同じ瞬間として正しく解釈できるので、そこから `getUTC*` 系だけを使って組み立てる。
 *
 * つまり**常に UTC で表示する**：実行環境のタイムゾーンに一切依存させないことを、ローカル時刻
 * らしい見た目より優先した（ローカル時刻での表示が要るなら、別途「どのタイムゾーンで見せるか」の
 * 設計判断が要る。本タスクの範囲外）。
 */
export function formatDateTime(iso: string | null): string | null {
  if (iso === null) return null;

  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");

  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
