# PR13a（server + cli：評価ツールとエクスポート）計画書

> **エージェント向け**：superpowers:subagent-driven-development で 1 タスクずつ実装する。
> 本書の「決定 1〜22」「テスト」節が要件の正本で、タスク分解はその割り付けである。

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
**3 本に分ける。**

| | 中身 | 対象 |
| --- | --- | --- |
| **PR13a-1** | 正解ファイルの形式、本文ハッシュ、**結果 JSON の検証**、突き合わせと集計、複数回実行の集計、CLI のサブコマンド化 | `packages/cli`、`packages/server`（ハッシュのみ） |
| **PR13a-2** | `GET /api/runs/:id/export` と形式、エクスポート JSON を評価の入力に加えるアダプター | `packages/server`、`packages/cli` |
| **PR13a-3** | 全文チャット方式（自由形式プロンプト）の CLI モード | `packages/cli`、`packages/server`（生成の呼び出しのみ） |

本書は 5 つすべての設計を含む。タスク分解は PR13a-1 を全量、13a-2 と 13a-3 は骨子まで書く
（PR13a-1 の実装で分かることが後続の細部に効くため、着手時に本書へ追記する）。

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

### 決定 1：PR13a を 3 本（13a-1 評価、13a-2 エクスポート、13a-3 全文チャット）に分け、13a-1 を先にする

**理由。** 5 つの成果物のうち、正解ファイル・突き合わせ・複数回集計の 3 つは「結果 JSON を読んで数える」
側で、エクスポートと全文チャット方式は「結果を出す」側である。触るパッケージも、レビューで見るべき
性質（前者は集計の正しさ、後者は漏えいと口の形）も違う。PR9 → 9a/9b、PR12 → 12a/b/c と同じ理由で分ける。

**順序。** 13a-1 を先にする。品質指標は CLI で取る（ロードマップ 2026-09-09 の見直し「評価の経路」）ので、
`PipelineResult` だけを入力にすれば 13a-1 は単独で完結し、ユーザーの正解データが揃った時点ですぐ回せる。
13a-2 のエクスポートは「サーバー経由の通し実行 1 回」を同じ物差しで測るための追加入力で、13a-1 の
突き合わせ器ができていないと接ぎ先がない。

**エクスポートと全文チャット方式を同じ PR に入れない。** どちらも「結果を出す側」ではあるが、
HTTP の口を足す変更と、自由形式で LLM を 1 回叩く変更は中身が無関係である。
レビューで見るべき性質も違う——前者は**漏えいと問い合わせ本数**、後者は**生成の失敗・打ち切り・
タイムアウト**であり、同じ diff に載せると両方の注意が薄くなる。

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

**値域（zod スキーマで固定する）。** 「形式の誤り」と「静かに効かない正解項目」を分けるために、
すべて明示する。

| 項目 | 制約 | 外したときに起きること |
| --- | --- | --- |
| `formatVersion` | リテラル `"1"` | 別形式のファイルを黙って読む |
| `manuscript.bodyHash` | **小文字 16 進 64 文字**（`/^[0-9a-f]{64}$/`） | 大文字・切り詰めのハッシュが常に不一致になり、原因が分からない |
| `entries[].id` | 空文字不可。全項目で一意 | レポートと正解ファイルを突き合わせられない |
| `entries[].paragraphId` | 0 以上の安全な整数 | 負値・小数が解決時に例外になる |
| `entries[].quote` | **空文字不可** | **ゼロ長の範囲になり、どの指摘とも重ならない「絶対に検出されない正解項目」が静かに残る** |
| `entries[].occurrence` | 1 以上の安全な整数（既定 1） | 0 起点と 1 起点の取り違えが静かに 1 つずれる |
| `entries[].perspective` | `kind: "error"` で必須、`typo` \| `naturalness` | 観点別の集計ができない |
| `entries[].expected` / `note` | 任意の文字列 | — |

とくに空の `quote` は、エラーにならないまま検出率の分母だけを増やす。必ず拒否する。

**正解ファイルの zod スキーマは strict にする**（`errorEntryWire` / `normalEntryWire` /
`manuscriptSchema` / 最上位のスキーマすべて）。正解ファイルは利用者が手で書く、この節が定める
正本の形式で、「正当な余分のキー」は存在しない。`occurrence` を `occurence` と書き間違えても
黙って取り除かれると、既定値 1 で別の出現を採点してしまう。決定 18 の「`.strict()` は使わない」は
**結果 JSON（`result-schema.ts`）についての決定であり、正解ファイルには適用されない**。
結果 JSON は `PipelineResult` の部分射影で実データに読まないキーが必ずあるが、正解ファイルには
その事情がないため区別する（PR #24 レビュー指摘 1）。

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
2 項目に分けて書く。段落をまたぐ指定は持ち越しにする（決定 22）。

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
- **逆向き（1 件の指摘が複数の error 項目に重なる場合）は決定 20 で 1 対 1 に対応付ける。**
  段落まるごとを引用した 1 件の指摘が、触れただけの誤りをすべて「検出」にできてしまうため。
- **率の表し方は決定 19**（分母が 0 になりうるので、`rate` は `number | null`）。

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

**「再確認後の集合」と「上の 4 区分」は別の話である。** 混ぜると、再確認が失敗した指摘を
「再確認が残した」と読める数字になる。次のとおり分ける。

- **再確認後の集合**（決定 5・6 の指標をもう一度計算する対象）：`done` かつ `withdraw` の指摘**だけ**を
  除く。`failed` / `pending` の指摘は**未検証の初回指摘として残す**（再確認できなかったことは、
  その指摘が消えることを意味しない）。
- **上の 4 区分**（`withdrew*` / `kept*`）：**`status === "done"` の再確認だけ**を母集団にする。
  `failed` / `pending` / `disabled` は `kept*` に混ぜない。
- `recheckFailed` / `recheckPending` / `recheckDisabled` を**別件数**として出す。再確認後の数字が
  どれだけ未検証を含んでいるかは、この 3 つを見て人が判断する（「未完了を成功にも失敗にも
  丸めない」という不変条件の適用）。
- 抑制された指摘（`suppressed`）は決定 8 のとおり最初から評価集合の外なので、この表に入らない。

`mode: "split"`（再確認なし）の結果 JSON では再確認後 = 再確認前になり、4 区分は全 0、
`recheckDisabled` が指摘の総数になる。

### 決定 8：抑制・位置特定失敗・実行性能の数え方

- **許容語の抑制**（`FindingResult.suppression !== null`）：error 項目に重なるものを
  `suppressedTruth`（**正しい指摘を抑制した。0 が望ましい**）、normal 項目に重なるものを
  `suppressedNormal`、どちらでもないものを `suppressedOther` に分ける。
  抑制された指摘は決定 5 の検出・誤検出の集合には**入れない**（利用者に指摘として出ないため）。
- **位置特定失敗**：`totals.unlocated` の内訳（`notFound` / `ambiguous` / `outsideTarget`）と、
  失敗率 = 失敗候補数 / 全候補数（`totals.candidates`）をそのまま出す（`totals.candidates` が 0 の
  ときの表し方は決定 19）。
  加えて**参考値**として、失敗候補の引用（`UnlocatedCandidate.llm.quote`）が error 項目の `quote` と
  相互に部分文字列の関係にある件数を出す（`unlocatedQuotingTruth`）。
  **これは検出率に算入しない。** 近似一致で位置を確定しないという仕様 10 節の規定と、
  位置が確定しない指摘は利用者に位置として提示されないという事実による。レポートでは
  「参考値（近似一致。検出率には算入しない）」と明記する。
  さらに、**診断変換別の候補取得件数**（`newline` / `nfc` / `newline+nfc` ごと。診断は
  `reason: "not-found"`（空引用を除く）のときだけ持つため、1 つの失敗候補が複数の診断候補を
  持つことも、診断自体を持たない失敗候補があることもある。合計は失敗候補数と一致するとは限らない）
  も出す。仕様 10 節が「位置特定失敗」の指標として明示している項目で、当初この決定の記述から
  書き落としていたため追記する。
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

**起動の書き方。** 入口は `packages/cli/bin/shuten-eval.ts` で、`shuten` というコマンドは存在しない
（`packages/cli/package.json` に `bin` も無い）。本書の以降の例で `shuten <サブコマンド>` と書くのは
略記であり、実際は次のいずれかで起動する。**ルートに `pnpm eval` を足す**（評価では何度も叩くため）。

```sh
pnpm eval hash --manuscript <原稿>                 # ルートの package.json に "eval" を足す
node packages/cli/bin/shuten-eval.ts hash --manuscript <原稿>   # 既存の書き方（README 148 行）
```

`package.json` に `bin` は足さない（グローバル導入を前提にしないため）。
`README.md` と `docs/reference/truth-format.md` には `pnpm eval` の形で書く。
- `collectRawOptions` は**サブコマンドごとの既知オプション集合**を受け取る形に変える。
  併せて「同じオプションを複数回書ける」ことを宣言できるようにする（`aggregate --result` で使う）。
  それ以外のオプションは今までどおり重複をエラーにする。
- **エラーメッセージに原稿本文もパスも出さない。** 解決できない正解項目は `id` と `paragraphId` と
  「見つかった件数」だけを出す。引用を出さずとも、正解ファイルを開いて直せる。

**既存の `run` にこの規則が守れていない箇所がある。本 PR で直す。**
`main.ts` は原稿・許容語の読み込み失敗と結果の書き出し失敗で `messageOf(error)` をそのまま
標準エラーに出しているが、Node の `fs` の例外メッセージは**パスを含む**。

```
$ node -e "require('fs/promises').readFile('/tmp/x.txt').catch(e=>console.log(e.message))"
ENOENT: no such file or directory, open '/tmp/x.txt'
```

同じファイルの `findOutPathConflict` には「エラーメッセージにパス文字列は含めない（利用者名を
含むパスが標準エラーに出るのを避ける）」と書いてあり、**そちらの意図と食い違っている**。
既存のテストは `MainIO` のモックがパスを含まない例外を投げるので、この漏えいを見ていない。

