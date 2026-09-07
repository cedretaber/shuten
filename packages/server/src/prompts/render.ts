import type { CheckInput, Paragraph, Range } from "@shuten/shared";

/**
 * 1 つの区画（<context_before> / <target> / <context_after>）を描画する。
 *
 * 区画の範囲 sec と厳密に重なる段落（p.range.start < sec.end && sec.start < p.range.end）を
 * ID 昇順に選び、各段落を `[P{id}]` の行 + 本文の断片で描画する。断片は加工しない。
 * 断片が LF/CR で終わっていなければ、次の行の前に LF を 1 つだけ補う（描画側の改行は常に LF 固定）。
 */
function renderSection(
  tag: string,
  text: string,
  paragraphs: readonly Paragraph[],
  sec: Range,
): string {
  const included = paragraphs
    .filter((p) => p.range.start < sec.end && sec.start < p.range.end)
    .sort((a, b) => a.id - b.id);
  let body = "";
  for (const p of included) {
    const fragStart = Math.max(p.range.start, sec.start);
    const fragEnd = Math.min(p.range.end, sec.end);
    const fragment = text.slice(fragStart, fragEnd);
    body += `[P${p.id}]\n`;
    body += fragment;
    const lastCode = fragment.length > 0 ? fragment.charCodeAt(fragment.length - 1) : undefined;
    if (lastCode !== 0x0a && lastCode !== 0x0d) {
      body += "\n";
    }
  }
  return `<${tag}>\n${body}</${tag}>`;
}

/** <manuscript> 区画全体を描画する。 */
export function renderManuscript(
  text: string,
  paragraphs: readonly Paragraph[],
  input: CheckInput,
): string {
  const sections: string[] = [];
  if (input.context.before !== null) {
    sections.push(renderSection("context_before", text, paragraphs, input.context.before));
  }
  sections.push(renderSection("target", text, paragraphs, input.target.range));
  if (input.context.after !== null) {
    sections.push(renderSection("context_after", text, paragraphs, input.context.after));
  }
  return `<manuscript>\n${sections.join("\n")}\n</manuscript>`;
}

/** <allowed_words> 区画。語が 0 件なら null（呼び出し側が区画ごと省く）。 */
export function renderAllowedWords(words: readonly string[]): string | null {
  if (words.length === 0) {
    return null;
  }
  return `<allowed_words>\n${words.join("\n")}\n</allowed_words>`;
}

/** user メッセージの本体。allowed_words → manuscript → closing の順。 */
export function renderUserMessage(params: {
  readonly text: string;
  readonly paragraphs: readonly Paragraph[];
  readonly input: CheckInput;
  readonly allowedWords: readonly string[];
  /** 末尾に置く 1 行以上の指示（呼び出し元が渡す）。 */
  readonly closing: string;
}): string {
  const allowedWords = renderAllowedWords(params.allowedWords);
  const manuscript = renderManuscript(params.text, params.paragraphs, params.input);
  const parts = allowedWords !== null ? [allowedWords, manuscript] : [manuscript];
  parts.push(params.closing);
  return parts.join("\n\n");
}
