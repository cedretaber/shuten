/**
 * 実行イベント（SSE）購読の型と口（決定 16）。
 *
 * `subscribeRunEvents` の中身は PR12b Task 2 が実装する。この時点（Task 1）では
 * 「購読せず、何もしない unsubscribe（`() => {}`）を返す」仮実装を置く。
 * `ApiClient.subscribeRunEvents`（`client.ts`）はこの関数をそのまま呼ぶだけの薄い委譲にする。
 */

import type { RunEventDto } from "@shuten/shared";

/**
 * `EventSource` の構造的な最小形。標準の `EventSource` はこれを満たすが、テストでは
 * この形だけを満たす fake を注入できる（`ApiClient` を丸ごと `fetch` 注入で作れるのと同じ理由）。
 */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export type EventSourceConstructor = new (url: string) => EventSourceLike;

export interface RunEventHandlers {
  onOpen(): void;
  onEvent(event: RunEventDto): void;
  onUnknownEvent(): void;
  onError(): void;
}

/**
 * 実行イベントの SSE 購読。**Task 2 で実装する。この時点では購読しない**（`deps` も未使用）。
 * 呼び出し側は返り値の `unsubscribe` を購読解除に使う想定だが、ここでは何もしない関数を返す。
 */
export function subscribeRunEvents(
  _runId: string,
  _handlers: RunEventHandlers,
  _deps?: { EventSource?: EventSourceConstructor },
): () => void {
  return () => {};
}
