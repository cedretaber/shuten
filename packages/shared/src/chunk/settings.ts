/** 分割と参考文脈の設定（仕様書 5.2 節）。長さはすべて書記素クラスタ数。 */
export interface ChunkSettings {
  /** 検査対象の目標長。初期案 1500。 */
  readonly targetGraphemes: number;
  /** 初回検査の参考文脈の目標長（前後それぞれ）。初期案 1000。 */
  readonly contextGraphemes: number;
  /** 再確認の参考文脈の目標長（前後それぞれ）。初期案 3000。 */
  readonly recheckContextGraphemes: number;
  /** 段落境界への丸めの許容幅（目標に対する割合）。初期案 0.2。 */
  readonly roundingTolerance: number;
  /** 1 回の要求に含められる本文の上限（検査対象 + 参考文脈）。超えたら InputTooLongError。 */
  readonly maxInputGraphemes: number;
}

/** 設定値が不正なときの例外。 */
export class InvalidChunkSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChunkSettingsError";
  }
}

/** 検査対象と参考文脈の合計が上限を超えたときの例外。黙って縮めない（仕様書 5.2 節）。 */
export class InputTooLongError extends Error {
  readonly required: number;
  readonly limit: number;

  constructor(required: number, limit: number) {
    super(`入力が上限を超えています（${required} 字、上限 ${limit} 字）`);
    this.name = "InputTooLongError";
    this.required = required;
    this.limit = limit;
  }
}

/** 許容幅を整数で返す：floor(目標 × 割合)。 */
export function roundingDelta(target: number, tolerance: number): number {
  return Math.floor(target * tolerance);
}

/** 設定を検証し、不正なら InvalidChunkSettingsError を投げる。 */
export function validateChunkSettings(settings: ChunkSettings): void {
  if (!Number.isSafeInteger(settings.targetGraphemes) || settings.targetGraphemes < 1) {
    throw new InvalidChunkSettingsError("targetGraphemes は 1 以上の整数である必要があります");
  }
  if (!Number.isSafeInteger(settings.contextGraphemes) || settings.contextGraphemes < 0) {
    throw new InvalidChunkSettingsError("contextGraphemes は 0 以上の整数である必要があります");
  }
  if (
    !Number.isSafeInteger(settings.recheckContextGraphemes) ||
    settings.recheckContextGraphemes < 0
  ) {
    throw new InvalidChunkSettingsError(
      "recheckContextGraphemes は 0 以上の整数である必要があります",
    );
  }
  if (
    !Number.isFinite(settings.roundingTolerance) ||
    settings.roundingTolerance < 0 ||
    settings.roundingTolerance >= 1
  ) {
    throw new InvalidChunkSettingsError(
      "roundingTolerance は 0 以上 1 未満の有限数である必要があります",
    );
  }
  const minimum =
    settings.targetGraphemes + roundingDelta(settings.targetGraphemes, settings.roundingTolerance);
  if (!Number.isSafeInteger(settings.maxInputGraphemes) || settings.maxInputGraphemes < minimum) {
    throw new InvalidChunkSettingsError(
      `maxInputGraphemes は ${minimum} 以上の整数である必要があります`,
    );
  }
}
