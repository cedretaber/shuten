# PR2 詳細計画：検査範囲と参考文脈の分割

日付：2026-09-07  
状態：計画（レビュー待ち）  
ブランチ：`feat/pr2-chunk-plan`  
上位計画：`docs/plans/2026-09-07-mvp-roadmap.md` の PR2 節

## 目標

`packages/shared` に、本文を検査対象範囲に分割し（`planTargets`）、各検査対象に参考文脈を付け（`buildCheckInput`）、
再確認用に文脈を広げる（`buildRecheckInput`）機能を実装する。書記素クラスタ数で長さを数え、段落境界・文境界・
書記素クラスタ境界の順で丸める。

対応する仕様：5.2（検査設定）、6.1 手順 2〜5（分割と検査範囲の保証）、6.5（再確認の入力範囲）。
受け入れ条件：11 節 3 項（全本文が検査対象に割り当てられる）、4 項（前後の参考文脈）、7 項（書記素クラスタの途中で
分割されない）、8 項（短い会話段落でも文字数基準の参考文脈）の shared 側。

## 全体の制約（`docs/reference/invariants.md` から）

- 文字数（分割長・文脈長）は書記素クラスタ数で数える。位置は UTF-16 コード単位、範囲は `[start, end)`。
- サロゲートペア、異体字セレクタ、結合文字、絵文字の連結、CRLF の途中で分割しない。
- 全本文の各位置がちょうど 1 つの検査対象に属する。参考文脈は重複してよい。
- 本文端では存在する文脈だけを使う。再確認の入力は初回の入力範囲を必ず含む。
- 入力上限超過時は本文を黙って切り捨てず、例外にする（案内の文言は UI の責務）。
- 分割範囲の正本はサーバーが保存した値。ブラウザは再計算しない（`docs/decisions/0001-tech-stack.md`）。
  この PR の関数はサーバーだけが呼ぶ。
- 相対 import は `.ts` 拡張子付き。`erasableSyntaxOnly`。公開関数は `src/index.ts` から再エクスポート。

## 作るもの

| ファイル | 責務 | 公開する名前 |
| --- | --- | --- |
| `packages/shared/src/text/grapheme-index.ts` | 書記素クラスタ境界の一覧と、位置 ⇄ 書記素番号の変換 | `GraphemeIndex`、`buildGraphemeIndex`、`graphemeAt`、`offsetAt`、`isGraphemeBoundary` |
| `packages/shared/src/chunk/sentence.ts` | 文境界の検出 | `findSentenceBoundaries` |
| `packages/shared/src/chunk/settings.ts` | 設定型と検証、例外 | `ChunkSettings`、`InvalidChunkSettingsError`、`InputTooLongError`、`validateChunkSettings`、`roundingDelta` |
| `packages/shared/src/chunk/plan.ts` | 分割、参考文脈、再確認入力 | `TargetRange`、`ContextWindow`、`CheckInput`、`planTargets`、`buildCheckInput`、`buildRecheckInput` |
| `packages/shared/src/index.ts` | 再エクスポート | 上記すべて |
| `packages/shared/src/{text,chunk}/*.test.ts` | テスト | |

## 設計上の決定

仕様とロードマップで固定されていない点。いずれも 13 節の未決事項（分割長・文脈長の値そのもの）ではなく、
丸めの規則と実装上の選択。

1. **許容幅は整数 `delta = floor(目標 × tolerance)`、窓は両端を含む `[ideal − delta, ideal + delta]`。**
   目標 1,500 字・tolerance 0.2 なら delta 300、窓は 1,200〜1,800 字。目標 1,000 字なら delta 200。
   小数の比較を避け、境界の採否を整数だけで決める。
2. **境界の選択は 1 つの関数 `chooseBoundary(ideal, delta, candidates, outer)` に集約する。**
   窓内の候補のうち ideal に最も近いものを選び、同距離なら `outer` 側を選ぶ。`outer` は呼び出し側が指定する。
   検査対象の終端と後方文脈の終端では「大きい位置」、前方文脈の始端では「小さい位置」（いずれも検査対象から遠い側）。
3. **検査対象の終端は 段落境界 → 文境界 → ideal の書記素境界 の順で決める。** 仕様 6.1 手順 2〜3 のとおり。
4. **参考文脈の端は 段落境界 → ideal の書記素境界 の順で決め、文境界は使わない。** 仕様 5.2 が文脈の丸めに
   段落境界と書記素クラスタ境界しか挙げていないため、字義どおりにする（「解釈で迷った点」参照）。
5. **最後の検査対象の規則：残りが `目標 + delta` 以下なら残り全部を 1 つの検査対象にする。**
   残りが `目標 + delta` をわずかに超える場合は、窓内の境界で切った後に短い最終対象（最小 1 書記素）が
   できうる。既知の制約として記録し、実測後に調整する（仕様の「初期値は調整可能」の範囲）。
6. **`paragraphIds` は検査対象と重なりのある（共通部分が空でない）段落すべて。** 文境界や書記素境界で切った段落は
   複数の検査対象に現れる。
7. **本文端の扱い：ideal が本文の外に出る場合は、存在する本文をすべて文脈にし、丸めない。**
   `target.start === 0` なら `before` は `null`、`target.end === text.length` なら `after` は `null`。
   `contextGraphemes === 0` のときも `null`（空範囲を作らない）。
8. **再確認の文脈は元の検査対象の端から `recheckContextGraphemes` で測り、その後 `initial.inputRange` を含むよう
   min / max で広げる。** これにより再確認の文脈長を初回より小さく設定しても「必ず含む」が成り立つ。
9. **文境界の文字集合。** 終端記号 `。！？!?` のいずれかで始まり、終端記号と閉じ括弧 `」』）】〕〉》］)` だけが
   続く最長の並びの直後を文境界とする。閉じ括弧だけ（`」` 単独）や `……` は文境界にしない。
   `。` の直後に結合文字や異体字セレクタが続くと書記素クラスタが「。+ U+0301」のようにまとまるので、候補は必ず
   書記素境界で濾す（Node 24 で「あ」「。+U+0301」「い」の 3 書記素になることを確認済み）。
