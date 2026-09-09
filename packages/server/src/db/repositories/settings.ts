import { eq } from "drizzle-orm";

import type { AppDatabaseLike } from "../client.ts";
import { settings } from "../schema.ts";

/**
 * UI から設定する値の永続化（PR10 決定 5）。
 *
 * `settings` 表はキー・バリューの汎用の形（`docs` の仕様書 5.1 節、`schema.ts` 参照）だが、
 * PR10 で使う鍵は接続先 URL の 1 つだけ。**API キーはここに保存しない**（決定 5。プロセスの
 * メモリのみ）。値の検証（`parseLmStudioUrl` など）はこのリポジトリの責務ではなく、
 * 呼び出し側（`connection.ts`）が行う。
 */

/** `settings` の `key`。LM Studio の接続先ルート URL（決定 5）。 */
export const LM_STUDIO_URL_KEY = "lm_studio_url";

/** 設定値を鍵で 1 件探す。見つからなければ null。 */
export function getSetting(db: AppDatabaseLike, key: string): string | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? null;
}

/**
 * 設定値を書く（upsert）。既に同じ鍵の行があれば `value` と `updated_at` を上書きし、
 * なければ新しく作る。`now` 省略時は現在時刻を使う。
 */
export function setSetting(db: AppDatabaseLike, key: string, value: string, now?: Date): void {
  const updatedAt = now ?? new Date();
  db.insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt },
    })
    .run();
}
