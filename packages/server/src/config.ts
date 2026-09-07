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
  /** LM Studio のルート URL（`/v1` を含めない）。末尾のスラッシュは除去済み（決定 5）。 */
  readonly lmStudioUrl: string;
  /** LM Studio の API キー。未設定・空文字・空白のみは null。 */
  readonly lmStudioApiKey: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = parsePort(env.SHUTEN_PORT ?? "3000");
  return {
    host: env.SHUTEN_HOST ?? "127.0.0.1",
    port,
    dataDir: path.resolve(env.SHUTEN_DATA_DIR ?? ".data"),
    webDistDir: path.resolve(env.SHUTEN_WEB_DIST ?? "../web/dist"),
    lmStudioUrl: parseLmStudioUrl(env.SHUTEN_LM_STUDIO_URL ?? "http://127.0.0.1:1234"),
    lmStudioApiKey: parseLmStudioApiKey(env.SHUTEN_LM_STUDIO_API_KEY),
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

/**
 * LM Studio のルート URL を検証して正規化する（決定 1）。
 *
 * `new URL().href` は `http://h:1234/` のように末尾スラッシュの扱いが混ざるため使わない。
 * 検証を通した元の文字列から末尾のスラッシュだけを除去して返す。
 */
export function parseLmStudioUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`SHUTEN_LM_STUDIO_URL を URL として解析できません: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `SHUTEN_LM_STUDIO_URL は http または https でなければなりません: ${JSON.stringify(raw)}`,
    );
  }
  if (!/^\/+$/.test(url.pathname)) {
    throw new Error(
      `SHUTEN_LM_STUDIO_URL にパスを含めることはできません（ルート URL のみ）: ${JSON.stringify(raw)}`,
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(
      `SHUTEN_LM_STUDIO_URL にクエリやフラグメントを含めることはできません: ${JSON.stringify(raw)}`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    // パスワードが例外メッセージやログ・実行記録（仕様書 8.1 節）に漏れないよう raw は出さない。
    throw new Error("SHUTEN_LM_STUDIO_URL に資格情報を含めることはできません");
  }
  return trimmed.replace(/\/+$/, "");
}

/** LM Studio の API キーを読む。未設定・空文字・空白のみは null。値は trim して返す。 */
export function parseLmStudioApiKey(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}