10. **`ChunkSettings` に `maxInputGraphemes` を追加する。** ロードマップの語彙にはない。shared は書記素数しか
    数えられないので上限も書記素数で持ち、トークン上限からの換算はサーバー（PR5/PR7）の責務にする。
    超過時は `buildCheckInput` / `buildRecheckInput` が `InputTooLongError { required, limit }` を投げる
    （入力長は文脈を付けた後にしか決まらないので `planTargets` では投げない）。
    `buildCheckInput` / `buildRecheckInput` に渡す `target` は `planTargets` の出力に限る（呼び出し側の契約）。
    書記素境界でない範囲を渡すと `RangeError` が伝播する。
11. **設定の検証は `validateChunkSettings` で先に行い、`InvalidChunkSettingsError` を投げる。**
    条件：`targetGraphemes ≥ 1`、`contextGraphemes ≥ 0`、`recheckContextGraphemes ≥ 0`、`0 ≤ roundingTolerance < 1`、
    `maxInputGraphemes ≥ targetGraphemes + delta`、すべて整数（tolerance を除く）。最後の条件で、検査対象単独が
    上限を超えることはなくなる。サーバー（PR7）がトークン上限から小さな `maxInputGraphemes` を換算した場合はこの検証で
    `InvalidChunkSettingsError` になるので、PR7 では `InputTooLongError` と同じ「設定変更を案内」の経路に載せる。
12. **`buildCheckInput` の引数から `contextGraphemes` を外す。** ロードマップの署名は文脈長を引数と `settings` の
    両方で受けていた。`settings.contextGraphemes` に一本化し、`buildRecheckInput` は `settings.recheckContextGraphemes`
    を使う。ロードマップの語彙を更新する。
13. **書記素インデックスは呼び出しごとに再構築する。** `segmentGraphemes` の `index` を境界一覧にする。
    1 万字で約 8 ms（Node 24、WSL）なので、引数に事前計算を足して署名を複雑にしない。
    段落境界は常に書記素境界（CR・LF は前後で必ず切れ、CRLF はまとまる）だが、実装は仮定せず
    `isGraphemeBoundary` で確認し、違えば `RangeError`。

### 数値例（目標 1,500 字、tolerance 0.2、delta 300）

- 段落終端が 400・1,250・1,700・2,100 字目：窓 1,200〜1,800 の候補は 1,250（距離 250）と 1,700（距離 200）→ 1,700。
- 段落終端が 1,300 と 1,700：どちらも距離 200 → 外側の 1,700。
- 段落終端が 1,000 と 2,000：窓内に段落境界なし → 窓内の文境界（例：1,450）→ なければ 1,500 字目の書記素境界。
- 前方文脈（目標 1,000 字、delta 200）、検査対象が 3,000 字目から：ideal 2,000、窓 1,800〜2,200。段落始端が
  1,900 と 2,150 なら 1,900（距離 100）。1,850 と 2,150 なら同距離 150 → 外側（小さい方）の 1,850。
- 再確認（目標 3,000 字）、検査対象 3,000〜4,500 字目：前方 ideal 0 → 本文先頭から、後方 ideal 7,500 →
  本文が 7,000 字なら末尾まで。

テストで使う値は小さくする（目標 10・delta 2 など）。付録の表が正本。

## 解釈で迷った点（PR 本文にも列挙する）

- **参考文脈の丸めに文境界を使うか。** 仕様 5.2 は「段落境界を優先して丸める…適切な境界がなければ目標位置の
  書記素クラスタ境界で切る」とし、6.1 手順 3 の文境界は検査対象の分割にだけ書かれている。字義どおり文脈では
  文境界を使わない。文脈は参考情報なので文の途中で切れても害は小さい。使うべきと判断すれば `chooseBoundary` に
  候補を足すだけで済む。
- **最後の検査対象が短くなる場合。** 決定 5 のとおり。仕様は「目標文字数前後」としか言っていないので違反ではないが、
  実測で目立てば規則を変える。
- **窓内に段落境界がないときの文境界。** 仕様 6.1 手順 3 は文境界を「単一段落が長い場合」に挙げている。本計画では、
  窓内に段落終端がなければ（段落終端が窓のすぐ外にあって窓が複数段落にまたがる場合も含めて）文境界を探す。
  違反ではないが読み替えなので記録する。
- **入力上限の単位。** 仕様は「入力上限」の単位を定めていない。shared では書記素数、サーバーでトークン上限から
  換算する前提。換算係数は PR5/PR7 で決める。

## テスト

一覧は付録の英語スペックが正本。分類だけ書く。

- `grapheme-index`：境界一覧、位置 ⇄ 番号の往復、境界でない位置は `RangeError`、ZWJ 絵文字・異体字セレクタ・CRLF
- `sentence`：`。！？!?` の後、`。」` の後、`」` 単独は境界でない、`……` は境界でない、結合文字が続く `。` は境界でない、
  範囲の外の境界を返さない
- `settings`：各条件の違反で `InvalidChunkSettingsError`、正常値で通る
- `planTargets`：段落境界が窓内、同距離で外側、文境界へのフォールバック、書記素境界へのフォールバック、
  ZWJ・異体字セレクタをまたぐ ideal、残りが `目標 + delta` 以下、空本文、`paragraphIds`
- 敷き詰めの不変条件（すべての入力に対して）：先頭 0、各対象の `start` が直前の `end`、最後の `end` が
  `text.length`、`index` が 0 始まりの連番、空対象なし、すべての境界が書記素境界、各対象の長さが
  `目標 + delta` 以下（最後の対象を含む）
- 付録の期待値はすべて、計画のアルゴリズムを別に書いた参照実装（scratch）で検算済み
- `buildCheckInput`：短い会話段落の連続で複数段落を含む文脈、前方の同距離で小さい側、本文先頭・末尾で `null`、
  ideal が本文外で丸めなし、`contextGraphemes = 0` で `null`、`inputRange` の一致、`InputTooLongError` の数値
- `buildRecheckInput`：文脈が広がる、再確認の文脈長が初回より小さくても `inputRange` を含む、本文末尾の検査対象、上限超過
- ランダム検査：`planTargets` の敷き詰め不変条件を、シード固定の乱数で作った本文（短い段落・長い段落・句点・絵文字・
  結合文字・CRLF の混在）で確認。`chooseBoundary` は内部関数なので、同距離と窓の両端の挙動は表の行で検証する
