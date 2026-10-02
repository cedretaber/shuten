# PR14a 詳細計画：結果画面の配置

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

作成日：2026-10-02
状態：実装済み
**Goal:** 結果画面で、本文の強調を選んだらすぐ右上に詳細と採否が見えるようにし、ヘッダー・絞り込み・進捗の内訳を折りたたんで、スクロールする領域を本文の列と右の列の 2 つにする。

**Architecture:** `packages/web` だけを変える。アプリの枠（`app/layout.tsx`）を縦方向の flex にして `main` を残りの高さに収め、結果画面はその高さの中で 2 カラムを伸ばす。右の列は「詳細（上に固定）」と「絞り込み＋一覧（その下でスクロール）」の 2 段にする。折りたたみはすべて `<details>` / `<summary>` で作る（中身は閉じていても DOM に残るので、既存の DOM テストの多くはそのまま通る）。

**Tech Stack:** React 19 + Vite、CSS Modules、Vitest + Testing Library（jsdom）。新しい依存は入れない。

**Spec:** `docs/plans/2026-10-02-ui-refresh.md`（UI の見直しの設計書）の「1. 結果画面の配置」。仕様の正本は `docs/spec/mvp-spec.md` 5.3・5.4。

## Global Constraints

- 変更は `packages/web` だけ。サーバーの API と DTO、`packages/shared` は変えない。
- 機能を増やさない（表示方式の切り替え、前・次の指摘への移動、キーボード操作、ダークモードは作らない）。
- 仕様書を改訂しない。5.3 節の各項目（上部の観点別の進捗、左の本文、右の一覧と詳細、絞り込み、同じ範囲の指摘をすべて参照できること）を、折りたたみの形ですべて残す。
- 案内文・ボタン・ラベルの文言を変えない。新しく足す文言は次のものだけ：「詳しい進捗」「絞り込み（」「を表示中）」「・絞り込み中」「本文の強調か一覧から指摘を選んでください」。
- 本文をブラウザで加工しない。`dangerouslySetInnerHTML` を使わない（PR12a の制約）。
- CSS フレームワーク・UI ライブラリを入れない。色・余白は `styles/tokens.css` の変数を使う（新しい色は足さない。色の差し替えは PR14c）。
- ドキュメント・コメント・コミットメッセージは日本語、識別子は英語。
- 各タスクの完了時に `pnpm check` を通す。

## Review Focus

テストでは押さえきれず、使う人が最初に踏みそうな入力と状態。各行のテストは担当するタスクに入れてある。

1. **絞り込みで選択中の指摘が一覧から消えたとき**：詳細は消え、「本文の強調か一覧から指摘を選んでください」が出る（選択が外れる既存の動きのまま）。→ Task 4 のテスト。
2. **絞り込みを既定から変えて折りたたんだとき**：閉じていても「絞り込み中」と分かる。既定に戻すと消える。→ Task 1・Task 4 のテスト。
3. **本文の強調から、絞り込みで隠れていない指摘を選んだとき**：一覧の該当行が見える位置までスクロールする。本文の強調自体へはスクロールしない（既存の決定：見えている場所をクリックしたので跳ねさせない）。→ Task 5 のテスト。
4. **案内文が多く、ヘッダーが高くなったとき**（停止中・失敗した単位・採否の保存失敗が同時に出る）：2 カラムが潰れきらず、最低限の高さを保ち、足りない分は `main` がスクロールする。→ Task 6 の実ブラウザでの確認。
5. **`isSettingsStop`（検査を開始できなかった実行）**：2 カラムが出ない画面でも、ヘッダーと案内文が崩れない。→ Task 3 のテスト（既存のテストが通ることの確認を含む）。

---

## ファイルの構成

| ファイル | 役割 | 変更 |
| --- | --- | --- |
| `packages/web/src/features/results/finding-filter.ts` | 絞り込みの純関数 | `isDefaultFilter` を足す |
| `packages/web/src/features/results/finding-filter.test.ts` | 同上のテスト | テストを足す |
| `packages/web/src/features/results/run-progress.tsx` | 進捗の描画 | 件数の行と内訳を分け、内訳を `<details>` に入れる |
| `packages/web/src/features/results/run-progress.test.tsx` | 同上のテスト | 折りたたみのテストを足す |
| `packages/web/src/features/results/run-header.tsx` | 結果画面の上部 | 1 行目（名前・状態・件数・操作）と 2 行目（モデル・時刻）に組み直す |
| `packages/web/src/features/results/run-header.test.tsx` | 同上のテスト | 行の構成のテストを足す |
| `packages/web/src/features/results/results-page.tsx` | 結果画面 | 右の列を「詳細」と「絞り込み＋一覧」の 2 段にする。絞り込みを折りたたむ。本文から選んだら一覧の行へスクロールする |
| `packages/web/src/features/results/finding-list.tsx` | 一覧 | 行に `data-finding-id` を付ける |
| `packages/web/src/features/results/navigate.ts` | 移動先の要素を探す関数 | 一覧の行を探す `findListRow` を足す |
| `packages/web/src/features/results/navigate.test.ts` | 同上のテスト | テストを足す |
| `packages/web/src/features/results/results-page.test.tsx` | 結果画面のテスト | 詳細の位置・空の案内・折りたたみ・一覧へのスクロールのテストを足し、移動のテスト 1 件の期待を直す |
| `packages/web/src/features/results/results-page.module.css` | 結果画面の CSS | ヘッダー・2 カラム・右の列の 2 段・折りたたみのスタイル |
| `packages/web/src/app/layout.tsx` | アプリの枠 | 縦方向の flex の容器にクラスを付ける |
| `packages/web/src/app/layout.module.css` | アプリの枠の CSS | 新規 |
| `packages/web/src/styles/global.css` | 共通 CSS | `main` の余白を枠の CSS に移す |
| `docs/plans/2026-09-07-mvp-roadmap.md` | ロードマップ | PR14a を完了にする |
| `docs/history.md` | 経過 | 1 段落足す |

---

### Task 1: 絞り込みが既定のままかを判定する `isDefaultFilter`

**Files:**
- Modify: `packages/web/src/features/results/finding-filter.ts`（`DEFAULT_FINDING_FILTER` の直後）
- Test: `packages/web/src/features/results/finding-filter.test.ts`

**Interfaces:**
- Consumes: `FindingFilter`、`DEFAULT_FINDING_FILTER`（同ファイル）
- Produces: `export function isDefaultFilter(filter: FindingFilter): boolean`。Task 4 が「・絞り込み中」の表示に使う。

