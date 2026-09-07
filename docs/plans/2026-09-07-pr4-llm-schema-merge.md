# PR4 詳細計画：LLM 出力スキーマ、重複統合、許容語抑制

日付：2026-09-07  
状態：計画（ユーザーの確認待ち）  
ブランチ：`feat/pr4-llm-schema-merge`  
上位計画：`docs/plans/2026-09-07-mvp-roadmap.md` の PR4 節

## 目標

`packages/shared` に、LLM の応答を検証する zod スキーマと `response_format` 用の JSON Schema、位置確定済み候補の
重複統合、許容語による抑制判定を実装する。いずれも純粋関数で、LM Studio との通信（PR5）、プロンプト（PR6）、
永続化（PR7）には依存しない。

対応する仕様：6.2（構造化データの項目）、6.4 全体（重複統合、許容語の後処理）、6.5（再確認の判定と修正案の扱い）、
7（受信データのスキーマ検証、`json_schema` の `strict`）。
受け入れ条件：11 節 10 項（許容語の抑制と非抑制）、11 項（統合後の再確認で初回判定を保持）、19 項（不正 JSON の検知）の
shared 側。

この PR の対象外：応答本文の JSON 解析と `finish_reason` の扱い（PR5/PR6）、プロンプト本文と各項目の意味の説明（PR6）、
統合結果・抑制結果の保存と再閲覧（PR7/PR12）、失敗観点の再試行時に既存の統合結果へ参照を追加する処理（PR9。
本 PR は同一性の鍵 `mergeKey` を提供するだけ）、再確認要求の組み立て（PR6/PR9）。

## 全体の制約（`docs/reference/invariants.md` から）

- 失敗・形式不正を正常な空配列に置き換えない。スキーマ検証の失敗は失敗として返す（空配列にしない）。
- 文字位置はアプリが原文から確定し、LLM の数値位置を信用しない。`LlmFinding` に数値位置を持たせない。
  空の引用の拒否は不変条件ではなく PR3 決定 4 と仕様 6.2「正確な引用」に基づく（「解釈で迷った点」）。
- 重複統合は同一の検査実行内に限る。本 PR の `mergeCandidates` は 1 回の呼び出しが 1 実行分であることを
  呼び出し元が保証する前提で、実行 ID を見ない。
- 統合・抑制・再確認は位置確定済み候補だけを扱う。位置特定失敗の候補は型で受け付けない。
- 許容語の自動抑制は「位置確定済みの表記訂正で、引用内の登録語の出現 1 箇所を空でない別の文字列に置き換えるだけで
  修正案を再現できる」場合に限る。登録語の外側に及ぶ変更・削除・複数箇所は対象外。判別に迷う場合は候補を残す。
- 再確認は修正案を改訂しない。`suggestion-inappropriate` のとき修正案は有効な修正案として表示しない。
- 位置は UTF-16 コード単位の `[start, end)`。書記素クラスタの途中で切らない。
- 相対 import は `.ts` 拡張子付き。`erasableSyntaxOnly`。公開関数は `src/index.ts` から再エクスポート。
  依存の版は完全固定。

## 作るもの

| ファイル | 責務 | 公開する名前 |
| --- | --- | --- |
| `packages/shared/package.json` | zod への依存（`4.5.4`、server と同じ版） | |
| `packages/shared/src/llm/schema.ts` | LLM 応答の型、zod スキーマ、JSON Schema | `Perspective`、`InitialVerdict`、`FindingCategory`、`LlmFinding`、`LlmCheckOutput`、`RecheckVerdict`、`RecheckReasonKind`、`LlmRecheckOutput`、`FINDING_CATEGORIES`、`INITIAL_VERDICTS`、`RECHECK_VERDICTS`、`RECHECK_REASON_KINDS`、`llmCheckOutputSchema`、`llmRecheckOutputSchema`、`checkOutputJsonSchema`、`recheckOutputJsonSchema` |
| `packages/shared/src/merge/candidate.ts` | 候補の型と位置確定済み・失敗の分割 | `CandidateBase`、`LocatedCandidate`、`UnlocatedCandidate`、`Candidate`、`partitionCandidates` |
| `packages/shared/src/merge/merge.ts` | 重複統合 | `MergedFinding`、`mergeKey`、`mergeCandidates` |
| `packages/shared/src/merge/allowed-words.ts` | 許容語による抑制判定 | `Suppression`、`SuppressionInput`、`findSuppression` |
| `packages/shared/src/index.ts` | 再エクスポート | 上記 |
| `packages/shared/src/llm/schema.test.ts`、`merge/*.test.ts` | テスト | |

ロードマップからの変更：`merge/diff.ts`（共通接頭辞・接尾辞の除去）は作らない（決定 9）。候補の型は `merge/merge.ts` から
`merge/candidate.ts` に分ける。`recheckOutputJsonSchema`、`mergeKey`、`SuppressionInput` を追加し、`mergeCandidates` に
ID 生成関数の引数を足す。ロードマップの共通語彙と PR4 節を同じ PR で更新する。

## 設計上の決定

仕様とロードマップで固定されていない点。仕様の字義から導けるものは根拠の節を、導けないものは
「解釈で迷った点」で代替案とともに記録する。

1. **応答の型。** `LlmFinding` は `QuoteRef` を拡張し、`category`、`reason`、`suggestion: string | null`、
   `verdict: InitialVerdict` を持つ。`paragraphId` は 0 以上の整数、`quote` は 1 文字以上、`before` / `after` は
   空文字を許す（仕様 6.2「本文端では空文字を許可」）。`LlmRecheckOutput` は `reason`、`reasonKind`、`verdict`、
   `suggestionValid`。
2. **スキーマは 2 層。** 変換を含まない「ワイヤ層」（`z.object`）から JSON Schema を生成し、公開する zod スキーマは
   ワイヤ層に正規化（決定 4）と整合性検査（決定 5）を重ねたもの。zod 4 の `z.toJSONSchema` は変換（`transform`）を
   含むスキーマを出力側では表現できず、入力側（`io: "input"`）では `additionalProperties: false` を落とすため
   （2026-09-07 に 4.5.4 で確認）、JSON Schema はワイヤ層からだけ作る。
3. **JSON Schema は検証済みの形に合わせる。** `docs/decisions/0003` で疎通を確認した要求は、各オブジェクトに
   `additionalProperties: false`、全キーを `required`、`$schema` なし、整数の `maximum` なし。生成後に `$schema` を
   除き、`integer` の `maximum`（zod が安全整数の上限として付ける `9007199254740991`）を `override` で除く。
   `suggestion` は `{ type: ["string", "null"] }`。`response_format` の `{ type: "json_schema", json_schema: { name, strict: true, schema } }`
   への包み込みは PR6 の責務で、本 PR は `schema` 本体だけを返す。再確認用も同じ形で `recheckOutputJsonSchema()` を提供する。
4. **`suggestion` の空文字と空白のみの文字列は `null` に正規化する。** 仕様 5.4「修正を特定できない場合は未提示を許可」に
   対し、モデルが `null` でなく `""` や `" "` を返すことがある。`trim()` が空になる文字列（全角空白 U+3000 を含む）を
   `null` にし、それ以外は加工しない。空白のみを残すと、引用「リュシア」・修正案 `" "` が決定 9 の判定を通って
   許容語で隠れてしまう（自己レビューで発見）。JSON Schema 側は `string | null` のまま（`minLength` を付けない）。
   理由と代替案は「解釈で迷った点」。
5. **再確認の整合性検査は仕様 6.5 が明記する 3 つだけ。** (a) `reasonKind === "suggestion-inappropriate"` かつ
   `suggestionValid === true` を拒否（ロードマップの規則。仕様 6.5「修正案が不適切と判断した場合は…有効な修正案としては
   表示しない」）。(b) `suggestion-inappropriate` で `verdict !== "confirm-with-author"` を拒否（同「作者への確認事項とし」）。
   (c) `insufficient-context` で `verdict !== "confirm-with-author"` を拒否（同「文脈が足りず判断できない場合は…作者への
   確認事項にする」）。`error-confirmed` と `keep`、`intentional-expression` / `unnecessary-polish` と `withdraw` の対応は
   仕様が定めていないので検査しない。理由は「解釈で迷った点」。
