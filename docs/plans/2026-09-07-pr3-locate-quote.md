# PR3 詳細計画：引用照合・位置確定・診断候補

日付：2026-09-07  
状態：設計中  
ブランチ：`feat/pr3-locate-quote`  
上位計画：`docs/plans/2026-09-07-mvp-roadmap.md` の PR3 節

## 目標

`packages/shared` に、LLM が返した引用（`QuoteRef`）を原文の位置に確定する `locateQuote` を実装する。
完全一致だけで位置を決め、複数一致は段落 ID と前後の引用で絞り、絞れなければ位置特定失敗にする。
完全一致がないときだけ、改行統一・NFC・その両方の 3 変換で比較用文字列を作って診断候補を探し、
比較用文字列から原文への位置対応を保持する。

対応する仕様：6.2（引用だけで一意なら失敗にしない）、6.3 全体（引用と位置の検証、位置特定失敗の診断）。
受け入れ条件：11 節 6 項（正しい範囲の強調）、7 項（反復・段落境界・CRLF・異体字セレクタ・結合文字・絵文字で
位置がずれない）、9 項（位置特定失敗の保存と診断候補）、17 項（参考文脈から始まる候補は採用しない）の shared 側。

## 全体の制約（`docs/reference/invariants.md` から）

- 文字位置はアプリが原文から確定する。LLM の数値位置は使わない（`QuoteRef` に数値位置を持たせない）。
- 引用は **完全一致** でのみ位置を確定する。近似一致で位置を割り当てない。
- 完全一致に失敗した候補は位置特定失敗として返す。診断候補は記録するだけで、強調・再確認・採用位置に使わない。
- 引用の開始位置が検査対象内にある候補だけを採用する。参考文脈内から始まる候補は担当範囲へ付け替えない。
- 引用だけで位置が一意に決まる場合は、前後の引用の不備だけを理由に失敗にしない。
- 原文は変更しない。Unicode 正規化・空白除去・改行統一を保存本文に対して暗黙に行わない。
  診断のための変換は比較専用の文字列にだけ適用する。
- 位置は UTF-16 コード単位の `[start, end)`。確定した範囲は書記素クラスタの途中で始まったり終わったりしない。
- 診断変換は改行統一と NFC の 2 種（とその組）に限る。括弧置換、長音・三点リーダの同一視、空白削除、
  異体字セレクタ除去は入れない。変換規則の版を記録する。
- 診断候補は指定段落に近い順に最大 3 件。同順位の存在と打ち切り件数を残す。無制限の全文類似検索はしない。
- 相対 import は `.ts` 拡張子付き。`erasableSyntaxOnly`。公開関数は `src/index.ts` から再エクスポート。

## 作るもの

| ファイル | 責務 | 公開する名前 |
| --- | --- | --- |
| `packages/shared/src/locate/quote-ref.ts` | LLM 出力の型に依存しない照合用の最小入力 | `QuoteRef` |
| `packages/shared/src/text/grapheme-index.ts`（追記） | 位置を書記素境界へ丸める補助 | `floorGraphemeBoundary`、`ceilGraphemeBoundary` |
| `packages/shared/src/locate/position-map.ts` | 比較用文字列の生成と、比較用文字列から原文への位置対応 | `DiagnosticTransform`、`applyTransform`（他は内部用） |
| `packages/shared/src/locate/diagnostic.ts` | 位置特定失敗の診断候補 | `Diagnostic`、`DiagnosticCandidate`、`DIAGNOSTIC_CANDIDATE_LIMIT` |
| `packages/shared/src/locate/locate.ts` | 完全一致、絞り込み、担当判定 | `LocateFailureReason`、`LocateResult`、`locateQuote` |
| `packages/shared/src/index.ts` | 再エクスポート | 上記 |
| `packages/shared/src/locate/*.test.ts`、`text/grapheme-index.test.ts`（追記） | テスト | |

## 設計上の決定

仕様とロードマップで固定されていない点。仕様の字義から導けるものは根拠の節を、導けないものは
「解釈で迷った点」で代替案とともに記録する。

1. **照合 → 絞り込み → 担当判定 の順。** 入力範囲（`inputRange`）全体で完全一致を集め、複数あれば段落 ID と
   前後の引用で 1 件に絞り、最後に「開始位置が `target.range` 内か」で担当を決める。ヒントが参考文脈側の出現を
   指していれば `outside-target` になる（表 A6）。根拠：仕様 6.3「参考文脈を含む要求の入力全体を対象に照合」と
   ロードマップの注記。代替案は「解釈で迷った点」。
2. **一致は書記素境界で始まり終わるものだけを数える。** `indexOf` の一致でも、開始か終了が書記素クラスタの途中
   （サロゲートペアの片方、結合文字の前）なら捨てる。根拠：11 節 7 項、6.3「強調位置がずれないよう検証する」。
   診断候補にも同じ規則を適用し、揃わなければ `range: null` にする（決定 10）。
3. **重なる出現も数える。** `あああ` に対する `ああ` は 0 と 1 の 2 件で `ambiguous`（表 G1）。
4. **空の引用は `not-found`、診断はしない。** 空文字列はどの位置にも一致するので、一致として扱わない。
   PR4 のスキーマで `quote` を 1 文字以上にして、通常はここまで来ない。
5. **絞り込みは 段落 ID → before → after の順に、残りが 1 件になるまで適用する。**
   各フィルタは「適用すると残りが 0 件になる」場合は適用しない（緩い適用）。ヒントが空（改行を除いて空）なら
   そのフィルタは無い。1 件になった時点で残りのフィルタは見ない（表 A13）。段落 ID が入力に無い番号でも、
   それだけでは失敗にしない（表 A3）。仕様 6.3「段落 ID と前後の引用で特定する」の解釈。代替案は
   「解釈で迷った点」。
6. **before / after の比較は CR と LF を両側から除いてから行う。** `before` は一致の直前（入力範囲の始端から
   一致の開始まで）の文字列が `before` で終わるか、`after` は一致の直後から入力範囲の終端までが `after` で
   始まるかを見る。比較対象は入力範囲内に限る。改行の除去はヒントの比較にだけ適用し、引用本体の照合には
   一切適用しない（引用は完全一致）。根拠：ロードマップの試験項目「`before` / `after` が改行を省く応答」。
