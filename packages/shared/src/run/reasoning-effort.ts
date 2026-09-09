/**
 * 思考の強さ。トップレベルの `reasoning_effort` に対応する（決定 0003）。CLI・server の
 * LM Studio クライアント・web の設定画面（PR10・PR11）が共通で参照するため shared に置く。
 */
export type ReasoningEffort = "none" | "low" | "medium" | "high";