6. **未知のキーは捨てて受理する。** zod の `z.object` の既定（strip）。`strict: true` の構造化出力では未知のキーは
   来ないが、構造化出力に対応しないモデルの経路（仕様 7）では余分なキーだけで形式不正にしない。必須キーの欠落、
   型違い、未知の列挙値、空の引用は拒否する。
7. **JSON Schema のキー順。** 文法制約付き生成ではモデルが `properties` の順に出力するので、キー順はプロンプト設計の
   一部になる。本 PR では `paragraphId, quote, before, after, category, reason, suggestion, verdict`（理由を修正案と
   判定の前に置き、根拠を書いてから結論を出させる）、再確認は `reason, reasonKind, verdict, suggestionValid`。
   仕様 13 節のプロンプトは未決なので、PR6 で実測に基づいて並べ替えてよい（並べ替えたら `PROMPT_VERSION` を上げる）。
8. **統合の鍵は範囲・引用・修正案の完全一致。** `mergeKey` は `suggestion` が `null` なら `null`（統合しない）、
   それ以外は `start`、`end`、`quote`、`suggestion` を連結した文字列。範囲が重なるだけの候補、修正案が異なる候補、
   修正案の無い候補は統合しない（仕様 6.4「修正案がないものや別の問題を示すものは、範囲の重なりだけで統合しない」）。
   同じ観点の重複（モデルが同じ指摘を 2 回返した）も鍵が同じなら統合する。`category` が一致しなければ `unclear`
   （ロードマップ）。分類が `unclear` になった統合結果は、単独なら抑制対象だった `notation` 候補を含んでいても
   抑制しない（仕様 6.4「不明瞭な分類…は自動抑制しない」。表 M2 と S3 の組。意図した結果）。`verdict` は全候補が
   `likely-error` のときだけ `likely-error`、それ以外は `confirm-with-author`（「解釈で迷った点」）。`sources` は入力順。出力は `range.start`、`range.end`、最初の候補の入力順で並べ、
   ID はその順に `createId()` を呼んで付ける。`quote` は最初の候補の `llm.quote`（完全一致で確定しているので範囲の
   原文と同じ）。
9. **抑制判定は「出現の外側が一致し、置換文字列が空でなく登録語と異なる」で直接判定する。** 登録語の各出現
   `[s, e)` について、`suggestion` が `quote[0..s)` で始まり `quote[e..)` で終わり、その間の置換文字列 `r` が空でなく、
   `r` が登録語で始まらず終わらない（決定 10）なら抑制する。これは仕様 6.4「引用内の登録語の出現 1 箇所を、空でない
   別の文字列に置き換えるだけで修正案を完全に再現できる」「登録語の外側は原文と完全一致」の字義そのもので、
   共通接頭辞・接尾辞の除去による差分範囲の計算（ロードマップの `diff.ts`）は不要になる。接頭辞と接尾辞が
   `suggestion` 上で重ならないこと（`s + (quote.length - e) < suggestion.length`）を先に確かめる。これを怠ると
   削除（登録語「b」、引用「aba」、修正案「aa」）が置換として通る。出現は重なりも数え（「あああ」の「ああ」は 0 と 1）、
   引用の書記素境界で始まり終わるものだけを数える（`locateQuote` と同じ規則。「が」の中の「か」は出現でない）。
   空文字の登録語は飛ばす（どこにでも一致してしまう）。複数の登録語・出現が該当するときは登録語の並び順、
   次に出現位置の順で最初のものを返す。
10. **登録語の前後への挿入だけの修正案は抑制しない。** 引用「吉野家」、登録語「野家」、修正案「吉野家だ」は、
    「野家」を「野家だ」に置き換えたとも、「野家」の後ろに「だ」を挿入したとも読める。後者なら差分は登録語の出現
    範囲の外（境界上）で、仕様 6.4「変更が登録語の表記を別表記に置き換えることだけに限定される場合に抑制する」
    「差分が登録語の出現範囲の外に及ぶ場合は抑制しない」「判別に迷う場合は候補を残す」に従い抑制しない。判定は
    「置換文字列が登録語を含む」で行う（登録語と同一、後ろへの挿入、前への挿入、両側への挿入をまとめて除く）。
    代替案と費用は「解釈で迷った点」。
11. **抑制の前提。** `category === "notation"`、`suggestion !== null`。位置確定済みであることは `MergedFinding`
    （`LocatedCandidate` からしか作れない）の型で保証する。他の 5 分類は文字列が同じでも抑制しない（仕様 6.4、
    ロードマップの「リュシア／ルシア」の 3 分類テスト）。`findSuppression` の引数は
    `Pick<MergedFinding, "category" | "quote" | "suggestion">`（`SuppressionInput`）にし、`MergedFinding` をそのまま渡せる。
12. **抑制結果。** `{ word, ruleVersion: ALLOWED_WORD_RULE_VERSION }`。`ALLOWED_WORD_RULE_VERSION` は既存の `"1"` のまま
    （判定規則の初版）。
13. **`partitionCandidates` は入力順を保つ。** `locate.status` で分けるだけ。`UnlocatedCandidate` は統合・抑制・再確認に
    進まず、保存・表示の経路へ渡す（ロードマップ）。
14. **ID の生成は呼び出し元。** shared は純粋関数の集まりで ID の生成源を持たないので、`mergeCandidates` は
    `createId: () => string` を受け取る。テストでは連番、server では UUID を渡す。

## 解釈で迷った点（PR 本文にも列挙する）

- **統合時の `verdict`（決定 8）。** 仕様 6.4 は統合後の暫定判定を規定していない。本計画は「全候補が
  `likely-error` のときだけ `likely-error`」（保守的。観点の一方が確認事項としたなら確認事項）。代替案は
  「1 件でも `likely-error` なら `likely-error`」（2 観点が同じ修正で一致した事実を重く見る）。どちらでも再確認が
  最終判定を出すので影響は再確認なしの比較実験に限られる。ユーザーの確認を求める点。
- **`suggestion` の `""` と空白のみ → `null`（決定 4）。** 代替案は (a) そのまま残す（表示側と抑制判定が空文字・空白を
  扱う）、(b) `minLength: 1` で形式不正として拒否し再要求する（1 件の空文字で応答全体が失敗する）。本計画は表示・
  抑制・統合が「修正案なし」を `null` の 1 通りで扱えるように正規化する。
- **`verdict` と `reasonKind` の対応（決定 5）。** 仕様 6.5 は `suggestion-inappropriate` と `insufficient-context` を
  「作者への確認事項」にすると明記しているので、この 2 組だけ拒否する（初稿は検査しない方針だったが自己レビューで
  指摘され改めた）。`keep` に `intentional-expression`、`withdraw` に `error-confirmed` のような組は矛盾に見えるが
  仕様は対応を定めておらず、プロンプト（13 節、未決）の説明に依存する。拒否すると使える応答を失敗にしうるので、
  初版は表示側が両方を出す前提で検査しない。実測で矛盾が目立てば PR6 以降でスキーマに足す。
- **前後への挿入だけの修正案（決定 10）。** 代替案は字義どおり「置換文字列が空でなく登録語と異なる」だけで判定し、
  「吉野家」→「吉野家だ」を抑制すること。仕様の「引用内の登録語の出現 1 箇所を…置き換えるだけで再現できる」は
  満たすが、「差分が登録語の出現範囲の外に及ぶ」とも読め、脱字の補いを許容語で隠す危険がある（分類が `notation`
  でない限り門前で弾かれるので実害は小さい）。「判別に迷う場合は候補を残す」に従い抑制しない側に倒した。
  費用：登録名への長音の追加（「リュシア」→「リュシアー」、表 S28）は本計画では抑制されず、字義読みなら抑制される。
  カタカナの固有名詞で起こりやすいので、ユーザーの確認を求める点。また本決定が防ぐのは純粋な挿入だけで、
  「リュシア」→「ルシアさん」（表 S27）は「さん」が登録語の外に及んでいるように見えても、外側（空）が一致し
  置換文字列「ルシアさん」が登録語を含まないので、本計画でも字義読みでも抑制される。
