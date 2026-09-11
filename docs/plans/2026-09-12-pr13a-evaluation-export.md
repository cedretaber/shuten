# PR13a（server + cli：評価ツールとエクスポート）計画書

> **エージェント向け**：superpowers:subagent-driven-development で 1 タスクずつ実装する。
> 本書の「決定 1〜18」「テスト」節が要件の正本で、タスク分解はその割り付けである。

- ロードマップ：`docs/plans/2026-09-07-mvp-roadmap.md`（PR13a の節）
- 仕様：10 全体（評価方法）、8.1（保存する情報）、8.2 末尾（可搬用の一括エクスポート形式は実装設計時に決める）
- 前提 PR：PR7（`runPipeline` と結果 JSON）、PR8（DB スキーマ）、PR10（HTTP API・決定 16 でエクスポートを本 PR に移した）、PR12c（実行スコープの一括取得）
- 不変条件：`docs/reference/invariants.md`

## 目標

仕様書 10 節の評価を、**手作業の集計なしに回せる状態**にする。具体的には次の 5 つを作る。

1. **正解ファイルの形式**（ユーザーが用意する。形式は本書の決定 2〜4 で確定する）
2. **突き合わせと集計**（検出率、誤検出、位置特定失敗率、抑制の適否、実行性能。CLI）
3. **複数回実行の集計**（同条件で複数回走らせた結果のぶれ。CLI）
4. **全文チャット方式の自由形式プロンプトと CLI モード**（仕様 10 節「現在の全文チャット方式」との比較）
5. **エクスポートの口と形式**（`GET /api/runs/:id/export`。PR10 決定 16 の持ち越し）

ロードマップの「評価原稿と正解データの準備」はユーザーの作業で、**1 の形式が決まらないと着手できない**。
本書で最初に決めるのはそれである（決定 2〜4）。

## PR の分割（決定 1）

5 つの成果物は互いにほぼ独立で、1 本の PR にするとレビュー単位が PR9b・PR12a を超える。
**PR13a-1（消費側）と PR13a-2（生産側）に分ける。** 根拠と順序は決定 1 に書く。

| | 中身 | 対象 |
| --- | --- | --- |
| **PR13a-1** | 正解ファイルの形式、本文ハッシュ、突き合わせと集計、複数回実行の集計、CLI のサブコマンド化 | `packages/cli`、`packages/server`（ハッシュのみ） |
| **PR13a-2** | エクスポートの口と形式、全文チャット方式の CLI モード、エクスポート JSON を評価の入力に加える | `packages/server`、`packages/cli` |

本書は 5 つすべての設計を含む。タスク分解は PR13a-1 を全量、PR13a-2 は骨子まで書く
（PR13a-1 の実装で分かることが PR13a-2 の細部に効くため、着手時に本書へ追記する）。

## 対象外（MUST NOT）

- **実原稿・実際の正解データ・ユーザーの実プロンプトを、リポジトリのどこにも置かない。**
  テストの fixture も、ドキュメントの例も、すべて合成のテキストで書く。正解ファイル・プロンプト
  ファイル・評価レポートはリポジトリ外（`sample_novel.txt` と同じ扱い）。
- **評価ツールが品質の合否を判定しない。** 指標を出すだけで、閾値・合格基準を持たない
  （仕様 10 節「精度の数値目標は、初回評価の結果を見て決定する」。決定 14）。
- **近似一致で位置を自動確定しない**（仕様 10 節）。正解の位置解決は完全一致だけで行う（決定 4）。
  診断候補の正誤は人が判断する（決定 11）。
- **人が判断する指標を機械が代わりに埋めない**（修正案の妥当性、人間の確認負担、診断候補の正誤。決定 11）。
  「判定できない」を既定値に丸めない（不変条件「失敗・形式不正を正常な値に置き換えない」）。
- **接続先 URL と API キーを、結果 JSON・エクスポート・評価レポート・標準出力・標準エラーに出さない。**
  エクスポートは既存の DTO 射影（`api/dto.ts`）だけを通す（決定 16）。
- **原稿本文を CLI のエラーメッセージに出さない**（決定 9）。パスも出さない（既存 `main.ts` の方針）。
- **仕様書の「合意した機能範囲」を広げない。** 評価ツールは本文を書き換えず、DB にも書かない。
- **`GET /api/runs/:id/export` 以外の新しい口を足さない**（PR13a-2。ロードマップの「この PR で足す唯一の
  新しい口」）。
- **エクスポートで指摘の件数に比例する問い合わせを作らない**（PR12c で解消したばかりの形を再発させない。決定 17）。
- **web には触れない。** エクスポートのボタンは MVP の画面仕様（仕様 5 節）に無い。

## 全体の制約（このブランチのすべての作業に適用）

- 公開リポジトリである。個人情報・機器固有の値（IP アドレス、ユーザー名を含むパス）・実原稿を
  コミットしない。接続先 URL と API キーを検査履歴・ログ・結果出力に含めない。
