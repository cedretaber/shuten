/**
 * 実行イベント（SSE）購読の型と実装（決定 16）。
 *
 * サーバー側 `packages/server/src/api/events.ts` の規則に合わせる。要点は 3 つ：
 *
 * 1. 実行が終端状態なら、サーバーは合成した `run-settled` を 1 件送って接続を閉じる。
 *    `EventSource` は閉じられた接続を自動で再接続するので、受け取った側が `close()` を
 *    呼ばないと「接続 → run-settled → 切断 → 再接続」の無限ループになる。だから
 *    `run-settled` を受け取ったら **`onEvent` を呼ぶ前に自分で `close()` する**。
 * 2. サーバーは名前付きイベントで送る（`onmessage` では受け取れない）ので、型ごとに
 *    `addEventListener` する。
 * 3. サーバーは再送しない（`id:` を付けない）。`: ping` は `EventSource` がコメントとして
 *    無視するので、こちらでは何もしない。
 *
 * 受信した `data` の中身は、検証に失敗したときも含めて一切ログにも画面にも出さない
 * （原稿の断片や接続先が混ざりうるため）。
 */

import type { RunEventDto } from "@shuten/shared";
import { runEventDtoSchema } from "@shuten/shared";

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
 * 購読するイベント種別の一覧。`Record<RunEventDto["type"], true>` を `satisfies` することで、
 * `shared` にイベントが増えたときにこの定義が型検査で落ちる（網羅を型で担保する）。
 */
const RUN_EVENT_TYPES = {
  "target-planned": true,
  "check-started": true,
  "check-finished": true,
  "target-merged": true,
  "recheck-started": true,
  "recheck-finished": true,
  "generation-slow": true,
  "save-rolled-back": true,
  "stop-requested": true,
  "run-settled": true,
} as const satisfies Record<RunEventDto["type"], true>;

/** 実行環境の `EventSource`（jsdom には無い）。無ければ `undefined`。 */
function resolveGlobalEventSource(): EventSourceConstructor | undefined {
  return (globalThis as typeof globalThis & { EventSource?: EventSourceConstructor }).EventSource;
}

/**
 * 実行イベントの SSE 購読（決定 16）。
 *
 * `deps?.EventSource` が省略され `globalThis.EventSource` も無い環境（jsdom 上のテストなど）では、
 * 購読せずに「何もしない `unsubscribe`」を返す。戻り値の `unsubscribe` は冪等で、閉じた後は
 * ハンドラーを呼ばない。
 */
export function subscribeRunEvents(
  runId: string,
  handlers: RunEventHandlers,
  deps?: { EventSource?: EventSourceConstructor },
): () => void {
  const EventSourceCtor = deps?.EventSource ?? resolveGlobalEventSource();
  if (EventSourceCtor === undefined) {
    return () => {};
  }

  let closed = false;
  const source = new EventSourceCtor(`/api/runs/${encodeURIComponent(runId)}/events`);

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    source.close();
  }

  source.onopen = () => {
    if (closed) {
      return;
    }
    handlers.onOpen();
  };

  source.onerror = () => {
    if (closed) {
      return;
    }
    handlers.onError();
  };

  for (const type of Object.keys(RUN_EVENT_TYPES)) {
    source.addEventListener(type, (event) => {
      if (closed) {
        return;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(event.data);
      } catch {
        // 値はログに出さない（原稿の断片・接続先が混ざりうる）。
        handlers.onUnknownEvent();
        return;
      }

      const result = runEventDtoSchema.safeParse(parsedJson);
      if (!result.success) {
        handlers.onUnknownEvent();
        return;
      }

      const dto = result.data;
      if (dto.type === "run-settled") {
        // 決定 1：`onEvent` を呼ぶ前に閉じる。ここで閉じないと、サーバーが接続を閉じた後に
        // `EventSource` が自動再接続し「接続 → run-settled → 切断 → 再接続」を無限に繰り返す。
        close();
      }
      handlers.onEvent(dto);
    });
  }

  return () => {
    close();
  };
}
