# PR1 詳細計画：原稿の取り込みと段落モデル

日付：2026-09-07  
状態：計画（レビュー待ち）  
ブランチ：`feat/pr1-ingest-paragraph`  
上位計画：`docs/plans/2026-09-07-mvp-roadmap.md` の PR1 節

## 目標

`packages/shared` に、原稿の取り込み（UTF-8 の厳密デコードと BOM 除外）と段落モデル（改行列で区切られた行の
`[start, end)` 範囲）を実装し、PR2 以降が依存する型と関数を固定する。

対応する仕様：5.1（入力）、6.1（段落の定義と位置の基準）、9（位置対応の保持）。
受け入れ条件：11 節 7 項のうち「CRLF を含む原稿で位置がずれない」。

## 全体の制約（`docs/reference/invariants.md` から）

- 保存本文はファイル先頭の BOM を除外する以外、一切加工しない。正規化・空白除去・改行の統一を行わない。
- 位置は BOM 除外後の保存本文上の UTF-16 コード単位。範囲は `[start, end)`。
- 段落は CRLF・LF・CR のいずれか 1 つで区切られた行。CRLF は 1 つの区切り。空行も段落。区切りの改行列は直前の段落範囲に含める。
- 段落 ID は原稿版内で出現順に固定する。
- 読み込み不能な入力は文字コードの問題として扱い、黙って置換しない。
- 相対 import は `.ts` 拡張子付き。`erasableSyntaxOnly`（パラメータプロパティ不可）。公開関数は `src/index.ts` から再エクスポート。

## 作るもの

| ファイル | 責務 | 公開する名前 |
| --- | --- | --- |
| `packages/shared/src/text/range.ts` | 範囲型と、範囲で本文を切り出す補助 | `Range`、`sliceRange(text, range)` |
| `packages/shared/src/text/paragraph.ts` | 段落分割 | `Paragraph`、`splitParagraphs(text)` |
| `packages/shared/src/text/ingest.ts` | バイト列のデコード、BOM 除外、取り込み経路 | `Utf8DecodeError`、`decodeUtf8Strict(bytes)`、`stripBom(text)`、`ingestUtf8Bytes(bytes)` |
| `packages/shared/src/versions.ts` | 版定数 | `PROMPT_VERSION`、`ALLOWED_WORD_RULE_VERSION`、`DIAGNOSTIC_TRANSFORM_VERSION` |
| `packages/shared/src/index.ts` | 再エクスポート | 上記すべて |
| `packages/shared/src/text/*.test.ts` | 各ファイルのテスト | |
| `packages/shared/test/fixtures/*.txt` | CRLF・CR・BOM・不正 UTF-8 を含む実ファイル | |

書記素クラスタ（`Intl.Segmenter`）は PR1 では使わない。PR1 はコード単位の位置だけを扱い、字数の計数は PR2 の責務。

## 設計上の決定

ロードマップで固定されていない点だけを挙げる。いずれも仕様書 13 節の未決事項ではなく、実装上の選択。

1. **デコードは `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`。**
   `ignoreBOM` の既定値 `false` はデコード時に BOM を黙って捨てるため、ロードマップの
   「`decodeUtf8Strict` は BOM を保持する」契約に反する。`ignoreBOM: true` で U+FEFF が文字列に残る
   ことを Node 24 で確認済み。`fatal: true` は不正バイトで `TypeError` を投げる。これを
   `Utf8DecodeError`（`class Utf8DecodeError extends Error`、`name` を設定）に包み、サーバー側が
   「文字コードの問題」として表示できるようにする。元の例外は `cause` に入れる。
2. **取り込み経路を 1 つの関数 `ingestUtf8Bytes(bytes)` にまとめる。** 中身は
   `stripBom(decodeUtf8Strict(bytes))` だけ。ロードマップの「取り込み経路で `stripBom` を一度だけ適用する」
   契約に置き場所を与え、先頭 U+FEFF が 2 文字続く入力で 1 文字残るテストをここに置く。
   ロードマップの提供一覧にはない小さな追加。サーバーのファイル入力（PR10）はこの関数だけを呼ぶ。