- `buildCheckInput` の表には、文脈が ZWJ 絵文字をまたぎ、書記素番号とコード単位がずれる本文（text J）を含める

## 進め方（コミット単位）

1. **計画とブランチ**（このコミット）：本書を追加。
2. **実装とテスト**（qwen に委譲、Claude が検証）：付録のスペックを標準入力から渡す。実装 4 ファイル + `index.ts` +
   テスト 4 ファイルで委譲の上限に近いので、`grapheme-index` と `sentence` と `settings`（依存なし）を 1 回目、`plan` を
   2 回目に分ける。1 回目の出力を検証してから 2 回目を渡す。渡す前に、抽出したスペックに生の U+200D・U+0301・U+3099 が
   含まれないことを `grep -P` で確認する（計画の初稿に混入していた。qwen が正規化すると期待値が黙って変わる）。
3. **検証**（Claude）：全ファイルを読む。特に `outer` の向き、窓の両端の包含、最後の対象の規則、再確認の min/max を
   スペックの数値例と突き合わせる。テストの期待値が付録の表と一致していることを 1 行ずつ確認する（自己修正ループで
   期待値の側が書き換えられていないか）。`pnpm check` を自分でも実行する。
4. **ドキュメント**（Claude）：ロードマップの共通語彙と PR2 節を更新。差分：`ChunkSettings.maxInputGraphemes` の追加、
   `ChunkSettings` と `InputTooLongError` が `chunk/settings.ts` に移ること、`buildCheckInput` の署名から `contextGraphemes` を
   外すこと、`InvalidChunkSettingsError`・`roundingDelta`・`validateChunkSettings`・`findSentenceBoundaries` の公開、
   `text/grapheme-index.ts` の新設、文境界の定義（閉じ括弧は終端記号に続く場合だけ）。
5. **PR 作成**：解釈で迷った点、Windows の確認状況（CI で確認、ローカルは未確認）を書く。

## 付録 1：qwen へのスペック（1 回目。英語）

````text
# Task 1 of 2: grapheme index, sentence boundaries, chunk settings (packages/shared, TypeScript)

You are working in a pnpm monorepo. Only touch these files:

- packages/shared/src/text/grapheme-index.ts (create)
- packages/shared/src/text/grapheme-index.test.ts (create)
- packages/shared/src/chunk/sentence.ts (create)
- packages/shared/src/chunk/sentence.test.ts (create)
- packages/shared/src/chunk/settings.ts (create)
- packages/shared/src/chunk/settings.test.ts (create)
- packages/shared/src/index.ts (modify: add re-exports; keep all existing exports)

Do NOT touch any other file. Do NOT install dependencies. Do NOT modify any Markdown file.

## Project rules (MUST)

- Relative imports MUST end with ".ts". Node runs the TypeScript source directly.
- TypeScript: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`. MUST NOT use `enum`, `namespace`, constructor parameter properties.
  Use `import type` for type-only imports. Use `readonly` on all interface fields.
- Code comments MUST be Japanese. Identifiers MUST be English. Test names (`describe` / `it`) MUST be Japanese.
- `array[i]` has type `T | undefined`. Read elements with `?.` or compare whole arrays with `toEqual`.
  MUST NOT use the non-null assertion `!`. Use `charCodeAt` / `codePointAt`, never `text[i]`.
- In test source, write CR, LF, U+200D, variation selectors, combining marks and every surrogate pair as
  escapes (`\r`, `\n`, `\u200D`, `\u{E0100}`, `\u0301`, `\u{20BB7}`). MUST NOT paste raw control characters,
  raw ZWJ or raw emoji into string literals. Plain Japanese text (hiragana, kanji, 。！？「」, U+3000 full-width space)
  may be written raw.
- MUST NOT change any expected value in the tables below. A failing table row means the implementation is wrong,
  not the table. If you believe a table value is wrong, stop and report it instead of editing the expectation.
- Biome decides formatting and import order. Fix with `pnpm exec biome check --write .`, never by hand.
- Existing helpers you MUST reuse: `segmentGraphemes(text)` from `packages/shared/src/text/grapheme.ts`
  returns `{ segment, index }[]` where `index` is the UTF-16 start offset of each grapheme cluster.
  `Range` (`{ readonly start: number; readonly end: number }`) is in `packages/shared/src/text/range.ts`.

## 1. packages/shared/src/text/grapheme-index.ts

```ts
import { segmentGraphemes } from "./grapheme.ts";

/**
 * 書記素クラスタ境界の一覧。boundaries[k] は k 番目の書記素クラスタの開始位置（UTF-16 コード単位）、
 * boundaries[count] は text.length。位置 ⇄ 書記素番号の変換に使う。
 */
export interface GraphemeIndex {
  readonly boundaries: readonly number[];
  readonly count: number;
}

/** 本文から書記素インデックスを作る。 */
export function buildGraphemeIndex(text: string): GraphemeIndex

/** 位置が書記素境界かどうか。0 と text.length は常に境界。 */
export function isGraphemeBoundary(index: GraphemeIndex, offset: number): boolean

/** 書記素境界の位置を書記素番号に変換する。境界でない位置は RangeError。 */
export function graphemeAt(index: GraphemeIndex, offset: number): number

