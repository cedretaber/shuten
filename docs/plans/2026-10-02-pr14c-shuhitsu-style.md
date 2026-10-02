# PR14c 詳細計画：見た目の朱筆化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

作成日：2026-10-02
状態：実装済み（Windows のブラウザでの見え方はユーザーの確認待ち）

**Goal:** 全画面の配色と部品の形を、朱筆（白地・朱・本文明朝）にそろえる。項目・文言・動きは変えない。

**Architecture:** `packages/web` の CSS だけを変える。色・角丸・書体は `styles/tokens.css` の変数にまとめ、ボタン・入力欄・エラーの枠は新しい共通の CSS Modules `styles/controls.module.css` に 1 回だけ書いて、各画面の TSX から `className` で使う。各 feature の CSS Modules には、配置（余白・並び・幅）だけを残す。

**Tech Stack:** React 19 + Vite 8、CSS Modules、Vitest + Testing Library（jsdom）。新しい依存は入れない。

**Spec:** `docs/plans/2026-10-02-ui-refresh.md`（UI の見直しの設計書）の「3. 見た目の朱筆化（PR14c）」と「対象外（MUST NOT）」。仕様の正本は `docs/spec/mvp-spec.md`（この PR では改訂しない）。

## Global Constraints

- 変更は `packages/web` だけ。サーバー、`packages/shared`、API と DTO は変えない。
- 各画面の項目、文言、動きは変えない。DOM に新しい文字列を足さない（エラーの「エラー」は CSS の `::before` で出す。決めたこと 2）。
- 機能を増やさない。表示方式の切り替え、前・次の指摘への移動、キーボード操作、ダークモードは作らない。仕様書は改訂しない。
- CSS フレームワーク・UI ライブラリ・Web フォントを入れない。
- CSS Modules の `composes` は使わない（決めたこと 1）。
- 色の値（`#…`、`rgb(…)`）は `styles/tokens.css` にだけ書く。他の CSS は `var(--…)` で参照する。
- テストが名前で参照しているクラス（`findingRowSelected`、`findingQuote`、`headerMain`、`headerMeta`、`highlight`、`highlightSelected`）は、名前を変えずに見た目だけ変える。
- 本文をブラウザで加工しない。`dangerouslySetInnerHTML` を使わない（PR12a の制約）。
- ドキュメント・コメント・コミットメッセージは日本語、識別子は英語。
- 各タスクの完了時に `pnpm check` を通す。

## 設計書から先に決めたこと（ユーザーの確認を求める点）

1. **共通の部品は `styles/controls.module.css` に置き、TSX から直接使う。** CSS Modules の `composes` で各 feature の CSS から読み込む形も試した。しかし、Vitest は CSS を処理しないので `composes` が効かず、テストと本番でクラス名が変わる。さらに `vite build` で PostCSS の警告が出る。そこで、TSX で `className={controls.primaryButton}` のように付ける。配置の指定（`align-self` など）が要るときは、feature のクラスと並べて付ける（`` className={`${controls.primaryButton} ${styles.startButton}`} ``）。
2. **エラーの先頭の「エラー」は CSS で付ける。** 設計書は「枠で囲み、先頭に『エラー』と書く」と「文言を変えない」の両方を求めている。`.errorBox::before { content: "エラー" }` にすると、DOM の文言は今のままで、画面と読み上げには「エラー」が出る。今のエラーの文言に「エラー」で始まるものはない（確認済み）。
3. **枠で囲むエラーと、臙脂の文字だけの注記を分ける。** 操作や取得の失敗を伝えるものはエラーの枠にする（下の表の「エラー」）。指摘やモデルの状態を伝える短い注記（「位置未特定」「この修正案は再確認で不適切と判定されました」「LM Studio でロードしてください…」）は、文言だけで意味が分かるので、枠を付けず臙脂の文字のままにする。一覧の行の中に枠が入ると、行の見た目が崩れるためでもある。
4. **再試行のボタン（検査設定の「再試行」）の扱い。** 今は臙脂（赤）の塗りで、「検査を開始する」より目立たせている（結果不明のときは、新しく開始するより同じ操作の再送のほうが正しいため）。ボタンを 2 種類にすると、この差がなくなる。ユーザーの決定（2026-10-02）で A にした。
   - **A**（推奨）：朱の塗り（主な操作）にし、太字は残す。エラーの枠の中、説明のすぐ横にあるので、見つけやすさは保てる。「検査を開始する」も朱の塗りのままで、2 つは同じ強さになる。
   - **B**：臙脂の塗りを、ボタンの 3 種類目の例外として残す。今の「再試行のほうを目立たせる」意図は保てるが、「臙脂＝エラー」の役割分担が崩れる。