- **空の引用の拒否。** `quote` の `minLength: 1` は、構造化出力では文法で空引用を防ぎ、非対応モデルの経路では空引用を
  含む応答全体を形式不正にする（他の指摘も捨てて再要求）。代替案は `minLength` を外して `locateQuote` の `not-found`
  （空引用は診断なし）に任せ、位置特定失敗として一覧に出すこと。PR3 決定 4 は本 PR で拒否する前提だったので
  そのまま拒否するが、1 件の空引用で応答全体を失うのは厳しいとも言える。ユーザーの確認を求める点。
  `paragraphId` の負数・小数も同じ扱い（応答全体を拒否）。段落 ID はヒントに過ぎないが、構造化出力では文法で
  起こらず、非対応モデルでも整数以外を返すのは形式の崩れなので拒否側に置く。
- **`diff.ts` を作らない（決定 9）。** 仕様 6.4 の「差分範囲（共通接頭辞・接尾辞の除去など）を内部で計算する」は
  判定の手段の例示で、判定条件そのものは「出現 1 箇所の置換で再現できる」。共通接頭辞・接尾辞による差分は
  一意でなく（「ああ」→「あい」の差分は 2 通り）、出現ごとの直接判定の方が仕様の条件を漏れなく検査できる。
- **登録語の前処理。** `findSuppression` は登録語を加工しない（trim も重複除去もしない）。改行区切りの入力を
  語の配列にする（CRLF を含む改行で分割し、各語を trim し、空行を除く）のは設定を受け取る server の責務で、
  ロードマップの該当 PR に明記する。空文字だけは飛ばす。
- **統合の再実行。** 仕様 6.4「後から失敗観点を再試行して同じ候補が出た場合は参照を追加し、再確認済みの同じ候補を
  重複実行しない」は、保存済みの統合結果に対する処理で PR9 の責務。本 PR は同じ鍵 `mergeKey` を公開し、server が
  同じ同一性で照合できるようにする。
- **JSON Schema のキー順（決定 7）。** プロンプト設計に属するので確定ではない。PR6 が実測で並べ替えてよい。
- **`z.toJSONSchema` の `override`。** zod 4.5.4 で `override: (ctx) => void` が `ctx.jsonSchema` の直接変更を受け付けることを
  確認した（2026-09-07）。zod を更新したら JSON Schema のテストで形が保たれることを確かめる。

## テスト

一覧は付録の英語スペックが正本。分類だけ書く。

- `llm/schema`（表 T、R、J）：正常な応答の受理、空配列、未知の `category` / `verdict` / `reasonKind` の拒否、空引用の
  拒否、`paragraphId` の負数・小数・文字列の拒否、必須キー欠落の拒否（`suggestion` の省略も拒否）、`""` → `null` の
  正規化、未知のキーの除去、JSON でない値（文字列、`null`）の拒否、`suggestion-inappropriate` かつ `suggestionValid: true`
  の拒否、JSON Schema の形（`additionalProperties: false` が両階層、`required` と `properties` のキー順、`$schema` なし、
  `paragraphId` は `{ type: "integer", minimum: 0 }` だけ、`quote` の `minLength: 1`、`suggestion` の `["string", "null"]`、
  列挙値の全列挙、`JSON.stringify` の往復で不変）
- `merge/candidate`（表 P）：混在の分割と入力順の保持、空配列
- `merge/merge`（表 M）：2 観点の統合、分類不一致で `unclear`、判定不一致で `confirm-with-author`、修正案違いは別、
  修正案なしは統合しない、重なる別範囲は別、並び順、同じ観点の重複、空配列、ID の付与順、`mergeKey` の値、
  `UnlocatedCandidate` を含む配列を型で拒否（`@ts-expect-error`）
- `merge/allowed-words`（表 S）：ロードマップの「リュシア／ルシア」3 分類、登録語だけの引用、外側の変更、複数出現の
  1 箇所と両方、削除、修正案なし、無変更、修正案側にだけ登録語がある、複数登録語の優先順、空文字の登録語、
  書記素境界（結合文字）、重なる出現、接頭辞と接尾辞の重なり（削除の誤判定防止）、前後への挿入だけ、`ruleVersion`
- 付録の期待値はすべて、計画の判定規則を別に書いた参照実装（scratch）で検算済み（表 S の全行）。

## 進め方（コミット単位）

1. **計画とブランチ**（このコミット）：本書を追加。
2. **依存の追加**（Claude）：`packages/shared/package.json` に `zod` `4.5.4` を足して `pnpm install`。lockfile の差分を確認。
3. **実装とテスト**（qwen に委譲、Claude が検証）：付録のスペックを標準入力から渡す。1 回目は `llm/schema.ts` と
   テスト、2 回目は `merge/*` と `index.ts`。1 回目の出力を検証してから 2 回目を渡す。渡す前に、抽出したスペックに
   生の U+200D・U+0301・U+3099・CR と BMP 外の文字が含まれないことを `grep -P` で確認する。
4. **検証**（Claude）：全ファイルを読む。特に、ワイヤ層と公開スキーマの分離、`override` と `$schema` の除去、`""` の
   正規化の位置、統合の鍵と並び順、抑制の接頭辞・接尾辞の重なり判定と書記素境界、決定 10 の条件を表と
   突き合わせる。テストの期待値が付録の表と一致していることを 1 行ずつ確認する。`pnpm check` を自分でも実行する。
5. **ドキュメント**（Claude）：ロードマップの共通語彙（`llm/schema.ts`、`merge/*` の型と関数）と PR4 節、README の
   状態、`docs/decisions/0002` の検証状況。
6. **PR 作成**：解釈で迷った点、Windows の確認状況（CI で確認、ローカルは未確認）を書く。

経過：計画を仕様整合と技術面の 2 観点でエージェントに自己レビューした。仕様整合では、仕様 6.5 が明記する
`reasonKind` と判定の対応 2 組を拒否に加え（決定 5）、空白のみの修正案が抑制判定を通る穴を正規化で塞ぎ（決定 4）、
決定 10 の費用（長音の追加）と空引用の拒否をユーザーの判断事項に挙げた。技術面では、zod 4.5.4 の API と表 S・M・T・R・J の
全行が参照実装で一致することを確認し、qwen 向けスペックの落とし穴（入れ子の判別子では絞り込まれない、
`noUncheckedIndexedAccess` 下の配列要素、Biome の `useIterableCallbackReturn`、`refine` は `toJSONSchema` で
黙って通る）を明文化した。両側への挿入（表 S29）も決定 10 の論理に合わせて抑制しないよう `includes` に改めた。

## 付録 1：qwen へのスペック（1 回目。英語）

````text
# Task 1 of 2: LLM output schema (packages/shared, TypeScript, zod 4)

You are working in a pnpm monorepo. Only touch these files:

- packages/shared/src/llm/schema.ts (create)
- packages/shared/src/llm/schema.test.ts (create)

Do NOT touch any other file. Do NOT modify packages/shared/src/index.ts in this task. Do NOT install dependencies,
do NOT run `pnpm install`, do NOT modify any package.json or pnpm-lock.yaml (zod 4.5.4 is already installed for
packages/shared). Do NOT modify any Markdown file.

## Project rules (MUST)