/** 書記素番号（0..count）を位置に変換する。範囲外は RangeError。 */
export function offsetAt(index: GraphemeIndex, grapheme: number): number
```

Implementation:
- `buildGraphemeIndex`: `boundaries = segmentGraphemes(text).map((s) => s.index)` followed by `text.length`.
  For `""` this is `[0]` and `count` is 0. `count = boundaries.length - 1`.
- `isGraphemeBoundary` and `graphemeAt` use binary search over `boundaries` (sorted ascending, strictly increasing).
  MUST NOT use `indexOf` (O(n) per lookup is not acceptable; these are called many times per plan).
  Use this internal helper verbatim (it satisfies `noUncheckedIndexedAccess` without `!`):

```ts
/** 二分探索で offset の位置を返す。見つからなければ -1。 */
function searchBoundary(index: GraphemeIndex, offset: number): number {
  let lo = 0;
  let hi = index.boundaries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const value = index.boundaries[mid];
    if (value === undefined) {
      return -1;
    }
    if (value === offset) {
      return mid;
    }
    if (value < offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}
```

  `isGraphemeBoundary` is `searchBoundary(...) >= 0`; `graphemeAt` throws when it returns -1.
  `offsetAt` reads `index.boundaries[grapheme]` and throws `RangeError` if it is `undefined`.
- `graphemeAt` throws `new RangeError(...)` (Japanese message) when the offset is not a boundary.
- `offsetAt` throws `RangeError` when `grapheme < 0 || grapheme > count` or not an integer.

Tests (grapheme-index.test.ts):
- `""` → boundaries `[0]`, count 0; `isGraphemeBoundary(idx, 0)` is true.
- `"a\u{20BB7}b"` → boundaries `[0, 1, 3, 4]`, count 3. `graphemeAt(idx, 3)` is 2. `offsetAt(idx, 2)` is 3.
  `isGraphemeBoundary(idx, 2)` is false (inside the surrogate pair). `graphemeAt(idx, 2)` throws RangeError.
- `"\u{1F468}\u200D\u{1F469}\u200D\u{1F467}x"` (ZWJ family + x) → boundaries `[0, 8, 9]`, count 2.
- `"葛\u{E0100}飾"` → boundaries `[0, 3, 4]`.
- `"行\r\n次"` → boundaries `[0, 1, 3, 4]` (CRLF is one cluster).
- `"か\u3099"` (か + combining dakuten) → boundaries `[0, 2]`, count 1.
- `offsetAt(idx, count)` equals `text.length`; `offsetAt(idx, count + 1)` throws; `offsetAt(idx, -1)` throws.
- Round trip: for `"あ\u{20BB7}\r\nい"`, for every k in 0..count, `graphemeAt(idx, offsetAt(idx, k)) === k`.

## 2. packages/shared/src/chunk/sentence.ts

```ts
import { isGraphemeBoundary } from "../text/grapheme-index.ts";
import type { GraphemeIndex } from "../text/grapheme-index.ts";
import type { Range } from "../text/range.ts";

/**
 * 範囲内の文境界を返す（仕様書 6.1 手順 3 の「文境界」）。
 * 終端記号（。！？!?）で始まり、終端記号と閉じ括弧だけが続く最長の並びの直後を文境界とする。
 * 返す位置は range.start より大きく range.end より小さい書記素境界に限る。昇順。
 */
export function findSentenceBoundaries(text: string, range: Range, index: GraphemeIndex): number[]
```

Character sets (define as module-level `Set<number>` of code points):
- TERMINALS: U+3002 。, U+FF01 ！, U+FF1F ？, U+0021 !, U+003F ?
- CLOSERS: U+300D 」, U+300F 』, U+FF09 ）, U+3011 】, U+3015 〕, U+3009 〉, U+300B 》, U+FF3D ］, U+0029 )

Algorithm: scan `i` from `range.start` to `range.end` (exclusive) by code unit. When `text.charCodeAt(i)` is in
TERMINALS: set `j = i + 1`; while `j < range.end` and `charCodeAt(j)` is in TERMINALS or CLOSERS, `j += 1`.
If `j < range.end` and `isGraphemeBoundary(index, j)`, push `j` (`j > range.start` holds automatically because the scan
starts at `range.start`). Then continue scanning
from `j` (not from `i + 1`). If the code unit is not a terminal, `i += 1`.

Restated from the other direction so it is not inverted:
- A closer alone (`」` not preceded by a terminal) is NOT a boundary.
- `……` (U+2026) and `、` are NOT boundaries.
- A run like `。」` yields ONE boundary, after the `」`, not one after `。`.
- A boundary equal to `range.end` is NOT returned (nothing to split there). A boundary equal to `range.start` is NOT returned.
- If the terminal is followed by a combining mark or variation selector, the grapheme cluster continues, so
  `isGraphemeBoundary` is false and NO boundary is returned there.

Tests (sentence.test.ts). Build `index` with `buildGraphemeIndex(text)` and use `range = { start: 0, end: text.length }`
unless stated. Expected offsets are UTF-16 code units.
- `"雨だ。傘を持つ。帰る"` → `[3, 8]`
- `"本当？　そう！ええ"` → `[3, 7]` (U+3000 after ？ is ordinary text, so boundary is right after ？ at 3)
- `"「行こう。」と言った。"` → `[6]` (the boundary after the final 。 equals range.end and is not returned)
- `"「行こう」と言った"` → `[]` (closer alone is not a boundary)
- `"待って……行く"` → `[]`
- `"雨だ。"` → `[]` (the only boundary equals range.end)
- `"あ。」）！い"` → `[5]` (one boundary after the whole run)
- `"あ。\u0301い"` → `[]` (combining mark after 。; cluster continues, no boundary)
- `"a!b?c."` → `[2, 4]` (ASCII ! and ? are terminals; ASCII . is NOT)
- `"あ。い。う。え"` (full range) → `[2, 4, 6]`
- `"あ。い。う。え"` with `range = { start: 3, end: 6 }` → `[4]` (boundary 2 is before start, boundary 6 equals end)
- `"あ。い。う。え"` with `range = { start: 2, end: 7 }` → `[4, 6]` (the terminal at offset 1 is before the range, so no boundary at 2)

## 3. packages/shared/src/chunk/settings.ts

```ts
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
  constructor(message: string) { super(message); this.name = "InvalidChunkSettingsError"; }
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
export function roundingDelta(target: number, tolerance: number): number

/** 設定を検証し、不正なら InvalidChunkSettingsError を投げる。 */
export function validateChunkSettings(settings: ChunkSettings): void
```

Validation rules (each violation throws `InvalidChunkSettingsError` with a Japanese message naming the field):
- `targetGraphemes` is an integer ≥ 1
- `contextGraphemes` is an integer ≥ 0
- `recheckContextGraphemes` is an integer ≥ 0
- `roundingTolerance` is a finite number with `0 ≤ roundingTolerance < 1`
- `maxInputGraphemes` is an integer ≥ `targetGraphemes + roundingDelta(targetGraphemes, roundingTolerance)`

Use `Number.isInteger` / `Number.isFinite`. `roundingDelta` is `Math.floor(target * tolerance)`.

Tests (settings.test.ts). `base = { targetGraphemes: 1500, contextGraphemes: 1000, recheckContextGraphemes: 3000, roundingTolerance: 0.2, maxInputGraphemes: 8000 }`.
- `validateChunkSettings(base)` does not throw.
- `roundingDelta(1500, 0.2)` is 300; `roundingDelta(10, 0.2)` is 2; `roundingDelta(4, 0.2)` is 0; `roundingDelta(7, 0.5)` is 3.
- Each of the following throws `InvalidChunkSettingsError`: `targetGraphemes: 0`, `targetGraphemes: 1.5`,
  `contextGraphemes: -1`, `recheckContextGraphemes: -1`, `roundingTolerance: 1`, `roundingTolerance: -0.1`,
  `roundingTolerance: Number.NaN`, `maxInputGraphemes: 1799` (needs ≥ 1800 for base), `maxInputGraphemes: 1800` does NOT throw.
- `new InputTooLongError(18, 15)` has `required` 18, `limit` 15, `name` "InputTooLongError", and is `instanceof Error`.

## 4. packages/shared/src/index.ts

Add these re-exports (keep every existing line; let Biome sort):

```ts
export { findSentenceBoundaries } from "./chunk/sentence.ts";
export type { ChunkSettings } from "./chunk/settings.ts";
export { InputTooLongError, InvalidChunkSettingsError, roundingDelta, validateChunkSettings } from "./chunk/settings.ts";
export type { GraphemeIndex } from "./text/grapheme-index.ts";
export { buildGraphemeIndex, graphemeAt, isGraphemeBoundary, offsetAt } from "./text/grapheme-index.ts";
```

## Hazards to avoid

- Do NOT compute offsets with `.length` arithmetic on strings that may contain surrogate pairs; always go through the index.
- Do NOT treat a closer alone as a sentence boundary. Do NOT treat `、` or `…` as a terminal.
- Do NOT return boundaries equal to `range.start` or `range.end`.
- Do NOT use `!` non-null assertions. Do NOT use `text[i]`.

## Self-correction (MANDATORY — run before finishing)

Run from the repository root and fix errors iteratively until all pass:
1. Format and sort imports: `pnpm exec biome check --write .`
2. Typecheck: `pnpm typecheck`
3. Lint: `pnpm lint`
4. Full check: `pnpm check`

Do NOT finish the session until `pnpm check` passes.
````

## 付録 2：qwen へのスペック（2 回目。英語）

````text
# Task 2 of 2: target planning and context windows (packages/shared/src/chunk/plan.ts)

Only touch these files:

- packages/shared/src/chunk/plan.ts (create)
- packages/shared/src/chunk/plan.test.ts (create)
- packages/shared/src/index.ts (modify: add re-exports; keep all existing exports)

Do NOT touch any other file. Do NOT modify any Markdown file. The same project rules as Task 1 apply
(`.ts` imports, no `enum`, `readonly` fields, Japanese comments and test names, `?.` instead of `!`,
escapes for ZWJ / variation selectors / surrogates / CR / LF, Biome via `pnpm exec biome check --write .`).

Existing modules you MUST use (already implemented and tested):
- `packages/shared/src/text/range.ts`: `Range { readonly start; readonly end }`, `sliceRange(text, range)`
- `packages/shared/src/text/paragraph.ts`: `Paragraph { readonly id; readonly range }`, `splitParagraphs(text)`
- `packages/shared/src/text/grapheme-index.ts`: `GraphemeIndex`, `buildGraphemeIndex(text)`,
  `isGraphemeBoundary(index, offset)`, `graphemeAt(index, offset)` (offset → grapheme number, throws if not a boundary),
  `offsetAt(index, grapheme)` (grapheme number → offset)
- `packages/shared/src/chunk/sentence.ts`: `findSentenceBoundaries(text, range, index)` → sorted offsets strictly inside range
- `packages/shared/src/chunk/settings.ts`: `ChunkSettings`, `validateChunkSettings(settings)`, `roundingDelta(target, tolerance)`,
  `InputTooLongError(required, limit)`

## Types and functions

```ts
/** 検査対象範囲。index は検査実行内で 0 始まりの連番。paragraphIds は範囲と重なる段落すべて。 */
export interface TargetRange {
  readonly index: number;
  readonly range: Range;
  readonly paragraphIds: readonly number[];
}

/** 参考文脈。本文端や文脈長 0 では null。 */
export interface ContextWindow {
  readonly before: Range | null;
  readonly after: Range | null;
}

/** 1 回の検査要求に渡す本文の範囲。inputRange は before.start（なければ target.start）から after.end（なければ target.end）まで。 */
export interface CheckInput {
  readonly target: TargetRange;
  readonly context: ContextWindow;
  readonly inputRange: Range;
}

/** 本文を検査対象に分割する（仕様書 6.1 手順 2〜4）。全位置がちょうど 1 つの検査対象に属する。 */
export function planTargets(text: string, paragraphs: readonly Paragraph[], settings: ChunkSettings): TargetRange[]

/** 検査対象に初回検査の参考文脈を付ける（仕様書 5.2、6.1 手順 5）。 */
export function buildCheckInput(text: string, paragraphs: readonly Paragraph[], target: TargetRange, settings: ChunkSettings): CheckInput

/** 再確認用に文脈を広げる（仕様書 5.2、6.5）。initial.inputRange を必ず含む。 */
export function buildRecheckInput(text: string, paragraphs: readonly Paragraph[], initial: CheckInput, settings: ChunkSettings): CheckInput
```

All lengths and distances below are in GRAPHEME NUMBERS (via the index), never code units. Convert to offsets only
when building `Range` values. Every function first calls `validateChunkSettings(settings)` and `buildGraphemeIndex(text)`.

### chooseBoundary (internal, not exported)

```ts
/**
 * 窓 [ideal - delta, ideal + delta]（両端を含む）にある候補のうち ideal に最も近いものを返す。
 * 同距離なら outer 側（"larger" なら大きい方、"smaller" なら小さい方）。候補がなければ null。
 * 単位は書記素番号。candidates は昇順でなくてよい。
 */
function chooseBoundary(ideal: number, delta: number, candidates: readonly number[], outer: "larger" | "smaller"): number | null
```

Polarity, stated twice so it cannot be inverted:
- `outer` means "the side farther from the target". For the END of a target and for the END of the after-context,
  farther from the target is the LARGER grapheme number → pass `"larger"`. For the START of the before-context,
  farther from the target is the SMALLER grapheme number → pass `"smaller"`.
- Never pass `"smaller"` when choosing a target end. Never pass `"larger"` when choosing a before-context start.

### planTargets

Let `G = buildGraphemeIndex(text)`, `T = settings.targetGraphemes`, `D = roundingDelta(T, settings.roundingTolerance)`.
Paragraph boundaries as grapheme numbers: `PB = paragraphs.map((p) => graphemeAt(G, p.range.end))` (every paragraph end;
`text.length` is included because the last paragraph ends there). If `graphemeAt` throws for a paragraph end, let the
RangeError propagate (paragraph ends are always grapheme boundaries; this is a consistency check).

```
targets = []
cursor = 0                                  // grapheme number
while cursor < G.count:
  remaining = G.count - cursor
  if remaining <= T + D:                    // 最後の検査対象：残り全部
    end = G.count
  else:
    ideal = cursor + T
    end = chooseBoundary(ideal, D, PB.filter(b => b > cursor), "larger")
    if end == null:
      sentence = findSentenceBoundaries(text, { start: offsetAt(G, cursor), end: text.length }, G).map(o => graphemeAt(G, o))
      end = chooseBoundary(ideal, D, sentence, "larger")
    if end == null:
      end = ideal                           // 書記素境界で切る
  range = { start: offsetAt(G, cursor), end: offsetAt(G, end) }
  paragraphIds = paragraphs.filter(p => p.range.start < range.end && range.start < p.range.end).map(p => p.id)
  targets.push({ index: targets.length, range, paragraphIds })
  cursor = end
return targets
```

Empty text returns `[]`. The `remaining <= T + D` check comes FIRST, before looking for boundaries.
Candidates MUST be strictly greater than `cursor` (a boundary at the cursor would create an empty target).
Explanatory note, do not assert it in code: `ideal - D >= cursor + 1` always holds because `D < T` (tolerance < 1),
so the window never reaches the cursor.

### buildCheckInput

`B = settings.contextGraphemes`, `DB = roundingDelta(B, settings.roundingTolerance)`. Paragraph START boundaries as
grapheme numbers: `PS = paragraphs.map((p) => graphemeAt(G, p.range.start))` (this always includes 0).
`ts = graphemeAt(G, target.range.start)`, `te = graphemeAt(G, target.range.end)`.

before:
Check the conditions in this order (the order matters: swapping the first two would produce an empty range at `ts == 0`):
- if `ts == 0` or `B == 0`: `null`
- else if `ts - B <= 0`: `{ start: 0, end: target.range.start }` (everything up to the text start, no rounding)
- else: `ideal = ts - B`; `s = chooseBoundary(ideal, DB, PS.filter(b => b < ts), "smaller") ?? ideal`;
  `{ start: offsetAt(G, s), end: target.range.start }`

after (mirror):
- if `te == G.count` or `B == 0`: `null`
- else if `te + B >= G.count`: `{ start: target.range.end, end: text.length }`
- else: `ideal = te + B`; `e = chooseBoundary(ideal, DB, PB.filter(b => b > te), "larger") ?? ideal`
  where `PB` is paragraph ENDS as in planTargets; `{ start: target.range.end, end: offsetAt(G, e) }`

Context rounding uses paragraph boundaries and then the grapheme boundary at ideal. It does NOT use sentence boundaries
(that step exists only for target ends). Do NOT call findSentenceBoundaries here.

`inputRange = { start: before?.start ?? target.range.start, end: after?.end ?? target.range.end }`.
Then `required = graphemeAt(G, inputRange.end) - graphemeAt(G, inputRange.start)`; if `required > settings.maxInputGraphemes`
throw `new InputTooLongError(required, settings.maxInputGraphemes)`. Return `{ target, context: { before, after }, inputRange }`.

### buildRecheckInput

Same as buildCheckInput but with `R = settings.recheckContextGraphemes` (and `DR = roundingDelta(R, tolerance)`) measured
from `initial.target`, THEN widened so that `initial.inputRange` is contained:
- compute `before` / `after` exactly as above with `R` instead of `B`, using `initial.target`
- `start = Math.min(before?.start ?? initial.target.range.start, initial.inputRange.start)`
- `end = Math.max(after?.end ?? initial.target.range.end, initial.inputRange.end)`
- rebuild: `before = start < initial.target.range.start ? { start, end: initial.target.range.start } : null`,
  `after = end > initial.target.range.end ? { start: initial.target.range.end, end } : null`
- `inputRange = { start, end }`; apply the same `InputTooLongError` check; return `{ target: initial.target, context, inputRange }`.

The containment guard means: even when `recheckContextGraphemes` is SMALLER than `contextGraphemes`, the recheck input
is never narrower than the initial input.

## Tests (plan.test.ts)

Helper: `S(overrides)` returns `{ targetGraphemes: 10, contextGraphemes: 5, recheckContextGraphemes: 8, roundingTolerance: 0.2, maxInputGraphemes: 100, ...overrides }`
(so `D = 2`, window for target end is `[ideal - 2, ideal + 2]`; `DB = 1`; `DR = 1`).
`plan(text, settings)` = `planTargets(text, splitParagraphs(text), settings)`. `ranges(targets)` = `targets.map((t) => [t.range.start, t.range.end])`.
In the texts below every character is one code unit and one grapheme unless noted, so grapheme numbers equal offsets.

### planTargets

| case | text | expected ranges | notes |
| --- | --- | --- | --- |
| 空本文 | `""` | `[]` | |
| 段落境界が窓内 | `"あいうえ\nかきくけこさ\nたちつてとなにぬね\nは"` | `[[0,12],[12,23]]` | paragraph ends 5, 12, 22, 23. cursor 0: window [8,12] → 12. cursor 12: remaining 11 ≤ 12 → rest. paragraphIds `[0,1]` and `[2,3]` |
| 同距離は外側 | `"あいうえおかき\nくけこ\nさしすせそたちつてと"` | `[[0,12],[12,22]]` | ends 8 and 12 are both distance 2 from ideal 10 → larger (12) |
| 文境界へフォールバック | `"あいうえおかきく。けこさしすせそたちつ。なにぬねのはひふへほ"` | `[[0,9],[9,20],[20,30]]` | one paragraph (end 30). cursor 0: no paragraph end in [8,12]; sentence boundaries 9, 20 → 9. cursor 9: ideal 19, window [17,21] → 20. cursor 20: remaining 10 → rest. paragraphIds all `[0]` |
| 書記素境界へフォールバック | `"あ".repeat(25)` | `[[0,10],[10,20],[20,25]]` | no boundaries at all |
| ZWJ 絵文字をまたぐ ideal | `"あいうえおかきくけ" + "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}" + "さしすせそたちつてと"` | `[[0,17],[17,27]]` | 20 graphemes, 27 code units. grapheme 10 starts at offset 17 (after the 8-unit emoji). MUST NOT cut at offset 10 |
| 異体字セレクタをまたぐ ideal | `"あいうえおかきくけ" + "葛\u{E0100}" + "さしすせそたちつてと"` | `[[0,12],[12,22]]` | grapheme 10 starts at offset 12 |
| CRLF をまたがない | `"あいうえおかきくけ\r\nさしすせそたちつてとな"` | `[[0,11],[11,22]]` | 21 graphemes, 22 code units. paragraph end at grapheme 10 = offset 11 (CRLF is one grapheme). window [8,12] contains 10 → cut at 11, never between CR and LF. cursor 10: remaining 11 → rest |
| 残りが目標 + delta ちょうど | `"あ".repeat(12)` | `[[0,12]]` | remaining 12 ≤ 12 → single target |
| 残りが目標 + delta + 1 | `"あ".repeat(13)` | `[[0,10],[10,13]]` | remaining 13 > 12 → cut at ideal 10, then rest (a short final target is allowed) |
| 窓の下端を含む | `"あいうえおかき\nくけこさしすせそたちつて"` | `[[0,8],[8,20]]` | end 8 is exactly ideal − D → chosen; cursor 8: remaining 12 → rest |
| 窓の上端を含む | `"あいうえおかきくけこさ\nすせそたちつてとなに"` | `[[0,12],[12,22]]` | end 12 is exactly ideal + D |
| 窓の外は選ばない | `"あいうえおかきくけこさし\nすせそたちつてとな"` | `[[0,10],[10,22]]` | end 13 is outside [8,12]; no sentence boundary → cut at 10; cursor 10: remaining 12 → rest. paragraphIds `[0]` and `[0,1]` |

Also:
- `index` is sequential from 0 for the 文境界 case (`[0, 1, 2]`).
- Tiling invariant, one `it` per row of the table (define the table once as an array and loop over it, or use `it.each`):
  for non-empty text, `first.start === 0`, each `start`
  equals the previous `end`, last `end === text.length`, `index` equals array position, `end > start` for every target,
  `isGraphemeBoundary(G, start)` and `isGraphemeBoundary(G, end)` for every target, and
  `graphemeAt(G, end) - graphemeAt(G, start) <= 12` for every target, and concatenating `sliceRange` of all targets equals `text`.
- Randomized tiling check (one `it`, 300 iterations, seeded PRNG so it is deterministic — implement a tiny mulberry32):
  build a random text by concatenating 1..40 pieces drawn from
  `["あ", "い。", "う！", "\n", "\r\n", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "葛\u{E0100}", "か\u3099", "「え」"]`,
  plan with `S({ targetGraphemes: 1 + (rnd % 7), roundingTolerance: 0.4 })`, and assert the tiling invariant above (with the length bound `T + roundingDelta(T, 0.4)`).
- `chooseBoundary` is internal and not exported; its tie and window-edge behaviour is verified through the table rows above.

### buildCheckInput

Text F: `"あい\nうえ\nおか\nきく\nけこ\nさし\nすせ\nそた"` — paragraph starts 0,3,6,9,12,15,18,21; ends 3,6,9,12,15,18,21,23; length 23.
Targets are constructed directly as `{ index: 0, range, paragraphIds }` (paragraphIds may be `[]` for these tests; buildCheckInput does not read them).

| case | target range | settings | expected before | expected after | inputRange |
| --- | --- | --- | --- | --- | --- |
| 段落始端が窓内 | `[9,15]` | `S()` (B=5, DB=1) | `[3,9]` (ideal 4, window [3,5], start 3) | `[15,21]` (ideal 20, window [19,21], end 21) | `[3,21]` |
| 短い会話段落を複数含む | `[9,15]` | `S({ contextGraphemes: 8 })` (DB=1) | `[0,9]` (ideal 1, window [0,2], start 0 → 3 paragraphs) | `[15,23]` (ideal 23 ≥ count → to end) | `[0,23]` |
| 本文先頭では before が null | `[0,6]` | `S()` | `null` | `[6,12]` (ideal 11, window [10,12], end 12) | `[0,12]` |
| 本文末尾では after が null | `[18,23]` | `S()` | `[12,18]` (ideal 13, window [12,14], start 12) | `null` | `[12,23]` |
| ideal が本文の外なら丸めない | `[3,9]` | `S()` | `[0,3]` (ideal −2 ≤ 0) | `[9,15]` | `[0,15]` |
| 文脈長 0 は null | `[9,15]` | `S({ contextGraphemes: 0 })` | `null` | `null` | `[9,15]` |
| 前方は最も近い始端、後方の同距離は大きい側 | `[12,18]` | `S({ contextGraphemes: 4, roundingTolerance: 0.5 })` (DB=2) | ideal 8, window [6,10]: starts 6 (distance 2) and 9 (distance 1) → `[9,12]` | ideal 22, window [20,24]: ends 21 (distance 1) and 23 (distance 1) → tie → larger 23 → `[18,23]` | `[9,23]` |
| 前方は窓内で最も近い始端（text G） | `[13,19]` on text G below | `S({ contextGraphemes: 4, roundingTolerance: 0.5 })` (DB=2) | `[9,13]` (ideal 9, window [7,11]: starts 7 (distance 2), 9 (distance 0)) | `null` (target ends at 19 = length) | `[9,19]` |
| 前方の同距離は小さい側（text G） | `[13,19]` on text G below | `S({ contextGraphemes: 5, roundingTolerance: 0.2 })` (DB=1) | `[7,13]` (ideal 8, window [7,9]: starts 7 and 9 both distance 1 → tie → smaller 7) | `null` | `[7,19]` |
| 文脈が ZWJ 絵文字をまたぐ（text J） | `[16,19]` on text J below | `S()` (B=5, DB=1) | `[3,16]` (ts = grapheme 9, ideal 4, window [3,5]: paragraph start at grapheme 3 = offset 3) | `[19,21]` (te = 12, 12 + 5 ≥ 14 → to end) | `[3,21]`; required is 11 graphemes (not 18 code units): `S({ maxInputGraphemes: 11 })` does not throw, `S({ maxInputGraphemes: 10 })` throws with `required` 11, `limit` 10 |
| 段落境界が窓内にない | `[9,15]` on text H below | `S({ contextGraphemes: 5, roundingTolerance: 0 })` (DB=0, window is the single point ideal) | `[4,9]` | `[15,20]` | `[4,20]` |
| 上限超過 | `[9,15]` | `S({ maxInputGraphemes: 17 })` | throws `InputTooLongError` with `required` 18 and `limit` 17 | | |
| 上限ちょうど | `[9,15]` | `S({ maxInputGraphemes: 18 })` | does not throw; inputRange `[3,21]` | | |

Text G: `"あい\nうえお\nか\nきくけ\nこさしすせそ"` — paragraph starts 0,3,7,9,13; ends 3,7,9,13,19; length 19. Every character is one grapheme.

Text J: `"あい\n" + "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}え\n" + "おか\nきく\nけこ"` — 21 code units, 14 graphemes.
Paragraph starts (offsets) 0,3,13,16,19; the emoji occupies offsets 3..11 and is grapheme 3; `え` is grapheme 4 at offset 11.
Grapheme numbers of the starts: 0,3,6,9,12. The target `[16,19]` is grapheme 9..12. A code-unit implementation would compute
ideal 16 − 5 = 11 and fail this row.

Text H (no paragraph boundaries): `"あいうえおかきくけこさしすせそたちつてと"` (one paragraph, 20 graphemes). Target `[9,15]`, `S({ contextGraphemes: 5, roundingTolerance: 0 })`:
before ideal 4, window [4,4], start candidates `< 9` are only 0 → not in window → grapheme boundary at 4 → `[4,9]`.
after ideal 20 ≥ count 20 → `[15,20]` (to the end, no rounding). inputRange `[4,20]`.

### buildRecheckInput (text F, initial from `buildCheckInput` with `S()` on target `[9,15]`, i.e. initial inputRange `[3,21]`)

| case | settings | expected |
| --- | --- | --- |
| 文脈が広がる | `S()` (R=8, DR=1) | before `[0,9]` (ideal 1, window [0,2] → 0), after `[15,23]` (ideal 23 ≥ count), inputRange `[0,23]`, target unchanged |
| 再確認の文脈が初回より狭くても初回の入力を含む | `S({ recheckContextGraphemes: 2 })` (DR=0) | raw before ideal 7 → no start in [7,7] → 7; min(7, 3) = 3 → before `[3,9]`. raw after ideal 17 → no end at 17 → 17; max(17, 21) = 21 → after `[15,21]`. inputRange `[3,21]` |
| 再確認の文脈 0 でも初回の入力を含む | `S({ recheckContextGraphemes: 0 })` | before `[3,9]`, after `[15,21]`, inputRange `[3,21]` |
| 本文末尾の検査対象 | initial from `buildCheckInput` with `S()` on target `[18,23]` (initial inputRange `[12,23]`, after null); recheck with `S()` | before `[9,18]` (ideal 10, window [9,11] → start 9), after `null`, inputRange `[9,23]` |
| 上限超過 | `S({ maxInputGraphemes: 22 })` | throws `InputTooLongError` with `required` 23, `limit` 22 |

Also assert for every recheck case: `result.inputRange.start <= initial.inputRange.start` and `result.inputRange.end >= initial.inputRange.end`.

## packages/shared/src/index.ts

Add (let Biome sort):

```ts
export type { CheckInput, ContextWindow, TargetRange } from "./chunk/plan.ts";
export { buildCheckInput, buildRecheckInput, planTargets } from "./chunk/plan.ts";
```

## Hazards to avoid

- Do NOT invert `outer`: target end and after-context use `"larger"`; before-context uses `"smaller"`.
- Do NOT use sentence boundaries for context windows. Do use them for target ends (after paragraph boundaries fail).
- MUST NOT check boundaries before the `remaining <= T + D` rule; the rest-of-text rule comes first.
- Invariants from docs/reference/invariants.md: every position of the text MUST belong to exactly one target (tiling);
  every cut MUST be a grapheme cluster boundary (never inside CRLF, a surrogate pair, a ZWJ sequence, or a
  base + combining mark / variation selector); the input MUST NOT be shrunk silently when it exceeds the limit.
- Do NOT let a boundary equal to `cursor` be a candidate.
- Do NOT compute lengths with `.length` or `end - start` on code units when a grapheme count is required; convert with `graphemeAt`.
- Do NOT read or mutate `target.paragraphIds` in buildCheckInput / buildRecheckInput.
- MUST NOT shrink the input when it exceeds `maxInputGraphemes`; throw `InputTooLongError`.
- MUST NOT change any expected value in the tables. A failing row means the implementation is wrong, not the table.
- Do NOT rebuild `initial.target` in buildRecheckInput; return the same object.

## Self-correction (MANDATORY — run before finishing)

1. `pnpm exec biome check --write .`
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm check`

Do NOT finish the session until `pnpm check` passes.
````
