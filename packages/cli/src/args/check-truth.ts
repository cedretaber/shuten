import { collectRawOptions, err, ok, type Result } from "./common.ts";

/**
 * `check-truth` サブコマンドが受け付ける引数（Task 0 ブリーフ）。
 *
 * ```
 * shuten check-truth --manuscript <原稿> --truth <正解.json> [--report <失敗レポート.md>]
 * ```
 *
 * LLM を回さずに正解ファイル単体（zod 検証・原稿との bodyHash 照合・位置解決）を検証するための
 * サブコマンド。`--out` は受け付けない（結果は常に標準出力の要約 3 行）。
 */
export interface CheckTruthArgs {
  readonly manuscriptPath: string;
  readonly truthPath: string;
  /** 指定したときだけ、解決に失敗した項目の詳細レポートを書く。 */
  readonly reportPath: string | null;
}

const KNOWN_OPTIONS = ["--manuscript", "--truth", "--report"] as const;

/** `check-truth` サブコマンドの引数を解釈する純粋関数。不正な値は例外ではなくエラー値で返す。 */
export function parseCheckTruthArgs(argv: readonly string[]): Result<CheckTruthArgs> {
  const collected = collectRawOptions(argv, { known: KNOWN_OPTIONS });
  if (!collected.ok) {
    return collected;
  }
  const raw = collected.value;

  const manuscriptPath = raw.get("--manuscript")?.[0];
  const truthPath = raw.get("--truth")?.[0];

  if (manuscriptPath === undefined || truthPath === undefined) {
    // 欠けているものだけを --manuscript, --truth の順で並べる（`args.ts` と同じ形）。
    const missing: string[] = [];
    if (manuscriptPath === undefined) missing.push("--manuscript");
    if (truthPath === undefined) missing.push("--truth");
    return err(`必須オプションがありません: ${missing.join(", ")}`);
  }

  return ok({
    manuscriptPath,
    truthPath,
    reportPath: raw.get("--report")?.[0] ?? null,
  });
}
