import path from "node:path";

/**
 * サーバー設定。環境変数から読み、未指定なら既定値を使う。
 *
 * 仕様書 9 節のとおり、既定ではループバックアドレスのみで待ち受ける。
 */
export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  /** SQLite ファイルや将来の一括エクスポートを置くディレクトリ。 */
  readonly dataDir: string;
  /** web パッケージのビルド成果物。存在しなければ静的配信をスキップする。 */
  readonly webDistDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = parsePort(env.SHUTEN_PORT ?? "3000");
  return {
    host: env.SHUTEN_HOST ?? "127.0.0.1",
    port,
    dataDir: path.resolve(env.SHUTEN_DATA_DIR ?? ".data"),
    webDistDir: path.resolve(env.SHUTEN_WEB_DIST ?? "../web/dist"),
  };
}

/**
 * ポート番号の文字列を検証して数値にする。
 *
 * `Number.parseInt` は "3000oops" や "3000.5" を 3000、"3e3" を 3 として黙って受け入れるため、
 * 文字列全体が十進の整数表記であることを先に確認する。
 */
export function parsePort(raw: string): number {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`SHUTEN_PORT が不正です（十進の整数のみ）: ${JSON.stringify(raw)}`);
  }
  const port = Number(trimmed);
  if (port <= 0 || port > 65535) {
    throw new Error(`SHUTEN_PORT が範囲外です（1〜65535）: ${raw}`);
  }
  return port;
}