5. **案内文（停止中・遅延・復旧待ちなど）は朱にしない。** 今は本文の強調と同じ黄色を借りている。設計書は朱を「指摘・操作」に使うと決めているので、案内文は生成りの地（`#f7f3ea`）と灰茶の枠（`#8a8170`）にする。
6. **選択中の地の色は `#fcebe5` にする。** 設計書は「薄い朱の地」とだけ書いている。一覧の選択中の行にある「n 案」の印（朱の文字）が、この地の上でも文字の基準 4.5 を満たす値にした（4.63）。
   実装後、ユーザーの確認で薄すぎたため `#f6cdbd` に変えた（「実装時の調整」）。
7. **明朝体にするのは、本文の列と、詳細の「原文」「修正案」だけ。** 詳細で同じクラス（`detailQuote`）を使っている理由・元候補・位置診断はゴシックのままにする。トップ画面の原稿の入力欄とプレビューも、設計書の対象に入っていないのでそのままにする。
8. **見出しとリンクも、全画面でそろえる。** 今の `h1`・`h2` はブラウザの既定のままで、画面ごとに余白が違う。`global.css` で大きさと余白をそろえる。リンクの色は朱にする（今はブラウザ既定の青と朱が混ざっている）。キーボードで移ったときの枠（`:focus-visible`）も朱の線にそろえる。どれも見た目だけで、キーボード操作を足すものではない。
9. **角丸は `--radius`（4px）と `--radius-pill`（999px）の変数にまとめる。**

## 色の値とコントラスト比

白地との比は設計書の値。他はこの計画で計算した（WCAG 2.x の式）。文字は 4.5 以上、線は 3 以上を基準にする。

| 変数 | 値 | 用途 | 比 |
| --- | --- | --- | --- |
| `--color-accent` | `#c23a22` | 朱の文字、主な操作の塗り | 白地 5.35、`--color-bg-muted` 4.91、`--color-accent-bg` 3.67（選択中の下線と枠）、塗りの上の白文字 5.35 |
| `--color-accent-line` | `#d9452b` | 朱の線（下線・枠） | 白地 4.34、`--color-bg-muted` 3.98 |
| `--color-accent-bg` | `#f6cdbd`（当初は `#fcebe5`） | 選択中の地（本文の強調、一覧の行） | 墨の文字 11.92、`--color-fg-muted` 4.80、白地 1.46 |
| `--color-danger` | `#9f1239` | エラーの文字と枠、注記の文字 | 白地 8.02、`--color-danger-bg` 7.32 |
| `--color-danger-bg` | `#fdf2f4` | エラーの枠の地 | — |
| `--color-notice-bg` | `#f7f3ea` | 案内文の地 | 墨の文字 15.72、`--color-fg-muted` 6.33 |
| `--color-notice-border` | `#8a8170` | 案内文の枠 | `--color-notice-bg` 3.48 |
| `--color-bg` ・ `--color-fg` ・ `--color-bg-muted` ・ `--color-fg-muted` ・ `--color-border` | 今の値のまま | — | `--color-fg-muted` は白地 7.00 |

なくす変数：`--color-highlight-bg`、`--color-highlight-border`、`--color-highlight-selected-bg`。

## 部品の割り当て

| 今のクラス（ファイル） | 文言 | 割り当て |
| --- | --- | --- |
| `startButton`（settings） | 検査を開始する | 主な操作 |
| `confirmButton`（manuscript） | 原稿を確定する など | 主な操作 |
| `saveButton`（connection） | 保存 | 主な操作 |
| `judgmentSaveButton`（results） | 保存 | 主な操作 |
| `retryButton`（settings） | 再試行 | 主な操作（決めたこと 4 の A） |
| `controlButton`（results：run-control・recovery-notice・failed-units） | 停止・再開・再実行 など | 枠だけ |
| `refreshButton`（results） | 更新・再読み込み | 枠だけ |
| `detailNavigateButton`（results） | 本文の該当箇所へ移動 | 枠だけ |
| `recheckButton`（header） | 再確認 | 枠だけ |
| `resetButton`（manuscript） | 原稿を入力し直す など | 枠だけ |
| `advancedResetButton`（settings） | 既定値に戻す | 枠だけ |
| `detailRelatedButton`（results） | 重なる指摘のリンク | ボタンにしない（今の灰色の枠のカード。ホバーで朱の線） |
| `input`・`textarea`・`select`（connection・manuscript・settings）、`judgmentNoteTextarea`（results） | — | 入力欄 |
| `error`（header・connection・manuscript・settings・run-list・results の全箇所）、`controlFailure`、`judgmentErrorItem`、`retryNotice` | — | エラーの枠 |
| `findingLocateFailure`、`suggestionInvalidNote`、`modelNote`（connection） | — | 臙脂の文字だけ（決めたこと 3） |
| `statusNotice`（results） | — | 案内文（決めたこと 5） |