3. **`stripBom` は先頭の U+FEFF を最大 1 文字だけ除外する。** 本文中の U+FEFF は残す。
   入力が `"\uFEFF"` だけなら空文字列を返す。
4. **`splitParagraphs` は `charCodeAt` による 1 パス走査。** 位置 `i` が CR（0x0D）なら、次が LF（0x0A）で
   あれば `i + 2`、そうでなければ `i + 1` で段落を閉じる。LF なら `i + 1` で閉じる。走査の終端で
   閉じていない文字が残っていれば最後の段落にする。正規表現の分割は、CRLF と単独 CR の判定を
   2 段階に分けたときに `\r\r\n` を取り違えやすいので使わない。
   `text[i]` は `noUncheckedIndexedAccess` で `string | undefined` になるため使わない。
5. **`Paragraph` は `{ id, range }` のみ。** 本文は `sliceRange(text, range)` で取り出す。
   段落に本文を持たせると保存本文と二重管理になる。
6. **版定数の初期値は `"1"`。** 各定数はそれぞれ独立に、対応する規則（プロンプト、許容語判定、診断の変換）を
   変えたときに整数を 1 つ増やす。実行記録との比較は文字列の完全一致で行う。型はロードマップの語彙どおり
   `string` と明示し、リテラル型にしない。
7. **`Range` の補助は `sliceRange` だけ。** 検証関数などは必要になった PR で追加する。

## 解釈で迷った点（PR 本文にも列挙する）

- **貼り付け入力の先頭 U+FEFF。** 仕様書 5.1 は「ファイル先頭の BOM だけを本文から除外」とし、
  貼り付けは「ブラウザから受け取った文字列を基準」とする。貼り付け本文の先頭に U+FEFF があった場合に
  除外するかは PR1 では決めない。PR10（API）または PR11（入力画面）で決める。
  推奨は貼り付けにも `stripBom` を 1 回適用すること。理由は、先頭の U+FEFF は画面に見えず、残すと
  位置が 1 ずれた状態で引用照合に進むため。ただし仕様書の文言を「入力の先頭」に改める必要がある。

## テスト

テストの一覧は付録の英語スペックを正とし、ここでは分類だけを書く（同じ表を 2 言語で持たない）。

- `stripBom`：BOM あり・なし、本文中の U+FEFF、先頭 2 文字の U+FEFF、BOM のみ、空文字列
- `decodeUtf8Strict`：ASCII、日本語、BOM 保持、BOM のみのバイト列、サロゲートペアの 4 バイト列、不正バイト、
  途中で切れた多バイト列、UTF-8 でエンコードされたサロゲート、過長エンコード、空のバイト列
- `ingestUtf8Bytes`：BOM 付きファイルで BOM が消えること、二重 BOM で 1 文字残ること、BOM のみで空文字列になること
- `splitParagraphs`：改行なし、LF、CRLF、単独 CR、混在、`\r\r\n`、`\n\r`、末尾改行あり・なし、空行、
  改行のみ、空本文、改行を含まない長い単一段落、全角スペースの字下げ、
  U+0085・U+2028・U+2029・U+000B・U+000C が区切りにならないこと
- 被覆の不変条件（すべての入力に対して）：先頭が 0、各段落の `start` が直前の `end` と等しい、
  最後の `end` が `text.length`、空範囲がない、`id` が `0..n-1`、切り出した文字列を連結すると元の本文に戻る
- fixture 経由（bytes → decode → strip → split）：CRLF ファイル、単独 CR を含むファイル、BOM 付き CRLF ファイル、
  不正 UTF-8 ファイル。fixture のパスは `path.join(import.meta.dirname, "../../test/fixtures", name)` で解決する
  （`new URL(...).pathname` は Windows で `/C:/...` になるので使わない）

