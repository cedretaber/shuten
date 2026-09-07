import { composeCheckSystemPrompt } from "./common.ts";

export const TYPO_LOOK_FOR = `探すもの：誤変換、文字や語の欠落・重複、助詞の抜け、括弧・鉤括弧の閉じ忘れ、送り仮名や表記の誤り。`;

export const TYPO_SYSTEM_PROMPT = composeCheckSystemPrompt(TYPO_LOOK_FOR);