- [ ] **Step 1: 失敗するテストを書く**

`finding-filter.test.ts` の末尾に足す（import に `isDefaultFilter` を加える）。

```ts
describe("isDefaultFilter", () => {
  it("DEFAULT_FINDING_FILTER は既定とみなす", () => {
    expect(isDefaultFilter(DEFAULT_FINDING_FILTER)).toBe(true);
  });

  it("各項目が 1 つでも既定と違えば既定ではない", () => {
    expect(isDefaultFilter({ ...DEFAULT_FINDING_FILTER, categories: ["grammar"] })).toBe(false);
    expect(isDefaultFilter({ ...DEFAULT_FINDING_FILTER, judgments: [] })).toBe(false);
    expect(isDefaultFilter({ ...DEFAULT_FINDING_FILTER, recheckStates: ["done"] })).toBe(false);
    expect(isDefaultFilter({ ...DEFAULT_FINDING_FILTER, locateStates: ["located"] })).toBe(false);
    expect(isDefaultFilter({ ...DEFAULT_FINDING_FILTER, showSuppressed: true })).toBe(false);
    expect(isDefaultFilter({ ...DEFAULT_FINDING_FILTER, showWithdrawn: true })).toBe(false);
  });

  it("toggleFilterValue で一度外して戻すと既定に戻る（全選択は null に正規化される）", () => {
    const off = toggleFilterValue(null, FILTER_CATEGORY_OPTIONS, FILTER_CATEGORY_OPTIONS[0]);
    const back = toggleFilterValue(off, FILTER_CATEGORY_OPTIONS, FILTER_CATEGORY_OPTIONS[0]);
    expect(isDefaultFilter({ ...DEFAULT_FINDING_FILTER, categories: back })).toBe(true);
  });
});
```

`recheckStates: ["done"]` の値は `RECHECK_STATES` の要素名に合わせる（`finding-filter.ts` の `RECHECK_STATES` を読み、存在する値を使う）。3 つ目のテストは `toggleFilterValue` が「全部選ばれたら null に戻す」ことを前提にしている。`finding-filter.ts` の `toggleFilterValue` の doc コメント（125 行目付近）でそうなっていることを確かめてから書く。そうなっていなければ 3 つ目のテストは書かない。

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/finding-filter.test.ts`
Expected: FAIL（`isDefaultFilter` が無い）

- [ ] **Step 3: 実装する**

`DEFAULT_FINDING_FILTER` の直後に足す。

```ts
/**
 * 絞り込みが既定のまま（`DEFAULT_FINDING_FILTER` と同じ）か。折りたたんだ絞り込みに
 * 「絞り込み中」を出すかどうかの判定に使う（UI の見直し 1 節）。全選択は `toggleFilterValue` が
 * null に正規化するので、配列の中身を比べる必要はない。
 */
