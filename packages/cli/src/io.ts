import { resolve } from "node:path";
import { ingestUtf8Bytes } from "@shuten/shared";

/**
 * `main.ts` のサブコマンド間で共通の入出力ヘルパー（決定 9）。`run` と `hash` の両方が使う
 * 「原稿読み込み＋UTF-8 取り込み」と「結果書き出し」に加え、`evaluate` / `aggregate` が使う
 * 「正解・結果ファイルの読み込み」と「出力先の衝突検査（決定 21）」をここに 1 か所へまとめる。
 * パス漏えい対策（固定文言のみを返す）を複数箇所で同期させ忘れる事故を避けるため。
 */

/** 呼び出し側の `writeErrorLine` にそのまま渡せる、固定文言のエラー値。 */
export type IoResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** `readManuscriptText` が要る入出力だけを取り出した形。`MainIO` は構造的にこれを満たす。 */
export interface ManuscriptReader {
  readonly readManuscriptBytes: (path: string) => Promise<Uint8Array>;
}

/** `readTruthText` が要る入出力だけを取り出した形。`MainIO` は構造的にこれを満たす。 */
export interface TruthReader {
  readonly readTruthBytes: (path: string) => Promise<Uint8Array>;
}

/** `readEvalResultText` が要る入出力だけを取り出した形。`MainIO` は構造的にこれを満たす。 */
export interface EvalResultReader {
  readonly readResultBytes: (path: string) => Promise<Uint8Array>;
}

/** `writeResultOrFixedError` が要る入出力だけを取り出した形。`MainIO` は構造的にこれを満たす。 */
export interface ResultWriter {
  readonly writeResult: (outPath: string | null, content: string) => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * バイト列を読み込み UTF-8 として取り込む共通処理（決定 9）。`label` は「原稿ファイル」
 * 「正解ファイル」のように、失敗文言に埋め込む対象の呼び名。
 *
 * 読み込み失敗は固定文言（Node の `fs` の例外メッセージはパスを含むため、原因を連結しない。
 * 決定 9）。UTF-8 デコード失敗（`ingestUtf8Bytes` が投げる `Utf8DecodeError`）はパスを含まない
 * 固定メッセージなので、従来どおり原因を連結する。
 */
async function readTextOrFixedError(
  read: (path: string) => Promise<Uint8Array>,
  path: string,
  label: string,
): Promise<IoResult<string>> {
  let bytes: Uint8Array;
  try {
    bytes = await read(path);
  } catch {
    return { ok: false, error: `${label}を読み込めません` };
  }
  try {
    return { ok: true, value: ingestUtf8Bytes(bytes) };
  } catch (error) {
    return { ok: false, error: `${label}を UTF-8 として読み込めません: ${messageOf(error)}` };
  }
}

/** 原稿を読み込み UTF-8 として取り込む（`run` の原稿読み込みと `hash` の原稿読み込みで共通）。 */
export async function readManuscriptText(
  io: ManuscriptReader,
  path: string,
): Promise<IoResult<string>> {
  return readTextOrFixedError((p) => io.readManuscriptBytes(p), path, "原稿ファイル");
}

/** 正解ファイルを読み込み UTF-8 として取り込む（`evaluate` が使う。決定 9）。 */
export async function readTruthText(io: TruthReader, path: string): Promise<IoResult<string>> {
  return readTextOrFixedError((p) => io.readTruthBytes(p), path, "正解ファイル");
}

/** 結果 JSON ファイルを読み込み UTF-8 として取り込む（`evaluate` / `aggregate` が使う。決定 9）。 */
export async function readEvalResultText(
  io: EvalResultReader,
  path: string,
): Promise<IoResult<string>> {
  return readTextOrFixedError((p) => io.readResultBytes(p), path, "結果ファイル");
}

/**
 * 結果を書き出す（`run` の結果 JSON、`hash` の 1 行、`evaluate` の指標 JSON・レポートの
 * すべてで共通）。`label` は失敗文言に埋め込む対象の呼び名で、省略時は従来どおり「結果」。
 *
 * 失敗は固定文言（`fs` の書き出し失敗のメッセージも書き込み先パスを含みうるため、
 * 原因を連結しない。決定 9）。
 */
export async function writeResultOrFixedError(
  io: ResultWriter,
  outPath: string | null,
  content: string,
  label = "結果",
): Promise<IoResult<void>> {
  try {
    await io.writeResult(outPath, content);
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, error: `${label}の書き出しに失敗しました` };
  }
}

// --- 出力先の衝突検査（決定 21） ---------------------------------------------------------------

/** 同一ファイル判定に使う識別情報（`stat` の dev/ino）。 */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** `findPathConflict` が要る入出力だけを取り出した形。`MainIO` は構造的にこれを満たす。 */
export interface PathConflictChecker {
  /** ファイルの識別情報。存在しない・取得できないときは null（比較を諦める）。 */
  readonly statFile: (path: string) => Promise<FileIdentity | null>;
}

/** 衝突検査の対象 1 つ（引数名とパスの組）。 */
export interface NamedPath {
  readonly name: string;
  readonly path: string;
}

/**
 * 渡されたパス群のうち、どれか 2 つが同じ実体を指していないか調べる（決定 21）。
 *
 * `run` の出力（`--out`）対 入力の組だけでなく、`evaluate` の `--out`/`--report` 対
 * すべての入力、`--out` と `--report` どうし、`aggregate` の `--result` どうしなど、
 * 任意のパス集合の全組み合わせを見られるように一般化してある。
 *
 * 判定は 2 段：
 * 1. 正規化パスの文字列比較（`./x.txt` と `x.txt` を同一と見る）。
 * 2. `stat` の dev/ino の比較（シンボリックリンク・ハードリンク経由の別名を捕まえる）。
 *
 * 衝突していれば、衝突した 2 つの引数名の組（渡された配列での出現順）を返す。同じ引数名が
 * 複数回現れる呼び出し（`aggregate --result a.json --result a.json`）では、同じ名前の組
 * （例：`["--result", "--result"]`）を返してよい。
 */
export async function findPathConflict(
  io: PathConflictChecker,
  paths: readonly NamedPath[],
): Promise<readonly [string, string] | null> {
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      const a = paths[i];
      const b = paths[j];
      if (a === undefined || b === undefined) continue;
      if (resolve(a.path) === resolve(b.path)) {
        return [a.name, b.name];
      }
    }
  }

  // 正規化パスが一致しないものだけ、実体（dev/ino）を取り直して比べる。
  const identities = await Promise.all(paths.map((p) => io.statFile(p.path)));
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      const a = identities[i];
      const b = identities[j];
      if (a === undefined || a === null || b === undefined || b === null) continue;
      if (a.dev === b.dev && a.ino === b.ino) {
        const pa = paths[i];
        const pb = paths[j];
        if (pa !== undefined && pb !== undefined) {
          return [pa.name, pb.name];
        }
      }
    }
  }
  return null;
}
