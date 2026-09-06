import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDatabase } from "./client.ts";
import { manuscripts } from "./schema.ts";

describe("createDatabase", () => {
  it("メモリ DB に 1 行書いて読み戻せる", () => {
    const db = createDatabase(":memory:");
    db.run(sql`
      CREATE TABLE manuscripts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    const body = "本文\r\n二行目\r三行目\n𠮷";
    const createdAt = new Date(1_700_000_000_000);
    db.insert(manuscripts).values({ id: "m1", name: "試験", body, createdAt }).run();

    const rows = db.select().from(manuscripts).all();
    expect(rows).toEqual([{ id: "m1", name: "試験", body, createdAt }]);
    expect(rows[0]?.body).toBe(body);
  });
});
