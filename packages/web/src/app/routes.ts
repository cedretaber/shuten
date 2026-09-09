/** アプリ内の画面パス。パス文字列はここ以外に書かない。 */
export const ROUTES = {
  home: "/",
  connectionSettings: "/settings/connection",
  run: "/runs/:id",
} as const;

/** `/runs/:id` へのパスを組み立てる。 */
export function runPath(id: string): string {
  return `/runs/${encodeURIComponent(id)}`;
}
