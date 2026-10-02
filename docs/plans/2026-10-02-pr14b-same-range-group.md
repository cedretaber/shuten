# PR14b 詳細計画：同じ範囲の指摘のまとめ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

作成日：2026-10-02
状態：実装済み

**Goal:** 位置が確定していて範囲が完全に一致する指摘を、一覧では 1 行にまとめ、詳細には全部並べて 1 件ずつ採否を付けられるようにする。

**Architecture:** `packages/web` だけを変える。まとめる処理は DOM を持たない純粋な関数として `features/results/finding-group.ts` に置く。一覧（`finding-list.tsx`）は指摘の配列ではなく「まとめ」の配列を描く。詳細（`finding-detail.tsx`）は、まとめた指摘を縦に並べる。選択の状態は今どおり 1 つの指摘 ID で持ち、いつも「まとめの先頭」の ID にそろえる。詳細の取得（`getFinding`）は、まとめた指摘 1 件ずつに対して行う。この取得は新しいフック `use-finding-details.ts` に切り出す。

**Tech Stack:** React 19 + Vite、CSS Modules、Vitest + Testing Library（jsdom）。新しい依存は入れない。

**Spec:** `docs/plans/2026-10-02-ui-refresh.md`（UI の見直しの設計書）の「2. 同じ範囲の指摘のまとめ（PR14b）」。仕様の正本は `docs/spec/mvp-spec.md` 5.3・5.4・6.4。

## Global Constraints

- 変更は `packages/web` だけ。サーバーの API と DTO、`packages/shared` は変えない。
- 表示だけの変更である。仕様 6.4 節の統合規則、保存の単位（採否は指摘 1 件ずつ）、件数の数え方（「n / m 件」は指摘の件数）、評価とエクスポートは変えない。
- まとめる条件は「`locateStatus === "located"` かつ `range !== null` で、`range.start` と `range.end` が両方一致する」だけ。一部だけ重なる指摘と、位置が特定できなかった指摘はまとめない。
- まとめるのは、絞り込みを通った指摘の中だけ。
- 機能を増やさない（表示方式の切り替え、前・次の指摘への移動、キーボード操作、ダークモードは作らない）。仕様書は改訂しない。
- 案内文・ボタン・ラベルの今の文言は変えない。新しく足す文言は次のものだけにする。
  - 一覧の行と重なる指摘のリンクに添える件数：`{n} 案`（n は 2 以上。1 件のときは出さない）
  - 詳細のまとめの各指摘の見出し：`案 {i}：{分類}`（i は 1 から）
  - 詳細の末尾：`絞り込みで非表示：{n} 件`（n は 1 以上。0 のときは出さない）
  - 採否・再確認状態の要約：`{ラベル} {件数}` を `・` でつなぐ（例：`未判断 1・却下 1`）
  - 分類の要約：分類ラベルを `／` でつなぐ（例：`文法／助詞`）
- 本文をブラウザで加工しない。`dangerouslySetInnerHTML` を使わない（PR12a の制約）。
- CSS フレームワーク・UI ライブラリを入れない。色・余白は `styles/tokens.css` の変数を使う（新しい色は足さない。色の差し替えは PR14c）。
- 引用は JS 側で切り詰めない（`finding-list.tsx` 冒頭のコメントのとおり。省略表示は CSS に任せる）。
- ドキュメント・コメント・コミットメッセージは日本語、識別子は英語。
- 各タスクの完了時に `pnpm check` を通す。

## 設計書から先に決めたこと（ユーザーの確認を求める点）

設計書 2 節が決めていない点を、次のように決めた。計画の確認のときに見てほしい。

1. **元候補・位置診断は、まとめた指摘 1 件ずつ取る。** 詳細は今、選択中の 1 件だけ `getFinding` で元候補と位置診断を取っている。この PR からは、まとめの先頭以外の指摘を単独で選ぶ方法がなくなる。そのため、先頭の分しか取らないと、2 件目以降の元候補・位置診断を見る方法がなくなる。まとめは多くて数件なので、まとめた指摘すべてに `getFinding` を投げる。
2. **選択はいつも「まとめの先頭」の ID にそろえる。** 本文の強調・一覧の行・重なる指摘のリンクのどれから選んでも、その指摘を含むまとめの先頭を選択中とする。一覧の行の `data-finding-id` と `aria-current`、本文の強調の選択表示は、この先頭の ID で判定する。
3. **重なる指摘のリンクは、まとめごとに 1 つにする。** 重なる相手が 2 件のまとめなら、リンクは 1 つで、文言は `{分類の要約}：{先頭の引用}（2 案）` とする。押すとそのまとめの先頭が選ばれる。
4. **「同じ範囲の他の指摘」の欄はなくす。** 同じ範囲の指摘は詳細に縦に並ぶので、リンクの欄は要らなくなる。「範囲が重なる他の指摘」の欄は残す。
5. **一覧の行の再確認状態も要約する。** 設計書は分類と採否の要約だけを書いているが、今の行は再確認状態も出している。採否と同じ規則で、全員が同じなら 1 つ、違えば件数を並べる。
6. **分類の区切りは `／` にする。** 設計書の例は「文法・助詞」だが、分類のラベルには「誤字・表記」「脱字・重複」のように `・` を含むものがある。`・` でつなぐと「誤字・表記・文法」となり、どこで区切るのか分からない。採否と再確認状態の要約は、ラベルに `・` を含まないので `・` のままにする。
7. **詳細の並び。** 先頭に見出し（分類の要約と原文）、次に原文を 1 回だけ出す。続けて、まとめた指摘ごとに［許容語の注記 → 修正案 → 採否 → 理由 → 判定 → 更新の失敗の 1 行 → 元候補・位置診断］を並べる。その後に「絞り込みで非表示：n 件」「範囲が重なる他の指摘」「本文の該当箇所へ移動」を置く。まとめていない指摘も同じ並びにする。そのため今と比べて、許容語の注記が原文の後へ、移動のボタンが元候補・位置診断の後へ移る。

## Review Focus

テストでは押さえきれず、使う人が最初に踏みそうな入力と状態。各行のテストは担当するタスクに入れてある。

1. **採否を「未判断」だけに絞り、まとめの先頭を「却下」にしたとき**：2 件目がまだ表示対象なので、詳細は閉じずに 2 件目へ移る。→ Task 2 のテスト。
2. **まとめの 2 件目の判断メモを書きかけたまま、先頭の採否を保存して先頭が絞り込みから外れたとき**：2 件目の書きかけのメモは消えない。→ Task 4 のテスト。引き継ぎ先を描画の中で求めて詳細を一度も閉じないこと（Task 2）と、指摘ごとの区画を `key={finding.id}` で作り、まとめが 2 件から 1 件になっても作り直されない構造にすること（Task 4）で守る。
3. **自動更新で、選択中のまとめに同じ範囲の指摘が増えたとき**：詳細に増えた指摘が足され、その指摘の詳細だけを取りに行く。すでに出ている指摘の元候補は「読み込み中…」に戻らない。→ Task 3 のテスト。
4. **位置が特定できなかった指摘で、引用が同じものが複数あるとき**：まとめずに 1 件ずつ出る。→ Task 1 のテスト。
5. **まとめた指摘が多く（5 件など）、詳細の枠に入りきらないとき**：詳細の枠の中でスクロールでき、後ろの指摘の採否にも届く。→ Task 5 の実ブラウザでの確認。

---

## ファイルの構成

| ファイル | 役割 | 変更 |
| --- | --- | --- |
| `packages/web/src/features/results/finding-group.ts` | まとめる処理の純関数 | 新規 |
| `packages/web/src/features/results/finding-group.test.ts` | 同上のテスト | 新規 |
| `packages/web/src/features/results/finding-list.tsx` | 一覧 | まとめの配列を描く。件数の要約と「n 案」を出す |
| `packages/web/src/features/results/finding-list.test.tsx` | 同上のテスト | まとめを渡す形に直し、テストを足す |
| `packages/web/src/features/results/use-finding-details.ts` | まとめた指摘の詳細の取得 | 新規 |
| `packages/web/src/features/results/use-finding-details.test.tsx` | 同上のテスト | 新規 |
| `packages/web/src/features/results/finding-detail.tsx` | 詳細 | まとめた指摘を縦に並べる。同じ範囲の欄をなくし、重なる指摘をまとめ単位にする |
| `packages/web/src/features/results/finding-detail.test.tsx` | 同上のテスト | props の形に合わせて直し、テストを足す |
| `packages/web/src/features/results/finding-detail.ts` | 詳細の純関数 | 使われなくなる `relatedFindings` を消す |
| `packages/web/src/features/results/finding-detail.test.ts` | 同上のテスト | `relatedFindings` のテストを消す（同じ境界は `finding-group.test.ts` の `overlappingGroups` で見る） |
| `packages/web/src/features/results/results-page.tsx` | 結果画面 | まとめを作り、選択を先頭にそろえ、引き継ぎの規則を入れる。詳細の取得をフックに替える |
| `packages/web/src/features/results/results-page.test.tsx` | 結果画面のテスト | まとめ・引き継ぎ・詳細のテストを足し、同じ範囲のリンクのテストを置き換える |
| `packages/web/src/features/results/results-page.module.css` | 結果画面の CSS | 「n 案」の印、詳細のまとめの区切り |
| `docs/plans/2026-09-07-mvp-roadmap.md` | ロードマップ | PR14b を完了にする |
| `docs/history.md` | 経過 | 1 段落足す |

---

### Task 1: まとめる処理の純関数 `finding-group.ts`

**Files:**
- Create: `packages/web/src/features/results/finding-group.ts`
- Test: `packages/web/src/features/results/finding-group.test.ts`

**Interfaces:**
- Consumes: `recheckStateOf`、`RECHECK_STATES`、`RECHECK_STATE_LABELS`（`finding-filter.ts`）、`FINDING_CATEGORY_LABELS`、`JUDGMENT_STATUS_LABELS`（`labels.ts`）、`JUDGMENT_STATUSES`（`@shuten/shared`）
- Produces（Task 2・4 が使う）:
  - `export interface FindingGroup { readonly head: FindingDto; readonly members: readonly FindingDto[] }`
  - `export function sameRangeKey(finding: FindingDto): string | null`
  - `export function groupFindings(visible: readonly FindingDto[]): FindingGroup[]`
  - `export function groupContaining(groups: readonly FindingGroup[], findingId: string): FindingGroup | null`
  - `export function nextSelection(selectedId: string | null, all: readonly FindingDto[], groups: readonly FindingGroup[]): string | null`
  - `export function hiddenSameRangeCount(group: FindingGroup, all: readonly FindingDto[]): number`
  - `export function overlappingGroups(group: FindingGroup, groups: readonly FindingGroup[]): FindingGroup[]`
  - `export function summarizeCategories(members: readonly FindingDto[]): string`
  - `export function summarizeJudgments(members: readonly FindingDto[]): string`
  - `export function summarizeRecheckStates(members: readonly FindingDto[]): string`

- [ ] **Step 1: 失敗するテストを書く**

`packages/web/src/features/results/finding-group.test.ts` を作る。

