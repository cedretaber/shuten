import { createHash } from "node:crypto";

/** 保存本文の UTF-8 バイト列に対する SHA-256 を、小文字 16 進文字列で返す。 */
export function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
