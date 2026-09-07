/** LLM が返した引用のうち、位置確定に使う最小の情報。数値位置は持たない（仕様書 6.3：LLM の数値位置を信用しない）。 */
export interface QuoteRef {
  /** モデルが指定した段落 ID。存在しない番号が来ることもある。 */
  readonly paragraphId: number;
  /** 原文からの正確な引用。完全一致で照合する。 */
  readonly quote: string;
  /** 引用の直前の文字列。本文端では空文字。 */
  readonly before: string;
  /** 引用の直後の文字列。本文端では空文字。 */
  readonly after: string;
}