```ts
import type { FindingDto } from "@shuten/shared";
import { describe, expect, it } from "vitest";
import {
  type FindingGroup,
  groupContaining,
  groupFindings,
  hiddenSameRangeCount,
  nextSelection,
  overlappingGroups,
  sameRangeKey,
  summarizeCategories,
  summarizeJudgments,
  summarizeRecheckStates,
} from "./finding-group.ts";

/**
 * 同じ範囲の指摘のまとめ（PR14b。UI の見直し 2 節）の純関数。DOM は描かない。
 */

function makeFinding(overrides: Partial<FindingDto> = {}): FindingDto {
  const id = overrides.id ?? "finding-1";
  return {
    id,
    runId: "run-1",
    targetId: "target-1",
    locateStatus: "located",
    range: { start: 0, end: 1 },
    paragraphId: 0,
    quote: "あ",
    suggestion: null,
    category: "notation",
    initialVerdict: "likely-error",
    suppression: null,
    reasons: [],
    recheck: null,
    judgment: {
      findingId: id,
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
    createdAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function at(id: string, start: number, end: number, overrides: Partial<FindingDto> = {}) {
  return makeFinding({ id, range: { start, end }, ...overrides });
}

function withJudgment(finding: FindingDto, status: FindingDto["judgment"]["status"]): FindingDto {
  return { ...finding, judgment: { ...finding.judgment, status } };
}

function ids(groups: readonly FindingGroup[]): string[][] {
  return groups.map((group) => group.members.map((member) => member.id));
}

describe("sameRangeKey", () => {
  it("位置が確定していれば開始と終了からキーを作る", () => {
    expect(sameRangeKey(at("a", 3, 7))).toBe("3:7");
  });

  it("位置が特定できなかった指摘は null（まとめない）", () => {
    expect(sameRangeKey(makeFinding({ locateStatus: "not-found", range: null }))).toBeNull();
    expect(sameRangeKey(makeFinding({ locateStatus: "ambiguous", range: null }))).toBeNull();
  });

  it("located でも range が null なら null（toHighlights と同じく両方を見る）", () => {
    expect(sameRangeKey(makeFinding({ locateStatus: "located", range: null }))).toBeNull();
  });
});

describe("groupFindings", () => {
  it("範囲が完全に一致する指摘だけをまとめる", () => {
    expect(ids(groupFindings([at("a", 0, 5), at("b", 0, 5)]))).toEqual([["a", "b"]]);
  });

  it("一部だけ重なる指摘はまとめない", () => {
    expect(ids(groupFindings([at("a", 0, 5), at("b", 3, 8)]))).toEqual([["a"], ["b"]]);
  });

  it("開始だけ同じ・終了だけ同じ指摘はまとめない", () => {
    expect(ids(groupFindings([at("a", 0, 5), at("b", 0, 6), at("c", 1, 6)]))).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });

  it("隣り合うだけの指摘はまとめない", () => {
    expect(ids(groupFindings([at("a", 0, 5), at("b", 5, 10)]))).toEqual([["a"], ["b"]]);
  });

  it("位置が特定できなかった指摘は、引用が同じでもまとめない", () => {
    const a = makeFinding({ id: "a", locateStatus: "not-found", range: null, quote: "同じ" });
    const b = makeFinding({ id: "b", locateStatus: "not-found", range: null, quote: "同じ" });
    expect(ids(groupFindings([a, b]))).toEqual([["a"], ["b"]]);
  });

  it("渡された順を保ち、まとめは先頭の指摘の位置に置く（間に別の指摘が挟まっても）", () => {
    // サーバーの順は start 昇順なので、同じ start で end の違う指摘が間に入りうる。
    const groups = groupFindings([at("a", 0, 5), at("b", 0, 9), at("c", 0, 5), at("d", 6, 7)]);
    expect(ids(groups)).toEqual([["a", "c"], ["b"], ["d"]]);
    expect(groups[0]?.head.id).toBe("a");
  });

  it("空の配列なら空の配列", () => {
    expect(groupFindings([])).toEqual([]);
  });
});

describe("groupContaining", () => {
  const groups = groupFindings([at("a", 0, 5), at("b", 0, 5), at("c", 6, 7)]);

  it("先頭でない指摘の ID からも、その指摘を含むまとめを返す", () => {
    expect(groupContaining(groups, "b")?.head.id).toBe("a");
    expect(groupContaining(groups, "c")?.head.id).toBe("c");
  });

  it("どのまとめにも無ければ null", () => {
    expect(groupContaining(groups, "x")).toBeNull();
  });
});

describe("nextSelection（選択の引き継ぎ。UI の見直し 2 節）", () => {
  it("null なら null", () => {
    expect(nextSelection(null, [], [])).toBeNull();
  });

  it("表示中のまとめの先頭なら、そのまま", () => {
    const all = [at("a", 0, 5), at("b", 0, 5)];
    expect(nextSelection("a", all, groupFindings(all))).toBe("a");
  });

  it("表示中のまとめの先頭でない指摘なら、先頭にそろえる", () => {
    const all = [at("a", 0, 5), at("b", 0, 5)];
    expect(nextSelection("b", all, groupFindings(all))).toBe("a");
  });

  it("絞り込みから外れても、同じ範囲で表示中の指摘が残っていれば、そのまとめの先頭へ移る", () => {
    const a = at("a", 0, 5);
    const b = at("b", 0, 5);
    const c = at("c", 0, 5);
    // a が外れ、b と c が残る。
    expect(nextSelection("a", [a, b, c], groupFindings([b, c]))).toBe("b");
  });

  it("同じ範囲で表示中の指摘が残っていなければ null", () => {
    const a = at("a", 0, 5);
    const other = at("x", 6, 7);
    expect(nextSelection("a", [a, other], groupFindings([other]))).toBeNull();
  });

  it("一部だけ重なる指摘が残っていても、引き継がない", () => {
    const a = at("a", 0, 5);
    const overlapping = at("b", 3, 8);
    expect(nextSelection("a", [a, overlapping], groupFindings([overlapping]))).toBeNull();
  });

  it("位置が特定できなかった指摘が外れたら null", () => {
    const a = makeFinding({ id: "a", locateStatus: "not-found", range: null });
    expect(nextSelection("a", [a], [])).toBeNull();
  });

  it("再取得で指摘そのものが無くなったら null", () => {
    const b = at("b", 0, 5);
    expect(nextSelection("a", [b], groupFindings([b]))).toBeNull();
  });
});

describe("hiddenSameRangeCount", () => {
  it("同じ範囲で、まとめに入っていない（絞り込みで隠れた）指摘の数", () => {
    const a = at("a", 0, 5);
    const b = at("b", 0, 5);
    const c = at("c", 0, 5);
    const other = at("x", 0, 6);
    const [group] = groupFindings([a]);
    if (group === undefined) throw new Error("まとめが無い");
    expect(hiddenSameRangeCount(group, [a, b, c, other])).toBe(2);
  });

  it("隠れた指摘が無ければ 0", () => {
    const all = [at("a", 0, 5), at("b", 0, 5)];
    const [group] = groupFindings(all);
    if (group === undefined) throw new Error("まとめが無い");
    expect(hiddenSameRangeCount(group, all)).toBe(0);
  });

  it("位置が特定できなかった指摘のまとめは 0", () => {
    const a = makeFinding({ id: "a", locateStatus: "not-found", range: null });
    const b = makeFinding({ id: "b", locateStatus: "not-found", range: null });
    const [group] = groupFindings([a]);
    if (group === undefined) throw new Error("まとめが無い");
    expect(hiddenSameRangeCount(group, [a, b])).toBe(0);
  });
});

describe("overlappingGroups", () => {
  it("範囲が一部だけ重なるまとめを返し、自分・隣接・離れたもの・位置未確定は含めない", () => {
    const visible = [
      at("self", 5, 10),
      at("left", 3, 6),
      at("right-1", 9, 12),
      at("right-2", 9, 12),
      at("adjacent", 10, 11),
      at("far", 20, 21),
      makeFinding({ id: "unlocated", locateStatus: "not-found", range: null }),
    ];
    const groups = groupFindings(visible);
    const self = groupContaining(groups, "self");
    if (self === null) throw new Error("まとめが無い");
    expect(ids(overlappingGroups(self, groups))).toEqual([["left"], ["right-1", "right-2"]]);
  });

  it("位置が特定できなかった指摘のまとめなら空", () => {
    const unlocated = makeFinding({ id: "u", locateStatus: "not-found", range: null });
    const groups = groupFindings([unlocated, at("a", 0, 5)]);
    const self = groupContaining(groups, "u");
    if (self === null) throw new Error("まとめが無い");
    expect(overlappingGroups(self, groups)).toEqual([]);
  });
});

describe("要約（一覧の行と詳細の見出し）", () => {
  it("分類は重複を除き、並びの順に「／」でつなぐ", () => {
    expect(
      summarizeCategories([
        at("a", 0, 5, { category: "grammar" }),
        at("b", 0, 5, { category: "particle" }),
        at("c", 0, 5, { category: "grammar" }),
      ]),
    ).toBe("文法／助詞");
  });

  it("分類が 1 つなら、そのラベルだけ（「・」を含むラベルもそのまま）", () => {
    expect(summarizeCategories([at("a", 0, 5), at("b", 0, 5)])).toBe("誤字・表記");
  });

  it("採否が全員同じなら、そのラベルだけ", () => {
    expect(summarizeJudgments([at("a", 0, 5), at("b", 0, 5)])).toBe("未判断");
  });

  it("採否が違えば、採否の定義順に件数を添えて「・」でつなぐ", () => {
    expect(
      summarizeJudgments([
        withJudgment(at("a", 0, 5), "rejected"),
        at("b", 0, 5),
        withJudgment(at("c", 0, 5), "rejected"),
      ]),
    ).toBe("未判断 1・却下 2");
  });

  it("再確認の状態も同じ規則で要約する", () => {
    const done = {
      id: "r",
      status: "done",
      notApplicableReason: null,
      verdict: "keep",
      reasonKind: null,
      reason: null,
      suggestionValid: null,
      failure: null,
    } as const;
    expect(summarizeRecheckStates([at("a", 0, 5), at("b", 0, 5)])).toBe("再確認なし");
    expect(
      summarizeRecheckStates([at("a", 0, 5, { recheck: done }), at("b", 0, 5)]),
    ).toBe("再確認なし 1・再確認済み 1");
  });

  it("1 件だけなら、そのラベルだけ", () => {
    const one = [withJudgment(at("a", 0, 5), "held")];
    expect(summarizeJudgments(one)).toBe("保留");
    expect(summarizeCategories(one)).toBe("誤字・表記");
  });
});
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/finding-group.test.ts`
Expected: FAIL（`./finding-group.ts` が無い）

- [ ] **Step 3: 実装する**

`packages/web/src/features/results/finding-group.ts` を作る。

