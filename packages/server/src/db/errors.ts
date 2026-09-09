/**
 * 保存本文に孤立サロゲート（対になっていないサロゲートコード単位）が含まれるときに投げる例外
 * （決定 17）。DB に行を作る前に弾き、壊れた文字列を書記素分割や照合の入力にしない。
 */
export class MalformedBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedBodyError";
  }
}

/**
 * `body` が孤立サロゲートを含まない、Unicode として整形式な文字列かを検査する。
 * `String.prototype.isWellFormed()`（Node 20 以降）を使う。不正なら `MalformedBodyError` を投げる。
 */
export function assertWellFormedBody(body: string): void {
  if (!body.isWellFormed()) {
    throw new MalformedBodyError("保存本文に孤立サロゲートが含まれています");
  }
}

/**
 * better-sqlite3 が投げる一意制約違反かどうかを判定する（決定 12）。
 *
 * better-sqlite3 の `SqliteError` は `code: "SQLITE_CONSTRAINT_UNIQUE"` を持つが、
 * どの列の一意制約に違反したかは `error.message`（`UNIQUE constraint failed: table.column`）
 * にしか出ない。`column` にはドット区切りの列名（例: `"start_operation_id"`）を渡し、
 * メッセージにその文字列が含まれるかで判定する。`code` が一致しない、または
 * メッセージに列名が含まれない場合は false（呼び出し側はそのまま再送出すること。決定 12）。
 */
export function isUniqueConstraintViolation(error: unknown, column: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if ((error as { readonly code?: unknown }).code !== "SQLITE_CONSTRAINT_UNIQUE") {
    return false;
  }
  return error.message.includes(column);
}