export function isDefaultFilter(filter: FindingFilter): boolean {
  return (
    filter.categories === null &&
    filter.judgments === null &&
    filter.recheckStates === null &&
    filter.locateStates === null &&
    filter.showSuppressed === DEFAULT_FINDING_FILTER.showSuppressed &&
    filter.showWithdrawn === DEFAULT_FINDING_FILTER.showWithdrawn
  );
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/finding-filter.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/features/results/finding-filter.ts packages/web/src/features/results/finding-filter.test.ts
git commit -m "PR14a: 絞り込みが既定のままかを判定する isDefaultFilter を足す"
```

（コミットメッセージの末尾には `Co-Authored-By` の行を付ける。以下のタスクも同じ。）

---

### Task 2: 進捗の内訳を「詳しい進捗」に折りたたむ

**Files:**
- Modify: `packages/web/src/features/results/run-progress.tsx`
- Modify: `packages/web/src/features/results/results-page.module.css`（`.progress` 周辺）
- Test: `packages/web/src/features/results/run-progress.test.tsx`

**Interfaces:**
- Consumes: 既存の `RunProgressProps`（変えない）
- Produces: `RunProgress` の DOM 構成。件数の行（`検査: 完了 n / 全 m 件`、`再確認: …`）は `<details>` の外。状態別の内訳（検査・再確認それぞれの「失敗 n 件 処理中 n 件 未処理 n 件 対象外 n 件」）と観点別の行は、`<summary>詳しい進捗</summary>` を持つ `<details>` の中。遅延の通知は `<details>` の外。

- [ ] **Step 1: 失敗するテストを書く**

`run-progress.test.tsx` に足す。

```tsx
describe("RunProgress: 内訳の折りたたみ（UI の見直し 1 節）", () => {
  it("件数の行は折りたたみの外、状態別・観点別の内訳は「詳しい進捗」の中にある", () => {
    const progress = makeProgress({
      checkUnits: makeCounts({ done: 2, pending: 1 }),
      recheckUnits: makeCounts({ done: 1 }),
    });
    const units: RunUnitsDto = {
      checkUnits: [makeCheckUnit({ id: "c1", perspective: "typo", status: "done" })],
      recheckUnits: [],
    };
    const { container } = render(
      <RunProgress progress={progress} units={units} recheckEnabled={true} slowUnitCount={1} />,
    );
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(within(details as HTMLElement).getByText("詳しい進捗")).toBeInTheDocument();

    // 件数の行と遅延の通知は外
    const checkLine = screen.getByText(/^検査: 完了 2 \/ 全 3 件/);
    expect(details?.contains(checkLine)).toBe(false);
    expect(details?.contains(screen.getByText(/^再確認: 完了 1 \/ 全 1 件/))).toBe(false);
    expect(details?.contains(screen.getByText(/生成が遅延しています/))).toBe(false);

    // 内訳と観点別は中
    expect(within(details as HTMLElement).getAllByText(/未処理 \d+ 件/).length).toBeGreaterThan(0);
    expect(within(details as HTMLElement).getByText(/誤字・脱字: 完了 1 \/ 全 1 件/)).toBeInTheDocument();
  });

  it("再確認なしのときも「再確認なし」は折りたたみの外", () => {
    const { container } = render(
      <RunProgress progress={makeProgress()} units={null} recheckEnabled={false} slowUnitCount={0} />,
    );
    const details = container.querySelector("details");
    expect(details?.contains(screen.getByText("再確認なし"))).toBe(false);
  });
});
```

`makeCheckUnit` の `RunUnitsDto` の形（`checkUnits` / `recheckUnits` のキー名）は、同じファイルの「B8: RunProgress の観点別の内訳」のテストに合わせる。

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/run-progress.test.tsx`
Expected: FAIL（`details` が無い）

- [ ] **Step 3: 実装する**

`run-progress.tsx` の `RunProgress` と `UnitTallySection` を次の形にする。`UnitTallySection` を「件数の行」（`UnitTallyLine`）と「状態別の内訳」（`UnitTallyBreakdown`）に分け、観点別だけは今と同じく行と内訳をまとめて出す。冒頭の doc コメントに「件数の行は常に見せ、内訳と観点別は『詳しい進捗』に折りたたむ（UI の見直し 1 節。仕様 5.3 の上部の観点別の進捗は折りたたみの中で満たす）」を 1 段落足す。

```tsx
export function RunProgress(props: RunProgressProps) {
  const { progress, units, recheckEnabled, slowUnitCount } = props;
  const checkTally = tallyOf(progress.checkUnits);
  const recheckTally = tallyOf(progress.recheckUnits);
  const perspectives = perspectiveTallies(units);
  const recheckNote =
    checkTally.done + checkTally.notApplicable < checkTally.total ? "検査が進むと件数が増えます" : null;

  return (
    <div className={styles.progress}>
      <div className={styles.progressSummary}>
        <UnitTallyLine label="検査" tally={checkTally} />
        {recheckEnabled ? (
          <UnitTallyLine
            label="再確認"
            tally={recheckTally}
            // 再確認の単位は検査が終わった範囲の指摘から作られるので、検査が残っている間は
            // 総数が増えていく。「完了 3 / 全 3 件」を終わったと読まれないよう、そのことを添える。
            note={recheckNote}
          />
        ) : (
          <p className={styles.progressLine}>再確認なし</p>
        )}
      </div>

      <details className={styles.progressDetails}>
        <summary className={styles.progressDetailsSummary}>詳しい進捗</summary>
        <UnitTallyBreakdown label="検査" tally={checkTally} />
        {recheckEnabled && <UnitTallyBreakdown label="再確認" tally={recheckTally} />}
        {/* I-1（レビュー指摘）の観点別の内訳。ここは件数の行と内訳を組で出す。 */}
        {perspectives.length > 0 && (
          <div className={styles.progressPerspectiveList}>
            {perspectives.map(({ perspective, tally }) => (
              <div key={perspective} className={styles.progressSection}>
                <UnitTallyLine label={PERSPECTIVE_LABELS[perspective]} tally={tally} />
                <UnitTallyBreakdown tally={tally} />
              </div>
            ))}
          </div>
        )}
      </details>

      {slowUnitCount > 0 && (
        <p className={styles.progressSlowNotice}>
          生成が遅延しています（{slowUnitCount} 件）。応答を待っています。
        </p>
      )}
    </div>
  );
}

function UnitTallyLine(props: {
  readonly label: string;
  readonly tally: UnitTally;
  /** 件数の後ろに括弧で添える補足。無ければ null か省略。 */
  readonly note?: string | null;
}) {
  const { label, tally, note = null } = props;
  if (tally.total === 0) {
    return <p className={styles.progressLine}>{label}: 準備中</p>;
  }
  return (
    <p className={styles.progressLine}>
      {label}: {formatCount(tally)}
      {note !== null && `（${note}）`}
    </p>
  );
}

/**
 * 状態別の内訳（決定 11：対象外は分母に含めたうえで内訳として別に出す。失敗・処理中・未処理も
 * 件数のみ）。`label` を渡すと先頭に「検査」などの見出しを付ける（観点別の行では付けない）。
 * `total === 0` のときは何も出さない（件数の行が「準備中」を出す）。
 */
function UnitTallyBreakdown(props: { readonly label?: string; readonly tally: UnitTally }) {
  const { label, tally } = props;
  if (tally.total === 0) return null;
  return (
    <div className={styles.progressBreakdown}>
      {label !== undefined && <span className={styles.progressBreakdownLabel}>{label}</span>}
      <ul className={styles.progressDetailList}>
        <li>
          {UNIT_STATUS_LABELS.failed} {tally.failed} 件
        </li>
        <li>
          {UNIT_STATUS_LABELS.running} {tally.running} 件
        </li>
        <li>
          {UNIT_STATUS_LABELS.pending} {tally.pending} 件
        </li>
        <li>
          {UNIT_STATUS_LABELS["not-applicable"]} {tally.notApplicable} 件
        </li>
      </ul>
    </div>
  );
}
```

`results-page.module.css` の `.progress` の近くに足す（既存の `.progressLine`・`.progressDetailList`・`.progressPerspectiveList`・`.progressSection` はそのまま使う）。

```css
/* 件数の行（検査・再確認）。ヘッダーの 1 行目に横並びで入る（UI の見直し 1 節）。 */
.progressSummary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs) var(--space-md);
}

/* 状態別・観点別の内訳を畳む「詳しい進捗」。閉じているときは summary の 1 行だけになる。 */
.progressDetails {
  font-size: var(--font-size-sm);
}

.progressDetailsSummary {
  cursor: pointer;
  color: var(--color-fg-muted);
}

.progressBreakdown {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-sm);
}

.progressBreakdownLabel {
  color: var(--color-fg);
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/run-progress.test.tsx src/features/results/run-header.test.tsx src/features/results/results-page.test.tsx`
Expected: PASS。既存の `run-progress.test.tsx` のうち、「I-1」の 3 件（`container` の中で `対象外 2 件` / `処理中 2 件` を探すもの）は、閉じた `<details>` の中身も DOM にあるのでそのまま通るはず。通らないものがあれば、テストの意図（その表示が出る／出ない）を変えずに、探す範囲を `details` 要素に絞る形で直す。

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/features/results/run-progress.tsx packages/web/src/features/results/run-progress.test.tsx packages/web/src/features/results/results-page.module.css
git commit -m "PR14a: 進捗の状態別・観点別の内訳を「詳しい進捗」に折りたたむ"
```

---

### Task 3: ヘッダーを 2 行に組み直す

**Files:**
- Modify: `packages/web/src/features/results/run-header.tsx`
- Modify: `packages/web/src/features/results/results-page.module.css`（`.header`・`.status`・`.statusLine`）
- Test: `packages/web/src/features/results/run-header.test.tsx`

**Interfaces:**
- Consumes: Task 2 の `RunProgress`（props は変えない）
- Produces: `RunHeader` の DOM 構成（props は変えない）。
  - 1 行目 `.headerMain`：`<h1>` 原稿名、`.statusLine`「状態: …」、停止理由があれば「停止理由: …」、`RunProgress`、`RunControl`、「最新の状態を取得」ボタン。
  - 2 行目 `.headerMeta`：「モデル: …」「開始: …」「終了: …」。
  - その下：停止メッセージ（あれば）、中間状態の案内（`statusNotice`）。

設計書は「1 行にまとめる」としているが、モデルと時刻まで 1 行目に入れると 1920px 幅でも折り返すため、小さめの文字の 2 行目に分ける（設計からの調整。PR 本文に書く）。

- [ ] **Step 1: 失敗するテストを書く**

`run-header.test.tsx` に足す。既存の `makeRun`・`makeProgress` と、既存テストが `RunHeader` を描くときの props の渡し方（`render(<RunHeader … />)` の形）をそのまま使う。

```tsx
describe("RunHeader: 2 行の構成（UI の見直し 1 節）", () => {
  it("1 行目に名前・状態・進捗・操作、2 行目にモデルと時刻が入る", () => {
    const { container } = render(
      <MemoryRouter>
        <RunHeader
          run={makeRun({ status: "running" })}
          manuscriptName="原稿 A"
          progress={makeProgress({ checkUnits: makeCounts({ done: 1, pending: 1 }) })}
          units={null}
          slowUnitCount={0}
          onRefresh={() => {}}
          refreshing={false}
          onStop={() => {}}
          onResume={() => {}}
          onRetryFailed={() => {}}
          onConfirmRecovery={() => {}}
          pending={null}
          failure={null}
        />
      </MemoryRouter>,
    );
    const main = container.querySelector(`.${styles.headerMain}`) as HTMLElement;
    const meta = container.querySelector(`.${styles.headerMeta}`) as HTMLElement;
    expect(within(main).getByRole("heading", { name: "原稿 A" })).toBeInTheDocument();
    expect(within(main).getByText("状態: 実行中")).toBeInTheDocument();
    expect(within(main).getByText(/^検査: 完了 1 \/ 全 2 件/)).toBeInTheDocument();
    expect(within(main).getByRole("button", { name: "停止" })).toBeInTheDocument();
    expect(within(main).getByRole("button", { name: "最新の状態を取得" })).toBeInTheDocument();
    expect(within(meta).getByText("モデル: model-a")).toBeInTheDocument();
    expect(within(meta).getByText(/^開始: /)).toBeInTheDocument();
  });
});
```

`styles` は `import styles from "./results-page.module.css";` で読み込む（vitest の CSS Modules の設定で、クラス名が文字列として取れることは `results-page.test.tsx` が `findingListStyles.findingRow` を使っていることで確認済み）。`RUN_STATUS_LABELS.running` が「実行中」であることは `labels.ts` で確かめる。

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/run-header.test.tsx`
Expected: FAIL（`.headerMain` が無い）

- [ ] **Step 3: 実装する**

`run-header.tsx` の `return` を次の形にする（`settingsStop` の分岐は残す。doc コメントの「画面ごとの仕様」1〜8 の番号との対応も残し、2 行の構成にしたことを 1 段落足す）。

```tsx
  return (
    <div className={styles.header}>
      <div className={styles.headerMain}>
        <h1 className={styles.headerTitle}>{manuscriptName}</h1>
        {settingsStop ? (
          <p className={styles.statusLine}>検査は開始できませんでした</p>
        ) : (
          <>
            <p className={styles.statusLine}>状態: {RUN_STATUS_LABELS[run.status]}</p>
            {run.stopReason !== null && (
              <p className={styles.statusLine}>
                停止理由: {RUN_STOP_REASON_LABELS[run.stopReason]}
              </p>
            )}
            {/* 4+5. 進捗（決定 10・11）。件数の行だけが見え、内訳は「詳しい進捗」に畳まれる。 */}
            <RunProgress
              progress={progress}
              units={units}
              recheckEnabled={run.recheckEnabled}
              slowUnitCount={slowUnitCount}
            />
          </>
        )}
        {/* 6+7. 操作と操作結果の案内（決定 6・7・8）。`isSettingsStop` でも出しうる（決定 14）。 */}
        <RunControl
          run={run}
          units={units}
          onStop={onStop}
          onResume={onResume}
          onRetryFailed={onRetryFailed}
          onConfirmRecovery={onConfirmRecovery}
          pending={pending}
          failure={failure}
        />
        <button
          type="button"
          className={styles.refreshButton}
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? "更新中…" : "最新の状態を取得"}
        </button>
      </div>

      {!settingsStop && (
        <div className={styles.headerMeta}>
          <span>モデル: {run.modelId}</span>
          {/* 裁定（最終レビュー Important 3）：ローカル時刻で表示する（`format-date-time.ts`）。 */}
          <span>
            開始: {formatDateTime(run.startedAt, -new Date(run.startedAt).getTimezoneOffset())}
          </span>
          {run.finishedAt !== null && (
            <span>
              終了: {formatDateTime(run.finishedAt, -new Date(run.finishedAt).getTimezoneOffset())}
            </span>
          )}
        </div>
      )}

      {run.stopMessage !== null && <p className={styles.stopMessage}>{run.stopMessage}</p>}
      {settingsStop && (
        <p>
          <Link to={ROUTES.home}>検査設定に戻る</Link>
        </p>
      )}
      {/* 3. 中間状態の案内（決定 9）。 */}
      {!settingsStop && notice !== null && <p className={styles.statusNotice}>{notice}</p>}
    </div>
  );
```

注意：
- 既存テストは「モデル: model-a」を `getByText` で探している可能性がある。`<span>` 1 つにテキストを 1 つの文字列として入れる（`モデル: {run.modelId}` は JSX で 2 つのテキストノードになるが、`getByText` は要素の `textContent` で照合するので通る）。
- 停止メッセージ・案内文の位置が変わるだけで、出す条件は変えない。

`results-page.module.css` の `.header`・`.status` を次に置き換える（`.status` は使わなくなるので消す。`.statusLine` は残す）。

```css
.header {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

/* 1 行目：名前・状態・件数・操作。幅が足りなければ折り返す。 */
.headerMain {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-xs) var(--space-md);
}

.headerTitle {
  margin: 0;
  font-size: var(--font-size-lg);
}

/* 2 行目：モデルと時刻。小さめの文字で 1 行に並べる。 */
.headerMeta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-md);
  font-size: var(--font-size-sm);
  color: var(--color-fg-muted);
}
```

`.statusLine` に `margin: 0;` を足す（横並びにしたとき段落の既定の余白で高さがずれないように）。`RunControl` の `.controlPanel`・`.controlButtons` が縦並びの指定なら、横並びになるよう `display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm);` にする（`RESUME_SCOPE_NOTE` の注記は再開ボタンの下に残る）。

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/`
Expected: PASS（`run-header.test.tsx` の既存 11 件と、`results-page.test.tsx` の settings 停止のテストを含む）

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/features/results/run-header.tsx packages/web/src/features/results/run-header.test.tsx packages/web/src/features/results/results-page.module.css
git commit -m "PR14a: 結果画面のヘッダーを、状態と操作の行とモデル・時刻の行の 2 行にする"
```

---

### Task 4: 右の列を「詳細（上）」と「絞り込み＋一覧（下）」の 2 段にし、絞り込みを折りたたむ

**Files:**
- Modify: `packages/web/src/features/results/results-page.tsx`（右の列の描画 1066〜1093 行付近、`FindingsPanel` 1100 行以降）
- Modify: `packages/web/src/features/results/results-page.module.css`
- Test: `packages/web/src/features/results/results-page.test.tsx`

**Interfaces:**
- Consumes: Task 1 の `isDefaultFilter(filter: FindingFilter): boolean`
- Produces:
  - 右の列の DOM：`.sideColumn` の中に `.detailPane`（`data-testid` は付けない）→ `.findingsPane` の順。`.detailPane` は選択中なら `FindingDetail`、そうでなければ `<p className={styles.detailEmpty}>本文の強調か一覧から指摘を選んでください</p>`。
  - `FindingsPanel` の絞り込み：`<details className={styles.filterDetails}>` の `<summary>` が `絞り込み（<span>{visible.length} / {findings.length} 件</span>を表示中）` と、既定でなければ `<span>・絞り込み中</span>`。中身は今の `FindingFilterControls`。
  - `detailPaneRef: RefObject<HTMLDivElement | null>`。Task 5 が選択の変化で `scrollTop = 0` に戻すのに使う。

- [ ] **Step 1: 失敗するテストを書く**

`results-page.test.tsx` に足す。既存の `makeClient`・`makeRunDetail`・`makeManuscript`・`makeFinding`・`makeFindingDetail`・`renderPage` を使う。

```tsx
describe("ResultsPage: 右の列の 2 段（UI の見直し 1 節）", () => {
  function setup(findings: FindingDto[]) {
    const getRun = vi.fn(() => Promise.resolve(makeRunDetail({ status: "completed" })));
    const getManuscript = vi.fn(() => Promise.resolve(makeManuscript()));
    const getFindings = vi.fn(() => Promise.resolve(findings));
    const getFinding = vi.fn((id: string) => Promise.resolve(makeFindingDetail({ id })));
    return makeClient({ getRun, getManuscript, getFindings, getFinding });
  }

  it("選んでいないときは詳細の位置に案内が出て、選ぶと詳細に替わる", async () => {
    const user = userEvent.setup();
    renderPage(setup([makeFinding({ id: "finding-1", quote: "一", range: { start: 0, end: 1 } })]));
    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    expect(screen.getByText("本文の強調か一覧から指摘を選んでください")).toBeInTheDocument();

    await user.click(document.querySelector('[data-findings~="finding-1"]') as HTMLElement);
    await waitFor(() =>
      expect(screen.queryByText("本文の強調か一覧から指摘を選んでください")).not.toBeInTheDocument(),
    );
  });

  it("詳細は絞り込みと一覧より前（上）にある", async () => {
    const user = userEvent.setup();
    renderPage(setup([makeFinding({ id: "finding-1", quote: "一", range: { start: 0, end: 1 } })]));
    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    await user.click(document.querySelector('[data-findings~="finding-1"]') as HTMLElement);

    const detailPane = document.querySelector(`.${findingListStyles.detailPane}`) as HTMLElement;
    const filterDetails = document.querySelector(`.${findingListStyles.filterDetails}`) as HTMLElement;
    expect(detailPane).not.toBeNull();
    expect(filterDetails).not.toBeNull();
    // detailPane が filterDetails より前にある
    expect(
      detailPane.compareDocumentPosition(filterDetails) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("絞り込みは閉じた状態で件数を出し、既定から変えると「絞り込み中」が付き、戻すと消える", async () => {
    const user = userEvent.setup();
    renderPage(setup([makeFinding({ id: "finding-1", quote: "一", range: { start: 0, end: 1 } })]));
    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());

    const filterDetails = document.querySelector(
      `.${findingListStyles.filterDetails}`,
    ) as HTMLDetailsElement;
    expect(filterDetails.open).toBe(false);
    expect(within(filterDetails).getByText(/を表示中/)).toBeInTheDocument();
    expect(screen.queryByText("・絞り込み中")).not.toBeInTheDocument();

    const toggle = within(filterDetails).getByRole("checkbox", { name: "抑制された指摘も表示する" });
    await user.click(toggle);
    expect(screen.getByText("・絞り込み中")).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByText("・絞り込み中")).not.toBeInTheDocument();
  });

  it("絞り込みで選択中の指摘が消えると、詳細の位置に案内が戻る", async () => {
    const user = userEvent.setup();
    renderPage(
      setup([
        makeFinding({ id: "finding-1", quote: "一", range: { start: 0, end: 1 }, category: "notation" }),
      ]),
    );
    await waitFor(() => expect(screen.getByText("1 / 1 件")).toBeInTheDocument());
    await user.click(document.querySelector('[data-findings~="finding-1"]') as HTMLElement);
    await waitFor(() =>
      expect(screen.queryByText("本文の強調か一覧から指摘を選んでください")).not.toBeInTheDocument(),
    );

    // 分類「誤字・表記」（notation）を外す
    const filterDetails = document.querySelector(
      `.${findingListStyles.filterDetails}`,
    ) as HTMLElement;
    await user.click(within(filterDetails).getByRole("checkbox", { name: "誤字・表記" }));
    await waitFor(() =>
      expect(screen.getByText("本文の強調か一覧から指摘を選んでください")).toBeInTheDocument(),
    );
  });
});
```

`findingListStyles` は `results-page.test.tsx` がすでに読み込んでいる `results-page.module.css`（名前は歴史的な理由で `findingListStyles`）。`within` が import されていなければ足す。チェックボックスの名前（「抑制された指摘も表示する」「誤字・表記」）は `finding-filter.tsx` と `labels.ts` の実際の文言に合わせる。`FindingDto` の型 import が無ければ足す。

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/results-page.test.tsx -t "右の列の 2 段"`
Expected: FAIL

- [ ] **Step 3: 実装する**

`results-page.tsx` の右の列（今の `<div className={styles.sideColumn}>` の中身）を次にする。`detailPaneRef` は `bodyContainerRef` の近くで `const detailPaneRef = useRef<HTMLDivElement | null>(null);` として宣言する。

```tsx
              <div className={styles.sideColumn}>
                {/* 詳細は右の列の上に固定する（UI の見直し 1 節）。本文を読みながら強調を選んだとき、
                    一覧の長さに関係なくすぐ見える位置に出すため。長いときはこの中だけでスクロールする。 */}
                <div className={styles.detailPane} ref={detailPaneRef}>
                  {selectedFinding !== null && related !== null ? (
                    <FindingDetail
                      finding={selectedFinding}
                      detail={findingDetail}
                      detailError={findingDetailError}
                      body={state.manuscript.body}
                      sameRange={related.sameRange}
                      overlapping={related.overlapping}
                      onSelectFinding={handleSelectFinding}
                      // `onNavigate` は省略可（`exactOptionalPropertyTypes` の下では `undefined` を
                      // 明示的に渡すのと「キー自体を省く」のは別物）。移動先が無いときはキーごと省く。
                      {...(selectedNavigationTarget !== null ? { onNavigate: handleNavigate } : {})}
                      onSaveJudgment={handleSaveJudgment}
                    />
                  ) : (
                    <p className={styles.detailEmpty}>本文の強調か一覧から指摘を選んでください</p>
                  )}
                </div>
                <div className={styles.findingsPane}>
                  <FindingsPanel
                    run={state.run}
                    findings={state.findings}
                    freshness={findingsFreshness}
                    visible={visible}
                    filter={filter}
                    onFilterChange={handleFilterChange}
                    selectedFindingId={selectedFindingId}
                    onSelectFinding={handleSelectFindingFromList}
                  />
                </div>
              </div>
```

`FindingsPanel` の最後の `return` を次にする（0 件のときの早期 `return` は変えない）。

```tsx
  return (
    <div className={styles.findingsPanel}>
      {/* 絞り込みは閉じておき、件数と「絞り込み中」だけを見せる（UI の見直し 1 節）。
          件数は既存の表示「n / m 件」をそのまま独立した要素に残す（テストと読み手の目印）。 */}
      <details className={styles.filterDetails}>
        <summary className={styles.filterSummary}>
          絞り込み（<span className={styles.findingCount}>{visible.length} / {findings.length} 件</span>
          を表示中）
          {!isDefaultFilter(filter) && <span className={styles.filterActive}>・絞り込み中</span>}
        </summary>
        <FindingFilterControls filter={filter} onChange={onFilterChange} />
      </details>
      <FindingList
        findings={visible}
        selectedFindingId={selectedFindingId}
        onSelectFinding={onSelectFinding}
      />
    </div>
  );
```

`isDefaultFilter` を `./finding-filter.ts` から import する。`.findingCount` の `margin: 0` は `<span>` では不要だが害はないので CSS はそのまま残す。

`results-page.module.css` に足し、`.sideColumn` を変える（`.bodyColumn` / `.sideColumn` の高さの指定は Task 6 で直すので、ここでは触らない）。

```css
.sideColumn {
  flex: 1 1 40%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

/* 詳細：右の列の上に固定。高さは列のおよそ半分まで、超えたらこの中だけでスクロール。 */
.detailPane {
  flex: 0 1 auto;
  max-height: 50%;
  overflow-y: auto;
  min-height: 0;
}

.detailEmpty {
  margin: 0;
  padding: var(--space-md);
  border: 1px dashed var(--color-border);
  border-radius: 4px;
  color: var(--color-fg-muted);
  font-size: var(--font-size-sm);
}

/* 絞り込み＋一覧：詳細の下の残りの高さを使い、この中でスクロールする。 */
.findingsPane {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.filterDetails {
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: var(--space-xs) var(--space-sm);
}

.filterSummary {
  cursor: pointer;
  font-size: var(--font-size-sm);
  color: var(--color-fg-muted);
}

.filterActive {
  color: var(--color-accent);
  font-weight: bold;
}
```

既存の `.sideColumn` にある `overflow-y: auto` は、この形では右の列全体ではなく `.findingsPane` と `.detailPane` がそれぞれスクロールするので外す（Task 6 で高さの指定と一緒に整理する）。`.detail`（`FindingDetail` の外枠）の doc コメントにある「`.findingsPanel` の下に置く」を「`.detailPane` の中に置く」に直す。

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/`
Expected: PASS（既存の「1 / 1 件」を待つテストは、件数の `<span>` がそのまま残るので通る）

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/features/results/results-page.tsx packages/web/src/features/results/results-page.test.tsx packages/web/src/features/results/results-page.module.css
git commit -m "PR14a: 右の列の上に詳細を固定し、絞り込みを件数付きの折りたたみにする"
```

---

### Task 5: 本文の強調から選んだら、一覧の行を見える位置へスクロールし、詳細を先頭に戻す

**Files:**
- Modify: `packages/web/src/features/results/finding-list.tsx`（`FindingListItem` の `<li>`）
- Modify: `packages/web/src/features/results/navigate.ts`（`findListRow` を足す）
- Modify: `packages/web/src/features/results/results-page.tsx`（`handleSelectFinding`、選択の変化の effect）
- Test: `packages/web/src/features/results/results-page.test.tsx`（「Task 9 指摘から本文への移動」の 1 件目を直す）
- Test: `packages/web/src/features/results/navigate.test.ts`（`findListRow` のテストを足す）

**Interfaces:**
- Consumes: Task 4 の `detailPaneRef`、`.findingsPane` の中の一覧、`navigate.ts` の `scrollIntoViewIfPossible(element: Element): void`
- Produces: 一覧の各 `<li>` に `data-finding-id={finding.id}`。`navigate.ts` の `export function findListRow(container: HTMLElement, findingId: string): HTMLElement | null`。

- [ ] **Step 1: 失敗するテストを書く**

`describe("ResultsPage: Task 9 指摘から本文への移動")` の 1 件目の前半（本文の強調のクリック）の期待を、次のように直す。本文の強調自体へは移動しない点は変えず、一覧の行へのスクロールが 1 回起きることを確かめる。

```tsx
    // 本文の強調をクリック：選択は変わる（詳細が出る）。本文の強調自体へは移動しない
    // （すでに見えている場所なので）。代わりに一覧の該当行を見える位置へ送る（UI の見直し 1 節）。
    await user.click(highlight);
    await waitFor(() => expect(getFinding).toHaveBeenCalledWith("finding-1"));
    const rowItem = document.querySelector('[data-finding-id="finding-1"]') as HTMLElement;
    expect(rowItem).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(rowItem);
    expect(scrollIntoView.mock.contexts).not.toContain(highlight);

    // 一覧の行をクリック：本文の強調へ移動する（既存の動き）。
    const row = document.querySelector(`.${findingListStyles.findingRow}`) as HTMLElement;
    await user.click(row);

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.contexts[1]).toBe(highlight);
```

`navigate.test.ts` に足す（一覧の行を探す関数の単体テスト。行が無いときに何もしないことを、React の DOM を手で壊さずに確かめる）。

```ts
describe("findListRow", () => {
  it("data-finding-id が一致する要素を返す", () => {
    const container = document.createElement("div");
    const row = document.createElement("li");
    row.dataset.findingId = "finding-1";
    container.append(row);
    expect(findListRow(container, "finding-1")).toBe(row);
  });

  it("無ければ null を返す（絞り込みで一覧に無い指摘）", () => {
    const container = document.createElement("div");
    expect(findListRow(container, "finding-1")).toBeNull();
  });

  it("ID にセレクターの特殊文字が含まれても探せる", () => {
    const container = document.createElement("div");
    const row = document.createElement("li");
    row.dataset.findingId = 'a"b';
    container.append(row);
    expect(findListRow(container, 'a"b')).toBe(row);
  });
});
```

3 つ目は `CSS.escape` が jsdom にあるかに依存する。`navigate.test.ts` の既存のテストが `findTargetElement` で同じことを確かめていれば、その書き方に合わせる。jsdom に `CSS.escape` が無く既存のテストもこの場合を扱っていなければ、3 つ目は書かない。

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/results-page.test.tsx src/features/results/navigate.test.ts`
Expected: FAIL（`data-finding-id` と `findListRow` が無い）

- [ ] **Step 3: 実装する**

`finding-list.tsx` の `FindingListItem` の `<li>` を `<li data-finding-id={finding.id}>` にする。

`navigate.ts` の `findTargetElement` の後に足す（import に `findListRow` を加える。`escapeForSelector` は同じファイルの既存の関数）。

```ts
/** 一覧の行（`finding-list.tsx` の `<li data-finding-id>`）を探す。無ければ null（絞り込みで一覧に無い）。 */
export function findListRow(container: HTMLElement, findingId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-finding-id="${escapeForSelector(findingId)}"]`);
}
```

`results-page.tsx` の `handleSelectFinding` を次にする（doc コメントの「ここでは選択するだけで本文への移動はしない」の段落に、一覧の行を見える位置へ送ることを足す）。

```tsx
  // 右の列の「絞り込み＋一覧」の容器。本文の強調から選んだとき、一覧の行をここから探す。
  const findingsPaneRef = useRef<HTMLDivElement | null>(null);

  const handleSelectFinding = useCallback((findingId: string) => {
    setSelectedFindingId(findingId);
    // 本文の強調から選んだときは、一覧の該当行を見える位置へ送る（UI の見直し 1 節）。
    // 本文の強調自体へはスクロールしない（見えている場所をクリックしたので跳ねさせない。Task 9）。
    const pane = findingsPaneRef.current;
    if (pane === null) return;
    const row = findListRow(pane, findingId);
    if (row !== null) scrollIntoViewIfPossible(row);
  }, []);