7. **結果の形。** `located` は `range` だけ。`failed` は `reason`、絞り込み後に残った完全一致 `exactMatches`、
   `diagnostic`（`not-found` のときだけ非 null。`ambiguous` / `outside-target` / 空引用では null）。
   `exactMatches` は仕様 6.3「対象外候補は…診断用に記録する」「失敗理由（該当なし・複数該当など）を保存」の
   ための材料で、`ambiguous` なら 2 件以上、`outside-target` なら 1 件以上、`not-found` なら 0 件。
8. **2 件以上残ったときの理由。** 残った候補の開始位置がすべて `target.range` 外なら `outside-target`
   （この検査対象の担当ではない。表 B3）、1 件でも内側にあれば `ambiguous`（表 A5）。
9. **診断は完全一致 0 件のときだけ、newline → nfc → newline+nfc の順で 3 変換を試す。** 比較用文字列も引用も
   変わらない変換は飛ばす（例：改行を含まない入力に対する newline）。根拠：仕様 6.3「完全一致失敗時のみ」。
   `ambiguous` では診断変換をしない（仕様の字義どおり。「解釈で迷った点」）。
10. **位置対応は書記素クラスタ単位。** 入力範囲を書記素クラスタごとに変換し（newline：クラスタ `\r\n` と `\r` を
    `\n` に、nfc：クラスタごとに `normalize("NFC")`）、内容が変わったクラスタだけを「変換チャンク」として
    原文範囲 ⇄ 出力範囲を記録する。変わらないクラスタは 1:1 で対応する。比較用文字列上の位置は、変換チャンクの
    内部にあれば対応不能、境界か無変換部分なら原文位置に写せる。一致の両端が写せて、かつ原文側で書記素境界なら
    `range` を付け、そうでなければ `range: null` にする。`text` は一致を覆う最小の書記素境界範囲の原文
    （`range` があればその範囲の原文と同じ）。NFC の合成は結合文字列の内部で起きるため書記素クラスタをまたがない
    という前提に立つ。前提はテストで「クラスタごとの NFC の連結 = 全文の NFC」を確認する。
11. **変換チャンクと重ならない一致は診断候補にしない。** そのような一致は原文にもそのまま存在した
    （書記素境界で捨てた）ものであり、「変換後の一致候補」ではない。候補の `transform` が実際に関与した変換を
    指すようにする（表 C4、C5）。
12. **重複除去。** 同じ覆い範囲の候補は最初に見つけた変換だけを残す（newline で見つかる候補は newline+nfc でも
    見つかる）。
13. **近さと打ち切り。** 近さは候補の覆い範囲の開始位置が属する段落 ID と `ref.paragraphId` の差の絶対値
    （段落 ID は出現順の連番なので段落数の差）。同距離は位置順。`ref.paragraphId` が段落に無ければ全候補を
    距離 0 とみなし位置順。保存は先頭 3 件（`DIAGNOSTIC_CANDIDATE_LIMIT`）、`omitted` は見つけた件数 − 保存数、
    `tied` は最良距離を共有する候補が 2 件以上あるか（表 E、F）。根拠：仕様 6.3「指定段落に近い候補を最大 3 件」
    「同順位の候補があることや打ち切り件数も残し」。
14. **`GraphemeIndex` は呼び出しごとに本文全体から作る。** PR2 決定 13 と同じ。指摘 1 件ごとに O(本文長) の
    分割が走るが、LLM の応答待ちに比べれば小さい。実測で問題になれば index を渡せる引数を足す（今は足さない）。
15. **`transformVersion` は `DIAGNOSTIC_TRANSFORM_VERSION`（`"1"`）。** 変換の種類や位置対応の規則を変えたら上げる。

## 解釈で迷った点（PR 本文にも列挙する）

- **照合と担当判定の順序（決定 1）。** 仕様 6.3 は「入力全体で照合」「開始位置が検査対象内の候補だけ採用」
  「複数なら段落 ID と前後の引用で特定」を並べていて、順序を明示していない。本計画は「入力全体で照合 → ヒントで
  1 件に絞る → 担当判定」。代替案は「検査対象内から始まる一致だけに絞ってからヒントで特定し、対象内に一致が
  なければ `outside-target`」。代替案では、引用が検査対象と参考文脈に 1 回ずつありヒントが文脈側を指す場合に
  対象側の出現へ確定してしまい、担当範囲が自身の文脈付きで検出するという 6.3 の前提と食い違う。表 A6 がこの
  判別例。
- **ヒントの緩い適用（決定 5）。** 仕様 6.2 の「前後の引用の不備だけを理由に失敗にしない」は一意な場合の規定で、
  複数一致でヒントが全候補と矛盾する場合の扱いは書かれていない。本計画は矛盾するフィルタを飛ばす（表 A9 は
  それでも 2 件残るので `ambiguous`）。代替案は矛盾したら即 `ambiguous`。誤った位置に確定する危険と、
  ヒントの軽微な崩れで失敗が増える不便のどちらを取るかの判断で、モデル出力の観察で見直す前提。
- **before / after の改行無視（決定 6）。** 引用の完全一致は崩さず、ヒントの比較だけを緩める。段落境界に接する
  引用でモデルが改行を省くことが多いという想定に基づく。
- **`ambiguous` で診断変換をしない（決定 9）。** 仕様 6.3 は「完全一致失敗時のみ」診断する。複数該当は完全一致は
  成功しているので字義どおり診断しない。代わりに `exactMatches` を残す。
- **ロードマップの型の変更。** `Diagnostic.truncated: boolean` を仕様 6.3 の「打ち切り件数」に合わせて
  `omitted: number` にする。`failed` に `exactMatches` を足し、`diagnostic` を `Diagnostic | null` にする。
  ロードマップの共通語彙を同じ PR で更新する。
- **位置対応の実機検証。** 仕様 13 節の「診断用比較の候補取得方法と位置対応の検証」は、本 PR で第 1 版を作る
  だけで、実モデルの出力に対する検証は未決のまま残す。

## テスト

一覧は付録の英語スペックが正本。分類だけ書く。

- `grapheme-index`（追記）：`floorGraphemeBoundary` / `ceilGraphemeBoundary` が境界ではそのまま、途中の位置は
  前後の境界へ、範囲外は `RangeError`
- `position-map`：3 変換それぞれの比較用文字列と変換チャンク、全位置の対応表（`mapToSource`）、対応不能の
  `null`、覆い範囲（`coverSource`）、`applyTransform` の CRLF・単独 CR・NFC、クラスタごとの NFC の連結が全文の
  NFC と一致すること、範囲が書記素境界でなければ `RangeError`