- TypeScript は strict（`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、
  `noUncheckedIndexedAccess`）。相対 import は `.ts` 拡張子付き。
- Vitest は `globals: true` を使わない（`describe` / `it` / `expect` は明示的に import する）。
- ドキュメント・コミットメッセージ・コード内コメントは日本語、識別子は英語。
- 作業の完了前に `pnpm check` を通す。Windows で未確認ならその旨を明記する。
- `git add -A` / `git add .` は使わない（必ず明示パスで stage する）。

## 現状

- CLI は `shuten --manuscript x --model y` の 1 用途だけで、`parseArgs` は `--flag value` の平坦な
  解釈器（`packages/cli/src/args.ts`）。結果は `PipelineResult` を JSON で吐く（`--out` または標準出力）。
- `PipelineResult.conditions.manuscript` は `utf16Length` / `graphemeCount` / `paragraphCount` /
  `targetCount` を持つが、**本文ハッシュを持たない**。正解ファイルを結果に結び付ける鍵がない。
- 本文ハッシュ `hashBody`（sha256 hex）は `packages/server/src/db/hash.ts` にあり、DB の
  `manuscript_versions.body_hash` を作るためだけに使われている。
- `mode: "full-text"` は既にあるが、これは**分割の対照**であって仕様 10 節の「現在の全文チャット方式」
  ではない（PR7 決定 8）。構造化出力を使い、プロンプトもアプリのもののままである。
- `GET /api/runs/:id/export` は無い（PR10 決定 16 で本 PR に移した）。
- 実行スコープの一括取得（`listFindings` / `listCandidates` / `listDiagnostics` / `listCheckUnits` /
  `listRunTargets` / `listRecheckUnits` / `listJudgments`）はすべて揃っている（PR8・PR12c）。

## 決定

### 決定 1：PR13a を 13a-1（消費側）と 13a-2（生産側）に分け、13a-1 を先にする

**理由。** 5 つの成果物のうち、正解ファイル・突き合わせ・複数回集計の 3 つは「結果 JSON を読んで数える」
側で、エクスポートと全文チャット方式は「結果を出す」側である。触るパッケージも、レビューで見るべき
性質（前者は集計の正しさ、後者は漏えいと口の形）も違う。PR9 → 9a/9b、PR12 → 12a/b/c と同じ理由で分ける。

**順序。** 13a-1 を先にする。品質指標は CLI で取る（ロードマップ 2026-09-09 の見直し「評価の経路」）ので、
`PipelineResult` だけを入力にすれば 13a-1 は単独で完結し、ユーザーの正解データが揃った時点ですぐ回せる。
13a-2 のエクスポートは「サーバー経由の通し実行 1 回」を同じ物差しで測るための追加入力で、13a-1 の
突き合わせ器ができていないと接ぎ先がない。

**却下した案。** (a) 1 本のままにする → タスク 12 個・変更 2 パッケージ・新形式 3 つになり、最終レビューが
成立しない。(b) 生産側を先にする → 13a-2 の「エクスポートを評価の入力に加える」が宙に浮く。

### 決定 2：正解ファイルは JSON 1 ファイル。誤りと「正常な文章」の 2 種類を持つ

仕様 10 節は「実在した誤字・脱字**と**、誤検出してほしくない正常な文章を用意する」と言う。
両方を 1 つのファイルに、`kind` で区別して入れる。

```json
{
  "formatVersion": "1",
  "manuscript": { "name": "評価原稿A", "bodyHash": "<sha256 hex>" },
  "entries": [
    {
      "id": "e001",
      "kind": "error",
      "perspective": "typo",
      "paragraphId": 12,
      "quote": "歩きはじじめた",
      "occurrence": 1,
      "expected": "歩きはじめた",
      "note": "「じ」の重複"
    },
    {
      "id": "n001",
      "kind": "normal",
      "paragraphId": 40,
      "quote": "そんでな、",
      "occurrence": 1,
      "note": "意図した口語"
    }
  ]
}
```

- `kind: "error"`：**拾ってほしい誤り。** `perspective`（`typo` | `naturalness`）が必須。
  仕様 10 節「誤字・脱字と、日本語の不自然さは別々に集計する」に対応する。
  `expected` は望ましい修正（任意）。修正案の妥当性を人が見るときの参照に使い、機械は判定に使わない。
- `kind: "normal"`：**指摘してほしくない正常な文章**（意図した口語・省略・倒置・造語・反復）。
  `perspective` は**持たない**。どの観点から指摘されても誤検出なので、観点は指摘側の値で数える。
- `id` は全項目で一意（重複はエラー）。レポートと正解ファイルを突き合わせる鍵になる。
- `note` は任意の自由記述。機械は読まない。
- `manuscript.bodyHash` は `hashBody(本文)`（sha256 の hex）。決定 3 のとおり照合に使う。
- `manuscript.name` は人が見るための名前。**原稿のパスは書かない**（機器固有の値をファイルに残さないため）。

**却下した案。**

- **TSV / CSV**：表計算で書ける利点はあるが、引用に改行・タブを含む項目の逃がし方が JSON より悪く、
  `kind` によって必須項目が変わる構造を表現できない。JSON なら zod で 1 か所検証でき、
  項目ごとに具体的な誤りを返せる。
- **UTF-16 オフセットを人が書く**：1 万字の原稿に対して手で書ける値ではなく、原稿を 1 文字直すたびに
  全件がずれる。決定 4 の解決方式なら、原稿が変わっても `bodyHash` の不一致として**必ず**露見する。
- **指摘の形（`LlmFinding`）を流用する**：`before` / `after` / `category` / `verdict` は LLM の出力の形で
  あって正解の形ではない。人が書く項目に不要な欄を強いる。

### 決定 3：正解ファイル・原稿・結果 JSON を本文ハッシュで 3 方向に縛る

評価の実行時に、次の 3 つが同じ原稿を指していることを確かめてから集計する。

1. `--manuscript` で読んだ本文の `hashBody(text)`
2. 正解ファイルの `manuscript.bodyHash`
3. 結果 JSON の `conditions.manuscript.bodyHash`

**1 つでも違えばエラー終了**（終了コード 1）。違う版の原稿に対する正解で採点した数字は、
気付かれずに誤った結論を生む。ハッシュ値そのものは（原稿の内容ではないので）エラーメッセージに出してよい。

そのために **`RunConditions.manuscript` に `bodyHash` を足す**。

- `hashBody` は `packages/server/src/db/hash.ts` から **`packages/server/src/hash.ts` へ移す**。
  DB 専用の値ではなく「原稿の同一性の鍵」であり、パイプラインからも使うため。呼び出し元は
  `db/repositories/manuscripts.ts` の 1 か所だけなので移動は機械的である。
- `RESULT_VERSION` は**上げない**。この定数自身の定義が「破壊的に形を変えるときだけ上げる」であり、
  項目の追加は既存の読み手を壊さない。
- ただし**評価ツールは `bodyHash` の無い結果 JSON を拒否する**（既定値で埋めない。不変条件）。
  PR13a-1 より前に作った結果 JSON は採点できない。実 LLM を回した結果はまだ無いので実害はない。

**ユーザーがハッシュ値を得る経路を用意する。** `hashBody` は `ingestUtf8Bytes` を通した後の
文字列（BOM を除いた本文）を hash するので、ファイルに対する `sha256sum` とは**一致しない**
（BOM 付きファイルで必ずずれる）。形式を「手で書けない値を要求する形式」にしないため、
**`shuten hash --manuscript <原稿>` を足す**（本文を読んで `hashBody` の結果を標準出力に 1 行出すだけ。
LLM に接続しない）。加えて、3 方向照合の不一致エラーには**計算したハッシュ値を出す**
（ハッシュは原稿の内容ではないので出してよい。原稿を直した後に貼り直せる）。

### 決定 4：正解の位置は「段落 ID ＋引用＋出現番号」で解決する

`paragraphId` の段落の範囲内で `quote` を**完全一致**で探し、`occurrence` 番目（1 起点、既定 1）を
その項目の範囲とする。書記素境界の内側に落ちる一致は採らない（`buildGraphemeIndex` /
`isGraphemeBoundary` を使う。仕様 6.3 と同じ規則）。

解決できない項目は**エラー**であり、黙って捨てない。次のすべてを 1 回の実行で列挙する
（1 件ずつ直して再実行する往復を避けるため、**全件を解決してからまとめて報告する**）。

- 段落 ID が原稿の段落数を超える
- 一致が 0 件
- 一致が `occurrence` 件に満たない
- `error` の項目と `normal` の項目の範囲が重なる（正解として矛盾している）

**段落 ID は 0 起点で、空行も 1 段落として数える**（仕様 6.1「空行の保持」、PR1）。
エディターの行番号（1 起点）とも、目で数えた「段落」とも一致しないので、
`docs/reference/truth-format.md` と zod のエラー文言の両方に明記する。

**解決に失敗したときの詳細は `--report` にだけ書く。** 標準出力・標準エラーには決定 9 のとおり
`id` と `paragraphId` と見つかった件数しか出さないが、それだけでは「その段落に何があるのか」を
確かめられない。`--report` が指定されているときに限り、**その段落の本文と見つかった一致の位置**を
レポートファイルに書く（出力先はユーザーが選んだリポジトリ外のファイルで、原稿の断片が入るのは
レポートの本来の役目と同じである）。`--report` なしでも集計は行える（失敗はエラーのまま）。

**`locateQuote` は使わない。** あれは `CheckInput`（検査対象と参考文脈）に縛られ、複数一致を
`ambiguous` として失敗にし、診断候補を作る。正解ファイルに要るのは「人が指定した n 番目の出現を
取る」ことで、規則が違う。専用の小さな解決器を `packages/cli/src/eval/truth.ts` に書く。
書記素境界の判定だけ `@shuten/shared` と共有する。

**引用は 1 つの段落に収まっていなければならない。** 段落をまたぐ誤り（閉じ括弧の欠落など）は
2 項目に分けて書く。段落をまたぐ指定は持ち越しにする（決定 18）。

### 決定 5：検出は「範囲の重なり」で判定する

正解項目の範囲 `e` と指摘の範囲 `f` が `f.start < e.end && e.start < f.end` を満たすとき重なりとする
（UTF-16 オフセットの半開区間）。

- **検出**：`kind: "error"` の項目に重なる指摘が 1 件以上あれば、その項目は検出された。
  **検出率 = 検出された error 項目数 / error 項目数。**
- **誤検出**：どの error 項目とも重ならない指摘。うち `normal` 項目と重なるものを `on-normal`、
  それ以外を `other` に分ける。**誤検出率 = 誤検出件数 / 指摘件数。**
- **優先順位**：error にも normal にも重なる指摘は**検出として数え、誤検出には数えない**。
  誤りの隣に意図した口語があるだけで誤検出が増えるのは実態に合わない。
- **重複指摘**：1 つの error 項目に 2 件以上が重なったときの余剰件数を別に出す（`duplicateFindings`）。
  検出率は項目単位なので二重に得点されない。

**完全一致を条件にしない理由。** LLM は誤りを含む語句を長めに引用する（「歩きはじじめた」ではなく
「彼は歩きはじじめた」）。完全一致を条件にすると、利用者にとっては正しく拾えている指摘が
未検出に数えられる。代わりに、重なったときの関係（`exact` / `containsTruth` / `containedInTruth` /
`partial`）をレポートに出し、**どこまで緩めてよいかを人が後から判断できる材料を残す**。

### 決定 6：観点は「全体」と「観点一致」の 2 通りで数える

`error` 項目は `perspective` を持ち、指摘は `sources[].perspective`（`MergedFinding` の元候補。
統合により複数ありうる）を持つ。

- **全体の検出率**：観点を問わず重なりがあれば検出。
- **観点一致の検出率**：項目の `perspective` が指摘の `sources[].perspective` のいずれかと一致する
  ものだけを数える。

両方出す。誤字を「不自然な日本語」として拾ってしまう挙動は、拾えてはいるが観点の設計が効いて
いないことを意味し、分けて見ないと分からない。誤検出は**指摘側の観点**で分類する（`normal` 項目は
観点を持たないため。決定 2）。

### 決定 7：再確認の前後を両方集計する

仕様 10 節は「再確認が正しい指摘を撤回していないか」を求め、仕様 8.1 は「再確認前の候補と撤回理由も
保存し、再確認による見逃し増加を評価できるように」と言う。したがって指標を **2 セット**出す。

- **再確認前**：`FindingResult` 全件（抑制されたものを除く）を指摘とみなす。
- **再確認後**：再確認が撤回した指摘を除いた集合を指摘とみなす。

そのうえで、再確認そのものの効き方を次の 4 つの数で出す。

| | 撤回した | 残した |
| --- | --- | --- |
| error 項目に重なる指摘 | **`withdrewTruePositive`（見逃しの増加。0 が望ましい）** | `keptTruePositive` |
| error 項目に重ならない指摘 | `withdrewFalsePositive`（再確認の利き） | `keptFalsePositive` |

撤回の判定は `RecheckResult.status === "done"` かつ `output.verdict === "withdraw"`。
`confirm-with-author` は撤回ではない（指摘は残り、作者に確認を促す。`RECHECK_VERDICTS` は
`keep` / `withdraw` / `confirm-with-author` の 3 値）。
**`done` かつ `withdraw` 以外はすべて「残した」側に数える**（`failed`・`pending`・`disabled`・
`suppressed`、および `confirm-with-author`）。再確認が失敗した指摘を、撤回されたものとしても
検出されたものとしても扱わないという意味で、これは「未完了を成功にも失敗にも丸めない」
（不変条件）の適用である。再確認が `failed` / `pending` の件数はレポートに別に出し、
再確認後の数字がどれだけ未完了を含んでいるかを人が見られるようにする。

`mode: "split"`（再確認なし）の結果 JSON では再確認後 = 再確認前になり、上の表は全 0 になる。

### 決定 8：抑制・位置特定失敗・実行性能の数え方

- **許容語の抑制**（`FindingResult.suppression !== null`）：error 項目に重なるものを
  `suppressedTruth`（**正しい指摘を抑制した。0 が望ましい**）、normal 項目に重なるものを
  `suppressedNormal`、どちらでもないものを `suppressedOther` に分ける。
  抑制された指摘は決定 5 の検出・誤検出の集合には**入れない**（利用者に指摘として出ないため）。
- **位置特定失敗**：`totals.unlocated` の内訳（`notFound` / `ambiguous` / `outsideTarget`）と、
  失敗率 = 失敗候補数 / 全候補数（`totals.candidates`）をそのまま出す。
  加えて**参考値**として、失敗候補の引用（`UnlocatedCandidate.llm.quote`）が error 項目の `quote` と
  相互に部分文字列の関係にある件数を出す（`unlocatedQuotingTruth`）。
  **これは検出率に算入しない。** 近似一致で位置を確定しないという仕様 10 節の規定と、
  位置が確定しない指摘は利用者に位置として提示されないという事実による。レポートでは
  「参考値（近似一致。検出率には算入しない）」と明記する。
- **実行性能**：`totals.requests` / `checkUnits.failed` / `checkUnits.pending` / `elapsedMs` と、
  `conditions.startedAt` / `finishedAt` をそのまま転記する。ツールは計り直さない。

### 決定 9：CLI をサブコマンド化する。既存の起動はそのまま通す

先頭トークンが `--` で始まらなければ**サブコマンド名**、`--` で始まれば **`run` を補う**。
サブコマンド名がハイフンで始まることはないので曖昧さがない。既存の `shuten --manuscript x --model y`
と、`packages/cli/src/args.test.ts`（218 行）・`main.test.ts`（498 行）はそのまま通る。

| サブコマンド | PR | 役割 |
| --- | --- | --- |
| `run`（既定） | 既存 | 検査パイプラインを回して結果 JSON を出す |
| `evaluate` | 13a-1 | 正解と結果 1 本を突き合わせて指標を出す |
| `aggregate` | 13a-1 | 同条件の結果 N 本のぶれを集計する |
| `hash` | 13a-1 | 原稿の `bodyHash` を 1 行出す（決定 3。LLM に接続しない） |
| `full-chat` | 13a-2 | 全文チャット方式（自由形式プロンプト）で 1 回生成する |

- 未知のサブコマンドはエラー（終了コード 1）。
- 引数が 1 つも無いときは `run` に振られ、既存の「必須オプションがありません: --manuscript, --model」
  になる（振る舞いを変えない）。
- `collectRawOptions` は**サブコマンドごとの既知オプション集合**を受け取る形に変える。
  併せて「同じオプションを複数回書ける」ことを宣言できるようにする（`aggregate --result` で使う）。
  それ以外のオプションは今までどおり重複をエラーにする。
- **エラーメッセージに原稿本文もパスも出さない。** 解決できない正解項目は `id` と `paragraphId` と
  「見つかった件数」だけを出す。引用を出さずとも、正解ファイルを開いて直せる。

### 決定 10：`evaluate` の入出力

```
shuten evaluate --manuscript <原稿> --truth <正解.json> --result <結果.json>
                [--out <指標.json>] [--report <レポート.md>]
