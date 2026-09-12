import { collectRawOptions, err, ok, type Result } from "./common.ts";

/**
 * `evaluate` サブコマンドが受け付ける引数（決定10・29）。
 *
 * ```
 * shuten evaluate (--result <結果.json> | --export <エクスポート.json>) --truth <正解.json>
 *                 [--manuscript <原稿>] [--out <指標.json>] [--report <レポート.md>]
 * ```
 *
 * `--result` と `--export` はちょうど一方だけを指定する（決定29）。`--export` を使うときは
 * 本文がエクスポートに埋め込まれているため `--manuscript` を受け付けない。`input` を判別可能な
 * 型にすることで、呼び出し側（`main.ts`）が「どちらの入力を使うか」「本文が要るか」を
 * 実行時に確かめ直さずに済むようにする。
 */
export type EvaluateInput =
  | { readonly kind: "result"; readonly resultPath: string; readonly manuscriptPath: string }
  | { readonly kind: "export"; readonly exportPath: string };

export interface EvaluateArgs {
  readonly input: EvaluateInput;
  readonly truthPath: string;
  /** 未指定なら指標 JSON を標準出力に書く（`run` と同じ方針）。 */
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

/** `evaluate` サブコマンドの引数を解釈する純粋関数。不正な値は例外ではなくエラー値で返す。 */
export function parseEvaluateArgs(argv: readonly string[]): Result<EvaluateArgs> {
  const collected = collectRawOptions(argv, { known: KNOWN_OPTIONS });
  if (!collected.ok) {
    return collected;
  }
  const raw = collected.value;

  const truthPath = raw.get("--truth")?.[0];
  const resultPath = raw.get("--result")?.[0];
  const exportPath = raw.get("--export")?.[0];
  const manuscriptPath = raw.get("--manuscript")?.[0] ?? null;
  const outPath = raw.get("--out")?.[0] ?? null;
  const reportPath = raw.get("--report")?.[0] ?? null;

  if (truthPath === undefined) {
    return err("必須オプションがありません: --truth");
  }

  // `resultPath` を先に見る（`resultPath !== undefined` の分岐内で `TypeScript` が
  // `resultPath: string` に絞り込むため、後段で「resultPath は必ずある」ことを確かめ直す
  // 到達しない分岐が要らない。`exportPath` 側も対称に、この分岐に来た時点で
  // `exportPath === undefined` と分かっている）。
  if (resultPath !== undefined) {
    if (exportPath !== undefined) {
      return err("--result と --export は同時に指定できません");
    }
    if (manuscriptPath === null) {
      return err("--manuscript がありません（--result だけを使うときは必要です）");
    }
    return ok({
      input: { kind: "result", resultPath, manuscriptPath },
      truthPath,
      outPath,
      reportPath,
    });
  }

  if (exportPath === undefined) {
    return err("--result か --export のどちらかを指定してください");
  }
  if (manuscriptPath !== null) {
    return err(
      "--export を指定したときは --manuscript を指定できません（本文はエクスポートに含まれます）",
    );
  }
  return ok({ input: { kind: "export", exportPath }, truthPath, outPath, reportPath });
}