- `locate`（表 A〜G）：段落 ID で絞る、段落 0 を指して `outside-target`、段落 ID 不在で `after` で絞る、
  同段落 2 件で `ambiguous`、混在 3 件で `ambiguous`、ヒントが文脈側を指す判別例、`before` / `after` が改行を
  省く、`before` が全候補と矛盾、一意ならヒント不備でも確定、対象から文脈へ続く、文脈から始まり対象へ続く、
  段落で 1 件に絞れたら `before` を見ない、空引用、存在しない引用、入力範囲外の一致を数えない、文脈側 2 件、
  全候補が対象外、入力末で `after` 空、本文先頭のサロゲートペア、本文末、CRLF と結合文字を含む完全一致、
  サロゲート途中と結合文字途中の一致を捨てる、NFC でのみ一致、改行統一でのみ一致、両方でのみ一致、
  どの変換でも一致なし、位置対応不能、近い順と打ち切り、段落不在で位置順と同順位、同順位 2 件、重なる出現
- ランダム検査：シード固定の乱数で作った本文（CRLF・LF・ZWJ 絵文字・結合文字・サロゲートペア・句点・括弧の
  混在）を `planTargets` / `buildCheckInput` で分割し、各検査対象から書記素境界で切った部分文字列を引用、
  入力範囲内の前後全部をヒント、開始位置の段落を段落 ID にして `locateQuote` を呼ぶ。結果は「その範囲に
  `located`」か「`ambiguous` で `exactMatches` にその範囲を含む」のどちらか。`located` の範囲は原文の切り出しが
  引用と一致し、両端が書記素境界で、開始が検査対象内。例外を投げない
- 付録の期待値はすべて、計画のアルゴリズムを別に書いた参照実装（scratch）で検算済み。参照実装は書記素境界の
  判定と決定 10 のクラスタ単位 NFC を含む。ランダム検査の性質も参照実装で 2,920 例確認した

## 進め方（コミット単位）

1. **計画とブランチ**（このコミット）：本書を追加。
2. **実装とテスト**（qwen に委譲、Claude が検証）：付録のスペックを標準入力から渡す。1 回目は依存の無い
   `quote-ref`・`grapheme-index` の追記・`position-map`、2 回目は `diagnostic`・`locate`・`index.ts`。
   1 回目の出力を検証してから 2 回目を渡す。渡す前に、抽出したスペックに生の U+200D・U+0301・U+3099・CR が
   含まれないことを `grep -P` で確認する。
3. **検証**（Claude）：全ファイルを読む。特に、絞り込みの順序と緩い適用、担当判定の不等号（`start <= m.start < end`）、
   書記素境界の判定、変換チャンクの内部判定、重複除去、距離と `tied` の定義を表と突き合わせる。テストの期待値が
   付録の表と一致していることを 1 行ずつ確認する。`pnpm check` を自分でも実行する。
4. **ドキュメント**（Claude）：ロードマップの共通語彙（`Diagnostic`、`DiagnosticCandidate`、`LocateResult` の形、
   `locate/position-map.ts` の公開名）と PR3 節の提供一覧、PR4 の `UnlocatedCandidate` の `locate` の形を更新。
   README の状態、`docs/decisions/0002` の検証状況、`docs/guides/windows-verification.md` の手順 3 にテスト内容を追記。
5. **PR 作成**：解釈で迷った点、Windows の確認状況（CI で確認、ローカルは未確認）を書く。

## 付録 1：qwen へのスペック（1 回目。英語）

````text
# Task 1 of 2: QuoteRef, grapheme boundary rounding, comparison text with position map (packages/shared, TypeScript)

You are working in a pnpm monorepo. Only touch these files:

- packages/shared/src/locate/quote-ref.ts (create)
- packages/shared/src/text/grapheme-index.ts (modify: add two functions; keep everything that exists)
- packages/shared/src/text/grapheme-index.test.ts (modify: add tests; keep existing tests)
- packages/shared/src/locate/position-map.ts (create)
- packages/shared/src/locate/position-map.test.ts (create)

Do NOT touch any other file. Do NOT modify packages/shared/src/index.ts in this task. Do NOT install
dependencies. Do NOT modify any Markdown file.

## Project rules (MUST)

- Relative imports MUST end with ".ts". Node runs the TypeScript source directly.
- TypeScript: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`. MUST NOT use `enum`, `namespace`, constructor parameter properties.
  Use `import type` for type-only imports. Use `readonly` on all interface fields.
- Code comments MUST be Japanese. Identifiers MUST be English. Test names (`describe` / `it`) MUST be Japanese.
- `array[i]` has type `T | undefined`. Read elements with `?.` or compare whole arrays with `toEqual`.
  MUST NOT use the non-null assertion `!`. Use `charCodeAt` / `codePointAt`, never `text[i]`.
- In test source, write CR, LF, U+200D, variation selectors, combining marks (U+3099, U+0301) and every
  surrogate pair as escapes (`\r`, `\n`, `\u200D`, `\u{E0100}`, `\u3099`, `\u0301`, `\u{20BB7}`).
  MUST NOT paste raw control characters, raw combining marks, raw ZWJ or raw emoji into string literals.
  Plain Japanese text (hiragana, kanji, 。！？「」, U+3000 full-width space) may be written raw.
  The precomposed character が (U+304C) is plain text and may be written raw; the decomposed form MUST be
  written `か\u3099`.
- MUST NOT change any expected value in the tables below. A failing table row means the implementation is wrong,
  not the table. If you believe a table value is wrong, stop and report it instead of editing the expectation.
- Biome decides formatting and import order. Fix with `pnpm exec biome check --write .`, never by hand.
- Existing code you MUST reuse (read these files first):
  - `packages/shared/src/text/range.ts`: `Range { readonly start: number; readonly end: number }`, `sliceRange(text, range)`.
  - `packages/shared/src/text/grapheme-index.ts`: `GraphemeIndex { readonly boundaries: readonly number[]; readonly count: number }`
    (`boundaries[k]` is the UTF-16 offset where grapheme cluster k starts; `boundaries[count] === text.length`),
    `buildGraphemeIndex(text)`, `isGraphemeBoundary(index, offset)`, `graphemeAt(index, offset)` (RangeError if not a
    boundary), `offsetAt(index, grapheme)`. There is a private binary search `searchBoundary`; reuse or extend it.

## 1. packages/shared/src/locate/quote-ref.ts

```ts
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
```

Nothing else in this file.

## 2. Additions to packages/shared/src/text/grapheme-index.ts

Add two exported functions. Keep all existing exports unchanged.

```ts
/** offset 以下で最大の書記素境界を返す。offset が境界ならそのまま。範囲外（0 未満、text.length 超）は RangeError。 */
export function floorGraphemeBoundary(index: GraphemeIndex, offset: number): number
/** offset 以上で最小の書記素境界を返す。offset が境界ならそのまま。範囲外は RangeError。 */
export function ceilGraphemeBoundary(index: GraphemeIndex, offset: number): number
```

Use binary search over `index.boundaries` (they are sorted ascending, first is 0, last is text.length).
`offset` MUST be a safe integer with `0 <= offset <= boundaries[count]`; otherwise throw
`new RangeError(`位置が範囲外です: ${offset}`)`.

### Tests to add to grapheme-index.test.ts

Text: `"\u{20BB7}か\u3099\r\nx"` — boundaries `[0, 2, 4, 6, 7]` (𠮷 = 2 units, か+U+3099 = 2 units, CRLF = 2 units, x).

| offset | floor | ceil |
| --- | --- | --- |
| 0 | 0 | 0 |
| 1 | 0 | 2 |
| 2 | 2 | 2 |
| 3 | 2 | 4 |
| 5 | 4 | 6 |
| 6 | 6 | 6 |
| 7 | 7 | 7 |

`floorGraphemeBoundary(index, -1)`, `ceilGraphemeBoundary(index, 8)`, and a non-integer offset `1.5` MUST throw `RangeError`.

## 3. packages/shared/src/locate/position-map.ts

Purpose: build a comparison-only copy of a range of the text under a diagnostic transform, and map offsets in
the comparison string back to the original text. The original text is never modified (invariant).

```ts
import type { GraphemeIndex } from "../text/grapheme-index.ts";
import type { Range } from "../text/range.ts";