```

Task 4 で書いた `<div className={styles.findingsPane}>` に `ref={findingsPaneRef}` を付ける。

選択が変わったら詳細を先頭に戻す effect を足す（`selectedFindingId` の宣言より後）。

```tsx
  // 選ぶ指摘が変わったら、詳細の中のスクロールを先頭に戻す（前の指摘の途中の位置が残らないように）。
  useEffect(() => {
    const pane = detailPaneRef.current;
    if (pane !== null) pane.scrollTop = 0;
  }, [selectedFindingId]);
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm --filter @shuten/web exec vitest run src/features/results/`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/features/results/finding-list.tsx packages/web/src/features/results/navigate.ts packages/web/src/features/results/navigate.test.ts packages/web/src/features/results/results-page.tsx packages/web/src/features/results/results-page.test.tsx
git commit -m "PR14a: 本文の強調から選んだら一覧の行を見える位置へ送り、詳細を先頭に戻す"
```

---

### Task 6: ページ全体をスクロールさせず、2 カラムを残りの高さに収める

**Files:**
- Create: `packages/web/src/app/layout.module.css`
- Modify: `packages/web/src/app/layout.tsx`
- Modify: `packages/web/src/styles/global.css`（`main` の規則）
- Modify: `packages/web/src/features/results/results-page.module.css`（`.page`・`.layout`・`.bodyColumn`・`.sideColumn`）

