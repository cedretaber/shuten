import { collectRawOptions, err, ok, type Result } from "./common.ts";

/**
 * `aggregate` サブコマンドが受け付ける引数（決定10・12・29）。
 *
 * ```
 * shuten aggregate (--result <結果.json> | --export <エクスポート.json>)... --truth <正解.json>
 *                  [--manuscript <原稿>] [--out <集計.json>] [--report <レポート.md>]
 * ```
 *
 * `--result` と `--export` は混ぜて渡せる。どちらも複数回指定できる（決定29）。合計で
 * 2 本以上必須（1 回では複数回実行のぶれを測れないため。決定12）。`--export` を 1 つでも
 * 渡したときは `--manuscript` を受け付けない（本文はエクスポートが運ぶため）。
 */
export interface AggregateArgs {
  /** 0 本以上（`--export` だけでもよい。合計で 2 本以上は `parseAggregateArgs` が保証する）。 */
  readonly resultPaths: readonly string[];
  /** 0 本以上（`--result` だけでもよい）。 */
  readonly exportPaths: readonly string[];
  /** `--export` を 1 つも指定していないときだけ非 null（`parseAggregateArgs` が保証する）。 */
  readonly manuscriptPath: string | null;
  readonly truthPath: string;
  /** 未指定なら集計 JSON を標準出力に書く（`evaluate` と同じ方針）。 */
  readonly outPath: string | null;
  /** 指定したときだけ Markdown のレポートを書く。 */
  readonly reportPath: string | null;
}

const KNOWN_OPTIONS = [
  "--manuscript",
  "--truth",
  "--result",
  "--export",
  "--out",
  "--report",
] as const;

/** `aggregate` サブコマンドの引数を解釈する純粋関数。不正な値は例外ではなくエラー値で返す。 */
export function parseAggregateArgs(argv: readonly string[]): Result<AggregateArgs> {
  const collected = collectRawOptions(argv, {
    known: KNOWN_OPTIONS,
    repeatable: ["--result", "--export"],
  });
  if (!collected.ok) {
    return collected;
  }
  const raw = collected.value;

  const truthPath = raw.get("--truth")?.[0];
  const resultPaths = raw.get("--result") ?? [];
  const exportPaths = raw.get("--export") ?? [];
  const manuscriptPath = raw.get("--manuscript")?.[0] ?? null;
  const outPath = raw.get("--out")?.[0] ?? null;
  const reportPath = raw.get("--report")?.[0] ?? null;

  if (truthPath === undefined) {
    return err("必須オプションがありません: --truth");
  }
  if (exportPaths.length > 0 && manuscriptPath !== null) {
    return err(
      "--export を指定したときは --manuscript を指定できません（本文はエクスポートに含まれます）",
    );
  }
  if (exportPaths.length === 0 && manuscriptPath === null) {
    return err("--manuscript がありません（--result だけを使うときは必要です）");
  }
  if (resultPaths.length + exportPaths.length < 2) {
    return err(
      "入力（--result / --export）は合計 2 本以上指定してください" +
        "（1 本では複数回実行のぶれを測れません。決定12）",
    );
  }

  return ok({ resultPaths, exportPaths, manuscriptPath, truthPath, outPath, reportPath });
}