/** 診断用の比較変換。仕様書 6.3 の初期対象は改行統一と NFC の 2 種とその組み合わせだけ。 */
export type DiagnosticTransform = "newline" | "nfc" | "newline+nfc";

/** 変換で内容が変わった書記素クラスタ 1 個の、原文側と比較用文字列側の範囲。 */
export interface TransformedChunk {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly outputStart: number;
  readonly outputEnd: number;
}

/** 比較用文字列と、原文への位置対応。 */
export interface ComparisonText {
  readonly transform: DiagnosticTransform;
  /** 変換元の原文範囲。 */
  readonly source: Range;
  /** 比較用文字列。 */
  readonly text: string;
  /** 変換チャンク。outputStart の昇順。変換で変わらなかった部分は 1:1 対応なので記録しない。 */
  readonly chunks: readonly TransformedChunk[];
}

/** 文字列全体に変換を適用する（引用側に使う）。 */
export function applyTransform(text: string, transform: DiagnosticTransform): string

/**
 * range（両端とも書記素境界。そうでなければ RangeError）を書記素クラスタごとに変換して比較用文字列を作る。
 * クラスタごとに applyTransform を適用し、結果がクラスタと異なるものだけを TransformedChunk として記録する。
 */
export function buildComparisonText(text: string, range: Range, index: GraphemeIndex, transform: DiagnosticTransform): ComparisonText

/**
 * 比較用文字列上の位置を原文の位置に写す。
 * 変換チャンクの外（1:1 の部分）とチャンクの両端は写せる。チャンクの内部は対応不能で null。
 */
export function mapToSource(comparison: ComparisonText, offset: number): number | null

/**
 * 比較用文字列上の範囲 [start, end) を覆う最小の原文範囲を、書記素境界に丸めて返す。
 * 端がチャンク内部ならそのチャンクの原文範囲まで広げる。端が写せるなら floor / ceil で境界に丸める。
 */
export function coverSource(comparison: ComparisonText, index: GraphemeIndex, start: number, end: number): Range

