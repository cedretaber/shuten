import { collectRawOptions, err, ok, type Result } from "./common.ts";

/**
 * `evaluate` サブコマンドが受け付ける引数（決定 10）。
 *
 * ```
 * shuten evaluate --manuscript <原稿> --truth <正解.json> --result <結果.json>
 *                 [--out <指標.json>] [--report <レポート.md>]
 * ```
 */
export interface EvaluateArgs {
  readonly manuscriptPath: string;
  readonly truthPath: string;
  readonly resultPath: string;
  /** 未指定なら指標 JSON を標準出力に書く（`run` と同じ方針）。 */
  readonly outPath: string | null;
  /** 指定したときだけ Markdown のレポートを書く。 */
  readonly reportPath: string | null;
}

const KNOWN_OPTIONS = ["--manuscript", "--truth", "--result", "--out", "--report"] as const;

/** `evaluate` サブコマンドの引数を解釈する純粋関数。不正な値は例外ではなくエラー値で返す。 */
export function parseEvaluateArgs(argv: readonly string[]): Result<EvaluateArgs> {
  const collected = collectRawOptions(argv, { known: KNOWN_OPTIONS });
  if (!collected.ok) {
    return collected;
  }
  const raw = collected.value;

  const manuscriptPath = raw.get("--manuscript")?.[0];
  const truthPath = raw.get("--truth")?.[0];
  const resultPath = raw.get("--result")?.[0];
  if (manuscriptPath === undefined || truthPath === undefined || resultPath === undefined) {
    const missing = [
      manuscriptPath === undefined ? "--manuscript" : null,
      truthPath === undefined ? "--truth" : null,
      resultPath === undefined ? "--result" : null,
    ].filter((name): name is string => name !== null);
    return err(`必須オプションがありません: ${missing.join(", ")}`);
  }

  return ok({
    manuscriptPath,
    truthPath,
    resultPath,
    outPath: raw.get("--out")?.[0] ?? null,
    reportPath: raw.get("--report")?.[0] ?? null,
  });
}