`modelNote`（settings）は今も灰色の補足で、エラーでも注記でもないので変えない。

## Review Focus

テストでは押さえきれず、使う人が最初に気づきそうな見た目。

1. **本文の強調と選択の見分け**：朱の下線だけの箇所と、薄い朱の地の選択中の箇所が、明朝の本文の上で見分けられる。→ Task 4 の実ブラウザでの確認と、ユーザーの Windows での確認。
2. **エラーの枠の「エラー」が二重にならない、欠けない**：ヘッダーの接続エラー、実行制御の失敗、採否の保存の失敗、検査開始の失敗と再試行の案内。→ Task 4 の実ブラウザでの確認（`::before` は jsdom では確かめられない）。
3. **主な操作と枠だけのボタンの区別**：結果画面の「保存」（朱の塗り）と「停止」などの枠だけのボタンが、並んでも役割の違いが分かる。→ Task 4。
4. **選択中の行の「n 案」の印**：薄い朱の地の上でも読める（比 4.63）。→ Task 1 のコントラストのテスト。
5. **消した色の変数の参照が残らない**：残ると、その指定だけ黙って無効になる。→ Task 1 の「定義されていない変数を使っていない」テスト。

---

## ファイルの構成

| ファイル | 変更 | 役割 |
| --- | --- | --- |
| `packages/web/src/styles/tokens.css` | 変更 | 色・角丸・書体の変数 |
| `packages/web/src/styles/global.css` | 変更 | 本文の書体、見出し、リンク、フォーカスの枠 |
| `packages/web/src/styles/style-guard.test.ts` | 新規 | コントラスト比、色の値の置き場所、未定義の変数、`composes` と角丸の直書きの禁止 |
| `packages/web/src/styles/controls.module.css` | 新規 | 主な操作・枠だけのボタン、入力欄、エラーの枠、臙脂の注記 |
| `packages/web/tsconfig.json` | 変えない | `*.module.css` の型は `vite/client` が与える（新しい型宣言は要らない） |
| `app/header.*`、`features/connection/*`、`features/manuscript/*`、`features/settings/*`、`features/run-list/*` | 変更 | 共通の部品を使い、feature の CSS から重複する見た目を消す |
| `features/results/*.tsx`、`results-page.module.css`、`results.module.css` | 変更 | 同上。強調・選択・案内文の色、明朝体 |
| `docs/plans/2026-10-02-pr14c-shuhitsu-style.md`、`docs/plans/2026-09-07-mvp-roadmap.md`、`docs/history.md` | 変更 | 状態と経過 |

---

### Task 1: 変数の差し替えと、CSS を見張るテスト

**Files:**
- Modify: `packages/web/src/styles/tokens.css`
- Modify: `packages/web/src/styles/global.css`
- Modify: `packages/web/src/features/results/results.module.css`（強調）
- Modify: `packages/web/src/features/results/results-page.module.css`（`statusNotice`、`findingRowSelected`、`findingGroupCount`、朱の線、角丸）
- Modify: 他の `*.module.css` すべて（角丸を変数に、朱の線を `--color-accent-line` に）
- Create: `packages/web/src/styles/style-guard.test.ts`

**Interfaces:**
- Produces: 変数 `--color-accent`、`--color-accent-line`、`--color-accent-bg`、`--color-danger`、`--color-danger-bg`、`--color-notice-bg`、`--color-notice-border`、`--radius`、`--radius-pill`、`--font-family-sans`、`--font-family-serif`（Task 2・3 が使う）

- [ ] **Step 1: 見張りのテストを書く**

`packages/web/src/styles/style-guard.test.ts`：