/** 比較用文字列上の範囲 [start, end) が変換チャンクの少なくとも 1 つと重なるか。 */
export function overlapsTransformedChunk(comparison: ComparisonText, start: number, end: number): boolean
```

### applyTransform

- `"newline"`: replace every `"\r\n"` and every lone `"\r"` with `"\n"` (`text.replace(/\r\n|\r/g, "\n")`).
- `"nfc"`: `text.normalize("NFC")`.
- `"newline+nfc"`: newline first, then NFC.

### buildComparisonText

1. `from = graphemeAt(index, range.start)`, `to = graphemeAt(index, range.end)` (both throw RangeError when not a boundary).
2. For each cluster k in `[from, to)`: `cluster = text.slice(boundaries[k], boundaries[k+1])`, `piece = applyTransform(cluster, transform)`.
   If `piece !== cluster`, push `{ sourceStart: boundaries[k], sourceEnd: boundaries[k+1], outputStart: out.length, outputEnd: out.length + piece.length }`.
   Append `piece` to `out`.
3. Return `{ transform, source: range, text: out, chunks }`.

Note: CRLF is a single grapheme cluster, so the newline transform of the cluster `"\r\n"` is `"\n"` (one chunk, output length 1).
A lone `"\r"` is also a single cluster and becomes `"\n"` (a chunk whose output length equals its source length).

### mapToSource

Let `c` be the chunk with the largest `outputStart <= offset` (binary search; `null` if none).

- No such chunk: return `comparison.source.start + offset`.
- `offset === c.outputStart`: return `c.sourceStart`.
- `offset >= c.outputEnd`: return `c.sourceEnd + (offset - c.outputEnd)`.
- Otherwise (strictly inside the chunk): return `null`.

`offset` MUST satisfy `0 <= offset <= comparison.text.length`; otherwise throw RangeError.

### coverSource

- Start: `s = mapToSource(comparison, start)`. If `s === null`, use the containing chunk's `sourceStart`; else `floorGraphemeBoundary(index, s)`.
- End: `e = mapToSource(comparison, end)`. If `e === null`, use the containing chunk's `sourceEnd`; else `ceilGraphemeBoundary(index, e)`.
- Return `{ start, end }`.

### overlapsTransformedChunk

Return `true` if any chunk satisfies `chunk.outputStart < end && start < chunk.outputEnd`.

### Tests (position-map.test.ts)

Text C = `"\u{20BB7}野家。\r\nか\u3099き\n終わり"` (length 14). Grapheme boundaries `[0,2,3,4,5,7,9,10,11,12,13,14]`.
Range = `{ start: 0, end: 14 }`.

| transform | comparison text | chunks |
| --- | --- | --- |
| newline | `"\u{20BB7}野家。\nか\u3099き\n終わり"` | `[{sourceStart:5, sourceEnd:7, outputStart:5, outputEnd:6}]` |
| nfc | `"\u{20BB7}野家。\r\nがき\n終わり"` | `[{sourceStart:7, sourceEnd:9, outputStart:7, outputEnd:8}]` |
| newline+nfc | `"\u{20BB7}野家。\nがき\n終わり"` | `[{sourceStart:5, sourceEnd:7, outputStart:5, outputEnd:6}, {sourceStart:7, sourceEnd:9, outputStart:6, outputEnd:7}]` |

`mapToSource` for every offset `0..text.length` of the comparison text (as one array, compare with `toEqual`):

| transform | mapped offsets |
| --- | --- |
| newline | `[0,1,2,3,4,5,7,8,9,10,11,12,13,14]` |
| nfc | `[0,1,2,3,4,5,6,7,9,10,11,12,13,14]` |
| newline+nfc | `[0,1,2,3,4,5,7,9,10,11,12,13,14]` |

Text D = `"か\u3099\u0301る"` (length 4; boundaries `[0,3,4]`; the cluster か+U+3099+U+0301 normalizes to `"が\u0301"`, 2 units).
Transform nfc, range `{ start: 0, end: 4 }`:

- comparison text `"が\u0301る"`, chunks `[{sourceStart:0, sourceEnd:3, outputStart:0, outputEnd:2}]`
- `mapToSource` for offsets `0,1,2,3` → `0, null, 3, 4`
- `coverSource(cmp, index, 0, 1)` → `{ start: 0, end: 3 }` (end is inside the chunk → chunk's sourceEnd)
- `coverSource(cmp, index, 2, 3)` → `{ start: 3, end: 4 }`
- `overlapsTransformedChunk(cmp, 0, 1)` → true; `overlapsTransformedChunk(cmp, 2, 3)` → false

Additional tests:

- `applyTransform("a\r\nb\rc\n", "newline")` → `"a\nb\nc\n"`; `applyTransform("か\u3099", "nfc")` → `"が"`;
  `applyTransform("か\u3099\r\n", "newline+nfc")` → `"が\n"`; `applyTransform("が", "nfc")` → `"が"` (unchanged).
- Per-cluster NFC equals whole-string NFC: for each of the texts C, D, `"か\u3099一\nか\u3099二\nか\u3099三\nか\u3099四"`,
  `"か\u3099一\n二\nか\u3099三"`, `"\u{1F468}\u200D\u{1F469}e\u0301\u{20BB7}\r\n"`, assert
  `buildComparisonText(t, {start:0, end:t.length}, buildGraphemeIndex(t), "nfc").text === t.normalize("NFC")`.
- Identity: for text C with transform `"newline"` on the range `{ start: 7, end: 14 }` (the only newline inside is a lone LF at offset 10, which
  the newline transform leaves unchanged), the comparison text equals `sliceRange(C, range)` and `chunks` is `[]`;
  `mapToSource(cmp, 3)` → `10`.
- `buildComparisonText(C, { start: 1, end: 14 }, index, "nfc")` MUST throw `RangeError` (1 is inside the surrogate pair).
- `mapToSource(cmp, -1)` and `mapToSource(cmp, cmp.text.length + 1)` MUST throw `RangeError`.

## Hazards to avoid

- Do not normalize or alter the original `text`. Only the returned comparison string is transformed.
- Do not apply the transform to the whole range at once; apply it cluster by cluster so that chunks are recorded.
- `offset >= c.outputEnd` also covers `offset === c.outputEnd` (maps to `c.sourceEnd`). Keep that order of checks.
- Keep all existing tests in grapheme-index.test.ts passing.

## Self-correction (MANDATORY — run before finishing)

1. `pnpm exec biome check --write .` then `pnpm check` from the repository root. Fix any failure in the implementation.
2. Re-read the tables above and confirm every expected value in your tests is exactly as written here.
3. Confirm no raw CR, LF, U+200D, U+3099, U+0301 or surrogate characters exist inside string literals of the test files.
````

## 付録 2：qwen へのスペック（2 回目。英語）

````text
# Task 2 of 2: diagnostics and quote location (packages/shared, TypeScript)

You are working in a pnpm monorepo. Task 1 (quote-ref.ts, position-map.ts, grapheme-index additions) is done and
verified. Only touch these files:

- packages/shared/src/locate/diagnostic.ts (create)
- packages/shared/src/locate/locate.ts (create)
- packages/shared/src/locate/locate.test.ts (create)
- packages/shared/src/index.ts (modify: add re-exports; keep all existing exports)

Do NOT touch any other file. Do NOT install dependencies. Do NOT modify any Markdown file.

## Project rules (MUST)

(Same as Task 1.) Relative imports end with ".ts". `erasableSyntaxOnly`, `verbatimModuleSyntax`, `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; no `enum` / `namespace` / parameter properties; `import type`
for types; `readonly` on interface fields. Comments and test names Japanese, identifiers English. No `!` non-null
assertion; use `?.` or `toEqual` on whole values. In test source, CR, LF, U+200D, U+3099, U+0301 and surrogate pairs
MUST be escapes (`\r`, `\n`, `\u200D`, `\u3099`, `\u0301`, `\u{20BB7}`); precomposed が (U+304C) may be raw, the
decomposed form MUST be `か\u3099`. MUST NOT change any expected value in the tables below; a failing row means the
implementation is wrong. Formatting: `pnpm exec biome check --write .`.

Existing code you MUST reuse (read these files first):

- `text/range.ts`: `Range`, `sliceRange`.
- `text/paragraph.ts`: `Paragraph { readonly id: number; readonly range: Range }`, `splitParagraphs(text)`.
- `text/grapheme-index.ts`: `GraphemeIndex`, `buildGraphemeIndex`, `isGraphemeBoundary`, `floorGraphemeBoundary`, `ceilGraphemeBoundary`.
- `chunk/plan.ts`: `TargetRange`, `CheckInput { readonly target: TargetRange; readonly context: ContextWindow; readonly inputRange: Range }`,
  `planTargets`, `buildCheckInput`. `chunk/settings.ts`: `ChunkSettings`.
- `locate/quote-ref.ts`: `QuoteRef { paragraphId; quote; before; after }`.
- `locate/position-map.ts`: `DiagnosticTransform`, `ComparisonText`, `applyTransform`, `buildComparisonText`, `mapToSource`,
  `coverSource`, `overlapsTransformedChunk`.
- `versions.ts`: `DIAGNOSTIC_TRANSFORM_VERSION`.

## Invariants (MUST / MUST NOT)

