# PR12c（server：指摘一覧の 3N+1 解消）計画書

> **エージェント向け**：superpowers:subagent-driven-development で 1 タスクずつ実装する。
> 本書の「決定 1〜10」「テスト」節が要件の正本で、タスク分解はその割り付けである。

- ロードマップ：`docs/plans/2026-09-07-mvp-roadmap.md`（PR12c の節）
- 前提 PR：PR12a（`docs/plans/2026-09-11-pr12a-result-view.md` 決定 14。計測と判断基準）、PR12b
- 不変条件：`docs/reference/invariants.md`
- 仕様：新しい振る舞いを足さないので、仕様書の改訂は伴わない

## 目標

`GET /api/runs/:id/findings` が指摘 1 件ごとに出している 3 本の問い合わせ（理由・再確認・採否）を、
**実行 1 件ぶんをまとめて読む形**に変える。応答の JSON は 1 バイトも変えない。

PR12a 決定 14 の計測で、指摘 800 件・各件に理由 1・再確認 1・採否 1 を添えた状態の中央値は
**110〜130 ms 台**（WSL2/Linux）で、判断基準の 100 ms を上回った。本ブランチ着手時にも再現している
（`median=125.12ms`、samples 124.29〜127.02 ms）。

## 対象外（MUST NOT）

- **応答の形・並び・値を変えない。** `FindingDto` の構造も、指摘の並び（`start` 昇順 → 位置未確定は
  最後 → `created_at` → `id`）も、理由の並び（`candidate_index` 昇順）も現状のままにする。
  既存の `packages/server/src/api/findings.test.ts` と `api/leak.test.ts` が回帰の網である。
- **新しい口を足さない。** クエリパラメーターによる絞り込み・ページングは足さない（絞り込みは
  クライアント側。PR10 決定 15）。
- **失敗・欠落を正常値に丸めない。** `judgments` の行が無い指摘は今までどおり例外（500 `internal`）。
  Map から引けないことを「未判断」として既定値に丸めてはならない（不変条件）。
- **`GET /api/findings/:id`（詳細）には手を入れない**（決定 9）。
- **スキーマを変えない・索引を足さない**（決定 5）。マイグレーション `0003` は作らない。
- **web には一切触れない。** 本 PR は `packages/server` だけの変更である。

## 全体の制約（このブランチのすべての作業に適用）

- 公開リポジトリである。個人情報・機器固有の値（IP アドレス、ユーザー名を含むパス）・実原稿を
  コミットしない。接続先 URL と API キーを検査履歴・ログ・結果出力に含めない。