```ts
/**
 * 朱筆化（PR14c）の約束を CSS の文字列から確かめる。jsdom は CSS を描かないので、
 * 見た目そのものは実ブラウザで確かめ、ここでは「値の置き場所」と「比」だけを見る。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(import.meta.dirname, "..");
const TOKENS = join(import.meta.dirname, "tokens.css");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

function tokens(): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of readFileSync(TOKENS, "utf8").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1] as string, (m[2] as string).trim());
  }
  return map;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("色の変数のコントラスト比", () => {
  const t = tokens();
  const v = (name: string): string => {
    const value = t.get(name);
    if (value === undefined) throw new Error(`${name} がない`);
    return value;
  };

  test.each([
    // [前景, 背景, 基準]
    ["--color-accent", "--color-bg", 4.5],
    ["--color-accent", "--color-bg-muted", 4.5],
    ["--color-accent", "--color-accent-bg", 4.5],
    ["--color-bg", "--color-accent", 4.5],
    ["--color-fg", "--color-accent-bg", 4.5],
    ["--color-fg-muted", "--color-accent-bg", 4.5],
    ["--color-danger", "--color-bg", 4.5],
    ["--color-danger", "--color-danger-bg", 4.5],
    ["--color-fg", "--color-notice-bg", 4.5],
    ["--color-fg-muted", "--color-notice-bg", 4.5],
    ["--color-fg-muted", "--color-bg", 4.5],
    ["--color-fg-muted", "--color-bg-muted", 4.5],
    ["--color-accent-line", "--color-bg", 3],
    ["--color-accent-line", "--color-bg-muted", 3],
    ["--color-accent-line", "--color-accent-bg", 3],
    ["--color-notice-border", "--color-notice-bg", 3],
  ] as const)("%s on %s ≥ %d", (fg, bg, min) => {
    expect(contrast(v(fg), v(bg))).toBeGreaterThanOrEqual(min);
  });
});

describe("CSS の書き方", () => {
  const files = cssFiles(SRC);
  const defined = new Set(tokens().keys());

  test.each(files.map((f) => [relative(SRC, f), f]))("%s", (_name, file) => {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    if (file !== TOKENS) {
      // 色の値は tokens.css にだけ書く。
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      // 角丸は変数で書く（0 は除く）。
      expect(css).not.toMatch(/border-radius:\s*[1-9]/);
    }
    // composes はテストと本番でクラス名が変わるので使わない。
    expect(css).not.toMatch(/\bcomposes\s*:/);
    // 使っている変数はすべて tokens.css で定義されている。
    for (const m of css.matchAll(/var\((--[\w-]+)/g)) {
      expect(defined, `${m[1]} が tokens.css にない`).toContain(m[1]);
    }
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/styles/style-guard.test.ts`
Expected: FAIL（`--color-accent-line` などがない、角丸が直書き）

- [ ] **Step 3: `tokens.css` を書き換える**

```css
/** 色・余白・文字サイズ・角丸・書体のカスタムプロパティ。feature 固有のスタイルはここを参照する。
 *  色の値はこのファイルにだけ書く（style-guard.test.ts が見張る）。比は PR14c の計画に記録した。 */
:root {
  /* 色：地と文字 */
  --color-bg: #ffffff;
  --color-bg-muted: #f5f5f5;
  --color-fg: #1a1a1a;
  --color-fg-muted: #595959;
  --color-border: #d9d9d9;

  /* 色：朱（指摘と操作）。文字・塗りは accent、線は accent-line、選択中の地は accent-bg */
  --color-accent: #c23a22;
  --color-accent-line: #d9452b;
  --color-accent-bg: #fcebe5;

  /* 色：臙脂（エラー）。色だけで見分けず、枠と「エラー」の文字を添える */
  --color-danger: #9f1239;
  --color-danger-bg: #fdf2f4;

  /* 色：案内文（エラーでも指摘でもない知らせ）。朱を使わない */
  --color-notice-bg: #f7f3ea;
  --color-notice-border: #8a8170;

  /* 余白 */
  --space-xs: 0.25rem;
  --space-sm: 0.5rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2rem;

  /* 文字サイズ */
  --font-size-sm: 0.875rem;
  --font-size-md: 1rem;
  --font-size-lg: 1.25rem;
  --font-size-xl: 1.75rem;

  /* 角丸 */
  --radius: 4px;
  --radius-pill: 999px;

  /* 書体。明朝は本文の列と、詳細の原文・修正案だけに使う */
  --font-family-sans:
    system-ui, -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
  --font-family-serif:
    "游明朝", "Yu Mincho", YuMincho, "Hiragino Mincho ProN", "Noto Serif JP", serif;
}
```

- [ ] **Step 4: `global.css` に書体・見出し・リンク・フォーカスの枠を足す**

`body` の `font-family` を `var(--font-family-sans)` にし、末尾の `header { … }` はそのまま残して、その後に次を足す。