- Relative imports MUST end with ".ts". Node runs the TypeScript source directly. Import zod as `import { z } from "zod";`.
- TypeScript: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`. MUST NOT use `enum`, `namespace`, constructor parameter properties.
  Use `import type` for type-only imports. Use `readonly` on all interface fields.
- Code comments MUST be Japanese. Identifiers MUST be English. Test names (`describe` / `it`) MUST be Japanese.
- MUST NOT use the non-null assertion `!`. MUST NOT use `any`. Where you need to read a nested property of the
  generated JSON Schema in tests, cast the object with a small typed helper (see the test section).
- MUST NOT change any expected value in the tables below. A failing table row means the implementation is wrong,
  not the table. If you believe a table value is wrong, stop and report it instead of editing the expectation.
- Biome decides formatting and import order. Fix with `pnpm exec biome check --write .`, never by hand.
- Existing code you MUST reuse (read it first):
  - `packages/shared/src/locate/quote-ref.ts`: `QuoteRef { readonly paragraphId: number; readonly quote: string; readonly before: string; readonly after: string }`.

## 1. packages/shared/src/llm/schema.ts

### Types (all exported)

```ts
/** 検査の観点。観点ごとに別の要求を送る（仕様書 6.2）。 */
export type Perspective = "typo" | "naturalness";
/** 初回検査の暫定判定（仕様書 5.4）。 */
export type InitialVerdict = "likely-error" | "confirm-with-author";
/** 指摘の分類。許容語による自動抑制は notation（誤字・表記の訂正）だけを対象にする（仕様書 6.4）。 */
export type FindingCategory = "notation" | "omission-or-duplication" | "particle" | "grammar" | "context-misuse" | "unclear";
/** 初回検査で LLM が返す指摘 1 件。数値位置は持たない（仕様書 6.3）。 */
export interface LlmFinding extends QuoteRef {
  readonly category: FindingCategory;
  /** 指摘の理由。 */
  readonly reason: string;
  /** 最小限の修正案。特定できないときは null（空文字は解析時に null に正規化する）。 */
  readonly suggestion: string | null;
  readonly verdict: InitialVerdict;
}
/** 初回検査の応答全体。該当なしは空配列。 */
export interface LlmCheckOutput { readonly findings: readonly LlmFinding[] }
/** 再確認の判定（仕様書 6.5）。 */
export type RecheckVerdict = "keep" | "withdraw" | "confirm-with-author";
/**
 * 再確認の理由区分（仕様書 6.5 の確認内容に対応）。suggestion-inappropriate は「問題は実在するが修正案が不適切」で、
 * 修正案を有効な修正案として表示しない（修正案の改訂はしない）。
 */
export type RecheckReasonKind = "error-confirmed" | "intentional-expression" | "suggestion-inappropriate" | "unnecessary-polish" | "insufficient-context";
/** 再確認の応答。 */
export interface LlmRecheckOutput {
  readonly reason: string;
  readonly reasonKind: RecheckReasonKind;
  readonly verdict: RecheckVerdict;
  /** 修正案を有効な修正案として表示してよいか。reasonKind が suggestion-inappropriate のときは必ず false。 */
  readonly suggestionValid: boolean;
}
```

Define the enum value lists as `as const` tuples so they can feed `z.enum` and be exported for tests:

```ts
export const FINDING_CATEGORIES = ["notation", "omission-or-duplication", "particle", "grammar", "context-misuse", "unclear"] as const;
export const INITIAL_VERDICTS = ["likely-error", "confirm-with-author"] as const;
export const RECHECK_VERDICTS = ["keep", "withdraw", "confirm-with-author"] as const;
export const RECHECK_REASON_KINDS = ["error-confirmed", "intentional-expression", "suggestion-inappropriate", "unnecessary-polish", "insufficient-context"] as const;
```

Derive the union types from these tuples (`(typeof FINDING_CATEGORIES)[number]`) so the list and the type cannot drift.

### Schemas (two layers)

Layer 1, internal "wire" schemas (NOT exported): plain `z.object` with NO `.transform`, NO `.refine`, NO `.preprocess`.
They describe exactly what the model must emit and are the ONLY input to `z.toJSONSchema`.
Key order matters (the model generates keys in this order under grammar-constrained output). Use exactly this order.

```ts
const checkOutputWire = z.object({
  findings: z.array(
    z.object({
      paragraphId: z.number().int().min(0),
      quote: z.string().min(1),
      before: z.string(),
      after: z.string(),
      category: z.enum(FINDING_CATEGORIES),
      reason: z.string(),
      suggestion: z.string().nullable(),
      verdict: z.enum(INITIAL_VERDICTS),
    }),
  ),
});
const recheckOutputWire = z.object({
  reason: z.string(),
  reasonKind: z.enum(RECHECK_REASON_KINDS),
  verdict: z.enum(RECHECK_VERDICTS),
  suggestionValid: z.boolean(),
});
```

Layer 2, exported parsing schemas:

```ts
/** 初回検査の応答を検証する。未知のキーは捨てる。suggestion の空文字は null に正規化する。 */
export const llmCheckOutputSchema: z.ZodType<LlmCheckOutput> = checkOutputWire.transform((output) => ({
  findings: output.findings.map((finding) => ({
    ...finding,
    // 空文字と空白のみ（全角空白を含む）は「修正案なし」として null に揃える
    suggestion: finding.suggestion !== null && finding.suggestion.trim() === "" ? null : finding.suggestion,
  })),
}));

/**
 * 再確認の応答を検証する（仕様書 6.5）。矛盾として拒否する組：
 * suggestion-inappropriate で suggestionValid が true、suggestion-inappropriate または insufficient-context で
 * verdict が confirm-with-author 以外。
 */
export const llmRecheckOutputSchema: z.ZodType<LlmRecheckOutput> = recheckOutputWire
  .refine((output) => !(output.reasonKind === "suggestion-inappropriate" && output.suggestionValid), {
    message: "reasonKind が suggestion-inappropriate のとき suggestionValid は false でなければならない",
  })
  .refine(
    (output) =>
      !(
        (output.reasonKind === "suggestion-inappropriate" || output.reasonKind === "insufficient-context") &&
        output.verdict !== "confirm-with-author"
      ),
    { message: "suggestion-inappropriate と insufficient-context の verdict は confirm-with-author でなければならない" },
  );