```

- `--out` 未指定なら指標 JSON を標準出力に書く（`run` と同じ方針）。
- `--report` を指定したときだけ Markdown のレポートを書く。**人が判断する指標のための材料**で、
  未検出の error 項目の一覧、誤検出の指摘の一覧（引用・修正案・理由つき）、抑制された指摘の一覧を
  表で出す。決定 11 の「人が埋める欄」を表の列として空で用意する。
- `--out` と `--report` は入力ファイルのいずれとも同じ実体を指してはならない（既存 `run` の
  `findOutPathConflict` と同じ検査を使う。実原稿・正解ファイルを潰す事故を防ぐ）。
- 終了コードは 0（集計できた）／ 1（引数・入出力・ハッシュ不一致・正解の解決失敗）。
  **指標の良し悪しで終了コードを変えない**（決定 14）。

### 決定 11：機械が判定しない指標を表で明示する

仕様 10 節の 8 指標を、自動・人手で分ける。レポートにこの表をそのまま出し、
**人手の欄を機械が埋めない**ことを読む人にも分かるようにする。

| 指標（仕様 10 節） | 誰が | 出し方 |
| --- | --- | --- |
| 誤りの検出率 | 自動 | 決定 5・6 |
| 誤検出 | 自動 | 決定 5（`on-normal` と `other` に分ける） |
| 位置特定失敗 | 自動（内訳まで） | 決定 8 |
| 許容語の抑制 | 自動 | 決定 8 |
| 実行性能 | 自動（転記） | 決定 8 |
| 位置の正確さ | 自動（重なりの関係のみ） | 決定 5 の `exact` / `partial` などの内訳。最終判断は人 |
| **修正案の妥当性** | **人** | レポートの誤検出・検出一覧に空欄の列を置く |
| **人間の確認負担** | **人** | ツールは測らない（`docs/experiments/` に記録する） |
| **診断候補の正誤** | **人** | 参考値のみ自動（決定 8）。正誤は `docs/experiments/` に記録する |

人が付けた判定をツールに読み戻す経路は作らない（決定 18 の持ち越し）。

### 決定 12：複数回実行の集計は「条件が一致していること」を先に確かめる

```
shuten aggregate --manuscript <原稿> --truth <正解.json> --result a.json --result b.json ...
                 [--out <集計.json>] [--report <レポート.md>]