```css
/* 見出しの大きさと余白を全画面でそろえる（PR14c）。各画面は flex の gap で間を取るので、余白は 0 にする。
   クラスを付けた見出し（結果画面のヘッダーや詳細）は、そちらの指定が優先する。 */
h1 {
  margin: 0;
  font-size: var(--font-size-xl);
  line-height: 1.3;
}

h2 {
  margin: 0;
  font-size: var(--font-size-lg);
  line-height: 1.4;
}

a {
  color: var(--color-accent);
}

/* キーボードで移ったときの枠。ブラウザ既定の青を朱の線にそろえる（操作は足さない）。 */
:focus-visible {
  outline: 2px solid var(--color-accent-line);
  outline-offset: 2px;
}
```

- [ ] **Step 5: 本文の強調を朱にする（`results.module.css`）**

```css
.highlight {
  cursor: pointer;
  border-radius: 2px;
  box-shadow: inset 0 -0.15em 0 0 var(--color-accent-line);
}

.highlightSelected {
  background-color: var(--color-accent-bg);
  box-shadow: inset 0 -0.15em 0 0 var(--color-accent);
}
```

`.highlight` の `border-radius: 2px` は角丸の直書きになるので `var(--radius)` に変える（4px でも地は選択中だけなので見た目の差はない）。`.body` には `font-family: var(--font-family-serif);` を足す（今の `font-family: inherit;` を置き換える）。冒頭の説明コメントに「本文の列は明朝体（PR14c）」と 1 行足す。

- [ ] **Step 6: 結果画面の色を差し替える（`results-page.module.css`）**

- `.statusNotice`：`background-color: var(--color-notice-bg); border: 1px solid var(--color-notice-border);`。直前のコメントを「エラーではなく、指摘でもないので、朱でも臙脂でもない案内文の配色を使う（PR14c）」に直す。
- `.findingRowSelected`：`border-color: var(--color-accent-line); background-color: var(--color-accent-bg);`
- `.findingGroupCount`：`border: 1px solid var(--color-accent-line);`、`border-radius: var(--radius-pill);`
- `.filterActive` は `color: var(--color-accent)` のまま。

- [ ] **Step 7: 全 CSS の朱の線と角丸をそろえる**

- `border…: … var(--color-accent)` と `border-color: var(--color-accent)` を `var(--color-accent-line)` に変える（`run-list.module.css` の `.runRow:hover` など。Task 2・3 で消すボタンのクラスもここでは機械的に変えてよい）。塗り（`background-color: var(--color-accent)`）と文字（`color: var(--color-accent)`）は変えない。
- `border-radius: 4px` をすべて `var(--radius)` に変える。

- [ ] **Step 8: テストと check を通す**

Run: `pnpm --filter @shuten/web exec vitest run src/styles/style-guard.test.ts` → PASS
Run: `pnpm check` → PASS

- [ ] **Step 9: コミット**

```bash
git add packages/web/src/styles/tokens.css packages/web/src/styles/global.css packages/web/src/styles/style-guard.test.ts packages/web/src/features/results/results.module.css packages/web/src/features/results/results-page.module.css <角丸を直した他の module.css>
git commit -F <メッセージのファイル>
```

メッセージ：`PR14c: 色の変数を朱筆に差し替え、CSS の書き方を見張るテストを足す`

---

### Task 2: 共通の部品を作り、結果画面以外の 4 画面に使う

**Files:**
- Create: `packages/web/src/styles/controls.module.css`
- Modify: `app/header.tsx`・`app/header.module.css`
- Modify: `features/connection/connection-section.tsx`・`model-section.tsx`・`connection.module.css`
- Modify: `features/manuscript/manuscript-editor.tsx`・`manuscript-confirmed.tsx`・`manuscript.module.css`
- Modify: `features/settings/run-settings-form.tsx`・`advanced-settings-summary.tsx`・`advanced-settings-section.tsx`（入力欄があれば）・`settings.module.css`
- Modify: `features/run-list/run-list-page.tsx`・`run-list.module.css`
- Test: 各画面の既存のテストファイルに、クラスの割り当てを確かめる `test` を足す

**Interfaces:**
- Consumes: Task 1 の変数
- Produces: `controls.module.css` のクラス `primaryButton`、`secondaryButton`、`input`、`errorBox`、`dangerNote`（Task 3 が使う）

- [ ] **Step 1: `controls.module.css` を書く**