**Interfaces:**
- Consumes: Task 4 の `.sideColumn` / `.detailPane` / `.findingsPane`
- Produces: アプリの枠 `.shell`（高さ 100%、縦 flex）と `.main`（残りの高さ、はみ出したらスクロール）。他の画面（トップ・設定・実行一覧）は `.main` の中で今までどおり縦にスクロールする。

jsdom はレイアウトを計算しないので、このタスクは実ブラウザで確かめる（Step 4）。

- [ ] **Step 1: アプリの枠を縦 flex にする**

`app/layout.module.css`（新規）：

```css
/**
 * アプリの枠（UI の見直し 1 節）。ヘッダーの下の `main` を残りの高さに収め、はみ出したら `main` の
 * 中でスクロールさせる。結果画面はこの高さの中で 2 カラムを伸ばし、ページ全体をスクロールさせない。
 * 他の画面は今までどおり `main` の中で縦にスクロールする。
 */
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.main {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-lg);
}
```

`app/layout.tsx`：

```tsx
import { Outlet } from "react-router";
import { Header } from "./header.tsx";
import styles from "./layout.module.css";

/** 全画面共通のヘッダーと本文領域。`main` は残りの高さに収まり、はみ出したらその中でスクロールする。 */
export function Layout() {
  return (
    <div className={styles.shell}>
      <Header />
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
```

