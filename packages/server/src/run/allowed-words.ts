/**
 * 許容語の分割は server 側の責務（決定 7）。`shared` の `findSuppression` は登録語を加工しない、
 * という PR4 の分担を守るため、分割・trim・重複除去はここで行い `runPipeline` から渡す。
 */

/**
 * 改行区切りの生の文字列を許容語の配列にする。
 * `/\r\n|\r|\n/` で分割し、各行を trim、空文字を除き、完全一致の重複を除いて出現順に返す。
 */
export function splitAllowedWords(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of raw.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