- 読み込み・書き出しの失敗は、**原因を連結せず固定の文言だけ**にする
  （`runPipeline` の想定外例外で既にそうしている方針にそろえる）。
  失敗の種類（原稿／許容語／書き出し）は文言で分かるので、切り分けには足りる。
- **番兵のパスを含む例外を `MainIO` に投げさせ、標準エラー・標準出力のどこにも現れないことを
  テストする**（`T22`）。新しいサブコマンドの入出力も同じ経路を通す。

### 決定 10：`evaluate` の入出力

```
shuten evaluate --manuscript <原稿> --truth <正解.json> --result <結果.json>
                [--out <指標.json>] [--report <レポート.md>]
```

- `--out` 未指定なら指標 JSON を標準出力に書く（`run` と同じ方針）。
- `--report` を指定したときだけ Markdown のレポートを書く。**人が判断する指標のための材料**で、
  未検出の error 項目の一覧、誤検出の指摘の一覧（引用・修正案・理由つき）、抑制された指摘の一覧を
  表で出す。決定 11 の「人が埋める欄」を表の列として空で用意する。
- 出力先の衝突検査は決定 21（入力との衝突だけでなく、`--out` と `--report` どうしも見る）。
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

人が付けた判定をツールに読み戻す経路は作らない（決定 22 の持ち越し）。

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

- `conditions.model`（LM Studio が返した `ModelInfo`）の扱いは項目ごとに分ける。
  - `id` と **`quantization`：値が取れている実行どうしで食い違えばエラー**（集計を拒否する）。
    同じモデル ID でも量子化が違えば別の比較条件であり、仕様 10 節も「モデルの識別情報・量子化」を
    実行条件として保存せよと言っている。混ぜた数字は読めない。
    **「両方の実行で値が取れていて食い違えばエラー」は 2 本前提の書き方であり、3 本以上を集計する
    ときは「非 null の値だけを取り出して一致を検査する」と読む。1 本でも値が欠ければ比較全体を
    やめる、という意味ではない**（PR #24 レビュー指摘 2。例：3 本中 2 本が `Q4` / `Q8` で食い違い、
    残り 1 本が `null` でも、`Q4` と `Q8` の食い違いはエラーにする）。
  - 値が取れなかった実行（`model` が `null`、または `quantization` 自体が `null`。
    `/api/v0/models` が返さなかった場合）は比較の対象にせず、それとは別に
    「値を取得できなかった実行があります」と notices に出す（取れなかったことを
    「一致」にも「比較しない」にも丸めない）。
  - `state` は比較しない（実行のたびに変わる）。`loadedContextLength` は記録上の注意として
    レポートに出すだけにする。
- 出す値：各指標の**最小・中央値・最大**と、error 項目ごとの**検出回数 k/N**。
  **中央値は、本数が偶数なら中央 2 値の算術平均**とする（実装差が出ないよう明記する。
  既存の `median`（`packages/server/src/api/findings.perf.test.ts`。5 回測る前提で奇数個しか
  想定していない）は流用しない）。

**`rate` が `null` の実行が混ざる場合を定義する。** 分母は実行ごとに変わるので、
決定 19 の `rate: null` は**普通に起こる**（実行 A は指摘 0 件で誤検出率が `null`、
実行 B は指摘 3 件で数値、など）。`null` を `0` として並べれば数字が下振れし、黙って除いて
中央値を出せば「何本から出した値か」が読めない。率の集計は必ず次の形にする。

```ts
{
  availableRuns: number;    // rate が数値だった実行の本数
  unavailableRuns: number;  // rate が null だった実行の本数（分母 0）
  min: number | null;
  median: number | null;
  max: number | null;
}
```

- **`min` / `median` / `max` は `rate` が数値の実行だけで計算する。**
- **全実行が `null` なら 3 値とも `null`。** `availableRuns` が 0 であることが理由になる。
- `availableRuns + unavailableRuns` は必ず結果ファイルの本数に等しい（読み手が確かめられる）。
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

### 決定 15：全文チャット方式は「ユーザーのプロンプト」をファイルから受け取る（PR13a-3）

仕様 10 節の「現在の全文チャット方式」は、ユーザーが LM Studio のチャットに原稿を貼って
自分の指示で校正させている運用そのものである。**こちらでプロンプトを書いてはならない**
（それは比較対象ではなく、別のアプリのプロンプトになる）。

```
shuten full-chat --manuscript <原稿> --model <id> --prompt-file <プロンプト.txt>
                 [--out <結果.json>] [--max-tokens N] [--temperature X] [--seed N]
                 [--reasoning-effort ...] [--check-timeout-ms N]
```