```

Rules:
- `suggestion` becomes `null` when it is `""` or when `trim()` leaves nothing (this includes the full-width space U+3000,
  which `String.prototype.trim` removes). Any string with a non-whitespace character is kept EXACTLY as is (no trimming
  of the stored value). `null` stays `null`.
- Unknown keys are stripped (default `z.object` behaviour). MUST NOT use `z.strictObject` and MUST NOT call `.strict()`.
- MUST NOT add any other refinement beyond the two shown (no other verdict/reasonKind coupling). MUST NOT add default
  values for missing keys.
- A validation failure MUST be a failure (`safeParse(...).success === false`); MUST NOT fall back to an empty findings array.

### JSON Schema for response_format (exported)

```ts
/** 初回検査の response_format 用 JSON Schema（json_schema.schema に入れる本体）。 */
export function checkOutputJsonSchema(): Record<string, unknown>
/** 再確認の response_format 用 JSON Schema。 */
export function recheckOutputJsonSchema(): Record<string, unknown>
```

Both call one internal helper:

```ts
function toResponseSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    override: (ctx) => {
      // zod は整数に安全整数の上限を付けるが、文法制約付き生成には不要なので外す。
      if (ctx.jsonSchema.type === "integer") {
        delete ctx.jsonSchema.maximum;
      }
    },
  });
  // 検証済みの要求（decisions/0003）に合わせ、$schema は付けない。
  delete json.$schema;
  return json;
}
```

Pass the WIRE schemas to it (`toResponseSchema(checkOutputWire)`), never the exported transform/refine schemas.
The return value of `z.toJSONSchema` is assignable to `Record<string, unknown>` as is; return it directly after the
`delete`. Do NOT cast. (It carries a non-enumerable `"~standard"` property; ignore it. It does not appear in
`Object.keys`, `JSON.stringify`, or `toEqual`.)
Do NOT pass `io: "input"` (it drops `additionalProperties: false`). Do NOT pass `target`. Do NOT hand-write the JSON Schema;
it must be generated from the wire schema so the two cannot drift.

## 2. packages/shared/src/llm/schema.test.ts

Import `{ describe, expect, it }` from "vitest". Test names in Japanese. Use `toEqual` for objects.

Helper for reading the generated schema without `any`:

```ts
type JsonObject = Record<string, unknown>;
function obj(value: unknown, ...path: string[]): JsonObject {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) throw new Error(`オブジェクトではありません: ${path.join(".")}`);
    current = (current as JsonObject)[key];
  }
  if (typeof current !== "object" || current === null) throw new Error(`オブジェクトではありません: ${path.join(".")}`);
  return current as JsonObject;
}
```

Parsing helper (put it in the test file; `safeParse`'s `data` is only narrowed inside `if (result.success)`):

```ts
function parseOk<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}
```

`array[i]` has type `T | undefined` (`noUncheckedIndexedAccess`). For "success" rows, assert on the WHOLE `findings`
array with `toEqual` (`expect(parseOk(llmCheckOutputSchema, input).findings).toEqual([...])`), never on `findings[0].xxx`.
For "failure" rows, assert `expect(llmCheckOutputSchema.safeParse(input).success).toBe(false)`.

A valid finding `V` used throughout:

```ts
const V = { paragraphId: 0, quote: "吉野家", before: "", after: "へ", category: "notation", reason: "誤変換", suggestion: "吉野屋", verdict: "likely-error" };
```

### Table T: llmCheckOutputSchema

| row | input | expected |
| --- | --- | --- |
| T1 | `{ findings: [V] }` | success; `parseOk(...)` toEqual `{ findings: [V] }` |
| T2 | `{ findings: [] }` | success; `parseOk(...).findings` toEqual `[]` |
| T3 | `{ findings: [{ ...V, category: "typo" }] }` | failure |
| T4 | `{ findings: [{ ...V, quote: "" }] }` | failure |
| T5a | `{ findings: [{ ...V, paragraphId: -1 }] }` | failure |
| T5b | `{ findings: [{ ...V, paragraphId: 1.5 }] }` | failure |
| T5c | `{ findings: [{ ...V, paragraphId: "1" }] }` | failure |
| T6a | `V` without the `before` key | failure |
| T6b | `V` without the `suggestion` key | failure (null must be explicit) |
| T7a | `{ ...V, suggestion: "" }` | success; `.findings` toEqual `[{ ...V, suggestion: null }]` |
| T7b | `{ ...V, suggestion: null }` | success; `.findings` toEqual `[{ ...V, suggestion: null }]` |
| T7c | `{ ...V, suggestion: " " }` | success; `.findings` toEqual `[{ ...V, suggestion: null }]` |
| T7d | `{ ...V, suggestion: "\u3000" }` (full-width space, written as the escape) | success; `.findings` toEqual `[{ ...V, suggestion: null }]` |
| T7e | `{ ...V, suggestion: " 吉野屋 " }` | success; `.findings` toEqual `[{ ...V, suggestion: " 吉野屋 " }]` (not trimmed) |
| T8 | `{ ...V, confidence: 0.9 }` | success; `.findings` toEqual `[V]` and `Object.keys(findings[0] ?? {})` not.toContain `"confidence"` (`toEqual` ignores keys whose value is `undefined`, so check the key list) |
| T9a | the string `'{"findings":[]}'` (not parsed) | failure |
| T9b | `null` | failure |
| T9c | `{ findings: "x" }` | failure |
| T10 | `{ ...V, verdict: "maybe" }` | failure |
| T11 | `{ ...V, before: "", after: "" }` | success (empty context strings are allowed) |

For rows with a single finding object, wrap it as `{ findings: [row] }`.

### Table R: llmRecheckOutputSchema

`R = { reason: "文脈上成立している", reasonKind: "intentional-expression", verdict: "withdraw", suggestionValid: false }`.

| row | input | expected |
| --- | --- | --- |
| R1 | `R` | success; `parseOk(...)` toEqual `R` |
| R2 | `{ ...R, reasonKind: "suggestion-inappropriate", verdict: "confirm-with-author", suggestionValid: true }` | failure |
| R3 | `{ ...R, reasonKind: "suggestion-inappropriate", verdict: "confirm-with-author", suggestionValid: false }` | success |
| R4 | `{ ...R, reasonKind: "other" }` | failure |
| R5 | `R` without `suggestionValid` | failure |
| R6 | `{ ...R, note: "x" }` | success; `Object.keys(parseOk(...))` not.toContain `"note"` |
| R7 | `{ ...R, verdict: "keep", reasonKind: "error-confirmed", suggestionValid: true }` | success |
| R8 | `{ ...R, reasonKind: "suggestion-inappropriate", verdict: "keep", suggestionValid: false }` | failure (verdict must be confirm-with-author) |
| R9 | `{ ...R, reasonKind: "insufficient-context", verdict: "withdraw", suggestionValid: true }` | failure |
| R10 | `{ ...R, reasonKind: "insufficient-context", verdict: "confirm-with-author", suggestionValid: true }` | success |
| R11 | `{ ...R, reasonKind: "intentional-expression", verdict: "keep", suggestionValid: true }` | success (no coupling is checked for the other three kinds) |

### Table J: JSON Schema

J1 (`checkOutputJsonSchema()`), with `s = checkOutputJsonSchema()`, `items = obj(s, "properties", "findings", "items")`:
- `"$schema" in s` is false
- `s.type === "object"`, `s.additionalProperties === false`, `s.required` toEqual `["findings"]`
- `obj(s, "properties", "findings").type === "array"`
- `items.additionalProperties === false`
- `items.required` toEqual `["paragraphId", "quote", "before", "after", "category", "reason", "suggestion", "verdict"]`
- `Object.keys(obj(items, "properties"))` toEqual the same array (key order)
- `obj(items, "properties", "paragraphId")` toEqual `{ type: "integer", minimum: 0 }` (no `maximum`)
- `obj(items, "properties", "quote")` toEqual `{ type: "string", minLength: 1 }`
- `obj(items, "properties", "suggestion")` toEqual `{ type: ["string", "null"] }`
- `obj(items, "properties", "category").enum` toEqual `[...FINDING_CATEGORIES]`
- `obj(items, "properties", "verdict").enum` toEqual `[...INITIAL_VERDICTS]`
- `obj(items, "properties", "before")` toEqual `{ type: "string" }`

J2: `JSON.parse(JSON.stringify(s))` toEqual `s`.

J3 (`recheckOutputJsonSchema()`), with `r = recheckOutputJsonSchema()`:
- `"$schema" in r` is false, `r.additionalProperties === false`
- `r.required` toEqual `["reason", "reasonKind", "verdict", "suggestionValid"]` and `Object.keys(obj(r, "properties"))` toEqual the same
- `obj(r, "properties", "reasonKind").enum` toEqual `[...RECHECK_REASON_KINDS]`
- `obj(r, "properties", "verdict").enum` toEqual `[...RECHECK_VERDICTS]`
- `obj(r, "properties", "suggestionValid")` toEqual `{ type: "boolean" }`

J4: `llmCheckOutputSchema.safeParse(JSON.parse(JSON.stringify({ findings: [V] })))` succeeds (round trip through JSON text).

## Hazards to avoid

- Do NOT generate the JSON Schema from `llmCheckOutputSchema` / `llmRecheckOutputSchema`. `.transform` makes
  `z.toJSONSchema` throw; `.refine` does NOT throw and silently emits the wire shape, so passing it would hide the
  mistake. Always pass `checkOutputWire` / `recheckOutputWire`.
  Generate from the wire schemas only.
- Do NOT use `io: "input"`. Do NOT hand-write `additionalProperties: false`; zod emits it for `z.object` in output mode.
- Do NOT make `""` → `null` a `preprocess` on the wire schema; the wire schema must stay transform-free.
- Do NOT use `.strict()` / `z.strictObject` (unknown keys must be stripped, not rejected).
- Do NOT reorder the object keys of the wire schemas.

## Self-correction (MANDATORY — run before finishing)

Run the following from the repository root and fix errors iteratively until all pass:
1. `pnpm exec biome check --write .`
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm test`