- TypeScript は strict（`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、
  `noUncheckedIndexedAccess`）。相対 import は `.ts` 拡張子付き。
- Vitest は `globals: true` を使わない（`describe` / `it` / `expect` は明示的に import する）。
- ドキュメント・コミットメッセージ・コード内コメントは日本語、識別子は英語。
- 作業の完了前に `pnpm check` を通す。Windows で未確認ならその旨を明記する。
- `git add -A` / `git add .` は使わない（必ず明示パスで stage する）。

## 現状（ここを直す）

`GET /api/runs/:id/findings` が出す問い合わせ（`packages/server/src/api/findings.ts`）：

| 回数 | 出どころ | 内容 |
| --- | --- | --- |
| 1 | `findRun` | 実行の存在確認 |
| 1 | `listFindings` | `findings` を `run_id` で列挙 |
| N | `listFindings` → `toFindingWithReasons` → `listReasons` | 指摘 1 件ごとに `candidates` × `check_units` |
| N | ハンドラー → `findRecheckUnitByFinding` | 指摘 1 件ごとに `recheck_units` |
| N | ハンドラー → `requireJudgment` → `findJudgment` | 指摘 1 件ごとに `judgments` |

`candidates` には `finding_id` 単独の索引が無いため、`listReasons` の 1 回ごとに
`candidates` の全走査が起きる。ここが遅さの主因である（PR12a 決定 14 の内訳計測：
遅さの 9 割は問い合わせそのもので、JSON 変換や zod 検証の寄与は小さい）。

## 決定

### 決定 1：方式は「実行 1 件ぶんをまとめて読む」バッチ取得にする

`GET /api/runs/:id/findings` の問い合わせを **1 + 4 本の固定本数**にする。

| 本数 | 内容 |
| --- | --- |
| 1 | `findRun`（実行の存在確認。現状のまま） |
| 1 | `findings` を `run_id` で列挙（現状のまま） |
| 1 | 理由をまとめて取る（決定 2） |
| 1 | `listRecheckUnits(db, runId)`（既存） |
| 1 | `listJudgments(db, runId)`（既存） |

検討して却下した代替案：

- **`candidates.finding_id` に索引を足すだけ。** 1 回ごとの走査は消えるが往復の本数は 3N+1 のまま
  残り、マイグレーションも増える。バッチ化の方が効き目が大きく、スキーマを触らずに済む。
- **SQL 1 本で指摘・理由・再確認・採否をすべて結合して取る。** 指摘 1 件につき理由の行数だけ
  行が重複し、組み立て直しが複雑になる。本数は 4 本でも定数なので、素直な 4 本を採る。
- **DTO の組み立てをサーバー側でキャッシュする。** 状態の正本は DB という不変条件に反する。

### 決定 2：理由は `candidates.run_id` で 1 本にまとめる

```sql
select candidates.id, candidates.finding_id, check_units.perspective, candidates.llm
  from candidates
  inner join check_units on candidates.check_unit_id = check_units.id
 where candidates.run_id = ? and candidates.finding_id is not null
 order by candidates.candidate_index asc