- The original text MUST NOT be modified or normalized. Only comparison strings from `buildComparisonText` are transformed.
- A quote is located ONLY by exact match (`String.prototype.indexOf` on the original text). Diagnostic candidates
  MUST NOT be returned as `located`.
- A located range MUST start and end on grapheme cluster boundaries of the original text.
- Only matches whose START lies inside `input.target.range` (`start <= m.start && m.start < end`) may be `located`.
- The empty quote MUST NOT match anything.

## 1. packages/shared/src/locate/diagnostic.ts

```ts
/** 位置特定失敗の診断候補 1 件。原文は変更しない。range は原文側の範囲で、位置対応が取れなければ null。 */
export interface DiagnosticCandidate {
  readonly transform: DiagnosticTransform;
  /** 一致を覆う最小の書記素境界範囲の原文。range があればその範囲の原文と同じ。 */
  readonly text: string;
  readonly range: Range | null;
}

/** 位置特定失敗の診断。強調・再確認・採用位置には使わない（仕様書 6.3）。 */
export interface Diagnostic {
  /** 変換規則の版（DIAGNOSTIC_TRANSFORM_VERSION）。 */
  readonly transformVersion: string;
  /** 指定段落に近い順、最大 DIAGNOSTIC_CANDIDATE_LIMIT 件。 */
  readonly candidates: readonly DiagnosticCandidate[];
  /** 見つけたが保存しなかった候補の数。 */
  readonly omitted: number;
  /** 最良の近さを 2 件以上の候補が共有しているか。一意な一致と誤認させないための印。 */
  readonly tied: boolean;
}

export const DIAGNOSTIC_CANDIDATE_LIMIT = 3;

/** 完全一致が 0 件のときだけ呼ぶ。inputRange 内で 3 変換の比較を行い、候補を近い順に返す。 */
export function diagnoseQuote(
  text: string,
  inputRange: Range,
  paragraphs: readonly Paragraph[],
  ref: QuoteRef,
  index: GraphemeIndex,
): Diagnostic
```

Algorithm of `diagnoseQuote`:

1. `slice = sliceRange(text, inputRange)`. `refExists = paragraphs.some(p => p.id === ref.paragraphId)`.
2. For each transform in this exact order: `"newline"`, `"nfc"`, `"newline+nfc"`:
   a. `cmp = buildComparisonText(text, inputRange, index, transform)`; `q = applyTransform(ref.quote, transform)`.
   b. If `cmp.text === slice && q === ref.quote`, skip this transform (it changes nothing).
   c. Find every occurrence of `q` in `cmp.text` including overlapping ones: `p = cmp.text.indexOf(q, from)` with `from = p + 1` after each hit.
      For each hit `[s, e)` with `e = s + q.length`:
      - If `!overlapsTransformedChunk(cmp, s, e)`, skip it (such a match existed in the original text too and was rejected for
        not being on grapheme boundaries; it is not a "match after transformation").
      - `cover = coverSource(cmp, index, s, e)`; key `${cover.start}:${cover.end}`; if the key was already collected, skip
        (dedup: the earliest transform wins).
      - `ms = mapToSource(cmp, s)`, `me = mapToSource(cmp, e)`. `range = (ms !== null && me !== null && isGraphemeBoundary(index, ms) && isGraphemeBoundary(index, me)) ? { start: ms, end: me } : null`.
      - `paragraphId` = id of the paragraph whose range contains `cover.start` (`p.range.start <= cover.start && cover.start < p.range.end`).
        `distance = refExists ? Math.abs(paragraphId - ref.paragraphId) : 0`.
      - Collect `{ transform, text: sliceRange(text, cover), range, cover, distance }`.
3. Sort collected candidates by `distance` ascending, then `cover.start` ascending, then `cover.end` ascending.
4. `tied = collected.length >= 2 && (number of candidates whose distance equals the first candidate's distance) >= 2`.
5. `candidates = first DIAGNOSTIC_CANDIDATE_LIMIT entries` projected to `{ transform, text, range }`; `omitted = collected.length - candidates.length`.
6. Return `{ transformVersion: DIAGNOSTIC_TRANSFORM_VERSION, candidates, omitted, tied }`.

## 2. packages/shared/src/locate/locate.ts

```ts
/** 位置特定失敗の理由。not-found / ambiguous は一覧に表示する失敗、outside-target は診断記録にだけ残す。 */
export type LocateFailureReason = "not-found" | "ambiguous" | "outside-target";

export type LocateResult =
  | { readonly status: "located"; readonly range: Range }
  | {
      readonly status: "failed";
      readonly reason: LocateFailureReason;
      /** 絞り込み後に残った完全一致。not-found では空。 */
      readonly exactMatches: readonly Range[];
      /** 診断。not-found（空引用を除く）のときだけ非 null。 */
      readonly diagnostic: Diagnostic | null;
    };

/**
 * 引用を原文の位置に確定する（仕様書 6.3）。
 * inputRange 全体で完全一致を集め、複数なら段落 ID・before・after で 1 件に絞り、開始位置が target.range 内なら採用する。
 */
export function locateQuote(
  text: string,
  input: CheckInput,
  paragraphs: readonly Paragraph[],
  ref: QuoteRef,
): LocateResult
```

Algorithm of `locateQuote`:

1. `index = buildGraphemeIndex(text)`. `ir = input.inputRange`, `tr = input.target.range`.
2. If `ref.quote === ""`: return `{ status: "failed", reason: "not-found", exactMatches: [], diagnostic: null }`.
3. Collect exact matches: `p = text.indexOf(ref.quote, ir.start)`; while `p >= 0 && p + quote.length <= ir.end`: record `p`, then
   `p = text.indexOf(ref.quote, p + 1)` (overlapping occurrences count). Keep only matches with
   `isGraphemeBoundary(index, p) && isGraphemeBoundary(index, p + quote.length)`. Each kept match is `{ start: p, end: p + quote.length }`.
4. If no match: return `{ status: "failed", reason: "not-found", exactMatches: [], diagnostic: diagnoseQuote(text, ir, paragraphs, ref, index) }`.
5. Narrowing (only while `matches.length >= 2`). Let `strip = (s) => s.replace(/\r|\n/g, "")`, `before = strip(ref.before)`, `after = strip(ref.after)`.
   Apply these filters in order; for each filter: if `matches.length === 1` stop; if the filter is absent skip it;
   `kept = matches.filter(pred)`; if `kept.length >= 1` then `matches = kept` (otherwise leave `matches` unchanged).
   - paragraph filter: `pred(m)` = the paragraph containing `m.start` has `id === ref.paragraphId`.
   - before filter (absent when `before === ""`): `pred(m)` = `strip(text.slice(ir.start, m.start)).endsWith(before)`.
   - after filter (absent when `after === ""`): `pred(m)` = `strip(text.slice(m.end, ir.end)).startsWith(after)`.