```css
/**
 * 全画面で共通の部品の見た目（UI の見直し 3 節、PR14c）。各画面の TSX が直接 import して使う。
 * feature の CSS Modules には配置（余白・並び・幅）だけを置き、色・枠・角丸はここに 1 回だけ書く。
 * `composes` は使わない（Vitest は CSS を処理しないので、テストと本番でクラス名が変わる）。
 */

/* 主な操作（検査を開始する、確定、保存など）：朱の塗り。 */
.primaryButton {
  padding: var(--space-xs) var(--space-lg);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius);
  background-color: var(--color-accent);
  color: var(--color-bg);
  font: inherit;
  font-weight: bold;
  cursor: pointer;
}

/* それ以外の操作：枠だけ。 */
.secondaryButton {
  padding: var(--space-xs) var(--space-lg);
  border: 1px solid var(--color-accent-line);
  border-radius: var(--radius);
  background-color: var(--color-bg);
  color: var(--color-accent);
  font: inherit;
  cursor: pointer;
}

.primaryButton:disabled,
.secondaryButton:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

/* 入力欄（1 行・複数行・選択）。 */
.input {
  padding: var(--space-xs) var(--space-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background-color: var(--color-bg);
  color: var(--color-fg);
  font: inherit;
}

.input:focus {
  border-color: var(--color-accent-line);
}

.input:disabled {
  background-color: var(--color-bg-muted);
  cursor: not-allowed;
}

/* エラー：色だけで見分けず、枠で囲み、先頭に「エラー」と出す。文言は DOM に足さない
   （各画面の文言を変えないため。読み上げでも ::before の文字は読まれる）。 */
.errorBox {
  padding: var(--space-xs) var(--space-sm);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius);
  background-color: var(--color-danger-bg);
  color: var(--color-danger);
}

.errorBox::before {
  content: "エラー";
  margin-right: var(--space-sm);
  font-weight: bold;
}

/* 指摘やモデルの状態を伝える短い注記：臙脂の文字だけ。文言で意味が分かるので枠は付けない。 */
.dangerNote {
  color: var(--color-danger);
}
```

`.errorBox` を付ける要素が `display: flex` のとき（`controlFailure`・`judgmentErrorItem`・`retryNotice`・settings の `.error`）、`::before` は最初の flex の子になる。横並びの要素ではメッセージの左に、縦並び（`controlFailure`）では 1 行目に出る。どちらも「先頭に」を満たすので、そのままにする。

- [ ] **Step 2: 割り当てのテストを先に書く**

各画面の既存のテストファイルに、次を確かめる `test` を 1 つずつ足す（画面の描き方は、そのファイルの既存のテストの準備をそのまま使う）。`import controls from "../../styles/controls.module.css";`（`app/` からは `"../styles/controls.module.css"`）。

| テストファイル | 確かめること |
| --- | --- |
| `app/header.test.tsx` | 「再確認」ボタンの `className` が `controls.secondaryButton` を含む。接続エラーを出したとき、そのメッセージの要素が `controls.errorBox` を含む |
| `features/connection/connection-section.test.tsx` | 「保存」ボタンが `controls.primaryButton`、URL の入力欄が `controls.input` を含む |
| `features/manuscript/manuscript.test.tsx` | 確定のボタンが `controls.primaryButton`、本文の入力欄（textarea）が `controls.input` を含む |
| `features/settings/run-settings-form.test.tsx` | 「検査を開始する」が `controls.primaryButton` を含む。開始が失敗したときのメッセージの要素（`role="alert"`）が `controls.errorBox` を含む |
| `features/run-list/run-list-page.test.tsx` | 取得の失敗のメッセージが `controls.errorBox` を含む |

確かめ方は `expect(button.className).toContain(controls.primaryButton)` の形にする（既存の `finding-list.test.tsx` と同じ）。

Run: 該当のテストファイル → FAIL

- [ ] **Step 3: TSX に共通の部品を付け、feature の CSS から重複を消す**

- 「部品の割り当て」の表のとおりに `controls.*` を付ける。配置の指定が残るクラス（`align-self: flex-start` など）は `` className={`${controls.primaryButton} ${styles.startButton}`} `` のように並べる。配置の指定も残らないクラスは、TSX から外し、CSS からも消す。
- feature の CSS からは、共通の部品と重複する宣言（`padding`・`border`・`border-radius`・`background-color`・`color`・`font-size`・`cursor`・`:disabled`）を消す。`.error` は全部消す（配置の指定がないため）。settings の `.error`（`display: flex` と `gap`）と `.retryNotice` は配置だけ残す。
- `run-settings-form.tsx` の再試行のボタンは、決めたこと 4 の A に従う（`controls.primaryButton` と配置用の `styles.retryButton`。直前のコメントも合わせて直す）。
- connection の `modelNote`（LM Studio でロードしてください…）は `controls.dangerNote` にする。settings の `modelNote` は変えない。
- `settings.module.css` の `.pageSection` のコメントにある「`connection.module.css` と宣言を二重に持っている」は、この PR では触らない（配置の話で、部品の話ではない）。

