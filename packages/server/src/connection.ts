/**
 * LM Studio への接続の供給元（PR10 決定 5・6・19）。
 *
 * オーケストレーターは `client` と `endpointUrl` を直接持たず、この `ConnectionSource` から
 * 実行の開始・再開・再試行の時点で 1 回だけ読む（決定 6）。`ConnectionManager` はその実体で、
 * 接続先 URL（`settings` 表、決定 5）と API キー（プロセスのメモリのみ、決定 5）を持ち、
 * `update()` で両方を差し替えられる。
 */

import { InvalidLmStudioUrlError, parseLmStudioUrl } from "./config.ts";
import type { AppDatabase } from "./db/client.ts";
import { getSetting, LM_STUDIO_URL_KEY, setSetting } from "./db/repositories/settings.ts";
import { createLmStudioClient } from "./lmstudio/client.ts";
import type { LmStudioClient, LmStudioClientOptions } from "./lmstudio/types.ts";

/**
 * `settings` 表に保存された接続先 URL が `parseLmStudioUrl` を通らないとき（DB を手で編集した
 * 場合）に投げる例外のメッセージ。**接続先 URL を含まない**（決定 5「URL を含まない定型文を
 * 出して非ゼロ終了する」。公開リポジトリの制約「接続先 URL をログ・エラーメッセージに出さない」）。
 * `index.ts`（Task 4）はこれを捕まえず、そのままプロセスを非ゼロ終了させる。
 */
export const INVALID_STORED_LM_STUDIO_URL_MESSAGE =
  "settings 表に保存された LM Studio 接続先 URL が不正です。settings 表の lm_studio_url を修正するか削除してから再起動してください。";

export interface ConnectionSnapshot {
  readonly client: LmStudioClient;
  readonly endpointUrl: string;
}

export interface ConnectionSource {
  /** 現在の接続。開始・再開・再試行の時点で 1 回だけ読み、その実行に固定する。 */
  current(): ConnectionSnapshot;
}

export interface ConnectionManager extends ConnectionSource {
  describe(): { readonly endpointUrl: string; readonly hasApiKey: boolean };
  /**
   * `endpointUrl` は `parseLmStudioUrl` を通す（不正なら `InvalidLmStudioUrlError` を投げ、
   * 何も変えない）。`apiKey`：省略＝維持、`null`＝消去、文字列＝設定（空白のみは消去）。
   * 古いクライアントは `close()` する。`await` しないが未処理の reject にはしない
   * （メッセージは接続先を含みうるのでクラス名だけログに出す）。
   */
  update(input: {
    readonly endpointUrl: string;
    readonly apiKey?: string | null | undefined;
  }): void;
}

export interface CreateConnectionManagerOptions {
  readonly db: AppDatabase;
  /** `config.ts` の `ServerConfig` から渡す起動時の既定値。 */
  readonly env: { readonly lmStudioUrl: string; readonly lmStudioApiKey: string | null };
  /** テスト差し替え用。省略時は `createLmStudioClient`。 */
  readonly createClient?: ((options: LmStudioClientOptions) => LmStudioClient) | undefined;
}

/** `apiKey` の入力（省略・null・文字列）から次の内部値を決める（決定 5）。空白のみは消去。 */
function resolveNextApiKey(
  current: string | null,
  input: string | null | undefined,
): string | null {
  if (input === undefined) {
    return current;
  }
  if (input === null) {
    return null;
  }
  const trimmed = input.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 起動時の接続先 URL を決める。`settings` 表に行があれば環境変数より優先する（決定 5）。
 * 保存済みの値が不正なら `INVALID_STORED_LM_STUDIO_URL_MESSAGE`（URL を含まない）で例外にする。
 */
function resolveInitialEndpointUrl(db: AppDatabase, envUrl: string): string {
  const stored = getSetting(db, LM_STUDIO_URL_KEY);
  if (stored === null) {
    return envUrl;
  }
  try {
    return parseLmStudioUrl(stored);
  } catch (err) {
    if (err instanceof InvalidLmStudioUrlError) {
      throw new Error(INVALID_STORED_LM_STUDIO_URL_MESSAGE);
    }
    throw err;
  }
}

export function createConnectionManager(
  options: CreateConnectionManagerOptions,
): ConnectionManager {
  const { db } = options;
  const createClient = options.createClient ?? createLmStudioClient;

  let endpointUrl = resolveInitialEndpointUrl(db, options.env.lmStudioUrl);
  let apiKey = options.env.lmStudioApiKey;
  let client = createClient({ baseUrl: endpointUrl, apiKey });

  function current(): ConnectionSnapshot {
    return { client, endpointUrl };
  }

  function describe(): { readonly endpointUrl: string; readonly hasApiKey: boolean } {
    return { endpointUrl, hasApiKey: apiKey !== null };
  }

  function update(input: {
    readonly endpointUrl: string;
    readonly apiKey?: string | null | undefined;
  }): void {
    // 検証を先に行い、失敗したら（InvalidLmStudioUrlError）ここで投げて何も変えない。
    const validatedUrl = parseLmStudioUrl(input.endpointUrl);
    const nextApiKey = resolveNextApiKey(apiKey, input.apiKey);

    // 新しいクライアントを先に作る。ここで投げたら、まだ何も変えていない（例外はそのまま伝播する）。
    const old = client;
    const next = createClient({ baseUrl: validatedUrl, apiKey: nextApiKey });

    try {
      setSetting(db, LM_STUDIO_URL_KEY, validatedUrl);
    } catch (e) {
      // DB 書き込みが失敗したら、まだ差し替えていない client / endpointUrl / apiKey はそのまま。
      // 作ってしまった next だけ閉じ、元の例外はそのまま伝播させる（メッセージは接続先を
      // 含みうるのでクラス名だけをログに出す。未処理の reject にはしない）。
      void next
        .close()
        .catch((closeErr) =>
          console.error(
            "client close failed:",
            closeErr instanceof Error ? closeErr.name : "unknown",
          ),
        );
      throw e;
    }

    client = next;
    endpointUrl = validatedUrl;
    apiKey = nextApiKey;

    // 古いクライアントを閉じる。await はしないが、reject を未処理のまま放置しない
    // （メッセージ＝LmStudioError.message は接続先を含みうるのでクラス名だけをログに出す）。
    void old
      .close()
      .catch((e) => console.error("client close failed:", e instanceof Error ? e.name : "unknown"));
  }

  return { current, describe, update };
}

/** テスト用：固定値を返すだけの `ConnectionSource`。 */
export function fixedConnection(client: LmStudioClient, endpointUrl: string): ConnectionSource {
  return {
    current: () => ({ client, endpointUrl }),
  };
}
