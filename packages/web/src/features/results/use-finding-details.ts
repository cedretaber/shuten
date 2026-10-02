/**
 * 選択中のまとめの指摘 1 件ずつの詳細（`getFinding`。元候補・位置診断を含む）を取る（PR14b）。
 *
 * PR14a までは選択中の 1 件だけを `results-page.tsx` の `fetchDetail` が取っていた。PR14b で
 * 同じ範囲の指摘を詳細に並べるようになり、まとめの先頭以外の指摘を単独で選ぶ方法が無くなった
 * ので、まとめた指摘すべての詳細をここで取る（まとめは多くて数件）。
 *
 * 規則は `fetchDetail` のものを指摘ごとに広げた形にする。
 *
 * - 新しい `memberIds` が空か、前の `memberIds` と 1 件も重ならなければ選び直しとみなし、
 *   全部の値を捨てて全員分を取り直す（前の指摘の詳細を出したままにしない）。
 * - 1 件でも重なれば同じまとめの中身が変わっただけとみなし（1 つの指摘は 1 つの範囲にしか
 *   属さない）、減った分の値を捨て、増えた分だけ取る（先頭が絞り込みから外れて 2 件目が先頭に
 *   なったときも、絞り込みを戻して先頭が増えたときも、残った指摘を取り直さない）。
 * - `refresh()` は全員分を取り直す。前の値を残したまま取りに行く（レビュー M-1。点滅させない）。
 *   失敗したら前の値を残して `error` を入れる（`finding-detail.tsx` が「更新できませんでした」の
 *   1 行を出す）。
 * - 指摘ごとに最新の要求の応答だけを反映する（要求ごとに番号を振り、指摘ごとに最新の番号を持つ）。
 *   もうまとめに無い指摘の応答も捨てる。
 *
 * `load` と `toMessage` は参照を安定させて渡すこと（`useCallback` かモジュールの関数）。参照が
 * 変わると取り直しの判定が走り直す（同じまとめなら、足りない分を取るだけで済むが）。
 */

import type { FindingDetailDto } from "@shuten/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export interface FindingDetailEntry {
  /** `getFinding` の応答。まだ届いていなければ null。 */
  readonly detail: FindingDetailDto | null;
  /** 直近の取得の失敗。成功したら null に戻る。 */
  readonly error: string | null;
}

/** まだ何も届いていない指摘の値。 */
export const PENDING_DETAIL: FindingDetailEntry = { detail: null, error: null };

const EMPTY_ENTRIES: ReadonlyMap<string, FindingDetailEntry> = new Map();

/** 指摘 ID の区切り。ID は UUID なので改行を含まない。 */
const ID_SEPARATOR = "\n";

export function useFindingDetails(
  load: (findingId: string) => Promise<FindingDetailDto>,
  toMessage: (cause: unknown) => string,
  memberIds: readonly string[],
): { readonly entries: ReadonlyMap<string, FindingDetailEntry>; readonly refresh: () => void } {
  const [entries, setEntries] = useState<ReadonlyMap<string, FindingDetailEntry>>(EMPTY_ENTRIES);
  // 指摘ごとの最新の要求番号。ここに無い指摘の応答は捨てる。
  const latestRef = useRef(new Map<string, number>());
  const counterRef = useRef(0);
  const idsRef = useRef<readonly string[]>([]);
  // 配列の参照ではなく中身で比べるため、文字列にして effect の deps に使う。
  const idsKey = memberIds.join(ID_SEPARATOR);

  const fetchOne = useCallback(
    (findingId: string) => {
      const token = ++counterRef.current;
      latestRef.current.set(findingId, token);
      let request: Promise<FindingDetailDto>;
      try {
        request = load(findingId);
      } catch (cause) {
        request = Promise.reject(cause);
      }
      request.then(
        (detail) => {
          if (latestRef.current.get(findingId) !== token) return; // 古い応答
          setEntries((prev) => new Map(prev).set(findingId, { detail, error: null }));
        },
        (cause: unknown) => {
          if (latestRef.current.get(findingId) !== token) return;
          const error = toMessage(cause);
          setEntries((prev) =>
            new Map(prev).set(findingId, { detail: prev.get(findingId)?.detail ?? null, error }),
          );
        },
      );
    },
    [load, toMessage],
  );

  useEffect(() => {
    const ids = idsKey === "" ? [] : idsKey.split(ID_SEPARATOR);
    const previous = idsRef.current;
    idsRef.current = ids;
    if (ids.length === 0 || !ids.some((id) => previous.includes(id))) {
      // 選び直し（別のまとめを選んだ、または選択を外した）。前の要求の応答はすべて捨て、
      // 全員分を取り直す。
      latestRef.current = new Map();
      setEntries(EMPTY_ENTRIES);
      for (const findingId of ids) {
        fetchOne(findingId);
      }
      return;
    }
    // 同じまとめの中身だけが変わった（先頭が増減した場合を含む）。
    const keep = new Set(ids);
    for (const findingId of Array.from(latestRef.current.keys())) {
      if (!keep.has(findingId)) {
        latestRef.current.delete(findingId);
      }
    }
    setEntries((prev) => {
      if (Array.from(prev.keys()).every((findingId) => keep.has(findingId))) {
        return prev;
      }
      return new Map(Array.from(prev).filter(([findingId]) => keep.has(findingId)));
    });
    for (const findingId of ids) {
      if (!latestRef.current.has(findingId)) {
        fetchOne(findingId);
      }
    }
  }, [idsKey, fetchOne]);

  const refresh = useCallback(() => {
    for (const findingId of idsRef.current) {
      fetchOne(findingId);
    }
  }, [fetchOne]);

  return { entries, refresh };
}