```ts
/**
 * 同じ範囲の指摘のまとめ（PR14b。UI の見直し 2 節）の純関数。
 *
 * 位置が確定していて、範囲（UTF-16 の `[start, end)`）が完全に一致する指摘だけを 1 つの
 * 「まとめ」にする。一部だけ重なる指摘と、位置が特定できなかった指摘はまとめず、1 件ずつの
 * まとめとして扱う。表示だけの変更なので、仕様 6.4 節の統合規則・採否の単位・件数の数え方は
 * 変えない（採否は指摘 1 件ずつ保存し、件数は指摘の数で数える）。
 *
 * まとめるのは、絞り込みを通った指摘（`visibleFindings` の結果）の中だけ。並び順は渡された順
 * （サーバーの順＝本文の位置順）のままで、まとめは先頭の指摘の位置に置く。同じ範囲なら本文の
 * 位置も同じなので、先頭は「渡された順で最初」の指摘になる。
 *
 * DOM は持たない。一覧（`finding-list.tsx`）・詳細（`finding-detail.tsx`）・結果画面
 * （`results-page.tsx`）がここを使う。
 */

import type { FindingDto, JudgmentStatus } from "@shuten/shared";
import { JUDGMENT_STATUSES } from "@shuten/shared";
import {
  RECHECK_STATE_LABELS,
  RECHECK_STATES,
  type RecheckState,
  recheckStateOf,
} from "./finding-filter.ts";
import { FINDING_CATEGORY_LABELS, JUDGMENT_STATUS_LABELS } from "./labels.ts";

export interface FindingGroup {
  /** まとめの先頭。一覧の行と選択は、この指摘の ID で表す。 */
  readonly head: FindingDto;
  /** まとめた指摘（先頭を含む）。絞り込みを通った指摘だけで、渡された順のまま。 */
  readonly members: readonly FindingDto[];
}

/**
 * 同じ範囲かどうかを比べるためのキー。位置が確定していなければ null（まとめない）。
 * `toHighlights` と同じく、`locateStatus` と `range` の両方を見る。
 */
export function sameRangeKey(finding: FindingDto): string | null {
  if (finding.locateStatus !== "located" || finding.range === null) {
    return null;
  }
  return `${finding.range.start}:${finding.range.end}`;
}

/** 絞り込みを通った指摘を、同じ範囲ごとにまとめる。 */
export function groupFindings(visible: readonly FindingDto[]): FindingGroup[] {
  const groups: { head: FindingDto; members: FindingDto[] }[] = [];
  const byKey = new Map<string, { head: FindingDto; members: FindingDto[] }>();
  for (const finding of visible) {
    const key = sameRangeKey(finding);
    if (key !== null) {
      const existing = byKey.get(key);
      if (existing !== undefined) {
        existing.members.push(finding);
        continue;
      }
    }
    const group = { head: finding, members: [finding] };
    groups.push(group);
    if (key !== null) {
      byKey.set(key, group);
    }
  }
  return groups;
}

/** その指摘を含むまとめ。先頭でない指摘の ID からも引ける。無ければ null。 */
export function groupContaining(
  groups: readonly FindingGroup[],
  findingId: string,
): FindingGroup | null {
  return groups.find((group) => group.members.some((member) => member.id === findingId)) ?? null;
}

/**
 * 選択中の指摘 ID を、今のまとめに合わせて決め直す（UI の見直し 2 節「選択中の指摘が
 * 絞り込みから外れたとき」）。
 *
 * - 表示中のまとめに入っていれば、そのまとめの先頭。
 * - 絞り込みから外れていても、同じ範囲で表示中の指摘が残っていれば、そのまとめの先頭。
 * - どちらでもなければ null（今どおり選択を外す）。
 *
 * `all` は絞り込み前の全件。外れた指摘の範囲を知るために使う。
 */
export function nextSelection(
  selectedId: string | null,
  all: readonly FindingDto[],
  groups: readonly FindingGroup[],
): string | null {
  if (selectedId === null) {
    return null;
  }
  const containing = groupContaining(groups, selectedId);
  if (containing !== null) {
    return containing.head.id;
  }
  const selected = all.find((finding) => finding.id === selectedId);
  if (selected === undefined) {
    return null;
  }
  const key = sameRangeKey(selected);
  if (key === null) {
    return null;
  }
  const successor = groups.find((group) => sameRangeKey(group.head) === key);
  return successor === undefined ? null : successor.head.id;
}

/** 同じ範囲なのに、絞り込みで隠れてまとめに入っていない指摘の数。 */
export function hiddenSameRangeCount(group: FindingGroup, all: readonly FindingDto[]): number {
  const key = sameRangeKey(group.head);
  if (key === null) {
    return 0;
  }
  const memberIds = new Set(group.members.map((member) => member.id));
  let count = 0;
  for (const finding of all) {
    if (!memberIds.has(finding.id) && sameRangeKey(finding) === key) {
      count += 1;
    }
  }
  return count;
}

/**
 * 範囲が一部だけ重なる、ほかのまとめ。隣り合うだけ（`[0,5)` と `[5,10)`）は含めない。
 * 範囲が完全に一致するものは同じまとめに入っているので、ここには出てこない。
 */
export function overlappingGroups(
  group: FindingGroup,
  groups: readonly FindingGroup[],
): FindingGroup[] {
  const range = group.head.range;
  if (sameRangeKey(group.head) === null || range === null) {
    return [];
  }
  return groups.filter((other) => {
    if (other.head.id === group.head.id) {
      return false;
    }
    const otherRange = other.head.range;
    if (sameRangeKey(other.head) === null || otherRange === null) {
      return false;
    }
    return otherRange.start < range.end && range.start < otherRange.end;
  });
}

/**
 * 分類の要約。重複を除き、並びの順に「／」でつなぐ。分類のラベルには「誤字・表記」のように
 * 「・」を含むものがあるので、区切りに「・」は使わない。
 */
export function summarizeCategories(members: readonly FindingDto[]): string {
  const labels: string[] = [];
  for (const member of members) {
    const label = FINDING_CATEGORY_LABELS[member.category];
    if (!labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels.join("／");
}

/**
 * 値の要約。全員が同じならそのラベルだけ、違えば `order` の順に「ラベル 件数」を「・」で
 * つなぐ（例：「未判断 1・却下 1」）。
 */
function summarizeCounts<T extends string>(
  values: readonly T[],
  order: readonly T[],
  labels: Readonly<Record<T, string>>,
): string {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const present = order.filter((value) => counts.has(value));
  const [only] = present;
  if (present.length === 1 && only !== undefined) {
    return labels[only];
  }
  return present.map((value) => `${labels[value]} ${counts.get(value) ?? 0}`).join("・");
}

export function summarizeJudgments(members: readonly FindingDto[]): string {
  return summarizeCounts<JudgmentStatus>(
    members.map((member) => member.judgment.status),
    JUDGMENT_STATUSES,
    JUDGMENT_STATUS_LABELS,
  );
}

export function summarizeRecheckStates(members: readonly FindingDto[]): string {
  return summarizeCounts<RecheckState>(
    members.map((member) => recheckStateOf(member)),
    RECHECK_STATES,
    RECHECK_STATE_LABELS,
  );
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/finding-group.test.ts`
Expected: PASS

- [ ] **Step 5: `pnpm check` を通してコミットする**

```bash
pnpm check
git add packages/web/src/features/results/finding-group.ts packages/web/src/features/results/finding-group.test.ts
git commit -m "PR14b: 同じ範囲の指摘をまとめる純関数を足す"
```

---

### Task 2: 一覧を「まとめ」で描き、選択を先頭にそろえ、絞り込みから外れたら引き継ぐ

**Files:**
- Modify: `packages/web/src/features/results/finding-list.tsx`
- Modify: `packages/web/src/features/results/finding-list.test.tsx`
- Modify: `packages/web/src/features/results/results-page.tsx`
- Modify: `packages/web/src/features/results/results-page.test.tsx`
- Modify: `packages/web/src/features/results/results-page.module.css`

**Interfaces:**
- Consumes（Task 1）: `FindingGroup`、`groupFindings`、`groupContaining`、`nextSelection`、`summarizeCategories`、`summarizeJudgments`、`summarizeRecheckStates`
- Produces: `FindingListProps` が `{ groups: readonly FindingGroup[]; selectedFindingId: string | null; onSelectFinding: (findingId: string) => void }` になる。`results-page.tsx` の中で `groups`（`useMemo`）、`groupsRef`、`effectiveSelectedId`（`useMemo`）を持つ。Task 4 がこれを使う。

この Task では、詳細（`FindingDetail`）にはまだ手を入れない。詳細は今までどおり選択中の 1 件（まとめの先頭）を出し、`sameRange` も今の `relatedFindings` のまま渡す。詳細のまとめ表示は Task 4 で行う。

- [ ] **Step 1: 一覧の失敗するテストを書く**

`finding-list.test.tsx` を直す。

1. `FindingList` は `groups` を受け取るようになるので、既存のテストの `findings={...}` を `groups={groupFindings(...)}` に置き換える（import に `groupFindings` を足す）。
2. 今のテストの `makeFinding` は既定の `range` が `{ start: 0, end: 1 }` なので、ID だけ違う指摘を並べると 1 つにまとまってしまう。行数・順・クリックを見ているテスト（「見つかった件数ぶんのボタンが並ぶ」「渡された順のまま描く」「行をクリックすると…」と、`findings` に 2 件以上を並べているほかのテスト）では、指摘ごとに `range: { start: i, end: i + 1 }` を付けて範囲を分ける。期待は変えない。
3. 次のテストを足す。

```tsx
describe("FindingList: 同じ範囲の指摘のまとめ（PR14b）", () => {
  it("同じ範囲の指摘は 1 行になり、引用に「2 案」を添える", () => {
    const groups = groupFindings([
      makeFinding({ id: "f1", range: { start: 0, end: 2 }, quote: "声が出す" }),
      makeFinding({ id: "f2", range: { start: 0, end: 2 }, quote: "声が出す" }),
      makeFinding({ id: "f3", range: { start: 5, end: 6 }, quote: "別" }),
    ]);
    render(<FindingList groups={groups} selectedFindingId={null} onSelectFinding={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(within(buttons[0] as HTMLElement).getByText("2 案")).toBeInTheDocument();
    expect(within(buttons[1] as HTMLElement).queryByText(/案$/)).not.toBeInTheDocument();
  });

  it("分類・採否・再確認状態は、違えば要約して並べる", () => {
    const groups = groupFindings([
      makeFinding({ id: "f1", category: "grammar", range: { start: 0, end: 2 } }),
      makeFinding({
        id: "f2",
        category: "particle",
        range: { start: 0, end: 2 },
        judgment: {
          findingId: "f2",
          status: "rejected",
          note: null,
          updatedAt: "2026-09-10T00:00:00.000Z",
        },
      }),
    ]);
    render(<FindingList groups={groups} selectedFindingId={null} onSelectFinding={vi.fn()} />);
    const row = screen.getByRole("button");
    expect(within(row).getByText("文法／助詞")).toBeInTheDocument();
    expect(within(row).getByText("未判断 1・却下 1")).toBeInTheDocument();
    expect(within(row).getByText("再確認なし")).toBeInTheDocument();
  });

  it("行は先頭の ID で選ばれ、先頭の ID が選択中なら選択状態になる", async () => {
    const user = userEvent.setup();
    const onSelectFinding = vi.fn();
    const groups = groupFindings([
      makeFinding({ id: "f1", range: { start: 0, end: 2 } }),
      makeFinding({ id: "f2", range: { start: 0, end: 2 } }),
    ]);
    render(<FindingList groups={groups} selectedFindingId="f1" onSelectFinding={onSelectFinding} />);
    const row = screen.getByRole("button");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.closest("li")?.getAttribute("data-finding-id")).toBe("f1");
    await user.click(row);
    expect(onSelectFinding).toHaveBeenCalledWith("f1");
  });
});
```

（`within` は `@testing-library/react` から import する。）

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/finding-list.test.tsx`
Expected: FAIL（`groups` を受け取らない）

- [ ] **Step 3: `finding-list.tsx` を直す**

冒頭のコメントに、PR14b で「まとめ」を描くようになったことを 1 段落足す（同じ範囲の指摘は 1 行、行は先頭の ID で表す、分類・採否・再確認状態は要約する）。本体は次のとおりにする。

```tsx
import type { FindingGroup } from "./finding-group.ts";
import {
  summarizeCategories,
  summarizeJudgments,
  summarizeRecheckStates,
} from "./finding-group.ts";
import { FINDING_LOCATE_STATUS_LABELS } from "./labels.ts";
import styles from "./results-page.module.css";

export interface FindingListProps {
  /** 絞り込み後の指摘を同じ範囲ごとにまとめたもの（呼び出し側が渡した順のまま描く）。 */
  readonly groups: readonly FindingGroup[];
  /** 選択中の指摘 ID（まとめの先頭の ID）。無ければ null。 */
  readonly selectedFindingId: string | null;
  readonly onSelectFinding: (findingId: string) => void;
}

export function FindingList(props: FindingListProps) {
  const { groups, selectedFindingId, onSelectFinding } = props;

  if (groups.length === 0) {
    return <p>絞り込みに一致する指摘はありません</p>;
  }

  return (
    <ul className={styles.findingList}>
      {groups.map((group) => (
        <FindingListItem
          key={group.head.id}
          group={group}
          selected={group.head.id === selectedFindingId}
          onSelectFinding={onSelectFinding}
        />
      ))}
    </ul>
  );
}

