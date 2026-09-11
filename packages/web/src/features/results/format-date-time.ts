/**
 * ISO 8601 の日時文字列を `YYYY-MM-DD HH:mm:ss` の形に決定的に整形する（`run-header.tsx`・
 * `run-list-page.tsx` が使う）。
 *
 * 裁定（最終レビュー Important 3）：単一利用者のローカル Windows アプリで、常に UTC のまま
 * 表示し UTC だと分かる印も無いのは実害がある（JST の利用者には全画面の時刻が 9 時間ずれて
 * 見える）ため、**ローカル時刻で表示する**。ただしテストの決定性は保つため、実行環境の
 * タイムゾーン設定に直接依存させない——時差を `offsetMinutes`（UTC からの分。JST なら +540）
 * として呼び出し側から受け取る**純関数**にする。
 *
 * 呼び出し側（`run-header.tsx`・`run-list-page.tsx`）は `-new Date(iso).getTimezoneOffset()` を渡す
 * （表示対象の瞬間 `iso` におけるブラウザのローカルタイムゾーンオフセット。DST があってもその
 * 瞬間の値を使う）。`toLocaleString` 等のロケール依存の整形は使わない（実装系・ロケール設定に
 * よって書式そのものが揺れるため）。`offsetMinutes` を明示的な引数にすることで、単体テストは
 * `0`・`+540`・`-300` のような値を渡し、日付・月・年をまたぐ境界を含めて決定的に検査できる。
 */
export function formatDateTime(iso: string | null, offsetMinutes: number): string | null {
  if (iso === null) return null;

  // `Date` はどちらの入力（`Z` 付き・オフセット付き）も同じ瞬間として正しく解釈できる。
  // その瞬間に `offsetMinutes` 分だけシフトした「見かけの時刻」を UTC 系のフィールドから
  // 組み立てる（実行環境のタイムゾーン設定を一切経由しないので決定的）。
  const shifted = new Date(new Date(iso).getTime() + offsetMinutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");

  const year = shifted.getUTCFullYear();
  const month = pad(shifted.getUTCMonth() + 1);
  const day = pad(shifted.getUTCDate());
  const hours = pad(shifted.getUTCHours());
  const minutes = pad(shifted.getUTCMinutes());
  const seconds = pad(shifted.getUTCSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