fixture は Claude がスクリプトで生成し、`git ls-files --eol` で 4 ファイルとも `attr/-text` になることを確認してから
コミットする。`i/` 列の期待値は、CRLF の 2 ファイルが `i/crlf`、単独 CR を含むファイルは git のバイナリ判定で `i/-text`、
不正 UTF-8 のファイルは `i/lf`。エディタで開いて保存しない。

テストソース内では、CR・LF・U+0085・U+2028・U+2029・U+000B・U+000C・U+FEFF・U+200D・サロゲートペアを
必ず `\uXXXX` / `\u{XXXXX}` のエスケープで書く。生の文字を貼ると、ツール経由の編集で欠落や化けが起きたときに
期待値が黙って変わる（レビューで実際に再現した）。

## 進め方（コミット単位）

1. **計画とブランチ**（このコミット）：本書を追加。
2. **fixture の追加**（Claude）：`packages/shared/test/fixtures/` に 4 ファイルを生成。`.gitkeep` は削除。
   生成スクリプトは `packages/shared/test/fixtures/generate.mjs` として同梱し、再生成できるようにする。
   `git ls-files --eol` の結果をコミットメッセージに書く。
3. **実装とテスト**（qwen に委譲、Claude が検証）：付録のスペックを標準入力から渡す。
   - 事前に qwen の疎通を確認する（`qwen-delegate` スキルの Step 0）。
   - 出力後、Claude が全ファイルを読んで検証し、`pnpm check` を自分でも実行する。
   - qwen の結果に不備があれば、失敗するテストを先に追加させてから修正させる（同スキルの TDD 修正手順）。
4. **ドキュメント**（Claude）：`docs/reference/conventions.md` の「テスト」節に fixture の生成方法を追記する必要があれば追記。
   ロードマップ PR1 節の提供一覧に `ingestUtf8Bytes` と `sliceRange` を追記。
5. **PR 作成**：本文に、解釈で迷った点と、Windows の確認状況（CI の windows-latest では確認済み、ローカルの Windows は未確認）を書く。

## 付録：qwen へのスペック（英語）

````text
# Task: implement text ingest and paragraph model in packages/shared (TypeScript)

You are working in a pnpm monorepo. Only touch these files:

- packages/shared/src/text/range.ts (create)
- packages/shared/src/text/range.test.ts (create)
- packages/shared/src/text/paragraph.ts (create)
- packages/shared/src/text/paragraph.test.ts (create)
- packages/shared/src/text/ingest.ts (create)
- packages/shared/src/text/ingest.test.ts (create)
- packages/shared/src/versions.ts (create)
- packages/shared/src/index.ts (modify: add re-exports; keep the existing grapheme exports)

Do NOT touch packages/shared/test/fixtures/ (the fixture files already exist and are binary-exact).
Do NOT touch any other package. Do NOT install dependencies. Do NOT modify any Markdown file.

## Project rules (MUST)

- Relative imports MUST end with ".ts" (e.g. `import type { Range } from "./range.ts"`).
  Node runs the TypeScript source directly; imports without the extension fail.
