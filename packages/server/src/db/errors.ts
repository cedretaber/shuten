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