- [ ] **Step 4: テストと check を通す**

Run: 該当のテストファイル → PASS。`pnpm check` → PASS

- [ ] **Step 5: コミット**

メッセージ：`PR14c: ボタン・入力欄・エラーの枠を共通の部品にし、結果画面以外の画面に使う`

---

### Task 3: 結果画面に共通の部品と明朝体を使う

**Files:**
- Modify: `features/results/run-control.tsx`・`recovery-notice.tsx`・`failed-units.tsx`・`run-header.tsx`・`results-page.tsx`・`judgment-control.tsx`・`finding-detail.tsx`・`finding-list.tsx`
- Modify: `features/results/results-page.module.css`
- Test: `features/results/finding-detail.test.tsx`・`judgment-control.test.tsx`・`run-control.test.tsx`

**Interfaces:**
- Consumes: Task 2 の `controls.module.css`

- [ ] **Step 1: テストを先に書く**

- `judgment-control.test.tsx`：「保存」が `controls.primaryButton`、判断メモの textarea が `controls.input` を含む。保存の失敗を出したとき、そのメッセージが `controls.errorBox` を含む。
- `run-control.test.tsx`：停止などの操作のボタンが `controls.secondaryButton` を含む。操作の失敗を出したとき、その枠が `controls.errorBox` を含む。
- `finding-detail.test.tsx`：
  - 原文の `<p>` と修正案の `<p>`（有効な修正案と、不適切と判定された修正案の両方）が `styles.detailSerif` を含む。
  - 理由の `<p>`（`finding.recheck.reason`）は `styles.detailSerif` を含まない。
  - 「この修正案は再確認で不適切と判定されました」が `controls.dangerNote` を含む。

Run → FAIL

- [ ] **Step 2: 実装する**

- 「部品の割り当て」の表の results の行のとおりに `controls.*` を付ける。`results-page.tsx` の `styles.error`（4 箇所）と `finding-detail.tsx` の `styles.error`（2 箇所、STALE_DETAIL_NOTICE と取得の失敗）は `controls.errorBox` に、`judgmentErrorItem` と `controlFailure` は `controls.errorBox` と並べる。
- `finding-list.tsx` の `findingLocateFailure` と `finding-detail.tsx` の `suggestionInvalidNote` は `controls.dangerNote` にする（`results-page.module.css` の 2 つのクラスは消す）。
- `results-page.module.css` に足す：

  ```css
  /* 詳細の原文と修正案だけ明朝体にして、本文の列と見比べやすくする（UI の見直し 3 節）。
     同じ .detailQuote を使う理由・元候補・位置診断はゴシックのまま。 */
  .detailSerif {
    font-family: var(--font-family-serif);
  }
  ```

  `finding-detail.tsx` の原文（177 行付近）と修正案（257・260 行付近）を `` className={`${styles.detailQuote} ${styles.detailSerif}`} `` にする。
- `results-page.module.css` から、共通の部品と重複する宣言と、使われなくなったクラス（`.error` など）を消す。冒頭のコメントに「色・枠・角丸は `styles/controls.module.css`（PR14c）」と 1 行足す。
- `detailRelatedButton` は灰色の枠のカードのままにし、`:hover { border-color: var(--color-accent-line); }` を足す。

- [ ] **Step 3: テストと check を通す**

Run → PASS。`pnpm check` → PASS。`grep -rn 'styles\.error\b' packages/web/src --include=*.tsx` が 0 件。

- [ ] **Step 4: コミット**

メッセージ：`PR14c: 結果画面に共通の部品を使い、本文と詳細の原文・修正案を明朝体にする`

---

### Task 4: 実ブラウザでの確認と、ドキュメントの更新（Claude が行う）

- [ ] **Step 1: WSL2 の Chrome で全画面を確かめる**

PR14b と同じく、完了済みの実行が入った DB の写しを `SHUTEN_DATA_DIR` に置いて `pnpm dev` を起動する（LLM は呼ばない）。トップ、設定、実行一覧、結果画面、存在しないページを 1920×856 と 1280×600 で開き、次を確かめる。

