import { composeCheckSystemPrompt } from "./common.ts";

export const NATURALNESS_LOOK_FOR = `探すもの：主述の不一致、係り受けの誤り、助詞の使い方、語の組み合わせの不自然さ、修飾関係の
不明瞭さ。不自然と判断する理由を具体的に書く。`;

export const NATURALNESS_SYSTEM_PROMPT = composeCheckSystemPrompt(NATURALNESS_LOOK_FOR);
