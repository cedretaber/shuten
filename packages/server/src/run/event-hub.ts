/**
 * 実行イベントの配信元（PR10 決定 13）。
 *
 * オーケストレーターの `onEvent` に `hub.emit` をそのまま渡し、SSE（Task 9）や将来の購読者は
 * `subscribe(runId, ...)` で実行ごとに受け取る。`emit` はループから**同期に**呼ばれるので、
 * 購読者の例外はここで握りつぶす（投げ返すとループ側で PR9b 決定 33 の内部エラーになり、
 * SSE の不具合が検査そのものを止めてしまう）。`onClose` の例外も同じ理由で握りつぶす。
 */

import type { RunEvent } from "./events.ts";

export interface RunEventSubscriber {
  /** 同期。非同期の書き込みは購読者側が chain に乗せる（決定 12）。 */
  onEvent(event: RunEvent): void;
  /** `closeAll` から呼ぶ。購読者はストリームを完了させる。 */
  onClose(): void;
}

export interface RunEventHub {
  emit(event: RunEvent): void;
  /** 戻り値は購読解除。同じ購読者を 2 回登録しない前提（Set で持つ）。 */
  subscribe(runId: string, subscriber: RunEventSubscriber): () => void;
  /** 全購読者の `onClose` を呼び、購読を空にする。shutdown（決定 18）から呼ぶ。 */
  closeAll(): void;
}

export function createRunEventHub(): RunEventHub {
  const subscribers = new Map<string, Set<RunEventSubscriber>>();

  /**
   * `index.ts` が `onEvent: hub.emit` と**メソッドを外して**渡すため、`this` に依存しない
   * クロージャとして実装する。
   */
  function emit(event: RunEvent): void {
    const set = subscribers.get(event.runId);
    if (set === undefined) {
      return;
    }
    // 購読者が `onEvent` の中で解除・追加することがあるので、反復はスナップショットに対して行う。
    for (const subscriber of [...set]) {
      try {
        subscriber.onEvent(event);
      } catch {
        // 決定 13：購読者の例外は捨てる。例外の中身はログにも出さない
        // （購読者が持つ値に接続先 URL が混ざる可能性を残さない）。
      }
    }
  }

  function subscribe(runId: string, subscriber: RunEventSubscriber): () => void {
    const set = subscribers.get(runId) ?? new Set<RunEventSubscriber>();
    set.add(subscriber);
    subscribers.set(runId, set);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;
      const current = subscribers.get(runId);
      if (current === undefined) {
        return;
      }
      current.delete(subscriber);
      if (current.size === 0) {
        subscribers.delete(runId);
      }
    };
  }

  function closeAll(): void {
    // 先に全購読者を取り出して購読を空にする。`onClose` の中で購読し直した購読者を
    // あとから消してしまわないようにするため（順序が逆だと再購読が握りつぶされる）。
    const all: RunEventSubscriber[] = [];
    for (const set of subscribers.values()) {
      all.push(...set);
    }
    subscribers.clear();

    for (const subscriber of all) {
      try {
        subscriber.onClose();
      } catch {
        // 決定 13：`onClose` の例外も捨てる。
      }
    }
  }

  return { emit, subscribe, closeAll };
}