```

- **`finding_id` ではなく `run_id` で絞ってよい根拠**：`candidates` には複合外部キー
  `(finding_id, run_id) → findings(id, run_id)` がある（`db/schema.ts`。PR8 決定 16）。
  候補の `run_id` と、その候補が紐づく指摘の `run_id` は必ず一致する。つまり
  「`run_id` で絞って `finding_id` で畳む」結果は、指摘ごとに `finding_id` で絞った結果と等しい。
- **索引**：`candidates_run_id_candidate_index_key`（`run_id`, `candidate_index`）が
  そのまま where と order by を満たす。走査ではなく索引順の読み取りになるので、本数が減るだけでなく
  1 本あたりも速くなる。
- **`order by candidate_index` も、`finding_id is not null` と同じくテストでは見分けられない**
  （Task 1 の実測。`EXPLAIN QUERY PLAN` は
  `SEARCH candidates USING INDEX candidates_run_id_candidate_index_key (run_id=?)` となり、
  この索引を等値検索に使う限り SQLite は `ORDER BY` の有無にかかわらず索引キー順＝
  `candidate_index` 昇順で行を返す。投入順をどうずらしても変わらない）。
  **それでも `order by` は必ず書く。** 並びの正しさを実行計画に依存させないためである。
  テストで守れるのは「`candidates.id` のような別のキーで並べ替えてしまう」取り違えの方で、
  そちらは C1 が実測で見分けている。
- **`finding_id` を必ず SELECT する。** これが `Map` のキーである。
- **`finding_id is not null` は効率と意図の明示のための条件であって、応答を変える条件ではない。**
  `outside-target` の候補（統合先を持たない。PR8 決定 4）はキーが null の組に入るだけで、指摘は
  自分の ID（文字列）で引くので応答には混ざらない。**つまりこの 1 行を外しても応答は変わらず、
  テストでは見分けられない**（レビュー Important 2）。それでも書く理由は、読む側に「統合先の無い
  候補は理由にならない」と示すことと、無関係な行の `llm` を解析しないで済むことである。
- 畳み込みは `Map<findingId, FindingReason[]>` に `push` するだけでよい。読み取りが
  `candidate_index` 昇順なので、各配列の中も `candidate_index` 昇順になる（現状と同じ並び）。

### 決定 3：`listFindings` の公開シグネチャは変えない

`listFindings(db, runId): FindingWithReasons[]` のまま、内部を「1 本（`findings`）＋ 1 本（理由）」に
変える。呼び出し側（`api/findings.ts`）から見た型も並びも変わらない。

`findFinding`（詳細が使う 1 件取得）は `listReasons` を残して今までどおりにする。1 件に対する
1 本なので N+1 にならない。`listReasons` はこの経路のためだけに残る。

### 決定 4：再確認・採否はハンドラーで `Map` に畳む

`api/findings.ts` の `buildFindingDto` は指摘 1 件ごとに `findRecheckUnitByFinding` と
`findJudgment` を呼んでいる。一覧では代わりに、既にあるリポジトリ関数を 1 回ずつ呼ぶ。

- `listRecheckUnits(db, runId)`（`db/repositories/rechecks.ts`）→ `Map<findingId, RecheckUnitRecord>`。
  `recheck_units_finding_id_key`（`finding_id` の一意索引）があるので、キーの衝突は起こらない。
- `listJudgments(db, runId)`（`db/repositories/judgments.ts`）→ `Map<findingId, JudgmentRecord>`。
  **`Map` に無い指摘は今までどおり例外にする**（`judgments の行がありません（指摘 ID: …）`）。
  既存テスト「judgments の行を消した指摘の一覧は 500 internal」がこの経路を守る。

詳細（`GET /api/findings/:id`）は 1 件なので、今までどおり `findRecheckUnitByFinding` /
`findJudgment` を直接呼ぶ。共通化のために一覧の経路へ寄せない（1 件のために実行全体の再確認・採否を
読むのは無駄）。

### 決定 5：索引もマイグレーションも足さない

バッチ化の後に残る全表走査は、実行 1 件あたり `findings`（1 本）、`recheck_units`（1 本）、
`judgments` × `findings` の結合（1 本）である。いずれも**従来から `listFindings` 本体が 1 本出していた
のと同じ性質**で、指摘の件数に比例して本数が増えることはない。MVP の規模（単一利用者、1 万字程度の
原稿）では走査で足りる。索引を足せばさらに速くなる余地はあるが、マイグレーションを増やしてまで
必要かは実測が示していない。**Task 4 の再計測で、この判断が妥当であることを数字で確かめる。**

### 決定 6：応答は 1 バイトも変えない

構造・値・並びをすべて保つ。守るのは既存テスト：

- `api/findings.test.ts`（一覧の並び、`reasons` / `recheck` / `judgment` の中身、404、500）
- `api/leak.test.ts`（接続先 URL・API キーが応答に出ない）
- `db/repositories/findings.test.ts`（`listFindings` の並びと `reasons`）

これらを**書き換えずに通す**ことが Task 1・2 の合格条件である（期待値をいじって通したら失敗と見なす）。

### 決定 7：守りは「時間」ではなく「クエリ本数」で入れる

時間のしきい値は環境差で揺れるため、N+1 の再発を守るのに向かない。**実際に実行された SQL 文の本数**を
数えて、指摘の件数を変えても本数が変わらないことを検査する。

- 継ぎ目：`createDatabase(file, options?)` に `onStatement?: (sql: string) => void` を足し、
  better-sqlite3 の `verbose` に渡す。**`verbose` は実行された SQL 文 1 本につきちょうど 1 回呼ばれる**
  ことを本ブランチで実測して確かめた（`PRAGMA`・DDL・`select` すべてが 1 本ずつ記録される）。
  `exactOptionalPropertyTypes` があるので、`{ verbose: undefined }` を渡す形にはせず条件付きで組み立てる。
- `api/test-support.ts` の `setupApi` に `onStatement` の override を足す（テスト基盤側の変更）。
- 計数は `applyMigrations` とデータ投入がすべて終わった後、`app.request(...)` の直前に 0 に戻す
  （マイグレーションや投入の SQL を数えないため）。
- 検査するのは 2 点：**指摘 3 件と 30 件で本数が等しい**ことと、**本数が小さい定数以下**であること。
  期待は 5 本（`findRun` 1・`findings` 1・理由 1・再確認 1・採否 1）だが、drizzle が内部で別の文を
  足す可能性があるので、**実装時に実測した値で上限を固定する**（実測より緩い上限にしない）。

### 決定 8：`findings.perf.test.ts` は残し、役割を書き換える

計測専用（「サーバーの実装は変えない」と書いてある）から、**改善後の回帰の歯止め**に役割を変える。

- 冒頭コメントを書き直す：3N+1 だった経緯、PR12c で 1 + 4 本にしたこと、判断値は決定 14 の 100 ms で
  なく本数テスト（決定 7）が本来の守りであること。
- 上限 5,000 ms は据え置く（遅い CI ランナーでも落ちないための歯止め。桁違いの回帰だけを捕まえる）。
- 中央値の `console.log` は残す。**改善後の実測値を Task 4 で本書と PR12a 決定 14 に記録する。**

### 決定 9：詳細（`GET /api/findings/:id`）は対象外

詳細が出す問い合わせは、指摘 1 件・理由 1 本・再確認 1 本・採否 1 本・候補 1 本に加えて、
候補ごとの `findDiagnostic` である。**指摘 1 件ぶんの取得であり、本 PR が計測した一覧の遅さ
（指摘の件数に比例して増える問い合わせ）とは別の話**なので対象外にする。

候補の数に上限があるとは書かない（レビュー Minor 4）。観点は `typo` と `naturalness` の 2 つだが、
1 回の応答が同じ統合キーの候補を複数返せるため、1 指摘に統合される候補の数は 2 件に制限されない。
ここを「定数で抑えられている」と断定するには実測がいる。本 PR では計測していないので、
**恒久的に触らないとまでは決めない**。一覧と同じ遅さが実際に観測されたら、そのときに測って判断する。

### 決定 10：グルーピングの正しさは「見分けられるテスト」で守る

既存の `findings.test.ts` の指摘はすべて理由 1 件で、`candidate_index` も指摘ごとに 1 つずつしか
無い。この形だけでは、`Map` の組み立てを間違えても（たとえば `candidate_index` ではなく
挿入順で並べる、`finding_id` を取り違える）テストが赤くならない。次の形の種を足す：

- 指摘 A に `candidate_index` 0 と 4、指摘 B に 1 と 2、指摘 C に 3 を与える（**飛び番かつ交互**）。
  A の `reasons` は `candidate_index` 0 → 4 の順、B は 1 → 2 の順になること。
- 指摘 A・B にそれぞれ固有の理由を持たせ、同じ実行に `outside-target`（`finding_id` が null）の
  候補も 1 件混ぜる。**A の `reasons` は A のものだけ、B の `reasons` は B のものだけ**であることを
  完全一致（`toEqual`）で検査し、`outside-target` がどちらにも現れないことも見る。
  「`outside-target` が混ざらない」だけを見る形にはしない——`finding_id is not null` を残す限り
  その候補はそもそも取得されないので、**畳み込みを取り違えても通ってしまう**
  （レビュー Important。決定 2 も参照）。**見分けたい誤りは「取得した候補を全指摘に配る」
  ことである**から、他の指摘の理由が混ざったら落ちる形でなければならない。
- 観点が異なる候補（`typo` と `naturalness`。`Perspective` はこの 2 つだけである。
  `packages/shared/src/llm/schema.ts`）を 1 つの指摘に統合し、`perspective` が候補ごとに
  正しく付くこと（`check_units` との結合が指摘単位に潰れていないこと）。

## テスト

| # | 内容 | 置き場所 |
| --- | --- | --- |
| C1 | `listFindings` が飛び番・交互の `candidate_index` でも各指摘の `reasons` を昇順で返す（決定 10） | `db/repositories/findings.test.ts` |
| C2 | `listFindings` が観点の違う複数候補を 1 指摘の `reasons` に正しく並べる（決定 10） | `db/repositories/findings.test.ts` |
| C3 | 指摘 A・B の `reasons` がそれぞれ自分の候補だけであることを完全一致で検査し、`outside-target` の候補がどちらにも混ざらない（決定 2・10） | `db/repositories/findings.test.ts` |
| C4 | 一覧の応答が理由 2 件・再確認あり／なし・採否ありの指摘で従来どおりであること（決定 6） | `api/findings.test.ts` |
| C5 | `judgments` の行が無い指摘の一覧が 500 `internal`（既存テストをそのまま通す。決定 4） | `api/findings.test.ts`（既存） |
| C6 | 指摘 3 件と 30 件で、`GET /api/runs/:id/findings` が実行する SQL 文の本数が等しく、上限以下（決定 7） | `api/findings.query-count.test.ts`（新規） |
| C7 | 指摘 800 件の中央値が上限（5,000 ms）を下回る（既存。役割を書き換える。決定 8） | `api/findings.perf.test.ts`（既存） |

**「実装前に落ちる」テストは C6 だけである。** C1〜C4 は振る舞いを変えない改修の網（characterization
test）なので、現状の実装でも通る。通ることに意味があるのではなく、**間違ったバッチ化をしたときに
落ちる**ことに意味がある。したがって C1〜C4 は、**実装後に意図的な変異（決定 10 の取り違え方を
実際にコードへ入れる）で落ちることを 1 件ずつ実測して**初めて「守れている」と言える。
実測しない限り合格としない。

**ただし、どう変異させても落ちない箇所が 2 つある**——`finding_id is not null`（決定 2）と
`order by candidate_index`（決定 2。索引探索の順がそのまま昇順になるため）である。
この 2 つは「テストで守られている」と報告してはならない。守っているのは**取得の畳み込み**
（どの指摘にどの理由が入るか）と**明示的な並べ替えキーの取り違え**である。

## 完了条件

- C1〜C7 が通り、`pnpm check` が緑。
- `api/findings.test.ts` / `api/leak.test.ts` / `db/repositories/findings.test.ts` の**既存の期待値を
  書き換えていない**こと（決定 6）。
- C1〜C4 が意図的な変異で落ちることを 1 件ずつ実測し、作業報告に記録している（決定 10）。
- 改善後の中央値を実測し、本書・PR12a 決定 14・ロードマップに記録している。
- ロードマップの PR12c 節を「完了」に、PR12b 節の持ち越し「`GET /api/runs/:id/findings` の 3N+1 は
  引き続き PR12c の担当」を解消済みに、README の該当記述を更新している。

## 持ち越し・既知の制限（着手時点の見込み）

- Windows 未確認（CI の Windows ジョブが通ることで代える。実機確認はしない）。
- 実 LLM を動かした本物のデータでの確認はしない（合成データでの計測のみ）。
- 索引の追加による更なる高速化は行わない（決定 5）。再計測の値が期待どおりでなければ、
  その時点で索引の要否を判断して本書に追記する。

## タスク分解

### Task 1：`listFindings` の理由を 1 本にまとめる（決定 2・3・10）

- Modify: `packages/server/src/db/repositories/findings.ts`
- Test: `packages/server/src/db/repositories/findings.test.ts`（C1・C2・C3）

1. C1・C2・C3 を先に書き、現状の実装でも**通ってしまう**ものが無いか確かめる
   （現状の `listReasons` は正しいので C1〜C3 は通る。ここで見るのは「テストが種を正しく作れて
   いるか」であり、落ちる必要は無い。落ちるのは**間違ったバッチ化をしたとき**である）。
2. `listFindings` の内部を、`findings` の列挙 1 本＋理由 1 本（決定 2 の SQL）に変える。
   `toFindingWithReasons` は `Map` から引く形にし、`listReasons` は `findFinding` 専用として残す。
3. C1〜C3 と既存の `findings.test.ts`（リポジトリ）が通ることを確認する。
4. **確かめ方**：バッチ化を意図的に壊して、C1〜C3 が落ちることを 1 件ずつ実測する。
   - `order by` を `candidates.id` にする → C1 が落ちる
   - `Map` を使わず、取得した候補すべてを各指摘の `reasons` に渡す → C3 が落ちる
     （A に B の理由が混ざるため。`Map` のキーを `run_id` にする変異は使わない——
     `outside-target` の不在しか見ない C3 なら通ってしまうのと同じ理由で、
     **C3 が A・B の理由を完全一致で検査している**ことが前提の変異である）
   - `perspective` を指摘の先頭候補の値で埋める → C2 が落ちる

   **`finding_id is not null` を外す変異は使わない。** それでは応答が変わらないのでどのテストも
   落ちない（決定 2。レビュー Important 2）。落ちない変異を「守れている証拠」に数えないこと。
5. コミット。

### Task 2：一覧ハンドラーの再確認・採否を `Map` にする（決定 4・6）

- Modify: `packages/server/src/api/findings.ts`
- Test: `packages/server/src/api/findings.test.ts`（C4。C5 は既存）

1. C4（理由 2 件・再確認あり／なし・採否ありが混ざった一覧）を書く。
2. 一覧のハンドラーで `listRecheckUnits` / `listJudgments` を 1 回ずつ呼び、`Map` を作って
   `toFindingDto` に渡す。`Map` に採否が無ければ従来と同じ文言で例外を投げる。
   詳細（`GET /api/findings/:id`）の経路は変えない。
3. C4・C5 と既存の `findings.test.ts` / `leak.test.ts` が通ることを確認する。
4. **確かめ方**：`Map` の引き方を意図的に壊して（再確認の `Map` を空にする、採否の欠落を
   `undecided` に丸める）、C4・C5 がそれぞれ落ちることを実測する。
5. コミット。

### Task 3：クエリ本数の回帰テストを入れる（決定 7）

- Modify: `packages/server/src/db/client.ts`（`onStatement` の継ぎ目）、
  `packages/server/src/api/test-support.ts`（`setupApi` の override）
- Create: `packages/server/src/api/findings.query-count.test.ts`（C6）

1. `createDatabase(file, options?: { readonly onStatement?: (sql: string) => void })` を足す。
   better-sqlite3 の `verbose` に渡す。`exactOptionalPropertyTypes` のため条件付きで組み立てる。
   JSDoc に「テストのための継ぎ目であり、本番の呼び出しは第 2 引数を渡さない」と書く。
2. `setupApi` に `onStatement` の override を足し、`createDatabase` へ素通しする。
3. C6 を書く。件数 3 と 30 で本数が等しいこと、上限以下であることを検査する。
   計数の 0 戻しは投入がすべて終わった後・`app.request` の直前。
4. **実装前に落ちることを確かめる**：Task 1・2 を revert した状態では本数が件数に比例するので
   C6 は落ちる。`git stash` などで確かめてもよいし、上限を実測値に固定する前に一度
   「3 件と 30 件の本数」を出力して確かめてもよい。
5. 実測した本数で上限を固定し、その値を本書の決定 7 に追記する。
6. コミット。

### Task 4：再計測とドキュメント（決定 5・8、完了条件）

- Modify: `packages/server/src/api/findings.perf.test.ts`（冒頭コメント）、
  `docs/plans/2026-09-11-pr12c-findings-batch.md`（本書）、
  `docs/plans/2026-09-11-pr12a-result-view.md`（決定 14 に後日談を追記）、
  `docs/plans/2026-09-07-mvp-roadmap.md`（PR12c を完了に、PR12b の持ち越しを解消に、
  「2026-09-09 の見直し」節の N+1 の記述に結論を追記）、`README.md`

1. `pnpm --filter @shuten/server exec vitest run src/api/findings.perf.test.ts --reporter=verbose` を
   3 回走らせ、中央値を記録する（改善前は `median=125.12ms`）。
2. `findings.perf.test.ts` の冒頭コメントを決定 8 のとおり書き直す。上限 5,000 ms は据え置く。
3. 本書の決定 5 に、再計測の値と「索引を足さない判断が妥当だった／見直しが要る」の結論を追記する。
4. PR12a 決定 14 の末尾に、PR12c で解消したことと改善後の実測値を追記する。
5. ロードマップと README を更新する。
6. `pnpm check` を通し、コミット。