`styles/global.css` の `main { padding: var(--space-lg); }` を消す（`.main` に移した）。`header { … }` の規則は `app/header.module.css` の `.header` と重なっているが、このタスクでは触らない。

- [ ] **Step 2: 結果画面を `main` の高さに合わせる**

`results-page.module.css` の `.page` を次にする（`main` がすでに余白を持つので、二重にならないよう `padding` を外す）。

```css
.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  height: 100%;
}
```

`.layout` と 2 カラムを次にする（`calc(100vh - 3.5rem - …)` の固定値の引き算と、その説明のコメントを、次のコメントに置き換える）。

```css
.layout {
  display: flex;
  gap: var(--space-lg);
  flex: 1 1 auto;
  /* ヘッダーや案内文が高くなっても、2 カラムが潰れきらない最低限の高さ。足りない分は
     アプリの `main` がスクロールする（Review Focus 4）。 */
  min-height: 20rem;
}

/*
 * 本文（左）と右の列を独立してスクロールさせる（PR12a Task 9、決定 15）。UI の見直し 1 節で、
 * 固定値の引き算（`calc(100vh - …)`）をやめ、`.page`（`main` の高さ）を縦 flex で埋める形にした。
 * 右の列は全体ではなく、中の `.detailPane` と `.findingsPane` がそれぞれスクロールする。
 */
.bodyColumn {
  flex: 1 1 60%;
  min-width: 0;
  overflow-y: auto;
}

.sideColumn {
  flex: 1 1 40%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}
```