function FindingListItem(props: {
  readonly group: FindingGroup;
  readonly selected: boolean;
  readonly onSelectFinding: (findingId: string) => void;
}) {
  const { group, selected, onSelectFinding } = props;
  const { head, members } = group;
  const rowClassName = selected
    ? `${styles.findingRow} ${styles.findingRowSelected}`
    : styles.findingRow;

  return (
    <li data-finding-id={head.id}>
      <button
        type="button"
        className={rowClassName}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelectFinding(head.id)}
      >
        <span className={styles.findingMeta}>
          <span>{summarizeCategories(members)}</span>
          <span>{summarizeJudgments(members)}</span>
          <span>{summarizeRecheckStates(members)}</span>
          {head.locateStatus !== "located" && (
            <span className={styles.findingLocateFailure}>
              {FINDING_LOCATE_STATUS_LABELS[head.locateStatus]}
            </span>
          )}
        </span>
        <span className={styles.findingQuoteLine}>
          <span className={styles.findingQuote}>{head.quote}</span>
          {members.length > 1 && (
            <span className={styles.findingGroupCount}>{members.length} 案</span>
          )}
        </span>
      </button>
    </li>
  );
}
```

まとめは位置が確定した指摘だけなので、位置未確定の印（`findingLocateFailure`）が出るのは 1 件だけのまとめに限られる。

`results-page.module.css` の `.findingQuote` の直後に足す。

```css
/* 引用と「n 案」の印を 1 行に並べる（PR14b）。引用は残りの幅で省略表示する。 */
.findingQuoteLine {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
  width: 100%;
  min-width: 0;
}

.findingQuoteLine .findingQuote {
  flex: 1 1 auto;
  width: auto;
}

.findingGroupCount {
  flex: none;
  padding: 0 var(--space-xs);
  border: 1px solid var(--color-accent);
  border-radius: 999px;
  font-size: var(--font-size-sm);
  color: var(--color-accent);
}
```

- [ ] **Step 4: 一覧のテストが通ることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/finding-list.test.tsx`
Expected: PASS

- [ ] **Step 5: 結果画面の失敗するテストを書く**

`results-page.test.tsx` を直す。

1. 「ResultsPage: PR21 レビュー指摘 2 保存の失敗は選択を変えても消えない」の `finding2` に `range: { start: 5, end: 6 }, paragraphId: 1` を足す（同じ範囲にまとまって 1 行になるのを避ける。期待は変えない）。
2. 「他の指摘（同じ範囲）のリンクをクリックすると選択が移り、getFinding がその指摘で呼ばれる」を消す。代わりに下の「同じ範囲の指摘は一覧で 1 行になり、先頭が選ばれる」を足す（同じ範囲の指摘はもうリンクで行き来しない）。
3. ファイル末尾に次の `describe` を足す。

```tsx
// PR14b（UI の見直し 2 節）：同じ範囲の指摘のまとめ。まとめる規則そのものは
// finding-group.test.ts、一覧の行の描き方は finding-list.test.tsx の役割。ここでは配線
// （選択を先頭にそろえること、絞り込みから外れたときの引き継ぎ）を見る。
describe("ResultsPage: 同じ範囲の指摘のまとめ（PR14b）", () => {
  function sameRangePair(
    first: Partial<FindingDto> = {},
    second: Partial<FindingDto> = {},
  ): [FindingDto, FindingDto] {
    return [
      makeFinding({ id: "finding-1", range: { start: 0, end: 1 }, quote: "一", ...first }),
      makeFinding({
        id: "finding-2",
        range: { start: 0, end: 1 },
        quote: "一",
        ...second,
        judgment: {
          findingId: "finding-2",
          status: "undecided",
          note: null,
          updatedAt: "2026-09-10T00:00:00.000Z",
          ...second.judgment,
        },
      }),
    ];
  }

  function setup(findings: readonly FindingDto[], extra: Partial<ApiClient> = {}) {
    const getFinding = vi.fn((findingId: string) =>
      Promise.resolve(makeFindingDetail({ id: findingId })),
    );
    const client = makeClient({
      getRun: () => Promise.resolve(makeRunDetail({ status: "completed" })),
      getManuscript: () => Promise.resolve(makeManuscript()),
      getFindings: () => Promise.resolve([...findings]),
      getFinding,
      ...extra,
    });
    return { client, getFinding };
  }

  function rows() {
    return Array.from(document.querySelectorAll<HTMLElement>(`.${findingListStyles.findingRow}`));
  }

  it("同じ範囲の指摘は一覧で 1 行になり、件数は指摘の数のまま、先頭が選ばれる", async () => {
    const user = userEvent.setup();
    const { client, getFinding } = setup(sameRangePair());
    renderPage(client);

    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0] as HTMLElement).getByText("2 案")).toBeInTheDocument();

    await user.click(rows()[0] as HTMLElement);
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-1"));
    expect(rows()[0]?.getAttribute("aria-current")).toBe("true");
  });

  it("本文の強調から選んでも、まとめの先頭が選ばれる", async () => {
    const user = userEvent.setup();
    const { client, getFinding } = setup(sameRangePair());
    renderPage(client);

    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());
    const span = document.querySelector('[data-findings~="finding-2"]') as HTMLElement;
    await user.click(span);

    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-1"));
    expect(rows()[0]?.getAttribute("aria-current")).toBe("true");
    expect(span.className).toContain("highlightSelected");
  });

  it("分類の絞り込みで先頭だけが外れたら、同じ範囲で残った指摘へ選択が移る", async () => {
    const user = userEvent.setup();
    const { client, getFinding } = setup(
      sameRangePair({ category: "notation" }, { category: "grammar" }),
    );
    renderPage(client);

    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());
    await user.click(rows()[0] as HTMLElement);
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-1"));

    await user.click(screen.getByRole("checkbox", { name: "誤字・表記" }));

    await waitFor(() => expect(screen.getByText("1 / 2 件")).toBeInTheDocument());
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-2"));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.getAttribute("aria-current")).toBe("true");
    expect(rows()[0]?.closest("li")?.getAttribute("data-finding-id")).toBe("finding-2");
    expect(document.querySelector(`.${findingListStyles.detail}`)).not.toBeNull();
  });

  it("採否を「未判断」だけに絞り、先頭を却下にしたら、詳細は閉じずに残った指摘へ移る", async () => {
    const user = userEvent.setup();
    const rejected: JudgmentDto = {
      findingId: "finding-1",
      status: "rejected",
      note: null,
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    const putJudgment = vi.fn(() => Promise.resolve(rejected));
    const { client, getFinding } = setup(sameRangePair(), { putJudgment });
    renderPage(client);

    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", { name: "採用予定" }));
    await user.click(screen.getByRole("checkbox", { name: "却下" }));
    await user.click(screen.getByRole("checkbox", { name: "保留" }));
    await user.click(rows()[0] as HTMLElement);
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-1"));

    // 先頭（finding-1）の採否の操作子は、詳細の中で最初に出る（Task 4 でまとめた指摘を
    // 並べたあとも、先頭が最初に来る）。
    await user.click(screen.getAllByRole("radio", { name: "却下" })[0] as HTMLElement);
    await user.click(screen.getAllByRole("button", { name: "保存" })[0] as HTMLElement);
    await waitFor(() => expect(putJudgment).toHaveBeenCalledWith("finding-1", { status: "rejected" }));

    await waitFor(() => expect(screen.getByText("1 / 2 件")).toBeInTheDocument());
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-2"));
    expect(rows()[0]?.getAttribute("aria-current")).toBe("true");
    expect(document.querySelector(`.${findingListStyles.detail}`)).not.toBeNull();
  });

  it("再確認状態の絞り込みで先頭だけが外れたら、同じ範囲で残った指摘へ選択が移る", async () => {
    const user = userEvent.setup();
    const recheckBase = {
      id: "recheck-1",
      notApplicableReason: null,
      reasonKind: null,
      reason: null,
      suggestionValid: null,
      failure: null,
    } as const;
    const { client, getFinding } = setup(
      sameRangePair(
        { recheck: { ...recheckBase, status: "done", verdict: "keep" } },
        { recheck: { ...recheckBase, id: "recheck-2", status: "pending", verdict: null } },
      ),
    );
    renderPage(client);

    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());
    await user.click(rows()[0] as HTMLElement);
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-1"));

    await user.click(screen.getByRole("checkbox", { name: "再確認済み" }));

    await waitFor(() => expect(screen.getByText("1 / 2 件")).toBeInTheDocument());
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-2"));
    expect(rows()[0]?.getAttribute("aria-current")).toBe("true");
  });

  it("同じ範囲の指摘が全部外れたら、今どおり選択を外す", async () => {
    const user = userEvent.setup();
    const { client } = setup(sameRangePair());
    renderPage(client);

    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());
    await user.click(rows()[0] as HTMLElement);
    await waitFor(() => expect(document.querySelector(`.${findingListStyles.detail}`)).not.toBeNull());

    await user.click(screen.getByRole("checkbox", { name: "誤字・表記" }));

    await waitFor(() => expect(screen.getByText("0 / 2 件")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText("本文の強調か一覧から指摘を選んでください")).toBeInTheDocument(),
    );
  });
});
```

（`FindingDto`・`JudgmentDto`・`ApiClient` は既に import されている。足りなければ足す。）

- [ ] **Step 6: テストが失敗することを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/results-page.test.tsx -t "PR14b"`
Expected: FAIL（一覧が 2 行のまま、引き継ぎが無い）

- [ ] **Step 7: `results-page.tsx` を直す**

1. import に `type FindingGroup`、`groupContaining`、`groupFindings`、`nextSelection`（`./finding-group.ts`）を足す。
2. モジュールの定数に `const EMPTY_GROUPS: readonly FindingGroup[] = [];` を足す（`EMPTY_FINDINGS` の近く）。
3. `selectedFindingIdRef` の宣言の直後に、まとめの参照を足す。選択のハンドラーは `useCallback` で参照を安定させている（`BodyView` の `React.memo` を効かせるため）ので、まとめは ref で読む。

```tsx
  // 今のまとめ（PR14b）。選択のハンドラーが「選んだ指摘を含むまとめの先頭」を引くために読む。
  // ハンドラーの参照を安定させたまま最新の値を読めるよう、毎レンダーで同期するだけの ref にする
  // （`selectedFindingIdRef` と同じ作法）。値は下で `groups` を作った直後に入れる。
  const groupsRef = useRef<readonly FindingGroup[]>(EMPTY_GROUPS);
```

4. `handleSelectFinding` で、選んだ ID を先頭にそろえる。

```tsx
  const handleSelectFinding = useCallback((findingId: string) => {
    // 同じ範囲の指摘はまとめの先頭を選択中とする（UI の見直し 2 節）。
    const headId = groupContaining(groupsRef.current, findingId)?.head.id ?? findingId;
    setSelectedFindingId(headId);
    const pane = findingsPaneRef.current;
    if (pane === null) return;
    // 絞り込みで一覧に無い指摘なら行は見つからず、何もしない。
    const row = findListRow(pane, headId);
    if (row !== null) scrollIntoViewIfPossible(row);
  }, []);
```

5. `handleSelectFindingFromList` も同じく先頭にそろえる（一覧の行は先頭の ID を渡すが、念のため同じ規則を通す）。

```tsx
  const handleSelectFindingFromList = useCallback(
    (findingId: string) => {
      const headId = groupContaining(groupsRef.current, findingId)?.head.id ?? findingId;
      setSelectedFindingId(headId);
      if (state.kind !== "loaded") return;
      const finding = state.findings.find((f) => f.id === headId);
      if (finding === undefined) return;
      const target = navigationTargetOf(finding, state.targets, state.manuscript.body);
      if (target === null) return;
      scrollToTarget(target);
    },
    [state, scrollToTarget],
  );
