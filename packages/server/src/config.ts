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
  const port = Number.parseInt(env.SHUTEN_PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SHUTEN_PORT が不正です: ${env.SHUTEN_PORT}`);
  }
  return {
    host: env.SHUTEN_HOST ?? "127.0.0.1",
    port,
    dataDir: path.resolve(env.SHUTEN_DATA_DIR ?? ".data"),
    webDistDir: path.resolve(env.SHUTEN_WEB_DIST ?? "../web/dist"),
  };
}
