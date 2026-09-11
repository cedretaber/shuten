import { ingestUtf8Bytes } from "@shuten/shared";

/**
 * `main.ts` のサブコマンド間で共通の入出力ヘルパー（決定 9）。`run` と `hash` の両方が使う
 * 「原稿読み込み＋UTF-8 取り込み」と「結果書き出し」をここに 1 か所へまとめる。
 * パス漏えい対策（固定文言のみを返す）を 2 か所で同期させ忘れる事故を避けるため。
 */

/** 呼び出し側の `writeErrorLine` にそのまま渡せる、固定文言のエラー値。 */
export type IoResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** `readManuscriptText` が要る入出力だけを取り出した形。`MainIO` は構造的にこれを満たす。 */
export interface ManuscriptReader {
  readonly readManuscriptBytes: (path: string) => Promise<Uint8Array>;
}

/** `writeResultOrFixedError` が要る入出力だけを取り出した形。`MainIO` は構造的にこれを満たす。 */
export interface ResultWriter {
  readonly writeResult: (outPath: string | null, content: string) => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 原稿を読み込み UTF-8 として取り込む（`run` の原稿読み込みと `hash` の原稿読み込みで共通）。
 *
 * 読み込み失敗は固定文言（Node の `fs` の例外メッセージはパスを含むため、原因を連結しない。
 * 決定 9）。UTF-8 デコード失敗（`ingestUtf8Bytes` が投げる `Utf8DecodeError`）はパスを含まない
 * 固定メッセージなので、従来どおり原因を連結する。
 */
export async function readManuscriptText(
  io: ManuscriptReader,
  path: string,
): Promise<IoResult<string>> {
  let bytes: Uint8Array;
  try {
    bytes = await io.readManuscriptBytes(path);
  } catch {
    return { ok: false, error: "原稿ファイルを読み込めません" };
  }
  try {
    return { ok: true, value: ingestUtf8Bytes(bytes) };
  } catch (error) {
    return { ok: false, error: `原稿ファイルを UTF-8 として読み込めません: ${messageOf(error)}` };
  }
}

/**
 * 結果を書き出す（`run` の結果 JSON、`hash` の 1 行の両方で共通）。
 *
 * 失敗は固定文言（`fs` の書き出し失敗のメッセージも書き込み先パスを含みうるため、
 * 原因を連結しない。決定 9）。
 */
export async function writeResultOrFixedError(
  io: ResultWriter,
  outPath: string | null,
  content: string,
): Promise<IoResult<void>> {
  try {
    await io.writeResult(outPath, content);
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, error: "結果の書き出しに失敗しました" };
  }
}