- TypeScript is configured with `erasableSyntaxOnly`, `verbatimModuleSyntax`, `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
  MUST NOT use `enum`, `namespace`, constructor parameter properties, or `import x = require()`.
  Use `import type` for type-only imports.
- Code comments MUST be written in Japanese. Identifiers MUST be English. Test names (the first argument of
  `describe` / `it`) MUST be Japanese, matching packages/shared/src/text/grapheme.test.ts.
- `noUncheckedIndexedAccess` is on: `array[i]` has type `T | undefined`. In tests, read elements with
  optional chaining (`result[0]?.range.start`) or compare whole arrays with `toEqual`. MUST NOT use the
  non-null assertion `!` (Biome warns on it).
- In test source, MUST write CR, LF, U+0085, U+2028, U+2029, U+000B, U+000C, U+FEFF, U+200D and every
  surrogate pair as escapes (`\r`, `\n`, `\u0085`, `\u{20BB7}` ...). MUST NOT paste raw control characters,
  raw ZWJ, or raw emoji into a string literal.
- Biome's formatter and import sorter decide layout. If the formatter expands an array literal from the tables
  below onto several lines, keep the formatter's output.
- Use `readonly` on all interface fields (match the style of packages/shared/src/text/grapheme.ts).
- Tests use Vitest (`import { describe, expect, it } from "vitest"`), placed next to the source as *.test.ts.
- MUST NOT use `Intl.Segmenter` or any grapheme logic in this task. Positions are UTF-16 code units only.
- MUST NOT normalize, trim, or otherwise modify text. The only allowed modification is removing
  one leading U+FEFF in `stripBom`.

## 1. packages/shared/src/text/range.ts

```ts
/** UTF-16 コード単位の範囲。開始を含み終了を含まない [start, end)。 */
export interface Range {
  readonly start: number;
  readonly end: number;
}

/** 範囲で本文を切り出す。 */
export function sliceRange(text: string, range: Range): string
```

`sliceRange` is `text.slice(range.start, range.end)`. No validation.

Tests (range.test.ts):
- `sliceRange("abc", { start: 1, end: 3 })` returns `"bc"`.
- A range covering a surrogate pair by code units: `sliceRange("a𠮷b", { start: 1, end: 3 })` returns `"𠮷"`.

## 2. packages/shared/src/text/paragraph.ts

```ts
import type { Range } from "./range.ts";

/** 段落。id は原稿版内で 0 始まりの出現順。 */
export interface Paragraph {
  readonly id: number;
  readonly range: Range;
}

/**
 * 本文を段落に分割する（仕様書 6.1 節）。
 * CRLF・単独 LF・単独 CR のいずれか 1 つの改行列で区切られた行が段落。
 * 区切りの改行列は直前の段落の範囲に含める。空行も段落として保持する。
 */
export function splitParagraphs(text: string): Paragraph[]
```

Algorithm (MUST implement as a single index scan using `charCodeAt`; MUST NOT use a regular expression
or `split`, and MUST NOT use `text[i]` indexing):

```
paragraphs = []
start = 0
i = 0
while i < text.length:
  code = text.charCodeAt(i)
  if code == 0x0D:                       // CR
    end = (i + 1 < text.length && text.charCodeAt(i + 1) == 0x0A) ? i + 2 : i + 1   // CRLF or lone CR
    push { id: paragraphs.length, range: { start, end } }
    start = end; i = end
  else if code == 0x0A:                  // LF
    end = i + 1
    push { id: paragraphs.length, range: { start, end } }
    start = end; i = end
  else:
    i += 1
if start < text.length:
  push { id: paragraphs.length, range: { start, end: text.length } }