```

仕様 10 節「同じ設定でも非決定性が残るため複数回実行し、結果のぶれを併記する」の道具である。
**ぶれを測るには条件が同じでなければならない**ので、次が全ファイルで一致しない限りエラーにする
（警告で済ませない。条件が混ざった数字は読めない）。

`conditions.manuscript.bodyHash`、`mode`、`perspectives`、`generation`（`model` / `maxTokens` /
`temperature` / `seed` / `reasoningEffort`）、`chunkSettings`、`timeouts`、`allowedWords`、
`versions`（4 つすべて）。`allowedWords` は**順序を含めて**比較する（並びが違えばプロンプトが違う）。
`seed` は未指定どうし（`undefined`）を一致とみなす。

- `conditions.model`（LM Studio が返した `ModelInfo`）は**一致を要求しない**。`state` や
  `loadedContextLength` は実行のたびに変わりうる値で、条件ではない。ただし `id` と `quantization` が
  ばらついていればレポートに注意として出す。
- 出す値：各指標の**最小・中央値・最大**と、error 項目ごとの**検出回数 k/N**。
  k/N は「たまたま拾えた誤り」と「安定して拾える誤り」を分ける唯一の材料で、
  1 回の実行では絶対に見えない。
- `--result` は 2 本以上必要（1 本ならぶれを測れないのでエラー）。

### 決定 13：指標 JSON にも `formatVersion` を持たせる

`evaluate` / `aggregate` の出力にも `formatVersion: "1"` を置く。あとで指標の定義を変えたときに、
古いレポートと混ざらないようにする。定義を変えたら上げる。結果 JSON の `RESULT_VERSION` とは別物。

### 決定 14：閾値判定をしない

仕様 10 節は「精度の数値目標は、初回評価の結果を見て決定する」と言い、仕様 13 節の
「実用上許容する誤検出・見逃し・確認時間」は未決である。**エージェントが独断で確定しない**という
AGENTS.md の規定どおり、ツールに合格基準を持たせない。`--fail-under` のようなオプションも作らない。

### 決定 15：全文チャット方式は「ユーザーのプロンプト」をファイルから受け取る（PR13a-2）

仕様 10 節の「現在の全文チャット方式」は、ユーザーが LM Studio のチャットに原稿を貼って
自分の指示で校正させている運用そのものである。**こちらでプロンプトを書いてはならない**
（それは比較対象ではなく、別のアプリのプロンプトになる）。

```
shuten full-chat --manuscript <原稿> --model <id> --prompt-file <プロンプト.txt>
                 [--out <結果.json>] [--max-tokens N] [--temperature X] [--seed N]
                 [--reasoning-effort ...] [--check-timeout-ms N]