```

6. `visible` と `highlights` の直後で、まとめを作り、ref に入れる。

```tsx
  // 絞り込みを通った指摘を、同じ範囲ごとにまとめる（PR14b）。一覧はまとめを 1 行で描く。
  // 件数（「n / m 件」）は今どおり指摘の数で数える（`visible.length`）。
  const groups = useMemo(() => groupFindings(visible), [visible]);
  groupsRef.current = groups;
```

7. 「選択中の指摘が可視集合（`visible`）に無ければ選択を外す」`useEffect` を、引き継ぎの規則に置き換える。引き継ぎ先は描画の中で `effectiveSelectedId` として求め、画面にはこちらを使う。state の `selectedFindingId` は `useEffect` で後から合わせる。描画の中で求めるのは、先頭が絞り込みから外れた直後の 1 回の描画でも、詳細を閉じずに引き継ぎ先を出すためである。1 回でも閉じると、詳細の部品が作り直され、残った指摘の判断メモの書きかけが消える（Review Focus 2）。コメントも書き直す（解除の経路を 1 つにまとめる理由は残す）。

```tsx
  // 選択中の指摘を、今のまとめに合わせて決め直す（最終レビュー Important 2、UI の見直し 2 節）。
  // 表示中なら、そのまとめの先頭にそろえる。絞り込みから外れても、同じ範囲で表示中の指摘が
  // 残っていれば、そのまとめの先頭へ移す。残っていなければ選択を外す。絞り込みの変更・採否の
  // 保存・再取得の 3 経路すべてがここを通る（経路ごとに個別の処理を持たない）。
  // 画面（一覧・本文・詳細）には、描画の中で求めた `effectiveSelectedId` を使う。state を
  // `useEffect` で合わせるのを待つと、先頭が外れた直後の 1 回の描画で詳細が閉じ、残った指摘の
  // 採否・判断メモの書きかけが作り直しで消えるため。
  const effectiveSelectedId = useMemo(
    () => nextSelection(selectedFindingId, findings, groups),
    [selectedFindingId, findings, groups],
  );
  // state も合わせる（絞り込みを戻したときに、引き継いだ先が選ばれたままになるように）。
  // 取得の成功時にここで潰そうとしないこと——`fetchInitial` / `performRefresh` の deps に
  // `filter` が無く、古い値を読んでしまう。移った先は表示中のまとめの先頭なので、次の回では
  // 値が変わらず止まる。
  useEffect(() => {
    if (effectiveSelectedId !== selectedFindingId) {
      setSelectedFindingId(effectiveSelectedId);
    }
  }, [effectiveSelectedId, selectedFindingId]);
```

`selectedFinding`（詳細に渡す指摘）は `effectiveSelectedId` から引く形に直す。`BodyView` の `selectedFindingId` にも `effectiveSelectedId` を渡す。詳細の取得（今の `fetchDetail` を呼ぶ `useEffect`）は、この Task では `selectedFindingId` のままでよい（Task 4 でフックに替える）。

8. `FindingsPanel` に `groups` を渡し、`FindingList` へは `groups` を渡す。`FindingsPanel` の props に `readonly groups: readonly FindingGroup[];` を足し、`visible` は件数の表示にだけ使う。`FindingsPanel` の `selectedFindingId` には `effectiveSelectedId` を渡す。

```tsx
      <FindingList
        groups={groups}
        selectedFindingId={selectedFindingId}
        onSelectFinding={onSelectFinding}
      />
```

9. ファイル冒頭のコメントの「指摘一覧・絞り込み・選択」の段落に、PR14b で一覧をまとめで描くこと、選択をまとめの先頭にそろえること、絞り込みから外れたときの引き継ぎを 2〜3 文で足す。

- [ ] **Step 8: テストが通ることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/`
Expected: PASS。ほかのテストが、同じ既定の範囲を持つ指摘を 2 件以上並べていて 1 行にまとまり落ちる場合は、そのテストの指摘に別々の `range`（と対応する `paragraphId`）を付けて直す。期待は変えない。直したテストはコミットメッセージの本文に列挙する。

- [ ] **Step 9: `pnpm check` を通してコミットする**

```bash
pnpm check
git add packages/web/src/features/results/finding-list.tsx packages/web/src/features/results/finding-list.test.tsx packages/web/src/features/results/results-page.tsx packages/web/src/features/results/results-page.test.tsx packages/web/src/features/results/results-page.module.css
git commit -m "PR14b: 一覧で同じ範囲の指摘を 1 行にまとめ、選択を先頭にそろえて絞り込みから外れたら引き継ぐ"
```

---

### Task 3: まとめた指摘の詳細を 1 件ずつ取るフック `use-finding-details.ts`

**Files:**
- Create: `packages/web/src/features/results/use-finding-details.ts`
- Test: `packages/web/src/features/results/use-finding-details.test.tsx`

**Interfaces:**
- Consumes: なし（`FindingDetailDto` の型だけ）
- Produces（Task 4 が使う）:
  - `export interface FindingDetailEntry { readonly detail: FindingDetailDto | null; readonly error: string | null }`
  - `export const PENDING_DETAIL: FindingDetailEntry`（`{ detail: null, error: null }`）
  - `export function useFindingDetails(load: (findingId: string) => Promise<FindingDetailDto>, toMessage: (cause: unknown) => string, memberIds: readonly string[]): { readonly entries: ReadonlyMap<string, FindingDetailEntry>; readonly refresh: () => void }`

振る舞い（今の `results-page.tsx` の `fetchDetail` の規則を、指摘ごとに広げたもの）:

- `memberIds` の先頭（まとめの先頭）が、前の `memberIds` に入っていなかったら、選び直しとみなす（別のまとめを選んだ、または選択を外した）。全部の値を捨てて（「読み込み中」に戻して）、全員分を取り直す。
- 新しい先頭が前の `memberIds` に入っていたら、同じまとめの中身が変わっただけとみなす（自動更新や絞り込みで、指摘が増えた・減った。先頭が外れて 2 件目が先頭になった場合を含む）。減った指摘の値を捨て、増えた指摘の分だけ取る。すでにある値は残す。
- `refresh()` は今の全員分を取り直す。前の値は残したまま取りに行く（点滅させない。レビュー M-1）。失敗したら、前の値を残して `error` を入れる（`finding-detail.tsx` が「更新できませんでした」の 1 行を出す）。
- 指摘ごとに最新の要求だけを反映する。古い応答と、もうまとめに無い指摘の応答は捨てる。
- `load` が同期的に例外を投げても、拒否として扱う。

- [ ] **Step 1: 失敗するテストを書く**

`packages/web/src/features/results/use-finding-details.test.tsx` を作る。

```tsx
import type { FindingDetailDto } from "@shuten/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFindingDetails } from "./use-finding-details.ts";

/**
 * まとめた指摘の詳細の取得（PR14b）。`results-page.tsx` の配線は results-page.test.tsx が見る。
 * ここでは取り直しの規則（選び直し・増減・取り直し・古い応答の破棄）だけを見る。
 */

function detailOf(id: string, mark = ""): FindingDetailDto {
  return {
    id,
    runId: "run-1",
    targetId: "target-1",
    locateStatus: "located",
    range: { start: 0, end: 1 },
    paragraphId: 0,
    quote: `あ${mark}`,
    suggestion: null,
    category: "notation",
    initialVerdict: "likely-error",
    suppression: null,
    reasons: [],
    recheck: null,
    judgment: {
      findingId: id,
      status: "undecided",
      note: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
    createdAt: "2026-09-10T00:00:00.000Z",
    candidates: [],
    diagnostics: [],
  };
}

interface Pending {
  readonly id: string;
  resolve(value: FindingDetailDto): void;
  reject(cause: unknown): void;
}

function controlledLoad() {
  const calls: Pending[] = [];
  const load = vi.fn(
    (id: string) =>
      new Promise<FindingDetailDto>((resolve, reject) => {
        calls.push({ id, resolve, reject });
      }),
  );
  return { load, calls };
}

const toMessage = (cause: unknown) => (cause instanceof Error ? cause.message : "失敗");

function renderDetails(load: (id: string) => Promise<FindingDetailDto>, ids: readonly string[]) {
  return renderHook(({ memberIds }) => useFindingDetails(load, toMessage, memberIds), {
    initialProps: { memberIds: ids },
  });
}

describe("useFindingDetails", () => {
  it("空なら何も取らない", () => {
    const { load } = controlledLoad();
    const { result } = renderDetails(load, []);
    expect(load).not.toHaveBeenCalled();
    expect(result.current.entries.size).toBe(0);
  });

  it("まとめた指摘を 1 件ずつ取り、届いた分から入る", async () => {
    const { load, calls } = controlledLoad();
    const { result } = renderDetails(load, ["a", "b"]);
    expect(load.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);

    await act(async () => calls[1]?.resolve(detailOf("b")));
    expect(result.current.entries.get("a")).toBeUndefined();
    expect(result.current.entries.get("b")?.detail?.id).toBe("b");
  });

  it("別のまとめを選んだら（選び直し）、前の値を捨てて取り直し、前の応答は捨てる", async () => {
    const { load, calls } = controlledLoad();
    const { result, rerender } = renderDetails(load, ["a"]);
    await act(async () => calls[0]?.resolve(detailOf("a")));
    expect(result.current.entries.get("a")?.detail?.id).toBe("a");

    rerender({ memberIds: ["c"] });
    expect(result.current.entries.size).toBe(0);
    expect(load).toHaveBeenLastCalledWith("c");

    // 先頭を a に戻して取り直し中に、前の要求（c）が遅れて届いても反映しない。
    rerender({ memberIds: ["a"] });
    await act(async () => calls[1]?.resolve(detailOf("c")));
    expect(result.current.entries.get("c")).toBeUndefined();
  });

  it("先頭が外れて 2 件目が先頭になったら（同じまとめ）、2 件目の値を残し取り直さない", async () => {
    const { load, calls } = controlledLoad();
    const { result, rerender } = renderDetails(load, ["a", "b"]);
    await act(async () => {
      calls[0]?.resolve(detailOf("a"));
      calls[1]?.resolve(detailOf("b"));
    });

    rerender({ memberIds: ["b"] });
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.entries.get("b")?.detail?.id).toBe("b");
    expect(result.current.entries.has("a")).toBe(false);
  });

  it("選択を外したら、値を捨てる", async () => {
    const { load, calls } = controlledLoad();
    const { result, rerender } = renderDetails(load, ["a"]);
    await act(async () => calls[0]?.resolve(detailOf("a")));

    rerender({ memberIds: [] });
    expect(result.current.entries.size).toBe(0);
  });

  it("先頭が同じまま増えたら、増えた分だけ取り、すでにある値は残す", async () => {
    const { load, calls } = controlledLoad();
    const { result, rerender } = renderDetails(load, ["a"]);
    await act(async () => calls[0]?.resolve(detailOf("a")));

    rerender({ memberIds: ["a", "b"] });
    expect(load.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    expect(result.current.entries.get("a")?.detail?.id).toBe("a");
  });

  it("先頭が同じまま減ったら、減った分の値を捨て、遅れて届いた応答も捨てる", async () => {
    const { load, calls } = controlledLoad();
    const { result, rerender } = renderDetails(load, ["a", "b"]);
    await act(async () => calls[0]?.resolve(detailOf("a")));

    rerender({ memberIds: ["a"] });
    await act(async () => calls[1]?.resolve(detailOf("b")));
    expect(result.current.entries.has("b")).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("refresh は全員分を取り直し、届くまで前の値を残す", async () => {
    const { load, calls } = controlledLoad();
    const { result } = renderDetails(load, ["a", "b"]);
    await act(async () => {
      calls[0]?.resolve(detailOf("a", "1"));
      calls[1]?.resolve(detailOf("b", "1"));
    });

    act(() => result.current.refresh());
    expect(load).toHaveBeenCalledTimes(4);
    expect(result.current.entries.get("a")?.detail?.quote).toBe("あ1");

    await act(async () => calls[2]?.resolve(detailOf("a", "2")));
    expect(result.current.entries.get("a")?.detail?.quote).toBe("あ2");
  });

  it("refresh が失敗したら、前の値を残してエラーを入れる。次に成功したらエラーを消す", async () => {
    const { load, calls } = controlledLoad();
    const { result } = renderDetails(load, ["a"]);
    await act(async () => calls[0]?.resolve(detailOf("a", "1")));

    act(() => result.current.refresh());
    await act(async () => calls[1]?.reject(new Error("取り直しに失敗")));
    expect(result.current.entries.get("a")).toEqual({
      detail: detailOf("a", "1"),
      error: "取り直しに失敗",
    });

    act(() => result.current.refresh());
    await act(async () => calls[2]?.resolve(detailOf("a", "3")));
    expect(result.current.entries.get("a")?.error).toBeNull();
  });

  it("同じ指摘で、古い要求の応答が新しい要求の後に届いても反映しない", async () => {
    const { load, calls } = controlledLoad();
    const { result } = renderDetails(load, ["a"]);
    act(() => result.current.refresh());

    await act(async () => calls[1]?.resolve(detailOf("a", "新")));
    await act(async () => calls[0]?.resolve(detailOf("a", "旧")));
    expect(result.current.entries.get("a")?.detail?.quote).toBe("あ新");
  });

  it("選び直しで最初の取得が失敗したら、値なしでエラーを入れる", async () => {
    const { load, calls } = controlledLoad();
    const { result } = renderDetails(load, ["a"]);
    await act(async () => calls[0]?.reject(new Error("取得に失敗")));
    expect(result.current.entries.get("a")).toEqual({ detail: null, error: "取得に失敗" });
  });

  it("load が同期的に例外を投げても、エラーとして入る", async () => {
    const load = vi.fn(() => {
      throw new Error("同期の失敗");
    });
    const { result } = renderDetails(load, ["a"]);
    await waitFor(() =>
      expect(result.current.entries.get("a")).toEqual({ detail: null, error: "同期の失敗" }),
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/use-finding-details.test.tsx`
Expected: FAIL（`./use-finding-details.ts` が無い）