return paragraphs
```

Rules restated from two angles so they are not inverted:
- A CR immediately followed by LF is ONE separator (CRLF). Do NOT produce an empty paragraph between the CR and the LF.
- A CR NOT followed by LF is a separator by itself. `"a\r\r\nb"` therefore has THREE paragraphs: `"a\r"`, `"\r\n"` (an empty line), `"b"`.
- An LF followed by CR is TWO separators: `"a\n\rb"` gives `"a\n"`, `"\r"`, `"b"`.
- Only U+000D and U+000A are separators. U+0085 (NEL), U+2028 (LINE SEPARATOR), U+2029, U+000B (VT), U+000C (FF)
  are NOT separators and stay inside the paragraph.
- Trailing newline: `"a\n"` is ONE paragraph `[0, 2)`. Do NOT append an empty final paragraph after a trailing newline.
- Empty text returns `[]`. Text that is only `"\n"` returns one paragraph `[0, 1)`.
- Full-width space U+3000 at the start of a line (Japanese indentation) is ordinary text, not a boundary.

Tests (paragraph.test.ts). Define the table below ONCE as an array of `{ name: string; text: string; expected: [number, number][] }`
(`name` in Japanese), then generate one `it` per row with a `for` loop, asserting
`splitParagraphs(text).map((p) => [p.range.start, p.range.end])` `toEqual(expected)`. Reuse the same array for the
coverage-invariant loop further below.

| input | expected ranges |
| --- | --- |
| `""` | `[]` |
| `"abc"` | `[[0,3]]` |
| `"a\nb"` | `[[0,2],[2,3]]` |
| `"a\n"` | `[[0,2]]` |
| `"\n"` | `[[0,1]]` |
| `"\n\n"` | `[[0,1],[1,2]]` |
| `"a\r\nb"` | `[[0,3],[3,4]]` |
| `"a\r\n"` | `[[0,3]]` |
| `"a\rb"` | `[[0,2],[2,3]]` |
| `"a\r"` | `[[0,2]]` |
| `"\r\n"` | `[[0,2]]` |
| `"a\r\r\nb"` | `[[0,2],[2,4],[4,5]]` |
| `"a\n\rb"` | `[[0,2],[2,3],[3,4]]` |
| `"a\r\n\r\nb"` | `[[0,3],[3,5],[5,6]]` |
| `"一\r\n二\n三\r四"` | `[[0,3],[3,5],[5,7],[7,8]]` |
| `"\u3000段落"` | `[[0,3]]` |
| `"あ".repeat(20000)` | `[[0,20000]]` (a single long paragraph with no newline) |
| `"a\u0085b\u2028c\u2029d\u000Be\u000Cf"` | `[[0,11]]` |
| `"a\uFEFFb\nc"` | `[[0,4],[4,5]]` (U+FEFF inside text is ordinary text) |
| `"\u{20BB7}\n\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\r\n"` | `[[0,3],[3,13]]` (𠮷 then a ZWJ family emoji; surrogates count as 2 code units each, the emoji is 8 code units) |

Additional tests:
- `id` equals the array index for every paragraph of `"a\nb\r\nc\rd"` (ids `[0,1,2,3]`).
- Coverage invariant, one `it` per row of the same table (loop over the array again):
  - if the text is empty, the result is empty; otherwise
  - `expect(result[0]?.range.start).toBe(0)`
  - for every k > 0: `expect(result[k]?.range.start).toBe(result[k - 1]?.range.end)`
  - `expect(result[result.length - 1]?.range.end).toBe(text.length)`
  - every range has `end > start` (no empty range)
  - `expect(result.map((p) => sliceRange(text, p.range)).join("")).toBe(text)`
  - `expect(result.map((p) => p.id)).toEqual(result.map((_, i) => i))`
- `splitParagraphs` MUST NOT modify its input (strings are immutable, so just assert the join-back equality above).

## 3. packages/shared/src/text/ingest.ts

```ts
/** UTF-8 として読めないバイト列を受け取ったときの例外。 */
export class Utf8DecodeError extends Error {
  constructor(options?: { cause?: unknown }) { super("UTF-8 として読み込めません", options); this.name = "Utf8DecodeError"; }
}

/**
 * バイト列を UTF-8 として厳密にデコードする。不正なバイト列は Utf8DecodeError。
 * 先頭の BOM（U+FEFF）は除去せず文字列に残す。BOM の除外は stripBom の責務。
 */
export function decodeUtf8Strict(bytes: Uint8Array): string

/** 先頭の U+FEFF を最大 1 文字だけ除外する。本文中の U+FEFF は残す。 */
export function stripBom(text: string): string

/**
 * ファイル入力の取り込み経路。decodeUtf8Strict の結果に stripBom を一度だけ適用する。
 * 保存本文や後続処理で stripBom を再適用してはならない。
 */
