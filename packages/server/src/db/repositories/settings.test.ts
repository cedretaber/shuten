import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDatabase } from "../client.ts";
import { applyMigrations } from "../migrate.ts";
import { settings } from "../schema.ts";
import { getSetting, LM_STUDIO_URL_KEY, setSetting } from "./settings.ts";

/** `settings` の 1 行を直接読む（`updated_at` は `getSetting` の戻り値に出ないため）。 */
function readUpdatedAt(db: ReturnType<typeof createDatabase>["db"], key: string): Date | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.updatedAt;
}

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

describe("db/repositories/settings", () => {
  it("S1: 未設定の鍵は getSetting が null を返す", () => {
    const { db, close } = setupDb();
    expect(getSetting(db, LM_STUDIO_URL_KEY)).toBeNull();
    close();
  });

  it("S2: setSetting で書いた値が getSetting で往復する", () => {
    const { db, close } = setupDb();
    setSetting(db, LM_STUDIO_URL_KEY, "http://127.0.0.1:1234");
    expect(getSetting(db, LM_STUDIO_URL_KEY)).toBe("http://127.0.0.1:1234");
    close();
  });

  it("S3: setSetting を同じ鍵で2回呼ぶと上書きされる（INSERT ... ON CONFLICT DO UPDATE）", () => {
    const { db, close } = setupDb();
    setSetting(db, LM_STUDIO_URL_KEY, "http://127.0.0.1:1234");
    setSetting(db, LM_STUDIO_URL_KEY, "http://127.0.0.1:5678");
    expect(getSetting(db, LM_STUDIO_URL_KEY)).toBe("http://127.0.0.1:5678");
    close();
  });

  it("S4: 別の鍵は互いに独立して読み書きできる", () => {
    const { db, close } = setupDb();
    setSetting(db, LM_STUDIO_URL_KEY, "http://127.0.0.1:1234");
    setSetting(db, "other_key", "other-value");
    expect(getSetting(db, LM_STUDIO_URL_KEY)).toBe("http://127.0.0.1:1234");
    expect(getSetting(db, "other_key")).toBe("other-value");
    expect(getSetting(db, "no-such-key")).toBeNull();
    close();
  });

  it("S5: now を渡すとその値が updated_at に使われ、省略すると現在時刻が使われる", () => {
    const { db, close } = setupDb();
    const at = new Date("2026-09-09T00:00:00.000Z");
    setSetting(db, LM_STUDIO_URL_KEY, "http://127.0.0.1:1234", at);
    expect(readUpdatedAt(db, LM_STUDIO_URL_KEY)).toEqual(at);

    const before = Date.now();
    setSetting(db, "other_key", "other-value");
    const after = Date.now();
    const updatedAt = readUpdatedAt(db, "other_key");
    expect(updatedAt).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: 直前で toBeDefined() を確認済み
    expect(updatedAt!.getTime()).toBeGreaterThanOrEqual(before);
    // biome-ignore lint/style/noNonNullAssertion: 直前で toBeDefined() を確認済み
    expect(updatedAt!.getTime()).toBeLessThanOrEqual(after);
    close();
  });

  it("S6: 上書き（S3）でも updated_at が新しい値に更新される", () => {
    const { db, close } = setupDb();
    const first = new Date("2026-09-09T00:00:00.000Z");
    const second = new Date("2026-09-09T01:00:00.000Z");
    setSetting(db, LM_STUDIO_URL_KEY, "http://127.0.0.1:1234", first);
    setSetting(db, LM_STUDIO_URL_KEY, "http://127.0.0.1:5678", second);
    expect(readUpdatedAt(db, LM_STUDIO_URL_KEY)).toEqual(second);
    close();
  });
});