Do NOT finish the session until all four pass. Do NOT edit files outside the allowed list to make them pass;
if that seems necessary, stop and report why.
````

## 付録 2：qwen へのスペック（2 回目。英語）

````text
# Task 2 of 2: candidate partition, duplicate merge, allowed-word suppression (packages/shared, TypeScript)

You are working in a pnpm monorepo. Only touch these files:

- packages/shared/src/merge/candidate.ts (create)
- packages/shared/src/merge/candidate.test.ts (create)
- packages/shared/src/merge/merge.ts (create)
- packages/shared/src/merge/merge.test.ts (create)
- packages/shared/src/merge/allowed-words.ts (create)
- packages/shared/src/merge/allowed-words.test.ts (create)
- packages/shared/src/index.ts (modify: add re-exports; keep every existing line)

Do NOT touch any other file. Do NOT install dependencies. Do NOT modify any Markdown file.

## Project rules (MUST)

- Relative imports MUST end with ".ts".
- TypeScript: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`. MUST NOT use `enum`, `namespace`, constructor parameter properties.
  Use `import type` for type-only imports. Use `readonly` on all interface fields.
- Code comments MUST be Japanese. Identifiers MUST be English. Test names (`describe` / `it`) MUST be Japanese.
- `array[i]` has type `T | undefined`. MUST NOT use the non-null assertion `!`. MUST NOT use `any`.
- In test source, write combining marks as escapes (`\u3099`). MUST NOT paste raw combining marks. The precomposed
  characters が (U+304C) and ご (U+3054) are plain text and may be written raw; the decomposed forms MUST be written
  `か\u3099` and `こ\u3099`.
- MUST NOT change any expected value in the tables below. A failing table row means the implementation is wrong,
  not the table. If you believe a table value is wrong, stop and report it instead of editing the expectation.
- Biome decides formatting and import order. Fix with `pnpm exec biome check --write .`, never by hand.
- Existing code you MUST reuse (read these files first):
  - `packages/shared/src/llm/schema.ts`: `Perspective`, `InitialVerdict`, `FindingCategory`, `LlmFinding`.
  - `packages/shared/src/locate/locate.ts`: `LocateResult` (a union of `{ status: "located"; range }` and `{ status: "failed"; reason; exactMatches; diagnostic }`).
  - `packages/shared/src/text/range.ts`: `Range { readonly start: number; readonly end: number }`.
  - `packages/shared/src/text/grapheme-index.ts`: `buildGraphemeIndex(text)`, `isGraphemeBoundary(index, offset)`.
  - `packages/shared/src/versions.ts`: `ALLOWED_WORD_RULE_VERSION` (currently `"1"`; do NOT change it).

## 1. packages/shared/src/merge/candidate.ts

```ts
import type { LlmFinding, Perspective } from "../llm/schema.ts";
import type { LocateResult } from "../locate/locate.ts";

/** 観点別検査が返した指摘 1 件と、その位置確定の結果。id は呼び出し元（server）が付ける。 */
export interface CandidateBase {
  readonly id: string;
  readonly perspective: Perspective;
  readonly llm: LlmFinding;
}
/** 位置確定済みの候補。統合・抑制・再確認はこれだけを扱う。 */
export interface LocatedCandidate extends CandidateBase {
  readonly locate: Extract<LocateResult, { status: "located" }>;
}
/**
 * 位置特定失敗の候補。統合・抑制・再確認に進まず、そのまま保存して一覧に表示する（not-found / ambiguous）か、
 * 診断記録にだけ残す（outside-target）。
 */
export interface UnlocatedCandidate extends CandidateBase {
  readonly locate: Extract<LocateResult, { status: "failed" }>;
}
export type Candidate = LocatedCandidate | UnlocatedCandidate;

/** 位置確定済みと失敗に分ける。それぞれ入力順を保つ。 */
export function partitionCandidates(candidates: readonly Candidate[]): {
  readonly located: readonly LocatedCandidate[];
  readonly unlocated: readonly UnlocatedCandidate[];
}
```

Implement with one type guard and a single loop. TypeScript does NOT narrow `Candidate` through the nested
`candidate.locate.status`, so write exactly this:

```ts
function isLocated(candidate: Candidate): candidate is LocatedCandidate {
  return candidate.locate.status === "located";
}
// in partitionCandidates:
for (const candidate of candidates) {
  if (isLocated(candidate)) {
    located.push(candidate);
  } else {
    unlocated.push(candidate);
  }
}
```

The `else` branch narrows to `UnlocatedCandidate` by itself. MUST NOT use `as LocatedCandidate` / `as UnlocatedCandidate`
anywhere. MUST NOT use `Array.prototype.filter` with a cast.

### Table P (candidate.test.ts)

Build candidates with helpers (put them in the test file). Imports for the test file:

```ts
import { describe, expect, it } from "vitest";
import type { FindingCategory, InitialVerdict, Perspective } from "../llm/schema.ts";
import type { Candidate, LocatedCandidate, UnlocatedCandidate } from "./candidate.ts";
import { partitionCandidates } from "./candidate.ts";
```

```ts
function located(id: string, perspective: Perspective, start: number, end: number, quote: string, suggestion: string | null, category: FindingCategory, verdict: InitialVerdict): LocatedCandidate {
  return { id, perspective, llm: { paragraphId: 0, quote, before: "", after: "", category, reason: "理由", suggestion, verdict }, locate: { status: "located", range: { start, end } } };
}
function unlocated(id: string, perspective: Perspective, quote: string): UnlocatedCandidate {
  return { id, perspective, llm: { paragraphId: 0, quote, before: "", after: "", category: "unclear", reason: "理由", suggestion: null, verdict: "confirm-with-author" }, locate: { status: "failed", reason: "not-found", exactMatches: [], diagnostic: null } };
}
```

| row | input | expected |
| --- | --- | --- |
| P1 | `[a, u1, b, u2]` where `a = located("a","typo",3,5,"リュシア","ルシア","notation","likely-error")`, `b = located("b","naturalness",10,12,"太郎","太朗","notation","likely-error")`, `u1 = unlocated("u1","typo","x")`, `u2 = unlocated("u2","naturalness","y")` | `located` toEqual `[a, b]`, `unlocated` toEqual `[u1, u2]` |
| P2 | `[]` | both `[]` |
| P3 | `[u1]` | `located` `[]`, `unlocated` `[u1]` |

## 2. packages/shared/src/merge/merge.ts

```ts
import type { FindingCategory, InitialVerdict } from "../llm/schema.ts";
import type { Range } from "../text/range.ts";
import type { LocatedCandidate } from "./candidate.ts";

/** 重複統合後の指摘。同一の検査実行内の位置確定済み候補だけから作る（仕様書 6.4）。 */
export interface MergedFinding {
  readonly id: string;
  readonly range: Range;
  /** 原文の引用。位置確定済みなので range の原文と同じ。 */
  readonly quote: string;
  /** 元候補の分類が一致すればその値、不一致なら unclear。 */
  readonly category: FindingCategory;
  readonly suggestion: string | null;
  /** 全候補が likely-error のときだけ likely-error。それ以外は confirm-with-author。 */
  readonly verdict: InitialVerdict;
  /** 統合した元候補。入力順。 */
  readonly sources: readonly LocatedCandidate[];
}

/**
 * 統合の同一性の鍵。範囲・引用・修正案が完全一致する候補だけが同じ鍵を持つ。
 * 修正案が無い候補は統合しないので null（仕様書 6.4）。
 */
export function mergeKey(candidate: LocatedCandidate): string | null

/**
 * 同じ鍵の候補を 1 件にまとめる。呼び出し元は candidates が同一の検査実行のものであることを保証する。
 * 出力は range.start、range.end、最初の元候補の入力順で並べ、その順に createId() で id を付ける。
 */