- プロンプトファイルに **`{{manuscript}}` を 1 つ以上含める**。無ければ引数エラー
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
- `runPipeline` は経由せず、`ensureLoaded` → `chat` を直接呼ぶ。**ただし `ensureLoaded` の戻り値を
  `isGenerationCapable`（`@shuten/shared`）に通し、満たさなければ生成要求を送らない。**
  `ensureLoaded` は `state === "loaded"` しか見ないので、ロード済みの embeddings モデルを
  そのまま通してしまう。通常の実行経路（`run/executor.ts:303`）は同じ検査を入れており、
  評価用の経路だけ緩いと、種別違いのモデルに 1 万字を投げる事故が起きる。
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
  recheckUnits: RecheckUnitDto[],    // 再確認単位の全項目（決定 32）
  findings: FindingDetailDto[],      // 理由・再確認要約・採否・元候補・位置診断
  unlocatedCandidates: CandidateDto[],   // finding_id が null の候補（outside-target。決定 23）
  unlocatedDiagnostics: DiagnosticDto[]  // 上記の候補に紐づく診断
}
```

- 仕様 8.1 の保存単位（原稿版・検査実行・検査単位・再確認単位・位置診断・指摘・作者の判断）を
  すべて覆う。採否は `FindingDetailDto` に入っている。**再確認単位は別の配列で全項目を運ぶ**
  （`FindingDetailDto.recheck` は要約で、試行回数や所要時間を落としている。決定 32）。
- **位置特定失敗の候補を別に持つ**。`FindingDetailDto.candidates` は指摘に紐づく候補だけなので、
  指摘を持たない候補（`finding_id` が null）は入らない。これが無いと仕様 10 節の
  「位置特定失敗率」をエクスポートから測れない。
  **ただし「指摘を持たない候補」は `outside-target` だけである**（`not-found` / `ambiguous` は
  位置 null の指摘を作る）。この行の当初の記述は誤りだったので、決定 23 で訂正する。
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

### 決定 18：結果 JSON は読む前に zod で検証する

`evaluate` / `aggregate` が読むのは、CLI が書いた JSON ファイルである。**TypeScript の型は実行時に
何も保証しない**ので、`JSON.parse` の戻り値を `PipelineResult` と名乗らせて `score` に渡すと、
項目の欠落・未知の enum・`end < start` の範囲が、例外か**黙った誤集計**になる。

- `packages/cli/src/eval/result-schema.ts` に、**評価が読む全項目**の zod スキーマを置く
  （`bodyHash` だけではない：`status` / `stop` / `conditions` / `findings[].finding.range` /
  `findings[].finding.sources[].perspective` / `findings[].suppression` / `findings[].recheck` /
  `unlocated[].candidate.llm.quote` / `totals` の読む項目すべて）。
- **`.strict()` は使わない。** 評価が読むのは `PipelineResult` の一部で、実データには `targets` など
  スキーマに書いていないキーが必ずある。`.strict()` を付けると**正しい結果 JSON が検証に落ちる**。
  zod の既定（未知のキーを取り除く）をそのまま使い、**`parse` の戻り値をそのまま
  `EvaluationResultInput` として扱う**。これが「外形を検証したうえでの明示的な射影」になる。
  未知のキーを弾く役目は、次の `versions.result` の照合と必須項目の検査が果たす。
- **`conditions.versions.result` が `RESULT_VERSION` と一致しなければ拒否する。** 形式が変わった
  結果を古い規則で数えない。
- **型との食い違いをコンパイル時に見つける。** 評価が読む部分だけを表す型
  `EvaluationResultInput` を定義してスキーマに `z.ZodType<EvaluationResultInput>` を付け（既存の
  `llmRecheckOutputSchema` と同じ書き方）、さらに
  `const _assignable: EvaluationResultInput = {} as PipelineResult;` を置く。
  これが捕まえるのは「**評価が読んでいる項目が `PipelineResult` から消えた・型が変わった**」ときで、
  `PipelineResult` に項目が**増えた**ときは落ちない（増えた項目は評価が読まないので実害もない）。
  「すべての変更を検出する」とは書かないこと。
- 検証に落ちたら**集計せずエラー終了**（終了コード 1）。どの項目がなぜ落ちたかを出す
  （zod の `issues` の `path` と `code`。**値そのものは出さない**——原稿の断片が入りうるため。決定 9）。
- 正解ファイルも「読む前に検証し、落ちたら集計しない」姿勢は同じだが、**`.strict()` を使わない
  という判断はこの結果 JSON だけに限る**。正解ファイルの形式・値域は決定 2（strict であることを含む）
  のとおり。

**形が正しいだけでは足りない。本文と突き合わせた意味の検証も集計前に行う。**
ハッシュが一致していても、範囲が壊れた指摘をそのまま採点すると、**その指摘が別の正解項目を
検出したことにできてしまう**。位置確定済みの指摘それぞれについて、次をすべて確かめる。

- `0 <= start < end <= text.length`（`start === end` のゼロ長も拒否する）
- `start` と `end` の両方が**書記素境界**にある（`buildGraphemeIndex` / `isGraphemeBoundary`）
- `text.slice(start, end) === finding.quote`（`MergedFinding.quote` は「位置確定済みなので range の
  原文と同じ」という不変条件を持つ。ここが破れている結果 JSON は信用できない）

1 件でも破れていれば集計せずエラー終了する。破れた指摘の `id` と `range` は出してよいが、
**`quote` と本文の断片は出さない**（決定 9）。位置未確定の候補（`unlocated`）は範囲を持たないので
この検査の対象外である。

### 決定 19：分母が 0 の率は `null` にする。0 に丸めない

検出率・誤検出率・位置特定失敗率は、いずれも分母が 0 になりうる。

| 率 | 分母が 0 になる場合 |
| --- | --- |
| 検出率 | `error` 項目が 0 件（`normal` だけの正解ファイル） |
| 観点別の検出率 | その観点の `error` 項目が 0 件 |
| 誤検出率 | 指摘が 0 件（1 件も出なかった実行） |
| 位置特定失敗率 | 候補が 0 件（`totals.candidates === 0`） |

**率は必ず `{ numerator: number, denominator: number, rate: number | null }` の形で出す。**
`denominator === 0` のとき `rate` は `null`。

- `0 / 0` を `0` に丸めない。「1 件も拾えなかった」と「数える対象が無かった」は別の事実で、
  丸めると前者に見える（不変条件「失敗・形式不正を正常な値に置き換えない」）。
- `NaN` を入れない。`JSON.stringify(NaN)` は**黙って `null` になる**ので、JSON に書いた時点で
  区別が消えるうえ、`null` に至った理由も残らない。分子と分母を必ず添えるのはそのためである。
- レポート（Markdown）では `rate === null` の行を `—（分母 0）` と書く。
- 4 つのケースすべてにテストを置く（`T17`）。

### 決定 20：1 件の指摘に自動で与える検出は最大 1 件（1 対 1 に対応付ける）

決定 5 の重なり判定だけだと、**段落まるごとを引用した 1 件の指摘が、その段落の誤りをすべて
「検出」にできる**。これは検出率を実態より良く見せる方向の誤りで、放置できない。

**貪欲では数え落とす。** 「重なりが長い組から確定する」だけだと検出可能な件数を下回る。
指摘 F1 が項目 E1・E2 に、指摘 F2 が E1 だけに重なるとき、F1→E1 を先に取ると F2 は行き先を失って
検出 1 件になるが、F1→E2・F2→E1 なら 2 件である。**検出率を実態より低く見せる方向の誤り**で、
これも放置できない。

**規則は最大二部マッチング（マッチ数の最大化）**とする。指摘を一方、error 項目をもう一方の頂点とし、
重なりのある組を辺とする。増加路法（Kuhn のアルゴリズム）で**マッチ数が最大**になる対応を求める。
辺は疎（重なる組しかない）なので計算量は問題にならない。

**同点の割り方（決定性）。** 最大マッチは一般に複数ある。どれを選んでも**マッチ数＝検出数は同じ**で、
変わるのはレポートに出る「どの指摘がどの項目に対応したか」の見え方だけである。
再現性のために、辺を**重なりの長さの降順 → 項目 `range.start` の昇順 → 項目 `id` の辞書順 →
指摘の出現順**に並べてから増加路を探す。同じ入力なら必ず同じ対応になる。

> **正直に書いておく。** この規則は**マッチ数だけを最大化**し、「最大マッチのうち重なり長の合計が
> 最大のもの」を選ぶことは保証しない（それには最小費用流が要る）。指標（検出数）は前者だけで決まり、
> 後者が効くのはレポートの対応表の見え方なので、ここでは実装しない。実データを見て対応表が
> 読みにくいと分かったら、そのとき最小費用流に差し替える（持ち越し。決定 22）。

マッチした項目だけを「検出」と数える（**これが検出率の正本**）。

**観点一致の検出率は、対応を取り直す**（決定 6）。全体用のマッチ結果から観点が違う組を後で
取り除くと、「観点一致の相手がいたのに全体用のマッチで別の指摘に取られていた」項目を
数え落とす。**観点が一致する辺だけを残した部分グラフで、もう一度最大マッチングを解く。**

そのうえで、**参考値として 1 対 1 を課さない検出数（`detectedLoose`）も出す**。
この 2 つの差が「広く引用した指摘がどれだけ得点していたか」そのもので、計算はただの再集計なので
両方出しておけば、どちらの数え方が実態に近いかを実データを見てから判断できる。
どちらが正本かはレポートに明記する（正本は 1 対 1 のほう）。

加えて **`findingsOverlappingMultipleErrors`（複数の error 項目に重なった指摘の一覧）をレポートに出す**。
広く引用する癖があるのか、誤りが密集しているだけなのかは、件数ではなく現物を見ないと分からない。

### 決定 21：出力先は入力とも、出力どうしとも、同じ実体を指してはならない

既存 `run` の `findOutPathConflict`（正規化パスの比較 ＋ `stat` の dev/ino 比較）を共通化して使う。
見る組み合わせを広げる。

- `--out` / `--report` と、**すべての入力**（`--manuscript`・`--truth`・`--result`（複数可））。
- **`--out` と `--report` どうし。** 片方がもう片方を上書きする。
- **`aggregate` の `--result` どうし。** `--result a.json --result a.json` は同じ実行を 2 回として数え、
  **ぶれを偽装する**（同じ値が 2 つあれば分散は小さく出る）。重複を検出したらエラー。

シンボリックリンク・ハードリンク経由の別名も `stat` の dev/ino で捕まえる（既存の実装と同じ）。
テストでも両方を張って確かめる。

## 実装中に決めたこと（PR13a-1）

計画書の決定 1〜22 に書いていないことを、実装の過程でコントローラーが 4 つ決めた。番号は振らず、
設計の記録としてここに残す。

- **`EvaluationMetrics.performance` に `status` と `stopReason` を載せた。** 止まった実行の指標が
  完走した実行と同じ見た目で出ると、`aggregate` が両者を黙って混ぜて中央値を出してしまう。決定 12 が
  一致を要求する条件の一覧に `status` は入っておらず、集計側で弾かれないため。`stop.message` は運ばない
  （接続先の断片が入りうる）。
- **`aggregate` は `completed` でない実行が混ざっても集計を拒否せず、`notices` に明示する。** 決定 12 が
  一致を求めているのは設定であって結果の状態ではなく、`partially-failed` も設定は同じなので弾くと正当な
  用途を塞ぐ。一方、途中で止まった実行は本文の一部しか検査しておらず検出率が低く出るので、読み手が
  それを知らずに中央値を読むとモデルの能力を過小評価する。
- **正解項目ごとの検出回数 k/N は `afterRecheck` の検出に基づく。** 利用者が最終的に見るのは再確認後の
  指摘であり、「安定して拾える誤り」の判断もそこでするため。再確認前後の差は、集計された `detected` の
  3 値どうしで見える。
- **`evaluate` / `aggregate` の出力先の衝突検査は、`--out` / `--report` を含む組だけを見る。** 決定 21 が
  挙げるのはその組だけで、入力どうし（`--manuscript` と `--truth` など）は対象外。広く見ると、
  `--manuscript` と `--truth` に同じファイルを渡した場合に「正解ファイルを JSON として読み込めません」
  というより原因を指したエラーを、曖昧な衝突エラーで上書きしてしまう。`aggregate` の `--result` どうしの
  重複だけは決定 21 が明記しているので拒否する。

### 決定 22：持ち越し

- **対応表を「最大マッチのうち重なり長の合計が最大のもの」にする**（決定 20）。最小費用流が要る。
  検出数は現在の規則で確定するので、効くのはレポートの見え方だけである。
- **人が付けた判定の読み戻し**（修正案の妥当性・診断候補の正誤をレポートに書き込み、ツールに
  再入力して集計する）。13a では出力までにする。PR13b の実施で本当に要ると分かってから作る。
- **段落をまたぐ正解項目**（決定 4）。2 項目に分けて書けば表現できる。
- **全文チャット方式の自動採点**（決定 15）。自由形式の応答からの抽出は本質的に別の問題である。
- **エクスポートを画面から落とす導線**。仕様 5 節の画面仕様に無い。口だけ作る。


## PR13a-2 の設計（着手時の追記）

PR13a-1 の実装で分かったことを踏まえ、着手時に決めた（決定 1 の「着手時に本書へ追記する」）。
決定 23 は決定 16 の誤りの訂正で、残りは追加である。

### 決定 23：位置特定失敗の内訳は `findings[]` と `unlocatedCandidates` に分かれる（決定 16 の訂正）

決定 16 は「`finding_id` が null の候補（`not-found` / `ambiguous` / `outside-target`）」と書いたが、
**誤りである。** 実際の保存規則は `db/repositories/findings.ts` の `saveUnlocatedCandidate` の表
（PR8 決定 4）にあり、次のとおり：

| `locate.reason` | `candidates` | `findings` | `diagnostics` |
| --- | --- | --- | --- |
| `not-found` | 1 行（`findingId` あり） | 1 行（位置は null） | 1 行（変換候補あり） |
| `ambiguous` | 1 行（`findingId` あり） | 1 行（位置は null） | 1 行（変換候補は null） |
| `outside-target` | 1 行（`findingId` は null） | 作らない | 1 行（変換候補は null） |

つまり `not-found` と `ambiguous` は**位置が null の指摘として `listFindings` に出る**
（`FindingDto.locateStatus` が `not-found` / `ambiguous`）。`finding_id` が null なのは
`outside-target` だけである。

**エクスポートの形は決定 16 のまま変えない**（`findings[]` ＋ `unlocatedCandidates` ＋
`unlocatedDiagnostics`）。変えるのは中身の説明である。

- `findings[]`：`listFindings` の全件（`located` ＋ `not-found` ＋ `ambiguous`）。
  それぞれの元候補と位置診断を `candidates` / `diagnostics` に添える。
- `unlocatedCandidates[]`：`finding_id` が null の候補 ＝ **`outside-target` だけ**。
- `unlocatedDiagnostics[]`：上記の候補に紐づく診断。

仕様 10 節の「位置特定失敗率」は、この 3 つを合わせれば 3 通りとも数えられる（決定 27 の写像）。

### 決定 24：組み立ては HTTP に依存しない関数に置く

`api/run-view.ts` と同じ形にする。`buildRunExport(db, run): RunExportDto` を
`packages/server/src/api/run-export.ts` に置き、ハンドラー（`api/runs.ts` か新ファイル）は
404 の判定と `respond` だけを行う。`app.request` を通さずに組み立てだけを検査できるようにする
（`run-view.test.ts` と同じ）。

- 応答スキーマ `runExportDtoSchema` は `packages/shared/src/api/dto.ts` に置く。他の DTO と同じく
  `.strict()`（`respond` が通す唯一の形。余分なキーを黙って落とさない）。
- `formatVersion` は `z.literal("1")`。エクスポート形式の版であり、`RESULT_VERSION` とは別物。
- `exportedAt` は `z.iso.datetime()`。時計は既存の口と同じ取り方に合わせる。

### 決定 25：エクスポートが使う問い合わせを固定する

決定 17 のとおり、**指摘の件数に比例する問い合わせを作らない**。使うのは次の 9 本だけで、
1 実行につき各 1 回（`listFindings` は内部で `listReasonsByRun` をもう 1 本使うが、これも実行
スコープの定数本）。

`findRun` / `findManuscriptVersion` / `listRunTargets` / `listCheckUnits` / `listFindings` /
`listRecheckUnits` / `listJudgments` / `listCandidates` / `listDiagnostics`

- **`api/findings.ts` の `requirePerspective` と `findDiagnostic` を流用しない。** どちらも候補 1 件
  ごとの問い合わせで、そのまま持ってくると N+1 になる。観点は `listCheckUnits` から作る
  `checkUnitId → perspective` の `Map`、診断は `listDiagnostics` から作る `candidateId → DiagnosticDto`
  の `Map` で引く。
- 候補は `listCandidates` を `findingId` で畳んで指摘に配り、`findingId` が null のものを
  `unlocatedCandidates` にする（決定 23）。
- 参照先が見つからない場合（候補の指す検査単位が無い、など）は既定値に丸めず例外にする
  （`api/findings.ts` の `requirePerspective` と同じ姿勢。不変条件「失敗・形式不正を正常な値に
  置き換えない」）。

### 決定 26：エクスポートは実行の状態を問わない。拒否するのは評価側

`GET /api/runs/:id/export` は決定 16 のとおり「常に 1 実行ぶんの全量」で、`running` や
`recovery-waiting` の実行でもその時点の行をそのまま返す。可搬用の控えとしてはそれが正しく、
クエリパラメーターも読まない以上、状態で出し分ける根拠がない。

一方、**評価の入力にできるのは終わった実行だけ**である。途中の実行は検査単位が `running` のまま
で、件数も所要時間も確定していない。拒否は決定 27 のアダプター（`packages/cli`）で行う。

### 決定 27：エクスポート JSON から評価入力への写像

`packages/cli/src/eval/export-adapter.ts` に `adaptExportToResult(export): Result<EvaluationResultInput>`
を置く。`EvaluationResultInput`（決定 18）は `PipelineResult` の部分集合なので、エクスポートに
無い項目は**その場で数え直す**。数え直しの定義は `run/pipeline.ts` の `totals` の作り方に合わせる。

**実行の状態（`status`）と停止（`stop`）**

| `run.status` | 写す値 |
| --- | --- |
| `completed` / `partially-failed` | `status` はそのまま、`stop: null`。`stopReason` / `stopMessage` が非 null、または `generationUnconfirmed` が true なら不整合として拒否する（再開時に `clearStopState` が消すはずの値が残っている） |
| `stopped` | `status: "stopped"`、`stop: { reason: run.stopReason（null なら拒否）, message: run.stopMessage（null なら拒否）, failure: null, generationUnconfirmed: run.generationUnconfirmed }` |
| その他（`queued` / `running` / `recovery-waiting` など） | 拒否（決定 26・30） |

`stop.failure`（停止の原因になった検査単位の失敗）は `runs` に列が無く、**復元できないので `null` にする**。
丸めではなく「記録が無い」ことの表現である（`RunStop.failure` は設定値の検証エラーや停止要求でも
null になる）。`scoreRun` が読むのは `stop.reason` だけなので指標には影響しない。停止に至った単位の
失敗は `checkUnits[].failure` としてエクスポートに残っている。

**実行条件（`conditions`）**

| 写す先 | 元 |
| --- | --- |
| `startedAt` | `run.startedAt` |
| `finishedAt` | `run.finishedAt`（null なら拒否。決定 30） |
| `mode` | `run.recheckEnabled ? "split-recheck" : "split"`（サーバー経路に `full-text` は無い） |
| `perspectives` | `run.perspectives` |
| `generation` | `{ model: run.modelId, ...run.generationSettings }`（`seed` / `reasoningEffort` は値があるときだけキーを作る。`exactOptionalPropertyTypes`） |
| `model` | `run.modelInfo` |
| `chunkSettings` | `run.chunkSettings` |
| `timeouts` | `{ checkMs: run.timeouts.checkMs + run.recoveryConfirmMs, recheckMs: run.timeouts.recheckMs + run.recoveryConfirmMs }`（実効上限。決定 31） |
| `allowedWords` | `run.allowedWords` |
| `versions.result` | `"export/1"`（決定 28） |
| `versions.prompt` / `.allowedWordRule` / `.diagnosticTransform` | `run.promptVersion` / `.allowedWordRuleVersion` / `.diagnosticTransformVersion` |
| `manuscript.utf16Length` | `manuscript.body.length` |
| `manuscript.graphemeCount` | `countGraphemes(manuscript.body)` |
| `manuscript.paragraphCount` | `splitParagraphs(manuscript.body).length`（パイプラインと同じ関数） |
| `manuscript.targetCount` | `targets.length` |
| `manuscript.bodyHash` | `manuscript.bodyHash`。ただし `hashBody(manuscript.body)` と一致しなければ拒否する |

**指摘・位置特定失敗**

- `findings[]`（評価入力）には **`locateStatus === "located"` の指摘だけ**を入れる。
  `PipelineResult.findings` も統合後の位置確定済みの指摘だけなので、これで一致する。
  - `targetIndex`：`finding.targetId` → `targets` の `targetIndex`
  - `finding`：`{ id, range（null なら拒否）, quote, category, suggestion, verdict: initialVerdict,
    sources: candidates.map(c => ({ id: c.id, perspective: c.perspective, llm: c.llm })) }`
  - `suppression`：`finding.suppression`
  - `recheck`：下の表
- `unlocated[]` には 2 つの出どころを**この順で**並べる（決定 20 の対応付けは順序に依存しないが、
  出力の再現性のために固定する）。
  1. `locateStatus` が `not-found` / `ambiguous` の指摘（その指摘の候補はちょうど 1 件）。
     `targetIndex` は指摘の `targetId` から引く。
  2. `unlocatedCandidates[]`（`outside-target`）。`targetIndex` は候補の `checkUnitId` →
     `checkUnits` の `targetIndex` から引く。
- `locate.reason` は候補の `locateStatus`（`located` なら拒否）。
- `locate.diagnostic` は診断の `transformCandidates` が null なら `null`、非 null なら
  `{ candidates: transformCandidates.map(c => ({ transform: c.transform })) }`。
  **診断の行そのものが無い候補は `diagnostic: null` に丸めず拒否する**（決定 30）。
  位置特定に失敗した候補には必ず診断が 1 行ある。

**再確認（`recheckUnits[]` の `RecheckUnitDto` → `EvaluationRecheckInput`。決定 32）**

| エクスポート | 評価入力 |
| --- | --- |
| その指摘を指す再確認単位が無い（まだ起票されていない） | 下記のとおり `disabled` / `suppressed` / `pending` に振り分ける |
| `status: "done"` | `{ status: "done", output: { verdict, reasonKind, reason, suggestionValid } }`（4 つのいずれかが null なら拒否） |
| `status: "failed"` | `{ status: "failed" }` |
| `status: "pending"` | `{ status: "pending" }` |
| `status: "not-applicable"`、`notApplicableReason: "disabled"` | `{ status: "disabled" }` |
| 同上、`"suppressed"` | `{ status: "suppressed" }` |
| 同上、`"unlocated"` | 位置未確定の指摘に付くもの。その指摘は `unlocated[]` に回るので写さない |
| `status: "running"` | 拒否（決定 30） |

**再確認単位が無いときを `disabled` に丸めてはならない。** 再確認単位はその検査対象の初回検査が
決着してから起票される（`run/loop.ts` の `issueRechecks`。決定 34）ので、**指摘を保存した後・起票の前に
止まった実行**にも行の無い指摘がありうる。`FindingDto.recheck` の「再確認を無効にした実行では
起票されない」という注記は、起こりうる場合の一部しか挙げていない。`issueRechecks` の優先順位
（決定 11：disabled → unlocated → suppressed）をそのまま写して復元する。

| 条件（上から順に判定） | 写す値 |
| --- | --- |
| `run.recheckEnabled === false` | `{ status: "disabled" }` |
| 指摘が位置未確定（`locateStatus !== "located"`） | `unlocated[]` に回るので写さない |
| `finding.suppression !== null` | `{ status: "suppressed" }` |
| それ以外 | `{ status: "pending" }` |

これは `runPipeline` が同じ状況で作る値と一致する（止まった実行の未実施の再確認は `pending`）。

`LlmRecheckOutput` は `{ reason, reasonKind, verdict, suggestionValid }` の 4 項目だけで、
`RecheckSummaryDto` はその 4 つをすべて持つ。よって `done` の復元に欠落は無い。

**集計（`totals`）**

`run/pipeline.ts` の作り方をそのまま写す。

| 項目 | 数え方 |
| --- | --- |
| `targets` | `targets.length` |
| `checkUnits.done` / `.failed` / `.pending` | `checkUnits` を状態で数える（`running` / `not-applicable` があれば拒否） |
| `requests` | `Σ checkUnits[].attempts + Σ recheckUnits[].attempts`（どちらもエクスポート直下の配列。`executor` は `attempts` と `requestCount` を同じ 1 か所で増やすので一致する） |
| `candidates` | `Σ findings[].candidates.length + unlocatedCandidates.length` |
| `located` | 位置確定済みの指摘の `candidates.length` の合計 |
| `unlocated.notFound` / `.ambiguous` / `.outsideTarget` | **組み上がった `unlocated[]` の `locate.reason` で数える**（一覧と件数が構成上ずれない。`pipeline.ts` と同じ数え方。当初は「`locateStatus` がその値の指摘の件数」「`unlocatedCandidates.length`」と書いていたが、`unlocatedCandidates` に `outside-target` 以外が混ざったときに一覧と件数が食い違うため、Task 10 のレビューで改めた） |
| `findings` | 位置確定済みの指摘の件数 |
| `suppressed` | そのうち `suppression` が非 null の件数 |
| `rechecks.*` | 位置確定済みの指摘に付く再確認を、上の表で写した後の状態で数える |
| `elapsedMs` | `finishedAt − startedAt`（ミリ秒） |

**アダプターは純粋関数にする。** `node:fs` にも HTTP にも依存しない。読み込みと CLI 配線は
`io.ts` / `main.ts` の責務（決定 18 の `result-schema.ts` と同じ姿勢）。エクスポート JSON 自体の
検証は `shared` の `runExportDtoSchema` で行う（形の正本を 2 つ持たない）。

### 決定 28：`conditions.versions.result` は `"export/1"` にする

アダプターが作る評価入力の `versions.result` に `RESULT_VERSION`（`"1"`）を入れてはならない。
**サーバー経由の実行と CLI の実行は、同じ設定でも同じ条件ではない**からである。

- 実行経路が違う。オーケストレーター（逐次保存・キュー・復旧ゲート・再開）と `runPipeline`
  （1 回きりの通し実行）は別の実装で、再試行や停止の起こり方が同じとは限らない。
- `timeouts` の意味も違う（PR9 決定 7）。決定 31 で実効上限に正規化するので**数値としては
  比べられる**ようになるが、正規化した値と設定値そのものを同じ物差しの上に並べるべきではない。

`aggregate` は `versions.result` の一致を要求する（決定 12）ので、`"export/1"` にしておけば
**CLI の結果とエクスポート由来の結果を混ぜた集計は、意味の分かるエラーで止まる**。
エクスポート由来どうしの集計は通る。

**却下した案。** (a) `RESULT_VERSION` を入れる → 上記 2 つの違いを黙って混ぜる。
(b) `EvaluationResultInput` に出どころの項目を足す → `PipelineResult` に無い項目を足すことになり、
`_assignable` の対応（決定 18）が崩れる。レポートに出どころを書くのは (c) で足りる。
(c) レポートに 1 行足す：`EvaluationReportInput` に `source: "result" | "export"` を足し、
実行条件の節に「入力：エクスポート JSON（サーバー経由の実行）」と書く。これは採用する。
**集計レポート（`formatAggregateReport`）にも同じ行を出す。** 集計レポートは実行条件の節そのものを
印字しないので、出どころが分からないと `timeouts` が実効上限（決定 31）であることに気づけない。
出どころは `AggregateResult`（純粋な集計値）ではなく `formatAggregateReport` の引数で渡す。

### 決定 29：`--export` は `evaluate` と `aggregate` の両方で受ける。`--result` とは排他

```
shuten evaluate --export <エクスポート.json> --truth <正解.json> [--out ...] [--report ...]
shuten aggregate (--result <結果.json> | --export <エクスポート.json>)... [--out ...] [--report ...]
```

- `evaluate` は `--result` と `--export` の**ちょうど一方**を要求する。両方あれば引数エラー。
- **`--export` を 1 つでも渡したときは `--manuscript` を受け付けない**（引数エラー。`evaluate` /
  `aggregate` 共通）。本文はエクスポートが埋め込んで運ぶので、外から渡すと同じ原稿の出どころが
  2 つになる。決定 3 の 3 方向の照合は「正解ファイルの `bodyHash`」
  「エクスポートの `manuscript.bodyHash`」「`hashBody(埋め込み本文)`」で行い、方向は 3 つのままである。
- 逆に、`--export` が 1 つも無ければ `--manuscript` は**必須のまま**（`--result` の結果 JSON は
  本文を持たないため）。正解の位置解決（決定 4）に使う本文は、`--export` があれば
  **最初の `--export` の埋め込み本文**、無ければ `--manuscript` の内容とする。
  `--export` を 2 つ以上渡した場合、埋め込み本文どうしの一致は決定 12 の `bodyHash` の一致検査が
  保証する（決定 30 が各エクスポートの `hashBody(本文) === bodyHash` を保証するため）。
- 位置の意味検証（`validateFindingRanges`。決定 18）は、埋め込み本文に対してそのまま行う。
- `aggregate` は `--result` と `--export` を混ぜて渡せる（形が違っても評価入力に揃うため）。
  合計 2 本以上という条件は変えない（決定 12）。
  ただし決定 28 により `versions.result` が食い違うので、実際に混ぜた集計は条件不一致で止まる。
  同じ種類どうしなら通る。`--export` の重複も `--result` と同じく拒否する（決定 21）。
- 出力先の衝突検査（決定 21）の入力一覧に `--export` を加える。

### 決定 30：写せない値は既定値に丸めず、固定文のエラーにする

アダプターは `Result` を返し、失敗は**すべて**列挙して返す（決定 4 の正解解決と同じ姿勢）。
**パスも本文も接続先も出さない**。拒否するのは次の場合。

| 拒否する条件 | 理由 |
| --- | --- |
| `run.status` が `completed` / `partially-failed` / `stopped` のいずれでもない | 終わっていない実行は件数も所要時間も確定していない（決定 26） |
| `run.finishedAt` が null | `elapsedMs` を作れない |
| `run.stopReason` が `backend-restarted` | `StopReason`（`PipelineResult`）にこの値が無い。`RUN_STOP_REASONS` は 8 値、`StopReason` は 7 値で、この 1 つだけサーバー側にしかない |
| 検査単位に `running` / `not-applicable` がある | 終わった実行には現れない状態（現れたら数え方が決まらない） |
| 再確認単位に `running` がある | 同上 |
| `status: "done"` の再確認で 4 項目のいずれかが null | `LlmRecheckOutput` を作れない |
| `locateStatus === "located"` の指摘の `range` が null | 位置確定済みの指摘は範囲を持つ |
| `hashBody(manuscript.body) !== manuscript.bodyHash` | 本文とハッシュが食い違う（決定 3 の鍵が壊れている） |
| 候補・指摘・検査単位の参照先が見つからない | 外部キーが守るはずの不変条件が壊れている |
| `completed` / `partially-failed` なのに `stopReason` / `stopMessage` が非 null、または `generationUnconfirmed` が true | 再開時に消えるはずの停止情報が残っている（決定 27） |
| `stopped` なのに `stopReason` または `stopMessage` が null | `RunStop` を作れない（`message` は非 null の項目） |
| `locateStatus` が `not-found` / `ambiguous` の指摘に、候補が 0 件または 2 件以上ある | 1 候補 1 指摘で保存される（決定 23 の表）。0 件なら黙って数え落とし、2 件以上ならどれを採るかが決まらない |
| 指摘と候補の `locateStatus` が食い違う | 同上。位置特定失敗の理由を候補から採るため、食い違うと理由が決まらない |
| 位置未確定の候補に対応する診断が無い | 3 通りとも診断が 1 行できる（決定 23 の表。`insertDiagnostic` の呼び出しは `saveUnlocatedCandidate` の 1 か所だけ）。欠けていれば診断変換別の候補取得件数（決定 8）を黙って過少に数える |
| 同じ候補を指す診断が 2 行以上ある | どちらを採るかが決まらない |
| どの候補にも紐づかない診断がある | 参照が壊れている（上と同じ理由） |
| どの指摘にも紐づかない再確認単位がある | 参照が壊れている |
| 同じ指摘を指す再確認単位が 2 つ以上ある | `finding_id` の一意索引が壊れている |
| `unlocatedCandidates` に `outside-target` 以外の候補がある | この配列は `finding_id` が null の候補＝`outside-target` だけである（決定 23）。`not-found` / `ambiguous` を受理すると、**同じ候補を指摘側と二重に数えうえ**、位置特定失敗の内訳が本来と変わる |
| 候補の `perspective` が、その候補の指す検査単位の `perspective` と違う | この値は候補の行ではなく `check_units` から導いたもの（PR8 決定 19）。食い違うエクスポートは壊れており、受理すると**観点一致の検出率（決定 6）を外から動かせる** |
| `findings[].recheck`（要約）と、その指摘を指す `recheckUnits[]` の項目が食い違う | 決定 32 で同じ DB 行を 2 か所に載せている。評価は単位の側だけを読むので、食い違ったまま受理すると**画面の表示と評価結果が食い違う**。比較するのは両者の共通項目（`id` / `status` / `notApplicableReason` / `verdict` / `reasonKind` / `reason` / `suggestionValid` / `failure`） |
| `findings[].recheck` が非 null なのに、その指摘を指す `recheckUnits[]` の要素が無い | 同上（要約だけがあって単位が無いのは、同じ行から作った控えとして成立しない） |
| `locateStatus === "located"` の指摘に候補が 0 件、または `located` でない候補がある | 統合後の指摘は位置確定済みの元候補を 1 件以上持つ |

上の表の後半 4 行は、**zod では書けない関連条件**である（`runExportDtoSchema` は 1 つの値の形しか
見ない）。エクスポート JSON は外から渡されるファイルなので、アダプターがここを守る。

`RunStopReason`（サーバー。8 値）と `StopReason`（`PipelineResult`。7 値）の対応は、
**全キー必須の対応表でコンパイル時に縛る**。

```ts
const STOP_REASON_MAP = {
  "model-not-loaded": "model-not-loaded",
  "recovery-needed": "recovery-needed",
  "connection-lost": "connection-lost",
  settings: "settings",
  aborted: "aborted",
  "internal-error": "internal-error",
  "recovery-blocked": "recovery-blocked",
  // PipelineResult の StopReason に無い。変換不能として拒否する。
  "backend-restarted": null,
} satisfies Record<RunStopReason, StopReason | null>;
```

`satisfies readonly StopReason[]` を通る 7 値の配列では**足りない**。それは「書いた 7 値が
`StopReason` として妥当か」を見るだけで、`RUN_STOP_REASONS` の網羅性とは結び付かず、
サーバー側に 9 つめが増えても気づけない。`Record<RunStopReason, ...>` ならキーが 1 つでも
欠ければ型検査で落ちる。`null` は「変換できないので拒否する」の意味になる。


### 決定 31：エクスポート由来の `timeouts` は `recoveryConfirmMs` を足した実効上限にする

`RunDto` は `timeouts`（`checkMs` / `recheckMs`）と `recoveryConfirmMs` を別に持つ。
`recoveryConfirmMs > 0` のとき、`timeouts` の値は打ち切りの上限ではなく**遅延として通知する閾値**で、
実際のハード上限は `timeouts + recoveryConfirmMs` である（PR9 決定 7。`run/result.ts` の
`RunConditions.timeouts` の注記）。

`RunConditions.timeouts` には `recoveryConfirmMs` を置く場所が無い。設定値をそのまま写すと、
**`recoveryConfirmMs` が 0 の実行と 120,000 の実行が「同じ条件」として集計されてしまう**
（決定 12 の一致検査は `timeouts` しか見ない）。`"export/1"`（決定 28）は CLI とサーバーを
分けるだけで、サーバー実行どうしのこの差は捕まえられない。

**そこで、アダプターは実効上限を写す。**

- `checkMs: run.timeouts.checkMs + run.recoveryConfirmMs`、`recheckMs` も同様。
- `recoveryConfirmMs` が 0 のときは設定値と一致する（CLI と同じ意味になる）。
- **設定値そのものは失われる。** レポートの実行条件の節に、エクスポート由来であること
  （決定 28(c) の 1 行）と併せて「`timeouts` は `recoveryConfirmMs` を含む実効上限」と明示する。
- 実効上限が同じで内訳が違う組（例：`checkMs 60,000 / confirm 0` と `checkMs 30,000 / confirm 30,000`）は
  **同条件として集計する**。生成そのものの打ち切りは同じ時点で起き、違うのは途中で遅延通知を出すか
  だけで、指摘の中身には効かないためである。これは意図した挙動として書き残す。

**却下した案。** `RunConditions` に `recoveryConfirmMs` を足す → `PipelineResult` の形を
エクスポートの都合で変えることになり、既存の結果 JSON（この項目を持たない）が検証に落ちる。
CLI 経路では常に 0 になる項目でもある。


### 決定 32：エクスポートは再確認単位を要約とは別に全項目で運ぶ

決定 16 は「再確認単位は `FindingDetailDto` に入っている」と書いたが、そこに入るのは
`RecheckSummaryDto`（`id` / `status` / `notApplicableReason` / `verdict` / `reasonKind` / `reason` /
`suggestionValid` / `failure`）であって、**`attempts` / `inputRange` / `elapsedMs` / 時刻を落とした要約**である。
画面の指摘一覧はそれで足りるが、エクスポートは可搬用の控えなので落としてはいけない。

とくに決定 27 の `totals.requests`（`Σ checkUnits.attempts + Σ recheckUnits.attempts`）が
**再確認側の試行回数を復元できず、再送のあった実行で要求数を静かに過小評価する**。

**`recheckUnits: RecheckUnitDto[]` をエクスポートの直下に足す。**

- 出どころは `listRecheckUnits`（決定 25 で既に呼んでいる。問い合わせは増えない）。
- `findings[].recheck`（要約）はそのまま残す。重複は控えとしては許容する
  （`checkUnits` と同じく、単位は単位として全項目で並ぶ形に揃う）。
- **アダプター（決定 27）は再確認の状態をこの `recheckUnits` から読む**（要約ではなく単位を正本にする）。
  `findingId` で引く。`recheck_units_finding_id_key`（`finding_id` の一意索引）があるので
  1 指摘につき高々 1 単位である。

**却下した案。** (a) `RecheckSummaryDto` に `attempts` を足す → 画面用の DTO を評価の都合で太らせる。
(b) 決定 27 から `requests` の再確認ぶんを落とす → 要求数が実測と食い違う指標になる。


### 決定 33：`--export` どうしは `run.id` の重複も拒否する（決定 21 の拡張）

決定 21 の重複検査はファイルの実体（正規化パス ＋ dev/ino）でしか見ない。**同じ実行を 2 回
エクスポートした 2 ファイル**は、内容がほぼ同じで `exportedAt` だけ違うので、実体としては別物と
判定されて集計に通ってしまう。条件の一致検査（決定 12）もすべて通るので、**ぶれ 0 の「2 回実行」**
として中央値が出る。決定 21 が防ぎたかったもの（ぶれの偽装）そのものである。

`--result`（結果 JSON）では、ファイルをコピーされると同じ危険があるが検出する手がかりが無い。
一方 **エクスポートは `run.id` を持っている**ので、`--export` に限れば安く確実に捕まえられる。

- `aggregate` は、`--export` で渡されたエクスポートの `run.id` が重複していたら拒否する。
- メッセージは重複した実行 ID を出す（実行 ID は原稿の内容でも接続先でもないので出してよい。
  決定 3 の `bodyHash` と同じ扱い）。
- `--result` どうし、および `--result` と `--export` の間では見ない（手がかりが無い）。


## テスト

`packages/cli` は Vitest。実 LLM・実原稿・実ファイルには触れない（既存 `main.test.ts` と同じく
`MainIO` を差し替える）。以下は**変異で落ちることを確かめる**テストである。

### PR13a-1

- **T1 本文ハッシュ**：同じ本文なら同じ `bodyHash`、1 文字違えば別の値。`RunConditions.manuscript`
  に載ること。移動後も `manuscript_versions.body_hash` が同じ値であること
  （変異：`hashBody` の入力を `body` 以外にする → 落ちる）。`hash` サブコマンドが値を 1 行だけ出す。
- **T2 サブコマンド**：`--` 始まりの argv と空の argv は `run` に振られる（既存のテストが通る）。
  `evaluate` / `aggregate` / `hash` に振られる。未知の名前はエラー。`--result` は `aggregate` でだけ
  複数指定できて、`run` の `--out` は今までどおり重複でエラー。
- **T3 正解の解決**：段落内の 2 回目の出現を `occurrence: 2` で取れる。書記素の内側に落ちる
  一致（結合文字・異体字セレクタ・絵文字）を採らない。段落 ID 超過・0 件・件数不足・
  error と normal の重なりが**すべて 1 回の実行で列挙される**（変異：最初の 1 件で投げる → 落ちる）。
  エラー文言に引用が含まれないこと。`--report` があるときだけ、失敗した段落の本文がレポートに出る。
  **値域（決定 2 の表）を 1 項目ずつ**：`formatVersion` が `"2"`、`bodyHash` が大文字・63 文字、
  `id` が空文字・重複、`paragraphId` が `-1` と `1.5`、`occurrence` が `0`、
  **`quote` が空文字**、`kind: "error"` に `perspective` が無い——それぞれ拒否する
  （変異：`quote` の `min(1)` を外す → ゼロ長範囲の項目が「検出されない正解」として通り、落ちる）。
- **T4 ハッシュの 3 方向照合**：原稿・正解・結果のどれか 1 つを別の本文にすると、集計せずに
  エラー終了する（3 通りとも）。`bodyHash` の無い結果 JSON を拒否する。不一致のメッセージに
  計算したハッシュ値が出る。
- **T5 検出と誤検出**：重なりの有無で検出が決まる。境界（`e.end === f.start` は重ならない）。
  error と normal の両方に重なる指摘が検出として数えられ誤検出に数えられないこと（決定 5 の優先順位。
  変異：優先順位を逆にする → 落ちる）。1 項目に 2 件重なっても検出率は 1 件ぶん、余剰が
  `duplicateFindings` に出る。
- **T6 観点**：観点違いで拾った指摘が「全体」には入り「観点一致」には入らない
  （変異：観点一致の判定を落とす → 落ちる）。誤検出は指摘側の観点で分類される。
- **T7 再確認の前後**（決定 7）：`done` かつ `withdraw` の指摘だけが再確認後の集合から消える。
  **`failed` / `pending` の指摘は再確認後にも残り、4 区分（`withdrew*` / `kept*`）には入らない**
  （変異：`failed` を `keptTruePositive` に数える → 落ちる。変異：`failed` を再確認後から除く → 落ちる）。
  `withdrewTruePositive` と `withdrewFalsePositive` を取り違える変異で落ちる。
  `recheckFailed` / `recheckPending` / `recheckDisabled` がそれぞれ独立に動く。
  `mode: "split"` の結果では 4 区分が全 0 で `recheckDisabled` が指摘の総数。
- **T8 抑制**：抑制された指摘が検出・誤検出の集合にも 4 区分にも入らず、`suppressedTruth` /
  `suppressedNormal` / `suppressedOther` に分かれる（変異：抑制を誤検出に数える → 落ちる）。
- **T9 位置特定失敗**：`totals.unlocated` の転記と失敗率。`unlocatedQuotingTruth` が
  検出率に影響しないこと（変異：検出率に足す → 落ちる）。
- **T10 複数回集計**：条件が 1 つでも違う結果を混ぜるとエラー（項目ごとに 1 例ずつ）。
  `--result` が 1 本ならエラー。k/N が正しい。**本数が偶数のとき中央値が中央 2 値の算術平均**になる
  （4 本で 2 番目と 3 番目が違う値になる固定データを置く。変異：下側を採る → 落ちる）。
  **`quantization` が両方取れていて食い違えばエラー**（変異：警告にする → 落ちる）。
  片方が `null` ならエラーにせず注意として出る。`state` の違いはエラーにならない。
  **`rate` の `null` が混ざる場合**（決定 12）：3 本のうち 1 本だけ `rate` が `null` のとき、
  `availableRuns: 2` / `unavailableRuns: 1` になり、`min` / `median` / `max` は残り 2 本だけから
  出る（変異：`null` を `0` として並べる → 落ちる。変異：黙って除いて `availableRuns` を出さない
  → 落ちる）。**全実行が `null`** なら 3 値とも `null` で `availableRuns: 0`。
- **T11 出力**：`--out` 未指定で標準出力に JSON。指標 JSON に `formatVersion` がある。
  レポート Markdown に人手の欄が空で出る。
- **T16 結果 JSON の検証**（決定 18）：項目の欠落・未知の enum・`versions.result` の不一致で、
  それぞれ集計せずエラー終了する。エラー文言に値そのものが出ないこと（`path` と `code` だけ）。
  **`targets` など評価が読まないキーを持つ実際の形の結果 JSON が通ること**
  （変異：スキーマに `.strict()` を付ける → 落ちる。正しい入力を拒否していないことの証拠）。
  `EvaluationResultInput` と `PipelineResult` の代入検査はコンパイル時の話なのでコメントで明示する。
- **T16b 本文と突き合わせた意味の検証**（決定 18）：ハッシュが一致していても、
  `end < start`・`start === end`・`end > text.length`・書記素の内側に落ちる端・
  `text.slice(start, end) !== quote` の結果 JSON は、それぞれ集計せずエラー終了する
  （変異：`quote` の一致検査を外す → 範囲だけ壊れた指摘が別の正解項目を検出したことになり、落ちる）。
  エラーに `quote` と本文の断片が出ないこと。
- **T17 分母 0**（決定 19）：`error` 項目 0 件／指摘 0 件／候補 0 件／その観点の `error` 0 件の
  4 ケースで、`rate` が `null` になり `numerator` と `denominator` が付く（変異：`0` に丸める → 落ちる）。
  **`NaN` の検査は `score` の戻り値を JSON 化する前に直接見る**——`rate === null` かつ
  `Number.isNaN(rate) === false` を確かめる。`JSON.stringify` を通した後では `NaN` も正しい `null` も
  同じ `null` になり、区別できない（変異：`0 / 0` をそのまま入れる → JSON 化前の検査で落ちる）。
  レポートに `—（分母 0）` と出る。
- **T18 対応付け**（決定 20）：段落まるごとを引用した 1 件の指摘が 3 つの error 項目に
  重なるとき、検出は 1 件だけ（変異：1 対 1 を外す → 落ちる）。`detectedLoose` は 3 件。
  `findingsOverlappingMultipleErrors` にその指摘が出る。重なりの長さが同じ組でも
  結果が一意に決まる（並べ替えの規則を変えると落ちる固定データを置く）。
  **貪欲では数え落とす配置で 2 件検出になること**：指摘 F1 が項目 E1・E2 に重なり（E1 との重なりが
  長い）、指摘 F2 が E1 だけに重なる固定データで、検出が **2 件**（変異：最大マッチングを
  「長い順に確定する貪欲」に戻す → 1 件になって落ちる）。
  **観点一致の検出率が部分グラフで解き直されること**：全体のマッチでは観点違いの指摘に
  取られてしまう項目が、観点一致のマッチでは正しく検出になる固定データを置く
  （変異：全体のマッチ結果から観点違いを後で除く → 数え落として落ちる）。
- **T22 パスの漏えい**（決定 9）：`MainIO` の読み込み・書き出しが**番兵のパスを含む例外**を投げても、
  標準エラー・標準出力のどこにも番兵が現れない（`run` の原稿読み込み・許容語読み込み・結果書き出しと、
  `evaluate` / `aggregate` / `hash` の入出力すべて。変異：`messageOf(error)` を連結し直す → 落ちる）。
- **T19 出力先の衝突**（決定 21）：`--out` と `--report` が同じ実体ならエラー。
  `aggregate --result a.json --result a.json`（同じパス／シンボリックリンク／ハードリンク）で
  エラー（変異：正規化パスだけ見る → リンクの 2 例で落ちる）。出力が入力のいずれかと同じ実体でもエラー。

### PR13a-2（エクスポート）

- **T13 エクスポート**：仕様 8.1 の全単位が入っている（再確認単位は `recheckUnits[]` に
  全項目で入る。決定 32。変異：`attempts` を落とす → 落ちる）。`not-found` / `ambiguous` の候補は
  位置 null の指摘として `findings[]` に、`outside-target` の候補は `unlocatedCandidates` /
  `unlocatedDiagnostics` に入る（決定 23。変異：`unlocatedCandidates` を `finding_id` で絞らず
  全候補にする → 落ちる）。存在しない実行 ID は 404。
- **T14 エクスポートの漏えい**：`api/leak.test.ts` の `ENDPOINTS` に追加され、番兵の接続先 URL と
  API キーが応答に出ない。
- **T15 エクスポートのクエリ本数**：指摘 3 件と 30 件で問い合わせ本数が変わらない
  （PR12c の `onStatement` 継ぎ目を使う。変異：候補を指摘ごとに引く → 落ちる）。
- **T20 評価入力アダプターの指標一致**：オーケストレーターと `runPipeline` は別経路なので、
  1 回の実行から両方の成果物は取れない。**同じ内容を 2 通りで作って突き合わせる**。
  合成した `PipelineResult` を、サーバーの保存関数（`run/save.ts` の `saveCheckUnitOutcome` /
  `saveRecheckOutcome`。`save.test.ts` の組み立て補助を使う）で DB に書き、`buildRunExport` →
  `adaptExportToResult` → `scoreRun` の結果が、元の `PipelineResult` を `scoreRun` に通した結果と
  `toEqual` で一致すること。素材には次をすべて含める：元候補 2 件の統合指摘、抑制された指摘、
  `not-found` / `ambiguous` / `outside-target` の各 1 件、`failed` の再確認、`pending` の再確認、
  再送のある検査単位（`attempts: 2`）。
  実行の開始・終了時刻と状態は DB 側と `PipelineResult` 側でそろえる（`performance` に出る）。
  変異：`requests` の数え方から再確認の `attempts` を落とす → 落ちる。
  **止まった実行の素材も別ケースで入れる**：位置確定済みの指摘があるのに再確認単位がまだ無い
  （`issueRechecks` の前に止まった）実行で、再確認が `pending`（抑制済みなら `suppressed`）に
  復元されること。変異：`recheck === null` を一律 `disabled` にする → 落ちる（決定 27）。
- **T23 アダプターの拒否**：決定 30 の表の**各行**について、既定値に丸めずエラーになる。
  1. `status: "running"`（終わっていない実行）
  2. `finishedAt: null`
  3. `completed` なのに `stopReason` が残っている
  4. `stopped` なのに `stopReason` が null
  5. `stopped` なのに `stopMessage` が null
  6. `stopReason: "backend-restarted"`
  7. 検査単位に `running` がある
  8. `status: "done"` の再確認で `verdict` が null
  9. `locateStatus: "located"` の指摘の `range` が null
  10. `hashBody(body)` と `bodyHash` の食い違い
  11. 候補の指す検査単位が無い
  12. `not-found` の指摘の候補が 0 件
  13. `ambiguous` の指摘の候補が 2 件
  14. 指摘と候補の `locateStatus` の食い違い
  15. `located` の指摘の候補が 0 件
  16. `located` の指摘に `located` でない候補がある
  17. 位置未確定の候補に対応する診断が無い
  18. 同じ候補を指す診断が 2 行ある
  19. どの候補にも紐づかない診断がある
  20. `unlocatedCandidates` に `not-found` の候補が混ざっている
  21. 候補の `perspective` が検査単位の `perspective` と違う
  22. `findings[].recheck` の `verdict` と `recheckUnits[]` の `verdict` が違う
  23. `findings[].recheck` が非 null なのに対応する `recheckUnits[]` の要素が無い

  失敗は 1 件目で止めずすべて列挙する（複数の違反を 1 つのエクスポートに入れたケースで固定する）。
  エラー文にパス・本文・接続先が出ない。
  変異：17 を `diagnostic: null` に丸める → 落ちる。
- **T25 実効上限の集計**：`timeouts` が同じで `recoveryConfirmMs` だけが違う 2 つのエクスポートを
  `aggregate` に渡すと、条件不一致で拒否される（決定 31。変異：`recoveryConfirmMs` を足さずに
  写す → 落ちる）。実効上限が等しい組（`60,000 / 0` と `30,000 / 30,000`）は通る。
- **T27 同じ実行の二重集計**：同じ `run.id` を持つ 2 つのエクスポートを `aggregate` に渡すと
  拒否される（決定 33。変異：`run.id` の重複検査を外す → 落ちる）。異なる `run.id` なら通る。
- **T28 集計レポートの出どころ**：`--export` を含む集計のレポートに出どころの行が出て、
  `--result` だけの集計では出ない（決定 28(c)）。
- **T26 `stop.failure`**：停止した実行のエクスポートから作った評価入力の `stop.failure` が null で、
  停止に至った検査単位の失敗は `totals.checkUnits.failed` に数えられている。
- **T24 `--export` の引数**：`--result` と `--export` の両方を渡すと引数エラー、どちらも無ければ
  引数エラー。`--export` と `--manuscript` の併用は引数エラー。`aggregate` の `--export` の重複は
  拒否。出力先の衝突検査に `--export` が入っている（決定 29）。

### PR13a-3（全文チャット方式）

- **T12 全文チャット**：`{{manuscript}}` が無いプロンプトはエラー。2 つあればすべて置換。
  `responseFormat` を渡していないこと（モックの `chat` が受けた引数を見る）。
  `truncated` 例外が `status: "failed"` として結果に残る（成功として保存しない。変異：例外を
  握りつぶして本文を保存する → 落ちる）。`reasoningContent` が別項目に入る。
- **T21 モデル種別**（決定 15）：`type` が `llm` / `vlm` のモデルには送信する。
  **`embeddings` と、種別が取れない（`null`）モデルには生成要求を送らない**
  （変異：`isGenerationCapable` の検査を外す → 落ちる。モックの `chat` が呼ばれたかで見る）。

## 完了条件

### PR13a-1

1. `docs/reference/truth-format.md` に正解ファイルの書き方が（合成の例だけで）書かれている。
   段落 ID が 0 起点で空行も 1 段落であること、`bodyHash` の取り方（`pnpm eval hash`）を含む。
2. `pnpm eval evaluate` が仕様 10 節の自動集計分をすべて出し、人手の指標は空欄として示す。
   率はすべて `{ numerator, denominator, rate }` で、分母 0 では `rate` が `null`。
3. `pnpm eval aggregate` が N 本のぶれと k/N を出し、条件の不一致（量子化を含む）を拒否する。
   率は `rate` が `null` の実行を除いて計算し、除いた本数を `unavailableRuns` で示す。
4. 既存の `node packages/cli/bin/shuten-eval.ts --manuscript ... --model ...` が今までどおり動く。
   **既存テストの期待値を変えない**——ただし型の追随は許す（`RunConditions.manuscript` に
   `bodyHash` が増えるので `main.test.ts` と `run/pipeline.test.ts` の `PipelineResult` の組み立てに
   1 項目足す、の 1 種類だけ）。**期待値（`expect` の右辺）とテスト名は 1 つも書き換えない。**
5. 結果 JSON と正解ファイルを、読む前に zod で検証し、指摘の範囲を本文と突き合わせている（決定 18）。
6. `MainIO` が投げる例外にパスが入っても標準エラー・標準出力に出ない（決定 9。既存の `run` も含む）。
7. `pnpm check` が通る。Windows は CI の `windows-latest` で確認する（実機は未確認と明記する）。
8. ロードマップの PR13a 節と依存関係を、3 分割（決定 1）に合わせて更新する。

### PR13a-2（エクスポート）

1. `GET /api/runs/:id/export` が仕様 8.1 の全単位を返し、`api/leak.test.ts` の表に載っている。
2. エクスポートの問い合わせ本数が指摘の件数に依存しない。
3. エクスポート JSON を `evaluate` と `aggregate` の入力にできる（決定 29）。
4. 仕様書 8.2 末尾の「可搬用の一括エクスポート形式は実装設計時に決める」を、決めた旨に改訂し、
   15 節の改訂記録に追記する（同じコミットに含める）。
5. `pnpm check` が通る。

### PR13a-3（全文チャット方式）

1. `pnpm eval full-chat` がユーザーのプロンプトで 1 回生成し、打ち切りを失敗として残す。
2. 生成できない種別のモデルに要求を送らない（決定 15）。
3. `pnpm check` が通る。

## タスク分解（PR13a-1）

### Task 1：本文ハッシュを結果 JSON に載せる（決定 3）

- `packages/server/src/db/hash.ts` を `packages/server/src/hash.ts` へ移す（中身は変えない）。
  `db/repositories/manuscripts.ts` の import と `db/hash.test.ts` も一緒に移す。
- `RunConditions.manuscript` に `bodyHash: string` を足し、`run/pipeline.ts` で `hashBody(text)` を入れる。
- `main.test.ts` と `run/pipeline.test.ts` が組み立てている `PipelineResult` に `bodyHash` を足す
  （型の追随。期待値は変えない。完了条件 4）。
- `hash` サブコマンドは Task 2 でサブコマンドの器ができてから足す。
- T1 の前半（ハッシュ）を書く。`RESULT_VERSION` は変えない（変えないことをコメントで明示する）。

### Task 2：CLI をサブコマンド化する（決定 9）

- `packages/cli/src/args.ts` は**動かさない**（`args.test.ts` と `main.ts` の import 行を触らないため）。
  共通部品（`collectRawOptions`、`parseIntegerOption` ほか）を `packages/cli/src/args/common.ts` に
  出して `args.ts` がそれを使う形にし、新しい解釈器は `args/evaluate.ts` のように `args/` 配下に置く。
- `collectRawOptions` を「既知オプション集合」と「複数回指定を許すオプション集合」を受け取る形にする。
- `main.ts` の入口でサブコマンドを振り分ける。`--` 始まりと空の argv は `run`。未知の名前はエラー。
- `hash` サブコマンド（決定 3）をここで足す。ルートの `package.json` に `"eval"` スクリプトを足す。
- **既存の漏えいを直す**（決定 9）：原稿・許容語の読み込み失敗と結果の書き出し失敗で
  `messageOf(error)` を連結するのをやめ、固定の文言だけにする。
- T2・T22 と T1 の後半（`hash`）を書く。**既存の `args.test.ts` / `main.test.ts` の期待値を
  書き換えない**（後方互換の証拠になる。既存テストは終了コードだけを見ているので、
  文言を固定しても落ちない）。

### Task 3：正解ファイルの読み込みと位置解決（決定 2・4）

- `packages/cli/src/eval/truth.ts`：zod スキーマ（`kind` の判別可能ユニオン）、`id` の一意性、
  段落内の完全一致と書記素境界、`occurrence`、**解決失敗の全件列挙**、error と normal の重なり検査。
- 段落 ID が 0 起点で空行も 1 段落であることを、zod のエラー文言に含める。
- T3 を書く。エラー文言に引用を含めない（これもテストで見る）。

### Task 4：結果 JSON の検証（決定 18）

- `packages/cli/src/eval/result-schema.ts`：`EvaluationResultInput` 型、`z.ZodType<EvaluationResultInput>`
  を付けたスキーマ（**`.strict()` は付けない**）、`PipelineResult` からの代入検査、
  `versions.result` の照合。
- 本文と突き合わせた意味の検証（範囲・書記素境界・`quote` の一致）。
- 検証失敗は `path` と `code` だけを出してエラー終了（値・`quote`・本文の断片を出さない）。
- T16・T16b を書く。

### Task 5：突き合わせと指標の算出（決定 5〜8・19・20）

- `packages/cli/src/eval/score.ts`：純粋関数。入力は「解決済みの正解項目」と検証済みの結果、
  出力は指標のオブジェクト（`formatVersion` 付き）。ファイル入出力を含めない。
- 率は `{ numerator, denominator, rate }`（決定 19）。検出の対応付けは**最大二部マッチング**で、
  観点一致は部分グラフで解き直す（決定 20）。
- T5〜T9・T17・T18 を書く。各変異が 1 つずつ落ちることを確かめる。

### Task 6：`evaluate` の配線と出力（決定 10・11・13・21）

- `packages/cli/src/eval/report.ts`（Markdown 整形）と `args/evaluate.ts`、`main.ts` の接続。
- ハッシュの 3 方向照合（決定 3）と、出力先の衝突検査（決定 21。既存 `findOutPathConflict` を
  共通化して入力・出力の全組み合わせを見る形にする）。
- T4・T11・T19 の `evaluate` 側を書く。

### Task 7：`aggregate`（決定 12・21）

- `packages/cli/src/eval/aggregate.ts`：条件一致の検査（量子化を含む）、最小・中央値・最大、k/N。
  中央値は偶数本なら中央 2 値の算術平均、率は `{ availableRuns, unavailableRuns, min, median, max }`
  で `null` の実行を除いて計算する（決定 12）。
- `args/aggregate.ts`（`--result` は複数指定可、2 本以上必須、重複はエラー）と `main.ts` の接続。
- T10 と T19 の `aggregate` 側を書く。

### Task 8：ドキュメント（完了条件 1・8）

- `docs/reference/truth-format.md`（合成の例のみ。リポジトリに実データを置かない旨を明記）。
- ロードマップの PR13a 節を 13a-1 / 13a-2 / 13a-3 に分け、PR 一覧・依存関係・見直し節を更新する。
- `README.md` の現在の状態に PR13a-1 を追記し、`pnpm eval` の書き方を載せる。

## タスク分解（PR13a-2・13a-3。13a-3 は着手時に本書へ詳細を追記する）

### PR13a-2（エクスポート）

- **Task 9**：`GET /api/runs/:id/export`（決定 16・23・24・25・26）。
  - `packages/shared/src/api/dto.ts` に `runExportDtoSchema`（`.strict()`、`formatVersion` は
    `z.literal("1")`）と `RunExportDto` を足し、`index.ts` から再エクスポートする。
  - `packages/server/src/api/run-export.ts` に `buildRunExport(db, run): RunExportDto` を置く
    （Hono を import しない。`run-view.ts` と同じ姿勢）。候補・診断・再確認・採否は
    実行スコープの一括取得を `Map` に畳んで配る。決定 25 の 9 本以外を呼ばない。
  - ハンドラーは `api/runs.ts` に `GET /runs/:id/export` として登録し、404 の判定と `respond`
    だけを行う。
  - `api/leak.test.ts` の `ENDPOINTS` にこの口を足す。
  - テスト：T13（`run-export.test.ts`。組み立てを直接呼ぶ）、T14、T15
    （`api/export.query-count.test.ts`。`findings.query-count.test.ts` の `onStatement` 継ぎ目を写す）。
- **Task 10**：エクスポート JSON を評価の入力にするアダプター（決定 27・28・30）。
  - `packages/cli/src/eval/export-adapter.ts` に `adaptExportToResult` を置く。純粋関数
    （`node:fs`・HTTP に依存しない）。エクスポート JSON の形の検証は `runExportDtoSchema` を使う。
  - `EvaluationReportInput` に `source: "result" | "export"` を足し、実行条件の節に 1 行出す
    （決定 28(c)）。エクスポート由来のときは `timeouts` が実効上限である旨も併せて出す（決定 31）。
  - テスト：T20、T23、T25、T26。
- **Task 11**：`--export` の配線（決定 29）と引数。
  - `evaluate` / `aggregate` の引数解釈、出力先の衝突検査への追加、`io.ts` の読み込み
    （`readExportFile`。既存の `readTruthFile` と同じ形）。
  - テスト：T24。既存の `main.test.ts` の番兵（パスを出さない）と同じ検査をエクスポートの
    読み込み失敗にも入れる。
- **Task 12**：ドキュメント。
  - 仕様書 8.2 末尾の「可搬用の一括エクスポート形式は実装設計時に決める」を、決めた旨に改訂し、
    15 節の改訂記録に追記する（同じコミット）。
  - `docs/reference/truth-format.md` に `--export` の使い方を足す（原稿ファイルが要らないこと）。
  - `README.md` の現在の状態と `pnpm eval` の書き方、ロードマップの更新。

### PR13a-3（全文チャット方式）

- **Task 13**：`full-chat` サブコマンドと `FullChatResult`（決定 15）。`isGenerationCapable` の検査を
  含む。T12・T21。
- **Task 14**：ロードマップと README の更新。