- 本文の強調が朱の下線、選択中が薄い朱の地。一覧の選択中の行も薄い朱の地。
- 主な操作は朱の塗り、他のボタンは朱の枠だけ。
- 案内文は生成りの地と灰茶の枠。
- エラーの枠の先頭に「エラー」が 1 回だけ出る（接続先を止めてヘッダーの接続エラーを出す。他は `evaluate_script` で `getComputedStyle(el, "::before").content` を確かめる）。
- 本文の列と、詳細の原文・修正案の computed `font-family` が `--font-family-serif` の並びになっている（WSL2 には日本語フォントがないので、明朝で描かれるかは確かめられない）。
- ページ全体がスクロールしない（PR14a の配置が崩れていない）。

- [ ] **Step 2: ドキュメントを更新する**

- この計画：状態を「実装済み」にし、実装時の調整があれば節を足す。
- `docs/plans/2026-09-07-mvp-roadmap.md`：PR14c を完了にする。
- `docs/history.md`：PR14c の段落を足す。Windows での明朝体と朱の見え方はユーザーが確かめることを明記する。

- [ ] **Step 3: check とコミット**

Run: `pnpm check` → PASS
メッセージ：`PR14c: 実ブラウザでの確認と、ロードマップ・経過の更新`

---

## 確かめ方のまとめ

- 自動テスト：コントラスト比と CSS の書き方（Task 1）、各画面の部品の割り当て（Task 2・3）。
- WSL2 の Chrome：配色、枠、「エラー」の出方、配置、`font-family` の指定（Task 4）。
- Windows のブラウザ（ユーザー）：明朝体の見え方、朱と臙脂の色味、本文の強調と選択の見分け。

## 実装時の調整

- **手入力の欄の書体**：`controls.input` は `font: inherit` を持つ。原稿と検査設定の等幅の textarea は、
  `textarea.textarea` と詳細度を上げて等幅を保った。
- **最終レビューで直したこと**：
  - 不適切と判定された修正案の注記は、元の小さい文字（`--font-size-sm`）に戻した。
  - ボタンの `line-height` を 1.2 にした。`font: inherit` で body の 1.6 を受け継ぎ、ボタンが高くなっていたため。
  - 本文の強調の角丸は 0 にした。地がなく下線だけなので、角丸を付けると下線の両端が細くなるため。
  - 一覧の行のフォーカスの枠は、内側（`outline-offset: -2px`）に出した。スクロール領域の端で切れないようにするため。
  - 再試行のボタン（決めたこと 4）のテストを足した。
- **見送ったこと**：
  - 「エラー」と本文の間の余白は、親の `gap` が足されるので、箇所によって少し違う。差が小さいので見送った。
  - `style-guard.test.ts` は、名前付きの色（`red` など）や `border-*-radius` の直書きを検出しない。
    今のコードには該当がないので見送った。
- **選択中の見分け**（ユーザーの確認、2026-10-02）：
  - 当初の地 `#fcebe5` では、本文の選択中の箇所が選択していない強調と見分けにくかった。地は白地との比が約 1.1 で、
    違いが地の色にしかなかったため。
  - 地を `#f6cdbd` に濃くした。あわせて、本文の選択中の下線を太く（0.25em）し、一覧の選択中の行の枠を朱で 2px に見せた
    （内側の影で足すので、行の大きさは変わらない）。地の濃さだけに頼らず、形でも区別する。
  - 濃い地の上では「n 案」の朱の文字の比が 3.67 になり、文字の基準 4.5 を割る。そのため、印は白地で抜いた。
- **足したこと**：ラジオボタンとチェックボックスがブラウザ既定の青のままだった。そのため、`:root` に
  `accent-color: var(--color-accent)` を足して朱にそろえた（見た目だけ）。
- **実ブラウザでの確認**（WSL2 の Chrome。PR14b と同じ DB の写しを使い、LLM は呼んでいない）：
  - 1908×856 と 1280×600 のどちらでも、ページ全体はスクロールしなかった。
  - 本文の強調は朱の下線、選択中の箇所は薄い朱の地になった。一覧の選択中の行も薄い朱の地になった。
  - 主な操作（保存・確定・開始）は朱の塗り、ほかのボタンは朱の枠だけになった。
  - `.errorBox::before` の `content` は「エラー」、文字と枠は臙脂になっていた。
  - 本文の列と、詳細の原文・修正案の computed `font-family` は、明朝の並びになっていた。
  - WSL2 には日本語フォントがないので、明朝体で描かれるかは確かめていない。
