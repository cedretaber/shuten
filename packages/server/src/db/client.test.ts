import { describe, expect, it } from "vitest";
import { createDatabase } from "./client.ts";
import { applyMigrations } from "./migrate.ts";
import { manuscriptVersions } from "./schema.ts";

describe("createDatabase", () => {
  it("メモリ DB に 1 行書いて読み戻せる", () => {
    const { db, close } = createDatabase(":memory:");
    applyMigrations(db);

    const body = "本文\r\n二行目\r三行目\n𠮷";
    const createdAt = new Date(1_700_000_000_000);
    db.insert(manuscriptVersions)
      .values({ id: "m1", name: "試験", body, bodyHash: "hash", createdAt })
      .run();

    const rows = db.select().from(manuscriptVersions).all();
    expect(rows).toEqual([{ id: "m1", name: "試験", body, bodyHash: "hash", createdAt }]);
    expect(rows[0]?.body).toBe(body);

    close();
  });
});