- [ ] **Step 3: 実装する**

`packages/web/src/features/results/use-finding-details.ts` を作る。

```ts
/**
 * 選択中のまとめの指摘 1 件ずつの詳細（`getFinding`。元候補・位置診断を含む）を取る（PR14b）。
 *
 * PR14a までは選択中の 1 件だけを `results-page.tsx` の `fetchDetail` が取っていた。PR14b で
 * 同じ範囲の指摘を詳細に並べるようになり、まとめの先頭以外の指摘を単独で選ぶ方法が無くなった
 * ので、まとめた指摘すべての詳細をここで取る（まとめは多くて数件）。
 *
 * 規則は `fetchDetail` のものを指摘ごとに広げた形にする。
 *
 * - 新しい先頭（`memberIds[0]`）が前の `memberIds` に入っていなければ選び直しとみなし、
 *   全部の値を捨てて全員分を取り直す（前の指摘の詳細を出したままにしない）。
 * - 入っていれば同じまとめの中身が変わっただけとみなし、減った分の値を捨て、増えた分だけ取る
 *   （先頭が絞り込みから外れて 2 件目が先頭になったときに、2 件目を取り直さない）。
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
    const head = ids[0];
    if (head === undefined || !previous.includes(head)) {
      // 選び直し（別のまとめを選んだ、または選択を外した）。前の要求の応答はすべて捨て、
      // 全員分を取り直す。
      latestRef.current = new Map();
      setEntries(EMPTY_ENTRIES);
      for (const findingId of ids) {
        fetchOne(findingId);
      }
      return;
    }
    // 同じまとめの中身だけが変わった（先頭が外れて 2 件目が先頭になった場合を含む）。
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
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/use-finding-details.test.tsx`
Expected: PASS

- [ ] **Step 5: `pnpm check` を通してコミットする**

```bash
pnpm check
git add packages/web/src/features/results/use-finding-details.ts packages/web/src/features/results/use-finding-details.test.tsx
git commit -m "PR14b: まとめた指摘の詳細を 1 件ずつ取るフックを足す"
```

---

### Task 4: 詳細にまとめた指摘を縦に並べ、詳細の取得をフックに替える

**Files:**
- Modify: `packages/web/src/features/results/finding-detail.tsx`
- Modify: `packages/web/src/features/results/finding-detail.test.tsx`
- Modify: `packages/web/src/features/results/finding-detail.ts`（`relatedFindings` を消す）
- Modify: `packages/web/src/features/results/finding-detail.test.ts`（`relatedFindings` のテストを消す）
- Modify: `packages/web/src/features/results/results-page.tsx`
- Modify: `packages/web/src/features/results/results-page.test.tsx`
- Modify: `packages/web/src/features/results/results-page.module.css`

**Interfaces:**
- Consumes: Task 1 の `FindingGroup`、`groupContaining`、`hiddenSameRangeCount`、`overlappingGroups`、`summarizeCategories`。Task 2 の `groups`・`groupsRef`（`results-page.tsx`）。Task 3 の `useFindingDetails`、`PENDING_DETAIL`、`FindingDetailEntry`。
- Produces: `FindingDetailProps` を次の形にする。

```ts
/** まとめた指摘 1 件ぶん（`finding` と、その `getFinding` の応答・失敗）。 */
export interface FindingDetailMember {
  readonly finding: FindingDto;
  /** `getFinding` の応答。取得中は null。 */
  readonly detail: FindingDetailDto | null;
  /** 取得の失敗メッセージ。失敗していなければ null。 */
  readonly detailError: string | null;
}

export interface FindingDetailProps {
  /** まとめた指摘（先頭を含み、1 件以上）。先頭から順に並べる。 */
  readonly members: readonly FindingDetailMember[];
  /** 同じ範囲なのに絞り込みで隠れている指摘の数。 */
  readonly hiddenSameRangeCount: number;
  readonly body: string;
  /** 範囲が一部だけ重なる、ほかのまとめ。 */
  readonly overlapping: readonly FindingGroup[];
  readonly onSelectFinding: (findingId: string) => void;
  readonly onNavigate?: () => void;
  readonly onSaveJudgment: (
    findingId: string,
    status: JudgmentStatus,
    note: string | null,
    quote: string,
  ) => Promise<void>;
}
```

- [ ] **Step 1: 詳細の失敗するテストを書く**

`finding-detail.test.tsx` を直す。

1. `baseProps` を、今の呼び出し（`baseProps({ finding, detail, detailError, ... })`。29 か所）をそのまま使える形にする。

```tsx
function baseProps(
  overrides: Partial<Omit<FindingDetailProps, "members">> & {
    readonly finding?: FindingDto;
    readonly detail?: FindingDetailDto | null;
    readonly detailError?: string | null;
    readonly members?: readonly FindingDetailMember[];
  } = {},
): FindingDetailProps {
  const {
    finding = makeFinding(),
    detail = makeDetail(),
    detailError = null,
    members,
    ...rest
  } = overrides;
  return {
    members: members ?? [{ finding, detail, detailError }],
    hiddenSameRangeCount: 0,
    body: BODY,
    overlapping: [],
    onSelectFinding: vi.fn(),
    onSaveJudgment: vi.fn(() => Promise.resolve()),
    ...rest,
  };
}
```

（`FindingDetailMember` と `FindingGroup`・`groupFindings` を import に足す。`detail = makeDetail()` の既定値は、`detail: null` を明示的に渡したときは効かない。分割代入の既定値は `undefined` のときだけ使われるので、今のテストの `detail: null` はそのまま null になる。）

2. 「関連する他の指摘（決定 8）」の 2 つのテストを、重なるまとめのテストに置き換える。

```tsx
describe("FindingDetail: 範囲が重なる他の指摘", () => {
  it("重なるまとめごとに 1 つのリンクを出し、2 件以上なら件数を添え、押すと先頭の ID で選ぶ", async () => {
    const user = userEvent.setup();
    const onSelectFinding = vi.fn();
    const overlapping = groupFindings([
      makeFinding({ id: "o1", range: { start: 1, end: 3 }, quote: "重なる", category: "grammar" }),
      makeFinding({ id: "o2", range: { start: 1, end: 3 }, quote: "重なる", category: "particle" }),
      makeFinding({ id: "o3", range: { start: 2, end: 4 }, quote: "もう一つ" }),
    ]);
    render(<FindingDetail {...baseProps({ overlapping, onSelectFinding })} />);

    expect(screen.getByText("範囲が重なる他の指摘")).toBeInTheDocument();
    expect(screen.queryByText("同じ範囲の他の指摘")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "文法／助詞：重なる（2 案）" }));
    expect(onSelectFinding).toHaveBeenCalledWith("o1");
    await user.click(screen.getByRole("button", { name: "誤字・表記：もう一つ" }));
    expect(onSelectFinding).toHaveBeenCalledWith("o3");
  });

  it("重なるまとめが無ければ見出しごと出さない", () => {
    render(<FindingDetail {...baseProps({ overlapping: [] })} />);
    expect(screen.queryByText("範囲が重なる他の指摘")).not.toBeInTheDocument();
  });
});
```

3. まとめの表示のテストを足す。

```tsx
describe("FindingDetail: 同じ範囲の指摘のまとめ（PR14b）", () => {
  function pair() {
    const first = makeFinding({
      id: "m1",
      category: "grammar",
      suggestion: "声が出た",
      reasons: [{ candidateId: "c1", perspective: "typo", reason: "時制が合わない" }],
    });
    const second = makeFinding({
      id: "m2",
      category: "particle",
      suggestion: "声が出る",
      reasons: [{ candidateId: "c2", perspective: "typo", reason: "助詞の選び方" }],
      judgment: {
        findingId: "m2",
        status: "rejected",
        note: null,
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    });
    return [
      { finding: first, detail: makeDetail({ ...first }), detailError: null },
      { finding: second, detail: null, detailError: null },
    ] as const;
  }

  it("見出しは分類の要約、原文は 1 回だけ出し、指摘ごとに「案 n：分類」の区画を並べる", () => {
    render(<FindingDetail {...baseProps({ members: pair() })} />);

    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain("文法／助詞");
    expect(screen.getAllByRole("heading", { level: 3, name: "原文" })).toHaveLength(1);
    const first = screen.getByRole("region", { name: "案 1：文法" });
    const second = screen.getByRole("region", { name: "案 2：助詞" });
    expect(within(first).getByText("声が出た")).toBeInTheDocument();
    expect(within(first).getByText(/時制が合わない/)).toBeInTheDocument();
    expect(within(second).getByText("声が出る")).toBeInTheDocument();
    expect(within(second).getByText(/助詞の選び方/)).toBeInTheDocument();
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("採否は指摘ごとに持ち、保存はその指摘の ID で呼ぶ", async () => {
    const user = userEvent.setup();
    const onSaveJudgment = vi.fn(() => Promise.resolve());
    render(<FindingDetail {...baseProps({ members: pair(), onSaveJudgment })} />);

    const second = screen.getByRole("region", { name: "案 2：助詞" });
    expect(within(second).getByRole("radio", { name: "却下" })).toBeChecked();
    await user.click(within(second).getByRole("radio", { name: "保留" }));
    await user.click(within(second).getByRole("button", { name: "保存" }));
    expect(onSaveJudgment).toHaveBeenCalledWith("m2", "held", null, "これ");
  });

  it("元候補・位置診断は指摘ごとに出し、届いていない指摘だけ「読み込み中…」", () => {
    render(<FindingDetail {...baseProps({ members: pair() })} />);
    const first = screen.getByRole("region", { name: "案 1：文法" });
    const second = screen.getByRole("region", { name: "案 2：助詞" });
    expect(within(first).queryByText("読み込み中…")).not.toBeInTheDocument();
    expect(within(second).getByText("読み込み中…")).toBeInTheDocument();
  });

  it("1 件だけなら「案 n」の見出しを出さず、見出しの階層も今のまま", () => {
    render(<FindingDetail {...baseProps()} />);
    expect(screen.queryByText(/^案 1/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "修正案" })).toBeInTheDocument();
  });

  it("絞り込みで隠れた同じ範囲の指摘があれば、末尾に件数だけ出す", () => {
    const { rerender } = render(<FindingDetail {...baseProps({ hiddenSameRangeCount: 1 })} />);
    expect(screen.getByText("絞り込みで非表示：1 件")).toBeInTheDocument();
    rerender(<FindingDetail {...baseProps({ hiddenSameRangeCount: 0 })} />);
    expect(screen.queryByText(/絞り込みで非表示/)).not.toBeInTheDocument();
  });

  it("2 件から 1 件に減っても、残った指摘の書きかけの判断メモは消えない", async () => {
    const user = userEvent.setup();
    const [first, second] = pair();
    const { rerender } = render(<FindingDetail {...baseProps({ members: [first, second] })} />);
    const region = screen.getByRole("region", { name: "案 2：助詞" });
    await user.type(within(region).getByRole("textbox"), "書きかけ");

    rerender(<FindingDetail {...baseProps({ members: [second] })} />);
    expect(screen.getByRole("textbox")).toHaveValue("書きかけ");
  });
});
```

