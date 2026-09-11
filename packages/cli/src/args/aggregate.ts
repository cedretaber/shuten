import { collectRawOptions, err, ok, type Result } from "./common.ts";

/**
 * `aggregate` サブコマンドが受け付ける引数（決定 10・12）。
 *
 * ```
 * shuten aggregate --manuscript <原稿> --truth <正解.json> --result <結果.json> --result <結果.json> ...
 *                  [--out <集計.json>] [--report <レポート.md>]
 * ```
 *
 * `--result` は複数回指定できる（2 本以上必須。ぶれを測るには 2 回以上の実行結果が要るため。決定 12）。
 */
export interface AggregateArgs {
  readonly manuscriptPath: string;
  readonly truthPath: string;
  /** 2 本以上（`parseAggregateArgs` が保証する）。 */
  readonly resultPaths: readonly string[];
  /** 未指定なら集計 JSON を標準出力に書く（`evaluate` と同じ方針）。 */
  readonly outPath: string | null;
  /** 指定したときだけ Markdown のレポートを書く。 */
  readonly reportPath: string | null;
}

const KNOWN_OPTIONS = ["--manuscript", "--truth", "--result", "--out", "--report"] as const;

/** `aggregate` サブコマンドの引数を解釈する純粋関数。不正な値は例外ではなくエラー値で返す。 */
export function parseAggregateArgs(argv: readonly string[]): Result<AggregateArgs> {
  const collected = collectRawOptions(argv, { known: KNOWN_OPTIONS, repeatable: ["--result"] });
  if (!collected.ok) {
    return collected;
  }
  const raw = collected.value;

  const manuscriptPath = raw.get("--manuscript")?.[0];
  const truthPath = raw.get("--truth")?.[0];
  const resultPaths = raw.get("--result") ?? [];
  if (manuscriptPath === undefined || truthPath === undefined || resultPaths.length === 0) {
    const missing = [
      manuscriptPath === undefined ? "--manuscript" : null,
      truthPath === undefined ? "--truth" : null,
      resultPaths.length === 0 ? "--result" : null,
    ].filter((name): name is string => name !== null);
    return err(`必須オプションがありません: ${missing.join(", ")}`);
  }
  if (resultPaths.length < 2) {
    return err(
      "--result は 2 本以上指定してください（1 本では複数回実行のぶれを測れません。決定12）",
    );
  }

  return ok({
    manuscriptPath,
    truthPath,
    resultPaths,
    outPath: raw.get("--out")?.[0] ?? null,
    reportPath: raw.get("--report")?.[0] ?? null,
  });
}
