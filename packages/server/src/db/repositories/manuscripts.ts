import { eq } from "drizzle-orm";
import { hashBody } from "../../hash.ts";
import type { AppDatabase } from "../client.ts";
import { assertWellFormedBody } from "../errors.ts";
import { createId } from "../ids.ts";
import type { ManuscriptVersionRecord } from "../records.ts";
import { manuscriptVersions } from "../schema.ts";

/** `insertManuscriptVersion` の入力。`id`・`createdAt` は省略可能。 */
export interface InsertManuscriptVersionInput {
  readonly name: string;
  readonly body: string;
  readonly id?: string;
  readonly createdAt?: Date;
}

/**
 * 原稿版を 1 件保存する。
 *
 * 保存前に `assertWellFormedBody` で孤立サロゲートの有無を検査する（決定 17）。
 * 不正なら `MalformedBodyError` を投げ、DB に行を作らない。`bodyHash` は検査を通った後に計算する。
 * `body` は一切加工しない（trim・改行変換・正規化をしない）。
 */
export function insertManuscriptVersion(
  db: AppDatabase,
  input: InsertManuscriptVersionInput,
): ManuscriptVersionRecord {
  assertWellFormedBody(input.body);
  const id = input.id ?? createId();
  const createdAt = input.createdAt ?? new Date();
  const bodyHash = hashBody(input.body);
  db.insert(manuscriptVersions)
    .values({ id, name: input.name, body: input.body, bodyHash, createdAt })
    .run();
  return { id, name: input.name, body: input.body, bodyHash, createdAt };
}

/** 原稿版を ID で 1 件探す。見つからなければ null。 */
export function findManuscriptVersion(db: AppDatabase, id: string): ManuscriptVersionRecord | null {
  const row = db.select().from(manuscriptVersions).where(eq(manuscriptVersions.id, id)).get();
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    bodyHash: row.bodyHash,
    createdAt: row.createdAt,
  };
}
