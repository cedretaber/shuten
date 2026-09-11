import { describe, expect, it } from "vitest";

import type { MatchEdge } from "./matching.ts";
import { maximumMatching } from "./matching.ts";

/**
 * 最大二部マッチング（決定 20）の単体テスト。重なりの意味を持ち込まず、辺の並びだけで検証する。
 */
describe("maximumMatching", () => {
  it("貪欲では数え落とす配置でもマッチ数を最大化する", () => {
    // F0 は E0・E1 に、F1 は E0 だけに隣接する。重みの降順に並べると (F0,E0) が先頭に来るので、
    // 「長い順に確定する貪欲」なら F0→E0 で止まり 1 件。増加路法なら F0→E1・F1→E0 で 2 件。
    // 変異：augment の付け替えをやめて「空いている右頂点だけに繋ぐ」貪欲にすると 1 件になって落ちる。
    const edges: readonly MatchEdge[] = [
      { leftIndex: 0, rightIndex: 0, weight: 8 },
      { leftIndex: 0, rightIndex: 1, weight: 5 },
      { leftIndex: 1, rightIndex: 0, weight: 2 },
    ];
    const matched = maximumMatching(edges, 2, 2);
    expect(matched.size).toBe(2);
    expect(matched.get(0)).toBe(1);
    expect(matched.get(1)).toBe(0);
  });

  it("辺の並びが同じなら結果も同じ（決定性）", () => {
    // 4 本すべてが同じ重みでも、渡された並びだけで一意に決まる。
    // 変異：左頂点の処理順を添字の昇順などに変えると、並びを入れ替えたときに結果が変わって落ちる。
    const edges: readonly MatchEdge[] = [
      { leftIndex: 1, rightIndex: 0, weight: 4 },
      { leftIndex: 1, rightIndex: 1, weight: 4 },
      { leftIndex: 0, rightIndex: 0, weight: 4 },
      { leftIndex: 0, rightIndex: 1, weight: 4 },
    ];
    const matched = maximumMatching(edges, 2, 2);
    // 先に現れる左頂点は 1。1 が右 0 を取り、次に来た 0 が増加路で 1 を右 1 に押し出して右 0 を取る。
    expect([...matched]).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it("反復順は左の添字の昇順", () => {
    // 変異：内部の右→左の Map をそのまま反転して返すと、挿入順のまま出て落ちる。
    const edges: readonly MatchEdge[] = [
      { leftIndex: 2, rightIndex: 0, weight: 1 },
      { leftIndex: 0, rightIndex: 1, weight: 1 },
      { leftIndex: 1, rightIndex: 2, weight: 1 },
    ];
    expect([...maximumMatching(edges, 3, 3).keys()]).toEqual([0, 1, 2]);
  });

  it("辺が無ければ空のマッチ", () => {
    expect(maximumMatching([], 3, 3).size).toBe(0);
  });

  it("範囲外の添字は黙って捨てずに投げる", () => {
    // 静かに数え落とすくらいなら止まるほうがよい（指標の正しさが用途そのものであるため）。
    expect(() => maximumMatching([{ leftIndex: 2, rightIndex: 0, weight: 1 }], 2, 1)).toThrow(
      RangeError,
    );
    expect(() => maximumMatching([{ leftIndex: 0, rightIndex: 1, weight: 1 }], 2, 1)).toThrow(
      RangeError,
    );
  });
});