（Task 4 で書いた `.sideColumn` はこれで置き換わる。重複して 2 つ書かれていないことを確かめる。）

- [ ] **Step 3: テストと型・lint を通す**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 4: 実ブラウザで確かめる**

`docs/experiments/2026-10-02-browser-check/` と同じ手順で、WSL2 上でサーバーを起動し（`pnpm build` → 接続先を環境変数で渡して `pnpm start`、データディレクトリはスクラッチ領域）、評価原稿 2 で検査を 1 回最後まで回す。chrome-devtools MCP で次を確かめる。

1. 結果画面でページ全体がスクロールしない：`document.querySelector("main").scrollHeight <= document.querySelector("main").clientHeight + 1` が真。
2. スクロールする要素が `.bodyColumn`・`.detailPane`（長い詳細のときだけ）・`.findingsPane` に限られる（`overflowY` が `auto` で `scrollHeight > clientHeight` の要素を列挙する）。
3. 一覧の最後の指摘を選ぶと、本文の列が末尾まで動き、詳細が右上に出る。
4. 本文の中ほどの強調を選ぶと、詳細が右上に出て、一覧の該当行が見える位置に来る。
5. 停止中で失敗した単位の一覧も出る状態（実行 2 と同じ手順でタイムアウトを短くして停止する）で、2 カラムが潰れきらない。
6. トップ・設定・実行一覧の画面が、今までどおり縦にスクロールできる。

