import { collectRawOptions, err, ok, type Result } from "./common.ts";

/** `hash` サブコマンドが受け付ける引数（決定 3・9）。原稿の `bodyHash` を出すだけで LLM には接続しない。 */
export interface HashArgs {
  readonly manuscriptPath: string;
}

const KNOWN_OPTIONS = ["--manuscript"] as const;

/** `hash` サブコマンドの引数を解釈する純粋関数。不正な値は例外ではなくエラー値で返す。 */
export function parseHashArgs(argv: readonly string[]): Result<HashArgs> {
  const collected = collectRawOptions(argv, { known: KNOWN_OPTIONS });
  if (!collected.ok) {
    return collected;
  }
  const raw = collected.value;

  const manuscriptPath = raw.get("--manuscript")?.[0];
  if (manuscriptPath === undefined) {
    return err("必須オプションがありません: --manuscript");
  }

  return ok({ manuscriptPath });
}
