/**
 * 検査結果閲覧画面（PR12a）で使う列挙値の日本語ラベル一式（決定 11）。
 *
 * `@shuten/shared` の列挙（`RunStatus` など）の画面向け表示語をここに集約する。
 * `satisfies Record<...>` を付けることで、shared 側の列挙が増えたときにここが型検査で
 * 落ちるようにする。`default` の無い `switch` は書き方によっては列挙が増えても検査を
 * すり抜けるため使わない。
 *
 * `RUN_STATUS_LABELS` / `RUN_STOP_REASON_LABELS` は `features/run-receipt/labels.ts`
 * から移設したもの（文言は変えていない）。それ以外は本 PR で新規に追加した。
 *
 * 接続先 URL・API キーに関わる語はここに置かない。
 */

import type {
  FailureReason,
  FindingCategory,
  FindingLocateStatus,
  InitialVerdict,
  JudgmentStatus,
  Perspective,
  RecheckNotApplicableReason,
  RecheckReasonKind,
  RecheckVerdict,
  RunStatus,
  RunStopReason,
  UnitFailureDto,
  UnitStatus,
} from "@shuten/shared";

/**
 * 生成要求の失敗元区分。`@shuten/shared` に独立した型が無いため `UnitFailureDto["origin"]`
 * から導く（`unitFailureDtoSchema` の `origin` と同じ列挙に自動で追随する）。
 */
type FailureOrigin = UnitFailureDto["origin"];

export const RUN_STATUS_LABELS = {
  running: "実行中",
  stopped: "停止中",
  "recovery-waiting": "復旧待ち",
  completed: "完了",
  "partially-failed": "一部失敗",
} as const satisfies Record<RunStatus, string>;

export const RUN_STOP_REASON_LABELS = {
  "model-not-loaded": "モデル未ロード",
  "recovery-needed": "復旧が必要",
  "connection-lost": "接続切断",
  settings: "検査設定",
  aborted: "中断",
  "internal-error": "内部エラー",
  "recovery-blocked": "別の実行の復旧待ち",
  "backend-restarted": "サーバー再起動",
} as const satisfies Record<RunStopReason, string>;

/**
 * 指摘の分類（仕様書 6.3・`server/src/prompts/common.ts` の分類説明に対応）。
 * `context-misuse` と `unclear` の語は仕様書 6.4 の抑制対象外の列挙（「文脈上の誤用、
 * 助詞・係り受け、不明瞭な分類」）の表現に揃えている。
 */
export const FINDING_CATEGORY_LABELS = {
  notation: "誤字・表記",
  "omission-or-duplication": "脱字・重複",
  particle: "助詞",
  grammar: "文法",
  "context-misuse": "文脈上の誤用",
  unclear: "不明瞭な分類",
} as const satisfies Record<FindingCategory, string>;

/** 初回検査の暫定判定（仕様書 5.4）。 */
export const INITIAL_VERDICT_LABELS = {
  "likely-error": "誤りの可能性が高い",
  "confirm-with-author": "作者への確認事項",
} as const satisfies Record<InitialVerdict, string>;

/** 再確認の判定（仕様書 6.5「指摘を維持」「指摘を撤回」「作者への確認事項」）。 */
export const RECHECK_VERDICT_LABELS = {
  keep: "維持",
  withdraw: "撤回",
  "confirm-with-author": "作者への確認事項",
} as const satisfies Record<RecheckVerdict, string>;

/** 再確認の理由区分（仕様書 6.5・`server/src/prompts/recheck.ts` の説明に対応）。 */
export const RECHECK_REASON_KIND_LABELS = {
  "error-confirmed": "誤りを確認",
  "intentional-expression": "意図的な表現",
  "suggestion-inappropriate": "修正案が不適切",
  "unnecessary-polish": "不要な推敲",
  "insufficient-context": "文脈不足",
} as const satisfies Record<RecheckReasonKind, string>;

/** 作者の採否（仕様書 5.3「『未判断』『採用予定』『却下』『保留』を区別する」）。 */
export const JUDGMENT_STATUS_LABELS = {
  undecided: "未判断",
  "adopt-planned": "採用予定",
  rejected: "却下",
  held: "保留",
} as const satisfies Record<JudgmentStatus, string>;

/** 指摘の位置特定状態。 */
export const FINDING_LOCATE_STATUS_LABELS = {
  located: "位置確定",
  "not-found": "本文に見つからない",
  ambiguous: "候補が複数あり特定できない",
} as const satisfies Record<FindingLocateStatus, string>;

/** 再確認の対象外理由（仕様書 6.5「許容語により対象外」等）。 */
export const RECHECK_NOT_APPLICABLE_REASON_LABELS = {
  disabled: "再確認なし（無効）",
  suppressed: "再確認なし（許容語で抑制）",
  unlocated: "再確認なし（位置未確定）",
} as const satisfies Record<RecheckNotApplicableReason, string>;

/** 検査単位・再確認単位の処理状態（仕様書 8.1・8.2）。 */
export const UNIT_STATUS_LABELS = {
  pending: "未処理",
  running: "処理中",
  done: "完了",
  failed: "失敗",
  "not-applicable": "対象外",
} as const satisfies Record<UnitStatus, string>;

/**
 * 生成要求が失敗しうる理由の区分（仕様書 7 節「接続失敗、モデル未準備、入力上限超過、
 * タイムアウト、出力打ち切り、形式不正を区別する」）。`model-not-loaded` だけは
 * `RUN_STOP_REASON_LABELS` の言い回し（「モデル未ロード」）に揃える。
 */
export const FAILURE_REASON_LABELS = {
  connection: "接続失敗",
  "model-not-loaded": "モデル未ロード",
  "input-too-long": "入力上限超過",
  timeout: "タイムアウト",
  truncated: "出力打ち切り",
  malformed: "形式不正",
  aborted: "中断",
} as const satisfies Record<FailureReason, string>;

/** 検査の観点（`Perspective`）。 */
export const PERSPECTIVE_LABELS = {
  typo: "誤字・脱字",
  naturalness: "日本語の自然さ",
} as const satisfies Record<Perspective, string>;

/** 生成要求が失敗した箇所（`UnitFailureDto["origin"]`。仕様書 7 節）。 */
export const FAILURE_ORIGIN_LABELS = {
  "ensure-loaded": "モデルの準備",
  chat: "生成",
  local: "アプリ内",
} as const satisfies Record<FailureOrigin, string>;
