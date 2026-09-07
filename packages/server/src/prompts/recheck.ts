import type { MergedFinding, Paragraph } from "@shuten/shared";

import { COMMON_INSTRUCTIONS } from "./common.ts";

const RECHECK_ROLE = `あなたは日本語の小説の校正結果を検証する。すでに出ている指摘 1 件について、より広い文脈を読んだうえで、その指摘を維持するか撤回するかを判断する。<target> は初回の検査対象範囲で、指摘はその中にある。

確認すること：
- 文脈に照らして、実際に誤りまたは不自然さがあるか。
- 意図的な口語、省略、倒置、比喩として成立しないか。
- 修正案が意味や口調を変えていないか。
- 不要な推敲提案になっていないか。

修正案を書き直してはならない。新しい指摘を追加してはならない。`;

const RECHECK_OUTPUT_INSTRUCTIONS = `判断は次の項目で返す。

- reason：判断の理由。
- reasonKind：次のいずれか。
  - error-confirmed：文脈に照らしても誤り・不自然さが実在する。
  - intentional-expression：意図的な口語・省略・倒置・比喩として成立する。
  - suggestion-inappropriate：問題は実在するが、修正案が意味や口調を変えている。
  - unnecessary-polish：誤りではなく、不要な推敲提案になっている。
  - insufficient-context：与えられた文脈では判断できない。
- verdict：keep（指摘を維持）、withdraw（指摘を撤回）、confirm-with-author（作者への確認事項）。
- suggestionValid：修正案を有効な修正案として表示してよければ true、そうでなければ false。

次の組み合わせを返してはならない。
- reasonKind が suggestion-inappropriate のとき、suggestionValid は false でなければならない。
- reasonKind が suggestion-inappropriate または insufficient-context のとき、verdict は confirm-with-author でなければならない。

文脈が足りず判断できない場合は、reasonKind を insufficient-context、verdict を confirm-with-author にする。`;

export const RECHECK_SYSTEM_PROMPT = [
  RECHECK_ROLE,
  COMMON_INSTRUCTIONS,
  RECHECK_OUTPUT_INSTRUCTIONS,
].join("\n\n");

/** finding.range.start を含む段落の ID。見つからなければ null。 */
function findParagraphId(
  range: MergedFinding["range"],
  paragraphs: readonly Paragraph[],
): number | null {
  for (const p of paragraphs) {
    if (p.range.start <= range.start && range.start < p.range.end) {
      return p.id;
    }
  }
  return null;
}

/** 再確認する指摘 1 件を <finding> ブロックに描画する。 */
export function renderFindingBlock(
  finding: MergedFinding,
  paragraphs: readonly Paragraph[],
): string {
  const paragraphId = findParagraphId(finding.range, paragraphs);
  const paragraphLabel = paragraphId !== null ? `[P${paragraphId}]` : "不明";
  const suggestionLabel = finding.suggestion !== null ? finding.suggestion : "（なし）";
  const lines = [
    "<finding>",
    `段落: ${paragraphLabel}`,
    `引用: ${finding.quote}`,
    `分類: ${finding.category}`,
    `修正案: ${suggestionLabel}`,
    `暫定判定: ${finding.verdict}`,
    "元の指摘:",
    ...finding.sources.map(
      (source) =>
        `- 観点 ${source.perspective} / 分類 ${source.llm.category} / 判定 ${source.llm.verdict} / 理由: ${source.llm.reason}`,
    ),
    "</finding>",
  ];
  return lines.join("\n");
}