export function mergeCandidates(candidates: readonly LocatedCandidate[], createId: () => string): MergedFinding[]
```

### mergeKey

- `suggestion === null` → `null`.
- Otherwise `${range.start}:${range.end}:${JSON.stringify(quote)}:${JSON.stringify(suggestion)}` where
  `range = candidate.locate.range`, `quote = candidate.llm.quote`, `suggestion = candidate.llm.suggestion`.
  `JSON.stringify` is used so that quotes containing `:` cannot collide.

### mergeCandidates

1. Iterate candidates in input order. Keep a `Map<string, group>` for keyed candidates and a list of standalone groups
   for `mergeKey === null` candidates (each becomes its own group; never merged even if range and quote are equal).
   Each group is `{ readonly firstIndex: number; readonly first: LocatedCandidate; readonly members: LocatedCandidate[] }`;
   store `first` when the group is created so step 3 never indexes `members[0]` (which is `T | undefined`).
2. Sort groups by `range.start` ascending, then `range.end` ascending, then `firstIndex` ascending. Use `Array.prototype.sort`
   with an explicit comparator (do not rely on sort stability alone; the comparator includes `firstIndex`).
3. For each group in sorted order, build the finding: `id = createId()` (called once per group, in sorted order),
   `range` and `quote` from `group.first`, `suggestion` from `group.first`, `category` = the common category if
   every member has the same `llm.category`, else `"unclear"`, `verdict` = `"likely-error"` if every member's
   `llm.verdict === "likely-error"`, else `"confirm-with-author"`, `sources` = members in input order.
4. Return the array.

MUST NOT look at `perspective` when grouping (candidates from the same perspective with the same key are merged too).
MUST NOT merge candidates whose ranges merely overlap. MUST NOT mutate input arrays or candidates.

### Table M (merge.test.ts)

Imports for merge.test.ts: the same as candidate.test.ts plus `import type { MergedFinding } from "./merge.ts";` and
`import { mergeCandidates, mergeKey } from "./merge.ts";`. Copy the `located` and `unlocated` helpers from Table P into
this test file. Candidates:

```ts
const a  = located("a",  "typo",        3,  5, "リュシア", "ルシア",   "notation",      "likely-error");
const a2 = located("a2", "typo",        3,  5, "リュシア", "ルシア",   "notation",      "likely-error");
const b  = located("b",  "naturalness", 3,  5, "リュシア", "ルシア",   "notation",      "likely-error");
const c  = located("c",  "naturalness", 3,  5, "リュシア", "ルシア",   "context-misuse","confirm-with-author");
const d  = located("d",  "typo",        3,  5, "リュシア", "リュシヤ", "notation",      "likely-error");
const e  = located("e",  "typo",        3,  5, "リュシア", null,       "unclear",       "confirm-with-author");
const f  = located("f",  "naturalness", 3,  5, "リュシア", null,       "unclear",       "confirm-with-author");
const g  = located("g",  "typo",        4,  6, "ュシア",   "ュシヤ",   "notation",      "likely-error");
const h  = located("h",  "typo",       10, 12, "太郎",     "太朗",     "notation",      "likely-error");
```

Helpers (put them in the test file exactly as written; note the argument order of `F` differs from `located`):

```ts
function ids(): () => string {
  let n = 0;
  return () => `f${++n}`;
}
function F(
  id: string,
  start: number,
  end: number,
  quote: string,
  category: FindingCategory,
  suggestion: string | null,
  verdict: InitialVerdict,
  sources: readonly LocatedCandidate[],
): MergedFinding {
  return { id, range: { start, end }, quote, category, suggestion, verdict, sources };
}
```

| row | input | expected `mergeCandidates(input, ids())` |
| --- | --- | --- |
| M1 | `[a, b]` | `[F("f1",3,5,"リュシア","notation","ルシア","likely-error",[a,b])]` |
| M2 | `[a, c]` | `[F("f1",3,5,"リュシア","unclear","ルシア","confirm-with-author",[a,c])]` |
| M3 | `[a, d]` | `[F("f1",3,5,"リュシア","notation","ルシア","likely-error",[a]), F("f2",3,5,"リュシア","notation","リュシヤ","likely-error",[d])]` |
| M4 | `[e, f]` | `[F("f1",3,5,"リュシア","unclear",null,"confirm-with-author",[e]), F("f2",3,5,"リュシア","unclear",null,"confirm-with-author",[f])]` |
| M5 | `[a, g]` | `[F("f1",3,5,"リュシア","notation","ルシア","likely-error",[a]), F("f2",4,6,"ュシア","notation","ュシヤ","likely-error",[g])]` |
| M6 | `[h, a]` | `[F("f1",3,5,"リュシア","notation","ルシア","likely-error",[a]), F("f2",10,12,"太郎","notation","太朗","likely-error",[h])]` |
| M7 | `[a, a2]` | `[F("f1",3,5,"リュシア","notation","ルシア","likely-error",[a,a2])]` |
| M8 | `[]` | `[]` |
| M9 | `[h, a, b]` | `[F("f1",3,5,"リュシア","notation","ルシア","likely-error",[a,b]), F("f2",10,12,"太郎","notation","太朗","likely-error",[h])]` |
| M10 | `[a, e]` | `[F("f1",3,5,"リュシア","notation","ルシア","likely-error",[a]), F("f2",3,5,"リュシア","unclear",null,"confirm-with-author",[e])]` |
| M11 | `[d, a]` | `[F("f1",3,5,"リュシア","notation","リュシヤ","likely-error",[d]), F("f2",3,5,"リュシア","notation","ルシア","likely-error",[a])]` (same range; first-index order, so d before a) |

Also:
- MK1: `mergeKey(a)` toBe `'3:5:"リュシア":"ルシア"'`; `mergeKey(a) === mergeKey(b)`; `mergeKey(e)` toBeNull; `mergeKey(a) !== mergeKey(d)`.
- MI1: the input array passed to M9 is unchanged afterwards (toEqual its copy).
- MT1 (type test): the following MUST be present in merge.test.ts exactly in this shape. It compiles only because
  `mergeCandidates` rejects `Candidate[]` (a union containing `UnlocatedCandidate`, whose `locate.status` is `"failed"`).
  Do NOT "fix" the type error by widening the parameter type; the `@ts-expect-error` line is the assertion.

```ts
it("位置特定失敗の候補を含む配列は型で受け付けない", () => {
  // 呼び出さない関数の中に置き、型検査だけを行う（実行時には失敗候補を渡さない）。
  const call = (mixed: readonly Candidate[]) =>
    // @ts-expect-error 位置特定失敗の候補は統合に渡せない
    mergeCandidates(mixed, ids());
  expect(typeof call).toBe("function");
});
```

The arrow function is never invoked, so no unlocated candidate reaches the implementation at runtime.

## 3. packages/shared/src/merge/allowed-words.ts

```ts
import { buildGraphemeIndex, isGraphemeBoundary } from "../text/grapheme-index.ts";
import { ALLOWED_WORD_RULE_VERSION } from "../versions.ts";
import type { MergedFinding } from "./merge.ts";

/** 抑制の判定に使う項目。MergedFinding をそのまま渡せる。 */
export type SuppressionInput = Pick<MergedFinding, "category" | "quote" | "suggestion">;

/** 許容語による抑制の結果。適用した登録語と規則の版を保存する（仕様書 6.4）。 */
export interface Suppression {
  readonly word: string;
  readonly ruleVersion: string;
}

/**
 * 許容語による自動抑制の判定（仕様書 6.4）。
 * 前提：category が notation で、suggestion が null でない。それ以外は null。
 * 条件：引用内の登録語の出現 1 箇所を、空でなく登録語で始まりも終わりもしない文字列に置き換えるだけで
 * 修正案を完全に再現できる。登録語の外側は原文と完全一致していなければならない。
 */