（`within` を import に足す。判断メモの入力欄のロールと名前は `judgment-control.tsx` に合わせる。1 つしか無いなら `getByRole("textbox")` でよい。）

4. `finding-detail.test.ts` から `relatedFindings` の `describe` と import を消し、冒頭のコメントの `relatedFindings` への言及を消す。

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/finding-detail.test.tsx`
Expected: FAIL（`members` を受け取らない）

- [ ] **Step 3: `finding-detail.tsx` を直す**

冒頭のコメントに PR14b の段落を足す。内容は、同じ範囲の指摘を縦に並べること、並び（「設計書から先に決めたこと」の 7）、指摘ごとの区画を `key={finding.id}` で作り 1 件と 2 件以上で同じ要素の構造にすること（件数が変わっても採否と判断メモの書きかけを作り直さない）、「同じ範囲の他の指摘」の欄をなくしたこと。「区画の順」の段落も新しい並びに書き直す。

本体の骨組みは次のとおりにする。今の `FindingDetail` の中身（引用の出し分け、修正案、採否、理由、判定、更新の失敗の 1 行、元候補・位置診断）は、`MemberSections` に移す。文言と条件は変えない。

```tsx
export function FindingDetail(props: FindingDetailProps) {
  const {
    members,
    hiddenSameRangeCount,
    body,
    overlapping,
    onSelectFinding,
    onNavigate,
    onSaveJudgment,
  } = props;
  const head = members[0];
  if (head === undefined) {
    return null;
  }
  const grouped = members.length > 1;
  const finding = head.finding;

  // 同じ範囲なので、原文と見出しは先頭の指摘から作れば全員分を表す。
  const quote =
    finding.locateStatus === "located" && finding.range !== null
      ? { heading: "原文", text: body.slice(finding.range.start, finding.range.end) }
      : { heading: "LLM の引用（原文との一致未確認）", text: finding.quote };
  const resolved = quote.heading === "原文";

  return (
    <div className={styles.detail}>
      <h2 className={styles.detailHeading}>
        <span className={styles.detailHeadingCategory}>
          {summarizeCategories(members.map((member) => member.finding))}
        </span>
        <span className={styles.detailHeadingQuote}>{quote.text}</span>
        {!resolved && <span className={styles.detailHeadingUnverified}>（LLM 引用・未確認）</span>}
      </h2>

      <section>
        <h3>{quote.heading}</h3>
        <p className={styles.detailQuote}>{quote.text}</p>
      </section>

      {members.map((member, index) => {
        const label = `案 ${index + 1}：${FINDING_CATEGORY_LABELS[member.finding.category]}`;
        return (
          // 1 件でも 2 件以上でも同じ要素の構造にする（件数が変わったときに、採否と判断メモの
          // 書きかけを作り直さないため）。見出しの有無と階層だけを変える。
          <section
            key={member.finding.id}
            className={grouped ? styles.groupMember : undefined}
            aria-label={grouped ? label : undefined}
          >
            {grouped ? <h3 className={styles.groupMemberHeading}>{label}</h3> : null}
            <MemberSections
              member={member}
              headingLevel={grouped ? 4 : 3}
              onSaveJudgment={onSaveJudgment}
            />
          </section>
        );
      })}

      {hiddenSameRangeCount > 0 && (
        <p className={styles.hiddenSameRange}>絞り込みで非表示：{hiddenSameRangeCount} 件</p>
      )}

      {overlapping.length > 0 && (
        <section>
          <h3>範囲が重なる他の指摘</h3>
          <ul className={styles.detailRelatedList}>
            {overlapping.map((group) => (
              <li key={group.head.id}>
                <button
                  type="button"
                  className={styles.detailRelatedButton}
                  onClick={() => onSelectFinding(group.head.id)}
                >
                  {summarizeCategories(group.members)}：{group.head.quote}
                  {group.members.length > 1 ? `（${group.members.length} 案）` : ""}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {onNavigate !== undefined && (
        <button type="button" className={styles.detailNavigateButton} onClick={onNavigate}>
          本文の該当箇所へ移動
        </button>
      )}
    </div>
  );
}

function MemberSections(props: {
  readonly member: FindingDetailMember;
  readonly headingLevel: 3 | 4;
  readonly onSaveJudgment: FindingDetailProps["onSaveJudgment"];
}) {
  const { member, headingLevel, onSaveJudgment } = props;
  const { finding, detail, detailError } = member;
  const Heading = headingLevel === 3 ? "h3" : "h4";
  const display = describeRecheck(finding);
  const sortedReasons = [...finding.reasons].sort(
    (a, b) => PERSPECTIVE_ORDER.indexOf(a.perspective) - PERSPECTIVE_ORDER.indexOf(b.perspective),
  );

  return (
    <>
      {finding.suppression !== null && (
        <p className={styles.suppressionNote}>許容語『{finding.suppression.word}』により抑制</p>
      )}
      {/* 修正案・採否・理由・判定の各 <section>（今のものを移し、<h3> を <Heading> にする）。
          採否の JudgmentControl は今どおり key={finding.id} を付ける。 */}
      {/* 更新の失敗の 1 行（detail !== null && detailError !== null）と、
          元候補・位置診断の <details>（今のものをそのまま移す）。 */}
    </>
  );
}
```

（上の `MemberSections` の中のコメント 2 つは、今の `FindingDetail` の該当部分をそのまま移す場所を示す。移すときに文言・条件・クラス名は変えず、`<h3>` だけを `<Heading>` にする。元候補・位置診断の中の `<h4>`（元候補・位置診断の小見出し）はそのままにする。）

`RelatedFindingsSection` と `RelatedFindingsList` は消す。import に `FindingGroup`・`summarizeCategories`（`./finding-group.ts`）を足し、使わなくなった import を消す。

`results-page.module.css` の `.detail` 関係の規則の近くに足す。

```css
/* 同じ範囲の指摘のまとめ（PR14b）。指摘ごとの区画を線で区切る。 */
.groupMember {
  padding-top: var(--space-sm);
  border-top: 1px dashed var(--color-border);
}

.groupMemberHeading {
  font-size: var(--font-size-md);
}

.hiddenSameRange {
  font-size: var(--font-size-sm);
  color: var(--color-fg-muted);
}
```

`finding-detail.ts` から `relatedFindings` を消し、冒頭のコメントの「選択中の指摘に関連する他の指摘をどう 2 群に分けるか」を消す。

- [ ] **Step 4: 詳細のテストが通ることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/finding-detail.test.tsx src/features/results/finding-detail.test.ts`
Expected: PASS

- [ ] **Step 5: 結果画面の失敗するテストを書く**

`results-page.test.tsx` の「同じ範囲の指摘のまとめ（PR14b）」の `describe` に足す。

```tsx
  it("まとめた指摘は詳細に全部並び、getFinding はそれぞれの ID で 1 回ずつ呼ばれる", async () => {
    const user = userEvent.setup();
    const { client, getFinding } = setup(
      sameRangePair({ category: "grammar" }, { category: "particle" }),
    );
    renderPage(client);

    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());
    await user.click(rows()[0] as HTMLElement);

    await waitFor(() => expect(getFinding).toHaveBeenCalledTimes(2));
    expect(getFinding).toHaveBeenCalledWith("finding-1");
    expect(getFinding).toHaveBeenCalledWith("finding-2");
    expect(screen.getByRole("region", { name: "案 1：文法" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "案 2：助詞" })).toBeInTheDocument();
  });

  it("2 件目の採否を保存すると、2 件目の ID で putJudgment が呼ばれ、一覧の要約が変わる", async () => {
    const user = userEvent.setup();
    const held: JudgmentDto = {
      findingId: "finding-2",
      status: "held",
      note: null,
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    const putJudgment = vi.fn(() => Promise.resolve(held));
    const { client } = setup(sameRangePair({ category: "grammar" }, { category: "particle" }), {
      putJudgment,
    });
    renderPage(client);

    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());
    await user.click(rows()[0] as HTMLElement);
    const second = await screen.findByRole("region", { name: "案 2：助詞" });
    await user.click(within(second).getByRole("radio", { name: "保留" }));
    await user.click(within(second).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(putJudgment).toHaveBeenCalledWith("finding-2", { status: "held" }));
    await waitFor(() =>
      expect(within(rows()[0] as HTMLElement).getByText("未判断 1・保留 1")).toBeInTheDocument(),
    );
  });

  it("同じ範囲で絞り込みに隠れた指摘があれば、詳細の末尾に件数を出す", async () => {
    const user = userEvent.setup();
    const { client } = setup(sameRangePair({ category: "notation" }, { category: "grammar" }));
    renderPage(client);

    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", { name: "文法" }));
    await waitFor(() => expect(screen.getByText("1 / 2 件")).toBeInTheDocument());
    await user.click(rows()[0] as HTMLElement);

    expect(await screen.findByText("絞り込みで非表示：1 件")).toBeInTheDocument();
  });

  it("2 件目の判断メモを書きかけたまま先頭が絞り込みから外れても、書きかけは消えない", async () => {
    const user = userEvent.setup();
    const rejected: JudgmentDto = {
      findingId: "finding-1",
      status: "rejected",
      note: null,
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    const putJudgment = vi.fn(() => Promise.resolve(rejected));
    const { client } = setup(sameRangePair({ category: "grammar" }, { category: "particle" }), {
      putJudgment,
    });
    renderPage(client);

    await waitFor(() => expect(screen.getByText("2 / 2 件")).toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", { name: "採用予定" }));
    await user.click(screen.getByRole("checkbox", { name: "却下" }));
    await user.click(screen.getByRole("checkbox", { name: "保留" }));
    await user.click(rows()[0] as HTMLElement);

    const first = await screen.findByRole("region", { name: "案 1：文法" });
    const second = screen.getByRole("region", { name: "案 2：助詞" });
    await user.type(within(second).getByRole("textbox"), "書きかけ");
    await user.click(within(first).getByRole("radio", { name: "却下" }));
    await user.click(within(first).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByText("1 / 2 件")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "案 1：文法" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox")).toHaveValue("書きかけ");
  });

  it("重なるまとめのリンクから選んでも、そのまとめの先頭が選ばれる", async () => {
    const user = userEvent.setup();
    const { client, getFinding } = setup([
      makeFinding({ id: "finding-1", range: { start: 0, end: 2 }, quote: "一段" }),
      makeFinding({ id: "finding-2", range: { start: 1, end: 3 }, quote: "段落", category: "grammar" }),
      makeFinding({ id: "finding-3", range: { start: 1, end: 3 }, quote: "段落", category: "particle" }),
    ]);
    renderPage(client);

    await waitFor(() => expect(screen.getByText("3 / 3 件")).toBeInTheDocument());
    await user.click(rows()[0] as HTMLElement);
    await user.click(await screen.findByRole("button", { name: "文法／助詞：段落（2 案）" }));

    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-3"));
    expect(rows()[1]?.getAttribute("aria-current")).toBe("true");
    expect(rows()[1]?.closest("li")?.getAttribute("data-finding-id")).toBe("finding-2");
  });
```

- [ ] **Step 6: テストが失敗することを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/results-page.test.tsx -t "PR14b"`
Expected: FAIL（`results-page.tsx` がまだ `members` を渡していない。型検査も落ちる）

- [ ] **Step 7: `results-page.tsx` を直す**

1. 詳細の取得をフックに替える。`findingDetail`・`findingDetailError` の state、`detailGenerationRef`、`fetchDetail`、「選択中の指摘 ID が変わるたびに詳細を取り直す」`useEffect` を消す。`selectedFindingIdRef` は、ほかに使っていなければ消す。
2. `performRefresh` の中の詳細の取り直しを、ref 経由で `refresh` を呼ぶ形にする。`performRefresh` の deps から `fetchDetail` を消す。

```tsx
                // PR21 レビュー指摘 1：選択中のまとめがあれば、詳細も取り直す（選択が変わらないと
                // フックは取り直さないため）。フックの `refresh` は下で作るので ref 経由で呼ぶ。
                refreshDetailsRef.current();
```

ref は `performRefresh` より前に宣言する。

```tsx
  // 選択中のまとめの詳細を取り直す関数（`useFindingDetails` の `refresh`）。フックは `groups` を
  // 作った後で呼ぶので、それより前に定義する `performRefresh` からは ref で呼ぶ。
  const refreshDetailsRef = useRef<() => void>(() => {});
```

3. 取得の関数を `apiClient` に依存する `useCallback` で作る（フックに安定した参照を渡すため）。

```tsx
  const loadFindingDetail = useCallback(
    (findingId: string) => invoke(() => apiClient.getFinding(findingId)),
    [apiClient],
  );
```

4. `groups` と引き継ぎの `useEffect` の後で、選択中のまとめを求め、フックを呼ぶ。今の `selectedFinding` と `related`（`relatedFindings` を使う `useMemo`）は消し、次に置き換える。

```tsx
  // 選択中のまとめ（PR14b）。`effectiveSelectedId`（Task 2）から引くので、先頭が絞り込みから
  // 外れた直後の描画でも、引き継ぎ先のまとめになる。
  const selectedGroup = useMemo(
    () => (effectiveSelectedId === null ? null : groupContaining(groups, effectiveSelectedId)),
    [groups, effectiveSelectedId],
  );
  const selectedFinding = selectedGroup === null ? null : selectedGroup.head;
  const memberIds = useMemo(
    () => (selectedGroup === null ? EMPTY_IDS : selectedGroup.members.map((member) => member.id)),
    [selectedGroup],
  );
  const { entries: detailEntries, refresh: refreshDetails } = useFindingDetails(
    loadFindingDetail,
    errorMessageFrom,
    memberIds,
  );
  refreshDetailsRef.current = refreshDetails;
  const overlapping = useMemo(
    () => (selectedGroup === null ? EMPTY_GROUPS : overlappingGroups(selectedGroup, groups)),
    [selectedGroup, groups],
  );
  const hiddenCount = useMemo(
    () => (selectedGroup === null ? 0 : hiddenSameRangeCount(selectedGroup, findings)),
    [selectedGroup, findings],
  );
```

（`EMPTY_IDS` はモジュールの定数 `const EMPTY_IDS: readonly string[] = [];` として足す。`selectedNavigationTarget` は、この `selectedFinding`（まとめの先頭）から作るので、そのまま使える。）

先頭が絞り込みから外れたとき、詳細の部品は閉じずに残る。まとめの指摘の区画は `key={finding.id}` なので、残った指摘の区画も作り直されない。フックは「新しい先頭が前のまとめに入っていた」ので選び直しとはみなさず、残った指摘の詳細を取り直さない（Task 3 の規則）。

5. 詳細の描画を新しい props に替える。

```tsx
                  {selectedGroup !== null ? (
                    <FindingDetail
                      members={selectedGroup.members.map((member) => {
                        const entry = detailEntries.get(member.id) ?? PENDING_DETAIL;
                        return { finding: member, detail: entry.detail, detailError: entry.error };
                      })}
                      hiddenSameRangeCount={hiddenCount}
                      body={state.manuscript.body}
                      overlapping={overlapping}
                      onSelectFinding={handleSelectFinding}
                      {...(selectedNavigationTarget !== null ? { onNavigate: handleNavigate } : {})}
                      onSaveJudgment={handleSaveJudgment}
                    />
                  ) : (
                    <p className={styles.detailEmpty}>本文の強調か一覧から指摘を選んでください</p>
                  )}
```

6. import を整理する（`relatedFindings` を消し、`useFindingDetails`・`PENDING_DETAIL`・`overlappingGroups`・`hiddenSameRangeCount` を足す。使わなくなった `FindingDetailDto` などの型の import を消す）。
7. ファイル冒頭のコメントのうち、詳細の取得（`fetchDetail`・`detailGenerationRef`・`selectedFindingIdRef`）を説明している段落を、`useFindingDetails` で取る形に書き直す（PR21 レビュー指摘 1 とレビュー M-1 の理由は残す）。

- [ ] **Step 8: テストが通ることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/`
Expected: PASS。既存のテストのうち、`getFinding` の呼び出し回数を数えているもの（「指摘を選択すると getFinding が 1 回呼ばれる」、レビュー M-1 の 3 件、PR21 レビュー指摘 1）は、まとめていない 1 件の指摘で組んでいるので、回数の期待は変わらないはず。落ちたら、まず fixture の指摘が同じ範囲になっていないかを確かめる。

- [ ] **Step 9: `pnpm check` を通してコミットする**

```bash
pnpm check
git add packages/web/src/features/results/finding-detail.tsx packages/web/src/features/results/finding-detail.test.tsx packages/web/src/features/results/finding-detail.ts packages/web/src/features/results/finding-detail.test.ts packages/web/src/features/results/results-page.tsx packages/web/src/features/results/results-page.test.tsx packages/web/src/features/results/results-page.module.css
git commit -m "PR14b: 詳細に同じ範囲の指摘を並べ、指摘ごとに詳細を取って採否を付けられるようにする"
```

---

### Task 5: 実ブラウザで確かめ、ロードマップと経過を更新する

**Files:**
- Modify: `docs/plans/2026-09-07-mvp-roadmap.md`
- Modify: `docs/history.md`
- Modify: `docs/plans/2026-10-02-pr14b-same-range-group.md`（状態と「実装時の調整」）

この Task は Claude（コントローラー）が行う。サブエージェントには渡さない。

- [ ] **Step 1: 実ブラウザで確かめる**

`docs/experiments/2026-10-02-browser-check/` と同じ手順で、WSL2 上のサーバーと Chrome（chrome-devtools MCP）を実際の LM Studio につなぎ、評価原稿で検査を通す。接続先の URL と IP アドレスは記録に残さない。確かめること：

1. 同じ範囲の指摘が一覧で 1 行になり、「n 案」と要約が出る。件数は指摘の数のまま。
2. 本文の強調・一覧の行のどちらから選んでも、詳細にまとめた指摘が全部並び、それぞれに採否を付けて保存できる。
3. 採否を「未判断」だけに絞り、まとめの先頭を却下にしても、詳細が閉じずに残りへ移る。
4. 理由や判断メモが長い詳細と、件数の多い一覧が同時にある状態で、詳細の枠の中でスクロールでき、まとめの後ろの指摘の採否にも届く（Review Focus 5）。1280×600 でも確かめる。
5. 評価原稿で同じ範囲の指摘が出なかったときは、そのことを記録し、DOM テストで押さえていることを根拠にする。

- [ ] **Step 2: ロードマップと経過を更新する**

- `docs/plans/2026-09-07-mvp-roadmap.md` の PR14b を「完了」にし、実装時の調整があれば 1〜2 行で書く。
- `docs/history.md` に、PR14b で何を変えたか（同じ範囲の指摘のまとめ、詳細を指摘ごとに取ること、選択の引き継ぎ）を 1 段落足す。
- この計画の「状態」を「実装済み」にし、「実装時の調整」節に計画から変えたことを書く。

- [ ] **Step 3: `pnpm check` を通してコミットする**

```bash
pnpm check
git add docs/plans/2026-09-07-mvp-roadmap.md docs/history.md docs/plans/2026-10-02-pr14b-same-range-group.md
git commit -m "PR14b: 実ブラウザでの確認と、ロードマップ・経過の更新"
```

---

## 実装時の調整

- **まとめの小見出しの余白**：実ブラウザで、まとめた指摘の小見出し（`h4`）に規則が無く、ブラウザ既定の余白で
  採否が詳細の枠の下に落ちていた。`.detail h3, .detail h4` に同じ規則を当て、「案 n」の見出しは詳細度を上げて
  文字を大きくした。
- **同じまとめかどうかの判定**：計画では「新しい先頭が前のメンバーに入っているか」で選び直しを判定していた。
  これだと、引き継いだあとに絞り込みを戻してまとめが [a2] から [a1, a2] に戻ったとき、選び直しとみなされて
  a2 の元候補が「読み込み中…」に戻る。前と新しいメンバーの ID が 1 つも重ならないときだけ別のまとめとみなす
  形に直した（1 つの指摘は 1 つの範囲にしか属さないので、重なれば同じまとめ）。詳細の枠のスクロールを先頭に
  戻すのも同じ判定にし、同じまとめの中で引き継いだときは位置を保つ。
- **実ブラウザでの確認**：新しい検査は走らせず、2026-10-02 の通し確認で完了した実行（指摘 33 件、
  同じ範囲の組 4 つ）を開いて確かめた。31 件の表示で一覧は 27 行、「2 案」の行が 4 つ。
  確かめたこと：
  - 本文の強調から選ぶと先頭が選ばれ、一覧の行が見える位置に来る。
  - 採否を「未判断」だけに絞って先頭を却下にすると、詳細は閉じずに 2 件目へ移る。書きかけのメモも残る。
  - 1908×856 と 1280×600 で、ページ全体はスクロールしない。
  - 5 件のまとめは評価原稿に無かったので、2 件のまとめで、詳細の枠の中のスクロールで後ろの採否まで届くことを
    確かめた。

## 完了の条件

- Task 1〜5 のコミットがそろい、`pnpm check` が通る。
- 設計書 2 節の項目（まとめる条件、表示だけの変更、一覧、詳細、絞り込みとの関係、件数、重なる指摘、選択、選択の引き継ぎ）に、それぞれ対応するテストか実ブラウザでの確認がある。
- 「設計書から先に決めたこと」の 7 点がユーザーに確認されている。
- Windows のブラウザでは未確認であることを、PR の本文に書く。