export function ingestUtf8Bytes(bytes: Uint8Array): string
```

Implementation requirements:
- `decodeUtf8Strict` MUST use `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`.
  `ignoreBOM: true` is REQUIRED: the default value `false` silently strips the BOM, which violates the
  contract that decoding keeps the BOM. Create the decoder once at module level.
- Wrap the `TypeError` thrown by the decoder: `catch (error) { throw new Utf8DecodeError({ cause: error }); }`.
- `stripBom`: `text.charCodeAt(0) === 0xfeff ? text.slice(1) : text`. Exactly one character, never a loop.
- `ingestUtf8Bytes`: `stripBom(decodeUtf8Strict(bytes))`. Nothing else.

Tests (ingest.test.ts):

stripBom:
- `stripBom("\uFEFFabc")` → `"abc"`
- `stripBom("abc")` → `"abc"`
- `stripBom("a\uFEFFb")` → `"a\uFEFFb"` (U+FEFF in the middle stays)
- `stripBom("\uFEFF\uFEFFa")` → `"\uFEFFa"` (only one removed)
- `stripBom("\uFEFF")` → `""`
- `stripBom("")` → `""`

decodeUtf8Strict (build inputs with `new Uint8Array([...])` or `new TextEncoder().encode(...)`):
- `[0x61, 0x62]` → `"ab"`
- bytes of `"朱点"` via TextEncoder → `"朱点"`
- `[0xEF, 0xBB, 0xBF, 0x61]` → `"\uFEFFa"` (BOM is KEPT; this test guards the `ignoreBOM: true` setting)
- `[0xEF, 0xBB, 0xBF]` → `"\uFEFF"` (length 1)
- `[0xF0, 0xA0, 0xAE, 0xB7]` → `"𠮷"`, and the result `.length` is 2
- `[0xFF]` → throws `Utf8DecodeError`
- `[0xE3, 0x81]` (truncated 3-byte sequence) → throws `Utf8DecodeError`
- `[0xED, 0xA0, 0x80]` (UTF-8-encoded surrogate) → throws `Utf8DecodeError`
- `[0xC0, 0xAF]` (overlong encoding) → throws `Utf8DecodeError`
- `new Uint8Array(0)` → `""`
- The thrown error's shape. `toThrow` cannot inspect `cause`, so catch it explicitly:

```ts
let caught: unknown;
try {
  decodeUtf8Strict(new Uint8Array([0xff]));
} catch (error) {
  caught = error;
}
expect(caught).toBeInstanceOf(Utf8DecodeError);
expect((caught as Error).name).toBe("Utf8DecodeError");
expect((caught as Error).cause).toBeInstanceOf(TypeError);
```

ingestUtf8Bytes:
- `[0xEF, 0xBB, 0xBF, 0x61]` → `"a"`
- `[0xEF, 0xBB, 0xBF, 0xEF, 0xBB, 0xBF, 0x61]` → `"\uFEFFa"` (two leading BOMs: exactly one remains)
- `[0xEF, 0xBB, 0xBF]` → `""`
- `[0x61]` → `"a"`
- `[0xFF]` → throws `Utf8DecodeError`

Fixture round trip (also in ingest.test.ts). Read files from `packages/shared/test/fixtures/` using:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeUtf8Strict, ingestUtf8Bytes, stripBom, Utf8DecodeError } from "./ingest.ts";
import { splitParagraphs } from "./paragraph.ts";
import { sliceRange } from "./range.ts";

const fixturesDir = path.join(import.meta.dirname, "../../test/fixtures");
const readFixture = (name: string) => new Uint8Array(readFileSync(path.join(fixturesDir, name)));
```

MUST use `path.join` with `import.meta.dirname`. MUST NOT use `new URL(...).pathname` (breaks on Windows).
The fixtures and their exact contents:

- `crlf.txt`: bytes of `"一行目\r\n二行目\r\n\r\n　三行目\r\n"` (U+3000 before 三). No BOM.
  Expected: `ingestUtf8Bytes` returns exactly that string; `splitParagraphs` gives 4 paragraphs with ranges
  `[[0,5],[5,10],[10,12],[12,18]]`; `expect(paragraphs[2]?.range).toEqual({ start: 10, end: 12 })` and
  `sliceRange(text, { start: 10, end: 12 })` is `"\r\n"`.