export function findSuppression(finding: SuppressionInput, allowedWords: readonly string[]): Suppression | null
```

Algorithm (implement exactly this):

```
if finding.category !== "notation" or finding.suggestion === null: return null
quote = finding.quote; suggestion = finding.suggestion
index = buildGraphemeIndex(quote)
for word of allowedWords (in array order):
  if word === "": continue                              // 空文字はどこにでも一致するので飛ばす
  pos = quote.indexOf(word)
  while pos !== -1:
    s = pos; e = pos + word.length
    if isGraphemeBoundary(index, s) and isGraphemeBoundary(index, e):
      suffixLength = quote.length - e
      // 接頭辞と接尾辞が修正案の上で重ならず、置換文字列が 1 文字以上残ること（削除の誤判定防止）
      if s + suffixLength < suggestion.length
         and suggestion.startsWith(quote.slice(0, s))
         and suggestion.endsWith(quote.slice(e)):
        replacement = suggestion.slice(s, suggestion.length - suffixLength)
        // 置換文字列が登録語を含む（同一、前後・両側への挿入だけ）なら表記の置き換えでない
        if not replacement.includes(word):
          return { word, ruleVersion: ALLOWED_WORD_RULE_VERSION }
    pos = quote.indexOf(word, pos + 1)                   // 重なる出現も数える
return null
```

MUST NOT trim or otherwise modify `allowedWords` entries. MUST NOT use a regular expression built from the word
(escaping bugs). MUST NOT compute a common-prefix/suffix diff; the prefix/suffix check above is the whole rule.

### Table S (allowed-words.test.ts)

Notation: `(null)` in the suggestion column means the JavaScript value `null`, not a string. Backticked cells are
JavaScript string literals to be written exactly as shown (with `\u3099` escapes); the word column of S14b is the same
literal and the expected value is compared with `toBe` against that literal. Row numbers are not contiguous (there is
no S18); do not invent a row.

`sup(category, quote, suggestion, words)` calls `findSuppression({ category, quote, suggestion }, words)`.
Expected is the `word` of the result, or `null`. Unless stated, `words = ["リュシア"]` and `category = "notation"`.

| row | category | quote | suggestion | words | expected |
| --- | --- | --- | --- | --- | --- |
| S1 | notation | リュシア | ルシア | | リュシア |
| S2 | context-misuse | リュシア | ルシア | | null |
| S3 | unclear | リュシア | ルシア | | null |
| S4a | particle | リュシア | ルシア | | null |
| S4b | grammar | リュシア | ルシア | | null |
| S4c | omission-or-duplication | リュシア | ルシア | | null |
| S5 | notation | リュシアは走った | ルシアは走った | | リュシア |
| S6 | notation | リュシアは走った | ルシアが走った | | null |
| S7 | notation | リュシアとリュシア | リュシアとルシア | | リュシア |
| S7b | notation | リュシアとリュシア | ルシアとルシア | | null |
| S8 | notation | リュシアは | は | | null |
| S9 | notation | リュシア | (null) | | null |
| S10 | notation | リュシア | リュシア | | null |
| S11 | notation | ルシアは | リュシアは | | null |
| S12 | notation | リュシア | リュシヤ | ["シア", "リュシア"] | シア |
| S13a | notation | リュシア | ルシア | ["", "リュシア"] | リュシア |
| S13b | notation | リュシア | ルシア | [""] | null |
| S13c | notation | リュシア | ルシア | [] | null |
| S14a | notation | `"か\u3099き"` | `"こ\u3099き"` | ["か"] | null |
| S14b | notation | `"か\u3099き"` | `"こ\u3099き"` | [`"か\u3099"`] | `"か\u3099"` |
| S15a | notation | あああ | あいあ | ["ああ"] | ああ |
| S15b | notation | あああ | いああい | ["ああ"] | null |
| S16a | notation | aba | aa | ["b"] | null |
| S16b | notation | aba | a | ["b"] | null |
| S17 | notation | ルシア | リュシア | ["ルシア"] | ルシア |
| S19 | notation | シア | シヤ | | null |
| S20 | notation | リュシアとリュシア | リュシアとリュシア | | null |
| S21 | notation | 吉野家 | 吉野屋 | ["野家"] | 野家 |
| S22 | notation | 吉野家 | 吉乃家 | ["野家"] | 野家 |
| S23 | notation | 吉野家 | 吉野家だ | ["野家"] | null |
| S24 | notation | リュシア | リュシア。 | | null |
| S25 | notation | リュシア | 、リュシア | | null |
| S26 | notation | リュシアリュシア | リュシア | | null |
| S27 | notation | リュシア | ルシアさん | | リュシア |
| S28 | notation | リュシア | リュシアー | | null |
| S29 | notation | リュシア | xリュシアx | | null |

Also: SV1: `sup("notation", "リュシア", "ルシア", ["リュシア"])` toEqual `{ word: "リュシア", ruleVersion: "1" }` (use `toEqual` on the whole object).

Explanations (do not turn these into different expectations):
- S8, S16a, S16b: the replacement would be empty (deletion) → null.
- S10, S20: suggestion equals quote → replacement equals the word → null.
- S11: the word appears only in the suggestion → null.
- S12: both words qualify; the first word in array order wins.
- S14a: "か" ends inside the grapheme cluster "か\u3099" → not an occurrence.
- S15a: occurrences at 0 and 1; occurrence 0 ("ああ" → "あい") reproduces the suggestion.
- S23, S24, S25, S28, S29: pure insertion after, before or around the word (replacement contains the word) → null.
- S27: the outside of the occurrence (empty prefix and suffix) matches and the replacement "ルシアさん" does not contain
  the word → suppressed. The rule does not try to tell "さん" apart from the word.
- S26: the word occurs twice; removing one occurrence is a deletion for occurrence 0 (prefix "" + suffix "リュシア" leaves an
  empty replacement) and for occurrence 1 → null.

## 4. packages/shared/src/index.ts

Add re-exports (keep existing ones; Biome will sort):

```ts
export type { FindingCategory, InitialVerdict, LlmCheckOutput, LlmFinding, LlmRecheckOutput, Perspective, RecheckReasonKind, RecheckVerdict } from "./llm/schema.ts";
export { checkOutputJsonSchema, FINDING_CATEGORIES, INITIAL_VERDICTS, llmCheckOutputSchema, llmRecheckOutputSchema, RECHECK_REASON_KINDS, RECHECK_VERDICTS, recheckOutputJsonSchema } from "./llm/schema.ts";
export type { Candidate, CandidateBase, LocatedCandidate, UnlocatedCandidate } from "./merge/candidate.ts";
export { partitionCandidates } from "./merge/candidate.ts";
export type { MergedFinding } from "./merge/merge.ts";
export { mergeCandidates, mergeKey } from "./merge/merge.ts";
export type { Suppression, SuppressionInput } from "./merge/allowed-words.ts";
export { findSuppression } from "./merge/allowed-words.ts";
```

## Hazards to avoid

- Polarity: the suppression gate is `category === "notation"` → continue; every OTHER category → return null. Do not invert.
- The `s + suffixLength < suggestion.length` guard MUST be checked BEFORE `startsWith` / `endsWith`; otherwise S16a passes wrongly.
- The replacement check is `!replacement.includes(word)`; `replacement !== word` alone is NOT enough (S23, S24, S29).
- Use `for...of` for every loop. If you use `forEach`, the callback MUST be a block body `{ ... }` that returns nothing;
  an expression body like `(c) => list.push(c)` fails Biome (`useIterableCallbackReturn`, severity error).
- Occurrence search must continue from `pos + 1`, not `pos + word.length` (S15a needs overlapping occurrences).
- Merge grouping ignores `perspective` (M7 merges two "typo" candidates). Merge never groups `suggestion === null` (M4).
- Sorting must include `firstIndex` as the last tie-breaker (M11).

## Self-correction (MANDATORY — run before finishing)

Run the following from the repository root and fix errors iteratively until all pass:
1. `pnpm exec biome check --write .`
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm test`

Do NOT finish the session until all four pass. Do NOT edit files outside the allowed list to make them pass;
if that seems necessary, stop and report why.
````
