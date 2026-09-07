import { buildGraphemeIndex, isGraphemeBoundary } from "../text/grapheme-index.ts";
import { ALLOWED_WORD_RULE_VERSION } from "../versions.ts";
import type { MergedFinding } from "./merge.ts";

/** 抑制の判定に使う項目。MergedFinding をそのまま渡せる。 */
export type SuppressionInput = Pick<MergedFinding, "category" | "quote" | "suggestion">;

/** 許容語による抑制の結果。適用した登録語と規則の版を保存する（仕様書 6.4）。 */
export interface Suppression {
  readonly word: string;
  readonly ruleVersion: string;
}

/**
 * 許容語による自動抑制の判定（仕様書 6.4）。
 * 前提：category が notation で、suggestion が null でない。それ以外は null。
 * 条件：引用内の登録語の出現 1 箇所を、空でなく登録語を含まない文字列に置き換えるだけで修正案を完全に再現できる
 * （登録語の前後・両側への挿入だけの修正案は抑制しない）。登録語の外側は原文と完全一致していなければならない。
 * 前提：suggestion は llmCheckOutputSchema で正規化済み（空文字・空白のみは null）。空白のみの文字列を直接渡すと抑制される。
 */
export function findSuppression(
  finding: SuppressionInput,
  allowedWords: readonly string[],
): Suppression | null {
  if (finding.category !== "notation" || finding.suggestion === null) {
    return null;
  }
  const { quote } = finding;
  const suggestion = finding.suggestion;
  const index = buildGraphemeIndex(quote);
  for (const word of allowedWords) {
    if (word === "") {
      // 空文字はどこにでも一致するので飛ばす
      continue;
    }
    let pos = quote.indexOf(word);
    while (pos !== -1) {
      const s = pos;
      const e = pos + word.length;
      if (isGraphemeBoundary(index, s) && isGraphemeBoundary(index, e)) {
        const suffixLength = quote.length - e;
        // 接頭辞と接尾辞が修正案の上で重ならず、置換文字列が 1 文字以上残ること（削除の誤判定防止）
        if (
          s + suffixLength < suggestion.length &&
          suggestion.startsWith(quote.slice(0, s)) &&
          suggestion.endsWith(quote.slice(e))
        ) {
          const replacement = suggestion.slice(s, suggestion.length - suffixLength);
          // 置換文字列が登録語を含む（同一、前後・両側への挿入だけ）なら表記の置き換えでない
          if (!replacement.includes(word)) {
            return { word, ruleVersion: ALLOWED_WORD_RULE_VERSION };
          }
        }
      }
      pos = quote.indexOf(word, pos + 1); // 重なる出現も数える
    }
  }
  return null;
}