- `cr-mixed.txt`: bytes of `"甲\r乙\n丙\r\n丁"`. No BOM.
  Expected: 4 paragraphs `[[0,2],[2,4],[4,7],[7,8]]`, and `sliceRange(text, { start: 4, end: 7 })` is `"丙\r\n"`.
- `bom-crlf.txt`: bytes `EF BB BF` followed by `"見出し\r\n本文"`.
  Expected: `decodeUtf8Strict` result starts with `"\uFEFF"` and has length 8; `ingestUtf8Bytes` returns
  `"見出し\r\n本文"` (length 7); paragraphs `[[0,5],[5,7]]`.
- `invalid-utf8.txt`: bytes `E3 81 82 FF 0A` (valid "あ", then an invalid 0xFF, then LF).
  Expected: `ingestUtf8Bytes` throws `Utf8DecodeError`.

## 4. packages/shared/src/versions.ts

```ts
/** プロンプトの版。プロンプト本文や出力スキーマを変えたら 1 増やす。実行記録に保存する。 */
export const PROMPT_VERSION: string = "1";
/** 許容語判定の規則の版。判定規則を変えたら 1 増やす。 */
export const ALLOWED_WORD_RULE_VERSION: string = "1";
/** 位置診断で使う変換規則（改行統一・NFC）の版。変換を変えたら 1 増やす。 */
export const DIAGNOSTIC_TRANSFORM_VERSION: string = "1";
```

No test file is needed for versions.ts.

## 5. packages/shared/src/index.ts

Replace the file content with re-exports of everything public, keeping the existing grapheme exports.
The order below is what Biome's import sorter requires (module specifiers alphabetical, `export type` before
`export` for the same module, names sorted case-insensitively):

```ts
export type { GraphemeSegment } from "./text/grapheme.ts";
export { countGraphemes, segmentGraphemes } from "./text/grapheme.ts";
export { decodeUtf8Strict, ingestUtf8Bytes, stripBom, Utf8DecodeError } from "./text/ingest.ts";
export type { Paragraph } from "./text/paragraph.ts";
export { splitParagraphs } from "./text/paragraph.ts";
export type { Range } from "./text/range.ts";
export { sliceRange } from "./text/range.ts";
export {
  ALLOWED_WORD_RULE_VERSION,
  DIAGNOSTIC_TRANSFORM_VERSION,
  PROMPT_VERSION,
} from "./versions.ts";
```

## Hazards to avoid

- Do NOT strip the BOM inside `decodeUtf8Strict`. The BOM is removed ONLY by `stripBom`, ONLY once, ONLY in `ingestUtf8Bytes`.
- Do NOT treat `\r\r\n` as one separator. It is a lone CR followed by a CRLF.
- Do NOT emit an empty trailing paragraph after a trailing newline. Do NOT drop the newline from the preceding paragraph's range.
- Do NOT use `Intl.Segmenter`, `normalize()`, `trim()`, or `replace()` anywhere in this task.
- Do NOT use `text[i]`; use `text.charCodeAt(i)`.
- Do NOT edit files under packages/shared/test/fixtures/ (they contain CRLF and invalid bytes on purpose; any editor save would corrupt them).
- Biome enforces formatting (line width 100, LF line endings) AND import/export sorting. `pnpm format` does NOT
  sort imports; use `pnpm exec biome check --write .` to fix both, instead of reordering by hand.

## Self-correction (MANDATORY — run before finishing)

Run the following commands from the repository root and fix any errors iteratively until all pass:
1. Format and sort imports: `pnpm exec biome check --write .`
2. Typecheck: `pnpm typecheck`
3. Lint: `pnpm lint`
4. Full check: `pnpm check`

If any step fails, read the error, fix the code, and re-run. Repeat until clean.
Do NOT finish the session until `pnpm check` passes.
````
