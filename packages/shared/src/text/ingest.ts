/** UTF-8 として読めないバイト列を受け取ったときの例外。 */
export class Utf8DecodeError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("UTF-8 として読み込めません", options);
    this.name = "Utf8DecodeError";
  }
}

// モジュール内で 1 つだけ作成する。ignoreBOM: true により、デコード時に BOM を除去しない。
// stream オプションなしの decode() は呼び出しごとに内部状態をリセットし、例外の後も再利用できる。
// 同期呼び出しなので複数の呼び出し元が割り込むこともない。
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * バイト列を UTF-8 として厳密にデコードする。不正なバイト列は Utf8DecodeError。
 * 先頭の BOM（U+FEFF）は除去せず文字列に残す。BOM の除外は stripBom の責務。
 */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw new Utf8DecodeError({ cause: error });
  }
}

/** 先頭の U+FEFF を最大 1 文字だけ除外する。本文中の U+FEFF は残す。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * ファイル入力の取り込み経路。decodeUtf8Strict の結果に stripBom を一度だけ適用する。
 * 保存本文や後続処理で stripBom を再適用してはならない。
 */
export function ingestUtf8Bytes(bytes: Uint8Array): string {
  return stripBom(decodeUtf8Strict(bytes));
}
