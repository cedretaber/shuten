/**
 * 最大二部マッチング（決定 20）。
 *
 * 指摘（左）と `kind: "error"` の正解項目（右）を、重なりのある組を辺として 1 対 1 に対応付ける。
 * 「1 件の指摘に自動で与える検出は最大 1 件」という規則を、**マッチ数が最大**になる形で満たす。
 *
 * ここに置くのは対応付けのアルゴリズムだけで、重なりの判定も辺の並べ替えも呼び出し側
 * （`score.ts`）の責務にしてある。単体で（重なりの意味を知らずに）テストできるようにするため。
 */

export interface MatchEdge {
  readonly leftIndex: number; // 指摘の添字
  readonly rightIndex: number; // 正解項目の添字
  readonly weight: number; // 重なりの長さ（並べ替えにだけ使う）
}

/**
 * 最大マッチ（増加路法。Kuhn のアルゴリズム）。辺は呼び出し側が決定的な順に並べて渡す。
 *
 * **貪欲（重なりの長い組から確定する）では数え落とす。** 指摘 F1 が項目 E1・E2 に、指摘 F2 が
 * E1 だけに重なるとき、F1→E1 を先に固定すると F2 が行き先を失って検出 1 件になるが、
 * F1→E2・F2→E1 なら 2 件である。検出率を実態より低く見せる方向の誤りなので、増加路で解く。
 *
 * **限界（決定 20 に明記されているとおり）。** この実装は**マッチ数だけを最大化**し、
 * 「最大マッチのうち重なり長の合計が最大のもの」を選ぶことは保証しない（それには最小費用流が要る）。
 * 指標（検出数）はマッチ数だけで決まり、重なり長の合計が効くのはレポートの対応表の見え方だけなので、
 * ここでは実装しない。`weight` は呼び出し側が辺を並べ替えるために持たせているだけで、
 * **この関数は `weight` を読まない**。
 *
 * **決定性。** 同点の割り方は渡された辺の順序だけで決まる。左頂点は「辺の並びで最初に現れた順」に
 * 処理し、各左頂点の隣接も辺の並びの順に辿る。並べ替えの規則（重なりの長さの降順 →
 * 項目 `range.start` の昇順 → 項目 `id` の辞書順 → 指摘の出現順）は `score.ts` にある。
 *
 * @returns 左の添字 → 右の添字。マッチしなかった左頂点は含まない。
 *   反復順は左の添字の昇順（呼び出し側の出力順を安定させるため）。
 */
export function maximumMatching(
  edges: readonly MatchEdge[],
  leftCount: number,
  rightCount: number,
): ReadonlyMap<number, number> {
  // 範囲外の辺は黙って捨てない。数え落としや数え過ぎが静かに指標に混ざるより、止まるほうがよい。
  for (const edge of edges) {
    if (!Number.isInteger(edge.leftIndex) || edge.leftIndex < 0 || edge.leftIndex >= leftCount) {
      throw new RangeError(
        `leftIndex が範囲外です（${String(edge.leftIndex)} / ${String(leftCount)}）`,
      );
    }
    if (
      !Number.isInteger(edge.rightIndex) ||
      edge.rightIndex < 0 ||
      edge.rightIndex >= rightCount
    ) {
      throw new RangeError(
        `rightIndex が範囲外です（${String(edge.rightIndex)} / ${String(rightCount)}）`,
      );
    }
  }

  // 隣接リストと左頂点の処理順を、渡された辺の並びのまま作る。
  const adjacency = new Map<number, number[]>();
  const leftOrder: number[] = [];
  for (const edge of edges) {
    const neighbors = adjacency.get(edge.leftIndex);
    if (neighbors === undefined) {
      adjacency.set(edge.leftIndex, [edge.rightIndex]);
      leftOrder.push(edge.leftIndex);
    } else {
      neighbors.push(edge.rightIndex);
    }
  }

  // 右 → 左。増加路の探索中に付け替えるため、向きはこちらで持つ。
  const rightToLeft = new Map<number, number>();

  /** `left` から増加路を探す。見つかれば経路上の対応を付け替えて true。 */
  const augment = (left: number, visited: Set<number>): boolean => {
    for (const right of adjacency.get(left) ?? []) {
      if (visited.has(right)) {
        continue;
      }
      visited.add(right);
      const current = rightToLeft.get(right);
      if (current === undefined || augment(current, visited)) {
        rightToLeft.set(right, left);
        return true;
      }
    }
    return false;
  };

  for (const left of leftOrder) {
    augment(left, new Set<number>());
  }

  const leftToRight = new Map<number, number>();
  for (const [right, left] of rightToLeft) {
    leftToRight.set(left, right);
  }
  // 反復順を左の添字の昇順に揃える（rightToLeft の挿入順に依存させない）。
  return new Map([...leftToRight].sort(([a], [b]) => a - b));
}