6. `inTarget(m)` = `tr.start <= m.start && m.start < tr.end`.
   - If `matches.length === 1`: `m = matches[0]`; if `inTarget(m)` return `{ status: "located", range: m }`;
     else return `{ status: "failed", reason: "outside-target", exactMatches: [m], diagnostic: null }`.
   - Else: `reason = matches.some(inTarget) ? "ambiguous" : "outside-target"`;
     return `{ status: "failed", reason, exactMatches: matches, diagnostic: null }`.

Newline stripping applies to the hints (`before` / `after`) and to the text they are compared with ONLY. The quote
itself MUST be matched exactly, with its newlines.

## 3. packages/shared/src/index.ts

Add (Biome will sort):

```ts
export type { Diagnostic, DiagnosticCandidate } from "./locate/diagnostic.ts";
export { DIAGNOSTIC_CANDIDATE_LIMIT } from "./locate/diagnostic.ts";
export type { LocateFailureReason, LocateResult } from "./locate/locate.ts";
export { locateQuote } from "./locate/locate.ts";
export type { DiagnosticTransform } from "./locate/position-map.ts";
export { applyTransform } from "./locate/position-map.ts";
export type { QuoteRef } from "./locate/quote-ref.ts";
export { ceilGraphemeBoundary, floorGraphemeBoundary } from "./text/grapheme-index.ts";
```

(`floorGraphemeBoundary` / `ceilGraphemeBoundary` go into the existing grapheme-index export list.)

## Tests (locate.test.ts)

Build inputs with a helper. `target` and `inputRange` are given directly (they are what PR2 would produce);
`paragraphs = splitParagraphs(text)`; `paragraphIds` = ids of paragraphs overlapping the target;
`context` = `{ before: inputRange.start < target.start ? {start: inputRange.start, end: target.start} : null, after: target.end < inputRange.end ? {start: target.end, end: inputRange.end} : null }`.

```ts
function makeInput(text: string, target: Range, inputRange: Range): { input: CheckInput; paragraphs: Paragraph[] }
```

Use `it.each` over a table array per text. Expected values are written as `LocateResult` objects.
Abbreviation in the tables: `L(s,e)` = `{ status: "located", range: { start: s, end: e } }`;
`F(reason, [[s,e],...], diagnostic)` = `{ status: "failed", reason, exactMatches: [...], diagnostic }`;
`D(candidates, omitted, tied)` = `{ transformVersion: "1", candidates, omitted, tied }`;
`C(transform, text, range | null)` = a `DiagnosticCandidate`.

### Text A = `"彼は言った。\n彼は言った。そして笑った。\n彼は笑った。"` (length 27; paragraphs `[0,7) [7,21) [21,27)`), target `[7,21)`, inputRange `[0,27)`

| id | paragraphId | quote | before | after | expected |
| --- | --- | --- | --- | --- | --- |
| A1 段落で絞る | 1 | `彼は言った。` | `` | `そして` | `L(7,13)` |
| A2 段落 0 を指すので対象外 | 0 | `彼は言った。` | `` | `` | `F("outside-target", [[0,6]], null)` |
| A3 段落 ID 不在、after で絞る | 5 | `彼は言った。` | `` | `そして` | `L(7,13)` |
| A4 同段落 2 件で ambiguous | 1 | `。` | `` | `` | `F("ambiguous", [[12,13],[19,20]], null)` |
| A5 混在 3 件で ambiguous | 5 | `彼は` | `` | `` | `F("ambiguous", [[0,2],[7,9],[21,23]], null)` |
| A6 ヒントが文脈側を指す | 2 | `笑った。` | `彼は` | `` | `F("outside-target", [[23,27]], null)` |
| A7 before が改行を省く | 9 | `彼は言った。` | `彼は言った。` | `` | `L(7,13)` |
| A8 after が改行を省く | 9 | `た。` | `` | `彼は笑った。` | `L(18,20)` |
| A9 before が全候補と矛盾 | 1 | `。` | `ない` | `` | `F("ambiguous", [[12,13],[19,20]], null)` |
| A10 一意ならヒント不備でも確定 | 0 | `そして` | `ない` | `ない` | `L(13,16)` |
| A11 対象から文脈へ続く | 1 | `笑った。\n彼は笑った。` | `` | `` | `L(16,27)` |
| A12 文脈から始まり対象へ続く | 0 | `た。\n彼は言った。` | `` | `` | `F("outside-target", [[4,13]], null)` |
| A13 段落で 1 件になれば before は見ない | 1 | `彼は言った。` | `ない` | `` | `L(7,13)` |
| A14 空引用 | 1 | `` | `` | `` | `F("not-found", [], null)` |
| A15 存在しない引用 | 1 | `彼は泣いた。` | `` | `` | `F("not-found", [], D([], 0, false))` |

### Text B = `"一二三四五\n六七八九十\n一二三四五\n六七八九十"` (length 23; paragraphs `[0,6) [6,12) [12,18) [18,23)`), target `[12,18)`, inputRange `[6,23)`

| id | paragraphId | quote | before | after | expected |
| --- | --- | --- | --- | --- | --- |
| B1 入力範囲外の一致は数えない | 2 | `一二三` | `` | `` | `L(12,15)` |
| B2 文脈側 2 件、段落で 1 件、対象外 | 3 | `六七` | `` | `` | `F("outside-target", [[18,20]], null)` |
| B3 全候補が対象外 | 7 | `六七` | `` | `` | `F("outside-target", [[6,8],[18,20]], null)` |
| B4 入力末で after 空 | 2 | `四五` | `一二三` | `` | `L(15,17)` |

### Text C = `"\u{20BB7}野家。\r\nか\u3099き\n終わり"` (length 14; paragraphs `[0,7) [7,11) [11,14)`), target `[0,14)`, inputRange `[0,14)`

