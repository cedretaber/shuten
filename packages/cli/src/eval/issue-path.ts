/**
 * zod の issue の `path` を `"a.b.c"` 形式の文字列に整形する。空なら `"(root)"`。
 *
 * `truth.ts`（正解ファイルの検証。`path: message` の形にする）と
 * `result-schema.ts`（結果 JSON の検証。`path: code` の形にする）の両方の `formatIssues` が
 * 使う共通部分。「path をどう文字列にするか」だけを切り出し、`message` と `code` のどちらを
 * 末尾に使うかは呼び出し側に委ねる。
 */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "(root)" : path.map((part) => String(part)).join(".");
}