スクリーンショットは `docs/` に入れない（本文が写るため）。結果は PR 本文に書く。

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/app/layout.tsx packages/web/src/app/layout.module.css packages/web/src/styles/global.css packages/web/src/features/results/results-page.module.css
git commit -m "PR14a: アプリの枠を縦 flex にし、結果画面のスクロールを本文と右の列の 2 か所にする"
```

---

### Task 7: ロードマップと経過を更新する

**Files:**
- Modify: `docs/plans/2026-09-07-mvp-roadmap.md`（PR 一覧の PR14a の行、`### PR14a〜PR14c` の節）
- Modify: `docs/history.md`（末尾）

- [ ] **Step 1: ロードマップの PR14a を完了にする**

PR 一覧の `PR14a   web         結果画面の配置（…）` の末尾に `（完了）` を足す。`### PR14a〜PR14c web：UI の見直し` の節の PR14a の行に、ヘッダーを 2 行にしたこと（設計からの調整）と、詳細計画 `docs/plans/2026-10-02-pr14a-results-layout.md` へのリンクを足す。

- [ ] **Step 2: 経過に 1 段落足す**

`docs/history.md` の末尾に足す。

```markdown
続けて **PR14a（結果画面の配置）が完了**した。選んだ指摘の詳細を右の列の上に固定し、
本文の強調を選べばすぐ詳細と採否が見えるようにした。絞り込みと進捗の内訳は折りたたみ、
ヘッダーは状態と操作の行と、モデル・時刻の行の 2 行にした。ページ全体はスクロールせず、
本文の列と右の列だけがスクロールする。設計は `docs/plans/2026-10-02-ui-refresh.md`。
```

- [ ] **Step 3: コミット**

```bash
git add docs/plans/2026-09-07-mvp-roadmap.md docs/history.md
git commit -m "PR14a: ロードマップと経過を更新する"
```

---

## 実装時の調整

実装と実ブラウザでの確認の中で、計画から次のように変えた。

- **ヘッダーを 2 行にした。** 設計の「1 行にまとめる」から、状態と操作の行とモデル・時刻の行に分けた（Task 3 の冒頭のとおり）。遅延の通知、復旧待ちの案内、操作の失敗の案内は、計画の DOM のとおりヘッダーの 1 行目の中（折り返しの中）に出る。設計は「ヘッダーの下」としていたが、停止中の実測で崩れていないので、見た目の整理は PR14c に回す。
- **詳細欄の高さを列の半分に固定し、下限を 16rem にした。** Task 4 の `max-height: 50%` では、下の一覧の枠と高さを取り合って縮み、詳細を読み込むと一覧の枠が縮んで、直前に送った一覧の行が隠れた。高さを固定し、狭い画面（1280×600 で 202px）でも採否が枠に入るよう下限を付けた。
- **詳細欄の区画の余白を詰めた。** 素の `section`・`h3`・`p` にブラウザ既定の余白が付いていたので、`.detail` と `.judgmentControl` の中に限った CSS で詰めた。
- **詳細欄で採否を修正案の直後に置いた（ユーザーの決定、2026-10-02）。** 詰めても、理由や判定が長いと採否が枠の外に出たため。項目は変えず、並びだけを変えた。

## 完了の条件

- `pnpm check` が通る（WSL2）。Windows では CI だけで確かめる旨を PR に書く。
- Task 6 Step 4 の 6 項目を実ブラウザで確かめ、結果を PR 本文に書く。
- PR 本文に、設計からの調整（ヘッダーを 2 行にしたこと）を書く。