| id | paragraphId | quote | before | after | expected |
| --- | --- | --- | --- | --- | --- |
| C1 本文先頭のサロゲートペア | 0 | `\u{20BB7}野` | `` | `家。` | `L(0,3)` |
| C2 本文末 | 2 | `終わり` | `き` | `` | `L(11,14)` |
| C3 CRLF と結合文字を含む完全一致 | 0 | `。\r\nか\u3099` | `` | `` | `L(4,9)` |
| C4 サロゲート途中の一致は捨てる | 0 | `\uD842` | `` | `` | `F("not-found", [], D([], 0, false))` |
| C5 結合文字途中の一致は捨てる | 1 | `か` | `` | `` | `F("not-found", [], D([], 0, false))` |
| C6 NFC でのみ一致 | 1 | `がき` | `` | `` | `F("not-found", [], D([C("nfc", "か\u3099き", [7,10])], 0, false))` |
| C7 改行統一でのみ一致 | 0 | `家。\n` | `` | `` | `F("not-found", [], D([C("newline", "家。\r\n", [3,7])], 0, false))` |
| C8 両方でのみ一致 | 0 | `。\nがき` | `` | `` | `F("not-found", [], D([C("newline+nfc", "。\r\nか\u3099き", [4,10])], 0, false))` |
| C9 どの変換でも一致なし | 0 | `吉野家` | `` | `` | `F("not-found", [], D([], 0, false))` |

### Text D = `"か\u3099\u0301る"` (length 4; one paragraph `[0,4)`), target `[0,4)`, inputRange `[0,4)`

| id | paragraphId | quote | before | after | expected |
| --- | --- | --- | --- | --- | --- |
| D1 位置対応不能 | 0 | `が` | `` | `` | `F("not-found", [], D([C("nfc", "か\u3099\u0301", null)], 0, false))` |

### Text E = `"か\u3099一\nか\u3099二\nか\u3099三\nか\u3099四"` (length 15; paragraphs `[0,4) [4,8) [8,12) [12,15)`), target `[0,15)`, inputRange `[0,15)`

| id | paragraphId | quote | expected |
| --- | --- | --- | --- |
| E1 段落 2 に近い順、打ち切り 1 | 2 | `が` | `F("not-found", [], D([C("nfc","か\u3099",[8,10]), C("nfc","か\u3099",[4,6]), C("nfc","か\u3099",[12,14])], 1, false))` |
| E2 段落不在、位置順、同順位 | 9 | `が` | `F("not-found", [], D([C("nfc","か\u3099",[0,2]), C("nfc","か\u3099",[4,6]), C("nfc","か\u3099",[8,10])], 1, true))` |
| E3 段落 1 | 1 | `が` | `F("not-found", [], D([C("nfc","か\u3099",[4,6]), C("nfc","か\u3099",[0,2]), C("nfc","か\u3099",[8,10])], 1, false))` |

(`before` and `after` are `""` in every row of E, F, G.)

### Text F = `"か\u3099一\n二\nか\u3099三"` (length 9; paragraphs `[0,4) [4,6) [6,9)`), target `[0,9)`, inputRange `[0,9)`

| id | paragraphId | quote | expected |
| --- | --- | --- | --- |
| F1 同順位 2 件 | 1 | `が` | `F("not-found", [], D([C("nfc","か\u3099",[0,2]), C("nfc","か\u3099",[6,8])], 0, true))` |

### Text G = `"あああ"`, target `[0,3)`, inputRange `[0,3)`

| id | paragraphId | quote | expected |
| --- | --- | --- | --- |
| G1 重なる出現 | 0 | `ああ` | `F("ambiguous", [[0,2],[1,3]], null)` |

### Random property test（describe「ランダム検査」）

Seeded PRNG (mulberry32, seed `20260907`), 300 iterations:

```ts
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

Pieces: `["\r\n", "\n", "\u{1F468}\u200D\u{1F469}", "か\u3099", "。", "「", "」", "あ", "い", "彼", "は", "言った", "\u{20BB7}", "　", "え\u0301", "！", "……"]`.
Each iteration: concatenate `1 + Math.floor(random() * 40)` pieces chosen with `Math.floor(random() * pieces.length)`.
Skip the iteration if the text is empty. Settings: `{ targetGraphemes: 10, contextGraphemes: 4, recheckContextGraphemes: 8, roundingTolerance: 0.2, maxInputGraphemes: 100 }`.
`paragraphs = splitParagraphs(text)`; `targets = planTargets(text, paragraphs, settings)`; for each target `input = buildCheckInput(text, paragraphs, target, settings)`;
`index = buildGraphemeIndex(text)`; `ts = graphemeAt(index, target.range.start)`, `te = graphemeAt(index, target.range.end)`, `ie = graphemeAt(index, input.inputRange.end)`;
`qs = ts + Math.floor(random() * (te - ts))`; `qe = qs + 1 + Math.floor(random() * (ie - qs))` (so `qs < qe <= ie`);
`start = offsetAt(index, qs)`, `end = offsetAt(index, qe)`; `quote = text.slice(start, end)`;
`paragraphId` = id of the paragraph containing `start`; `before = text.slice(input.inputRange.start, start)`; `after = text.slice(end, input.inputRange.end)`.
Call `locateQuote(text, input, paragraphs, { paragraphId, quote, before, after })`. Assert:

- it does not throw;
- EITHER `status === "located"` with `range` equal to `{ start, end }`,
  OR `status === "failed"`, `reason === "ambiguous"`, and `exactMatches` contains `{ start, end }` (this only happens when the
  quote is newline-only and the hints become empty after stripping);
- when located: `sliceRange(text, range) === quote`, both `range.start` and `range.end` are grapheme boundaries, and
  `target.range.start <= range.start && range.start < target.range.end`.

## Hazards to avoid

- Match on the ORIGINAL `text` in `locateQuote`, restricted to `inputRange` by the `p + quote.length <= ir.end` condition.
  Do not slice the text first and forget to add `ir.start` back to positions.
- Filters are "soft": a filter that would leave zero matches is skipped, not applied. But a filter that leaves exactly one
  match ends the narrowing. Do not continue filtering after one match remains.
- Hint stripping removes CR and LF only. Do not trim spaces, do not touch U+3000, do not normalize.
- Diagnostics run only when there are zero exact matches. `ambiguous` and `outside-target` have `diagnostic: null`.
- Transform order and dedup order are `newline`, `nfc`, `newline+nfc`. Keep candidates from earlier transforms.
- The `tied` flag is about the best distance only.

## Self-correction (MANDATORY — run before finishing)

1. `pnpm exec biome check --write .` then `pnpm check` from the repository root. Fix failures in the implementation, never in the tables.
2. Re-read every table row and confirm the test expectation is exactly as written here.
3. Confirm no raw CR, LF, U+200D, U+3099, U+0301 or surrogate characters exist inside string literals of the test file.
````
