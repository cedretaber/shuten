/**
 * `full-chat` サブコマンドのプロンプトへの原稿の差し込み（決定 35）。
 * これ以外は担わない（送信と実行条件の記録は `full-chat.ts` の `runFullChat`）。
 */
export type FillResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };

/** プロンプトに差し込む位置を示す目印。決定 15 のとおり、こちらでプロンプトを書かない。 */
const PLACEHOLDER = "{{manuscript}}";

/**
 * プロンプト中のすべての `{{manuscript}}` を原稿本文で置き換える。
 *
 * **必ず置換関数（`() => manuscript`）で置換する。** `prompt.replaceAll(PLACEHOLDER, manuscript)` の
 * ように置換文字列を直接渡すと、`String.prototype.replaceAll` が原稿本文中の `$&` / `` $` `` /
 * `$'` / `$$` / `$1` を特殊な指示として解釈し、原稿が壊れて差し込まれる（決定 35）。
 * 校正ツールが原稿を静かに書き換える事故になるため、関数を渡して戻り値をそのまま使う。
 */
export function fillManuscript(prompt: string, manuscript: string): FillResult {
  if (!prompt.includes(PLACEHOLDER)) {
    return { ok: false, error: "プロンプトに {{manuscript}} が含まれていません" };
  }
  const value = prompt.replaceAll(PLACEHOLDER, () => manuscript);
  return { ok: true, value };
}