```

- プロンプトファイルに **`{{manuscript}}` を必ず 1 つ含める**。無ければ引数エラー
  （差し込み位置を暗黙に決めない）。2 つ以上あればすべて置換する。
- **構造化出力を使わない**（`responseFormat` を渡さない）。`ChatRequest.messages` は
  `[{ role: "user", content: 差し込み済みのプロンプト }]` の 1 通だけ。system は付けない。
- 記録するもの：応答本文（生のまま）、`reasoningContent`、`finishReason`、`usage`、所要時間、
  実行条件（`RunConditions` と同じ項目のうち、分割に関わらないもの）、`manuscript.bodyHash`。
- **出力打ち切りは失敗として残す。** `ChatResult` は `finish_reason: "length"` を例外
  （`truncated`）にする（PR5 決定 6）ので、その例外を捕まえて `status: "failed"` と
  `UnitFailure` を結果 JSON に書く。打ち切られた本文を成功として保存しない。
- **自動採点しない。** 自由形式の応答から指摘を機械的に取り出すことはできない。
  結果 JSON は人が読んで正解と突き合わせるためのもので、`evaluate` の入力にはしない。
  その旨を結果 JSON のコメント欄ではなくレポート（決定 11 の表）と本書に書く。
- 結果の型は `PipelineResult` と**別**にする（`FullChatResult`。独自の `formatVersion`）。
  検査単位も対象も無いものを `PipelineResult` に詰めると、両方の型が濁る。
- `runPipeline` は経由せず、`ensureLoaded` → `chat` を直接呼ぶ。
- タイムアウトは `--check-timeout-ms` を使う（意味は「この要求のハード上限」で一致する。
  CLI は `recoveryConfirmMs: 0` 相当なので既定の上限がそのまま効く）。1 万字を 1 回で投げるため
  既定値では足りない可能性が高い旨をヘルプとドキュメントに書く。上限は `MAX_TIMEOUT_MS`
  （2,147,483,647 ms ≒ 24.8 日）なので、値域が制約になることはない。

### 決定 16：エクスポートは既存の DTO 射影だけを通す（PR13a-2）

`GET /api/runs/:id/export` は新しい射影を作らず、`api/dto.ts` の既存関数の出力を並べる。

```
{
  formatVersion: "1",
  exportedAt: <ISO>,
  run: RunDto,                       // toRunDto。endpointUrl を持たない（確認済み）
  manuscript: ManuscriptVersionDto,  // 本文と bodyHash を含む
  targets: RunTargetDto[],
  checkUnits: CheckUnitDto[],
  findings: FindingDetailDto[],      // 理由・再確認要約・採否・元候補・位置診断
  unlocatedCandidates: CandidateDto[],   // finding_id が null の候補（位置特定失敗）
  unlocatedDiagnostics: DiagnosticDto[]  // 上記の候補に紐づく診断
}
```

- 仕様 8.1 の保存単位（原稿版・検査実行・検査単位・再確認単位・位置診断・指摘・作者の判断）を
  すべて覆う。再確認単位と採否は `FindingDetailDto` に入っている。
- **位置特定失敗の候補を別に持つ**。`FindingDetailDto.candidates` は指摘に紐づく候補だけで、
  `finding_id` が null の候補（`not-found` / `ambiguous` / `outside-target`）は入らない。
  これが無いと仕様 10 節の「位置特定失敗率」をエクスポートから測れない。
- 接続先 URL と API キーは `toRunDto` が持たないので原理的に入らない。
  `api/leak.test.ts` の `ENDPOINTS` にこの口を**必ず足す**（同テストは `createApiRouter` が
  登録した route と表を突き合わせるので、足し忘れればテストが落ちる）。
- 応答は常に 1 実行ぶんの全量で、クエリパラメーターを読まない（PR10 決定 15 と同じ姿勢）。

### 決定 17：エクスポートは実行スコープの一括取得で組む（PR13a-2）

PR12c で `GET /api/runs/:id/findings` の 3N+1 を潰したばかりである。エクスポートは指摘の
**元候補と診断**まで含むので、素直に書くと指摘 1 件ごとに候補と診断を引く形（N+1）になる。

`listFindings` / `listCandidates` / `listDiagnostics` / `listRecheckUnits` / `listJudgments` /
`listCheckUnits` / `listRunTargets` はすべて実行スコープの一括取得がある（PR8・PR12c）。
これらを `Map` に畳んで組み立て、**問い合わせ本数を指摘の件数に依存させない**。
PR12c と同じ「クエリ本数のテスト」（`api/findings.query-count.test.ts` の `onStatement` 継ぎ目）で
エクスポートの本数も固定する。

### 決定 18：持ち越し

- **人が付けた判定の読み戻し**（修正案の妥当性・診断候補の正誤をレポートに書き込み、ツールに
  再入力して集計する）。13a では出力までにする。PR13b の実施で本当に要ると分かってから作る。
- **段落をまたぐ正解項目**（決定 4）。2 項目に分けて書けば表現できる。
- **全文チャット方式の自動採点**（決定 15）。自由形式の応答からの抽出は本質的に別の問題である。
- **エクスポートを画面から落とす導線**。仕様 5 節の画面仕様に無い。口だけ作る。

## テスト

`packages/cli` は Vitest。実 LLM・実原稿・実ファイルには触れない（既存 `main.test.ts` と同じく
`MainIO` を差し替える）。以下は**変異で落ちることを確かめる**テストである。

### PR13a-1

- **T1 本文ハッシュ**：同じ本文なら同じ `bodyHash`、1 文字違えば別の値。`RunConditions.manuscript`
  に載ること。移動後も `manuscript_versions.body_hash` が同じ値であること
  （変異：`hashBody` の入力を `body` 以外にする → 落ちる）。
- **T2 サブコマンド**：`--` 始まりの argv と空の argv は `run` に振られる（既存のテストが通る）。
  `evaluate` / `aggregate` に振られる。未知の名前はエラー。`--result` は `aggregate` でだけ
  複数指定できて、`run` の `--out` は今までどおり重複でエラー。
- **T3 正解の解決**：段落内の 2 回目の出現を `occurrence: 2` で取れる。書記素の内側に落ちる
  一致（結合文字・異体字セレクタ・絵文字）を採らない。段落 ID 超過・0 件・件数不足・
  error と normal の重なりが**すべて 1 回の実行で列挙される**（変異：最初の 1 件で投げる → 落ちる）。
  エラー文言に引用が含まれないこと。
- **T4 ハッシュの 3 方向照合**：原稿・正解・結果のどれか 1 つを別の本文にすると、集計せずに
  エラー終了する（3 通りとも）。`bodyHash` の無い結果 JSON を拒否する。
- **T5 検出と誤検出**：重なりの有無で検出が決まる。境界（`e.end === f.start` は重ならない）。
  error と normal の両方に重なる指摘が検出として数えられ誤検出に数えられないこと（決定 5 の優先順位。
  変異：優先順位を逆にする → 落ちる）。1 項目に 2 件重なっても検出率は 1 件ぶん、余剰が
  `duplicateFindings` に出る。
- **T6 観点**：観点違いで拾った指摘が「全体」には入り「観点一致」には入らない
  （変異：観点一致の判定を落とす → 落ちる）。誤検出は指摘側の観点で分類される。
- **T7 再確認の前後**：撤回された指摘が再確認前には入り再確認後には入らない。決定 7 の 4 つの数が
  それぞれ独立に動く（`withdrewTruePositive` と `withdrewFalsePositive` を取り違える変異で落ちる）。
  `mode: "split"` の結果では 4 つとも 0。
- **T8 抑制**：抑制された指摘が検出・誤検出の集合に入らず、`suppressedTruth` / `suppressedNormal` /
  `suppressedOther` に分かれる（変異：抑制を誤検出に数える → 落ちる）。
- **T9 位置特定失敗**：`totals.unlocated` の転記と失敗率。`unlocatedQuotingTruth` が
  検出率に影響しないこと（変異：検出率に足す → 落ちる）。
- **T10 複数回集計**：条件が 1 つでも違う結果を混ぜるとエラー（項目ごとに 1 例ずつ）。
  `--result` が 1 本ならエラー。k/N が正しい。中央値が偶数本でも決まる。
  `conditions.model` の違いはエラーにならず注意として出る。
- **T11 出力**：`--out` 未指定で標準出力に JSON。`--out` が `--manuscript` / `--truth` / `--result` と
  同じ実体ならエラー（`run` の既存テストと同じ形）。指標 JSON に `formatVersion` がある。
  レポート Markdown に人手の欄が空で出る。

### PR13a-2

- **T12 全文チャット**：`{{manuscript}}` が無いプロンプトはエラー。2 つあればすべて置換。
  `responseFormat` を渡していないこと（モックの `chat` が受けた引数を見る）。
  `truncated` 例外が `status: "failed"` として結果に残る（成功として保存しない。変異：例外を
  握りつぶして本文を保存する → 落ちる）。`reasoningContent` が別項目に入る。
- **T13 エクスポート**：仕様 8.1 の全単位が入っている。位置特定失敗の候補と診断が
  `unlocatedCandidates` / `unlocatedDiagnostics` に入る（変異：`findings` 側にだけ入れる → 落ちる）。
  存在しない実行 ID は 404。
- **T14 エクスポートの漏えい**：`api/leak.test.ts` の `ENDPOINTS` に追加され、番兵の接続先 URL と
  API キーが応答に出ない。
- **T15 エクスポートのクエリ本数**：指摘 3 件と 30 件で問い合わせ本数が変わらない
  （PR12c の `onStatement` 継ぎ目を使う。変異：候補を指摘ごとに引く → 落ちる）。

## 完了条件

### PR13a-1

1. `docs/reference/truth-format.md` に正解ファイルの書き方が（合成の例だけで）書かれている。
2. `shuten evaluate` が仕様 10 節の自動集計分をすべて出し、人手の指標は空欄として示す。
3. `shuten aggregate` が N 本のぶれと k/N を出し、条件の不一致を拒否する。
4. 既存の `shuten --manuscript ... --model ...` が今までどおり動く。
   **既存テストの期待値を変えない**——ただし型の追随は許す（`RunConditions.manuscript` に
   `bodyHash` が増えるので `main.test.ts` と `run/pipeline.test.ts` の `PipelineResult` の組み立てに
   1 項目足す、`args.ts` の置き場所を変えたなら import 行を直す、の 2 種類だけ）。
   **期待値（`expect` の右辺）とテスト名は 1 つも書き換えない。**
5. `pnpm check` が通る。Windows は CI の `windows-latest` で確認する（実機は未確認と明記する）。
6. ロードマップの PR13a 節と依存関係を、分割（決定 1）に合わせて更新する。

### PR13a-2

1. `GET /api/runs/:id/export` が仕様 8.1 の全単位を返し、`api/leak.test.ts` の表に載っている。
2. エクスポートの問い合わせ本数が指摘の件数に依存しない。
3. `shuten full-chat` がユーザーのプロンプトで 1 回生成し、打ち切りを失敗として残す。
4. 仕様書 8.2 末尾の「可搬用の一括エクスポート形式は実装設計時に決める」を、決めた旨に改訂し、
   15 節の改訂記録に追記する（同じコミットに含める）。
5. `pnpm check` が通る。

## タスク分解（PR13a-1）

### Task 1：本文ハッシュを結果 JSON に載せる（決定 3）

- `packages/server/src/db/hash.ts` を `packages/server/src/hash.ts` へ移す（中身は変えない）。
  `db/repositories/manuscripts.ts` の import と `db/hash.test.ts` も一緒に移す。
- `RunConditions.manuscript` に `bodyHash: string` を足し、`run/pipeline.ts` で `hashBody(text)` を入れる。
- `main.test.ts` と `run/pipeline.test.ts` が組み立てている `PipelineResult` に `bodyHash` を足す
  （型の追随。期待値は変えない。完了条件 4）。
- `hash` サブコマンドは Task 2 でサブコマンドの器ができてから足す。
- T1 を書く。`RESULT_VERSION` は変えない（変えないことをコメントで明示する）。

### Task 2：CLI をサブコマンド化する（決定 9）

- `packages/cli/src/args.ts` は**動かさない**（`args.test.ts` と `main.ts` の import 行を触らないため）。
  共通部品（`collectRawOptions`、`parseIntegerOption` ほか）を `packages/cli/src/args/common.ts` に
  出して `args.ts` がそれを使う形にし、新しい解釈器は `args/evaluate.ts` のように `args/` 配下に置く。
- `collectRawOptions` を「既知オプション集合」と「複数回指定を許すオプション集合」を受け取る形にする。
- `main.ts` の入口でサブコマンドを振り分ける。`--` 始まりと空の argv は `run`。未知の名前はエラー。
- `hash` サブコマンド（決定 3）をここで足す。
- T2 を書く。**既存の `args.test.ts` / `main.test.ts` を書き換えない**（後方互換の証拠になる）。

### Task 3：正解ファイルの読み込みと位置解決（決定 2・4）

- `packages/cli/src/eval/truth.ts`：zod スキーマ（`kind` の判別可能ユニオン）、`id` の一意性、
  段落内の完全一致と書記素境界、`occurrence`、**解決失敗の全件列挙**、error と normal の重なり検査。
- T3 を書く。エラー文言に引用を含めない（これもテストで見る）。

### Task 4：突き合わせと指標の算出（決定 5〜8）

- `packages/cli/src/eval/score.ts`：純粋関数。入力は「解決済みの正解項目」と `PipelineResult`、
  出力は指標のオブジェクト（`formatVersion` 付き）。ファイル入出力を含めない。
- T5〜T9 を書く。各変異が 1 つずつ落ちることを確かめる。

### Task 5：`evaluate` の配線と出力（決定 10・11・13）

- `packages/cli/src/eval/report.ts`（Markdown 整形）と `args/evaluate.ts`、`main.ts` の接続。
- ハッシュの 3 方向照合（決定 3）と出力先の衝突検査（既存 `findOutPathConflict` の再利用）。
- T4・T11 を書く。

### Task 6：`aggregate`（決定 12）

- `packages/cli/src/eval/aggregate.ts`：条件一致の検査、最小・中央値・最大、k/N。
- `args/aggregate.ts`（`--result` は複数指定可、2 本以上必須）と `main.ts` の接続。
- T10 を書く。

### Task 7：ドキュメント（完了条件 1・6）

- `docs/reference/truth-format.md`（合成の例のみ。リポジトリに実データを置かない旨を明記）。
- ロードマップの PR13a 節を 13a-1 / 13a-2 に分け、PR 一覧・依存関係・見直し節を更新する。
- `README.md` の現在の状態に PR13a-1 を追記する。

## タスク分解（PR13a-2。着手時に本書へ詳細を追記する）

- **Task 8**：`GET /api/runs/:id/export`（決定 16・17）。一括取得と `Map` で組み立て、
  `api/leak.test.ts` の `ENDPOINTS` に追加。T13・T14・T15。
- **Task 9**：`full-chat` サブコマンドと `FullChatResult`（決定 15）。T12。
- **Task 10**：エクスポート JSON を `evaluate` の入力に加えるアダプター（決定 1 の「接ぎ先」）。
- **Task 11**：仕様書 8.2 の改訂と 15 節の改訂記録、ロードマップと README の更新。
