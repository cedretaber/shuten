/**
 * 選択した指摘の詳細（Task 7、決定 3・9・12。仕様書 5.4）。
 *
 * `results-page.tsx` が選択中の `FindingDto`（一覧が持つ情報）と、`getFinding` で取得した
 * `FindingDetailDto`（元候補・位置診断を含む）を分けて渡す。取得中（`detail === null` かつ
 * `detailError === null`）は元候補・位置診断の欄だけ「読み込み中」にし、それ以外（分類・引用・
 * 修正案・理由・判定・採否・関連する他の指摘）は `finding`（一覧の情報）だけで描く——選択直後から
 * 引用や理由が出る（決定 3 と同じ、部分描画を厭わない方の作法。一覧全体の取得とは別に、詳細だけが
 * 遅れて埋まる）。
 *
 * `paragraphId` は表示しない（決定 9。位置未確定時は LLM の申告値で、本文の段落と対応する保証が
 * ない）。
 *
 * 移動（本文へのスクロール）の操作子は `onNavigate` が渡されたときだけ出す。Task 7 の時点では
 * 呼び出し側（`results-page.tsx`）はまだ `onNavigate` を渡さない（Task 9 が本文へのスクロールを
 * 実装してから渡すようになる）。渡されない間は「押しても何も起きないボタン」を作らないよう、
 * 操作子そのものを描かない。
 *
 * 採否と判断メモ（Task 8、決定 13）：操作子そのもの（ラジオ・メモ・保存ボタン）は
 * `judgment-control.tsx` の `JudgmentControl` に持たせ、ここでは指摘ごとに差し替えて渡すだけ。
 * `key={finding.id}` を付けて指摘ごとに作り直すことで、別の指摘を選び直したときに前の指摘の
 * 入力（未保存のラジオ・メモ）が残らないようにする。保存の実行（`putJudgment` の呼び出しと
 * `findings` への反映）は `onSaveJudgment` を通じて呼び出し側（`results-page.tsx`）が行う
 * （状態の持ち主を 1 か所にするため、ここでは API を直接呼ばない）。
 */

import type {
  CandidateDto,
  CandidateLocateStatus,
  DiagnosticDto,
  FindingDetailDto,
  FindingDto,
  JudgmentStatus,
  Perspective,
} from "@shuten/shared";
import { describeRecheck } from "./finding-detail.ts";
import { JudgmentControl } from "./judgment-control.tsx";
import {
  FINDING_CATEGORY_LABELS,
  INITIAL_VERDICT_LABELS,
  RECHECK_VERDICT_LABELS,
} from "./labels.ts";
import styles from "./results-page.module.css";

/**
 * 検査の観点（`Perspective`）の日本語ラベル。`labels.ts`（変更禁止）には無いので、
 * `run-settings-form.tsx` の `PERSPECTIVE_LABELS` と同じ形でここに置く（`satisfies` で網羅性を担保）。
 */
const PERSPECTIVE_LABELS = {
  typo: "誤字・脱字",
  naturalness: "日本語の自然さ",
} as const satisfies Record<Perspective, string>;

/**
 * 候補・診断候補の位置特定状態（`CandidateLocateStatus`。`FindingLocateStatus` と違い
 * `outside-target` を持つ）の日本語ラベル。`labels.ts` の `FINDING_LOCATE_STATUS_LABELS` は
 * `outside-target` を持たない別の型なので流用せず、ここに置く。
 */
const CANDIDATE_LOCATE_STATUS_LABELS = {
  located: "位置確定",
  "not-found": "本文に見つからない",
  ambiguous: "候補が複数あり特定できない",
  "outside-target": "検査対象範囲外（対象外候補）",
} as const satisfies Record<CandidateLocateStatus, string>;

const DIAGNOSTIC_TRANSFORM_LABELS = {
  newline: "改行形式の統一",
  nfc: "NFC 正規化",
  "newline+nfc": "改行形式の統一＋NFC 正規化",
} as const;

/** 観点の表示順（`PERSPECTIVE_LABELS` の定義順）。理由（`reasons`）を観点ごとに並べるために使う。 */
const PERSPECTIVE_ORDER: readonly Perspective[] = ["typo", "naturalness"];

export interface FindingDetailProps {
  readonly finding: FindingDto;
  /** `getFinding` の応答。取得中は null。 */
  readonly detail: FindingDetailDto | null;
  /** `detail` が null のときの取得失敗メッセージ。取得中（まだ失敗していない）なら null。 */
  readonly detailError: string | null;
  readonly body: string;
  /** `range` が完全に一致する他の指摘（決定 8）。 */
  readonly sameRange: readonly FindingDto[];
  /** 範囲が重なるが一致しない他の指摘（決定 8）。 */
  readonly overlapping: readonly FindingDto[];
  readonly onSelectFinding: (findingId: string) => void;
  /** 本文の該当箇所への移動。Task 9 が実装するまでは渡されない（渡されない間は操作子を出さない）。 */
  readonly onNavigate?: () => void;
  /**
   * 採否の保存を試みる（Task 8、決定 13）。`putJudgment` の呼び出しと成功時の `findings` への
   * 反映は呼び出し側（`results-page.tsx`）の責務。失敗したら reject する。
   * `quote` は保存を試みた時点の引用（PR21 レビュー指摘 2）。呼び出し側が「どの指摘の保存が
   * 失敗したか」を選択を跨いで表示するために使う。
   */
  readonly onSaveJudgment: (
    findingId: string,
    status: JudgmentStatus,
    note: string | null,
    quote: string,
  ) => Promise<void>;
}

export function FindingDetail(props: FindingDetailProps) {
  const {
    finding,
    detail,
    detailError,
    body,
    sameRange,
    overlapping,
    onSelectFinding,
    onNavigate,
    onSaveJudgment,
  } = props;

  const display = describeRecheck(finding);

  const quote =
    finding.locateStatus === "located" && finding.range !== null
      ? { heading: "原文", text: body.slice(finding.range.start, finding.range.end) }
      : { heading: "LLM の引用（原文との一致未確認）", text: finding.quote };
  // `quote.heading` から見出しの出し分けを再判定する（`finding.range` の null 絞り込みを
  // 上のオブジェクト生成式で使い切っているため、ここで独立に再判定すると絞り込みが効かない）。
  const resolved = quote.heading === "原文";

  const sortedReasons = [...finding.reasons].sort(
    (a, b) => PERSPECTIVE_ORDER.indexOf(a.perspective) - PERSPECTIVE_ORDER.indexOf(b.perspective),
  );

  return (
    <div className={styles.detail}>
      {/*
       * 仕様 5.4「分類と短い見出し」。裁定：見出しは「分類ラベル ＋ 原文」の 1 行にする。
       * 位置特定失敗時は `finding.quote`（LLM の引用）を使い、見出しからも未確認だと分かるよう
       * 注記を添える（切り詰めない。はみ出しは CSS の省略表示に任せる。一覧の見出しと同じ理由）。
       */}
      <h2 className={styles.detailHeading}>
        <span className={styles.detailHeadingCategory}>
          {FINDING_CATEGORY_LABELS[finding.category]}
        </span>
        <span className={styles.detailHeadingQuote}>{quote.text}</span>
        {!resolved && <span className={styles.detailHeadingUnverified}>（LLM 引用・未確認）</span>}
      </h2>

      {finding.suppression !== null && (
        <p className={styles.suppressionNote}>許容語『{finding.suppression.word}』により抑制</p>
      )}

      <section>
        <h3>{quote.heading}</h3>
        <p className={styles.detailQuote}>{quote.text}</p>
      </section>

      <section>
        <h3>修正案</h3>
        {finding.suggestion === null ? (
          <p>修正案なし</p>
        ) : display.suggestionUsable ? (
          <p className={styles.detailQuote}>{finding.suggestion}</p>
        ) : (
          <div>
            <p className={styles.detailQuote}>{finding.suggestion}</p>
            <p className={styles.suggestionInvalidNote}>
              この修正案は再確認で不適切と判定されました
            </p>
          </div>
        )}
      </section>

      <section>
        <h3>理由</h3>
        {sortedReasons.length === 0 ? (
          <p>理由の記録はありません</p>
        ) : (
          <ul className={styles.detailReasonList}>
            {sortedReasons.map((reason) => (
              <li key={reason.candidateId}>
                <strong>{PERSPECTIVE_LABELS[reason.perspective]}</strong>：{reason.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>判定</h3>
        <p>{display.stateLabel}</p>
        {display.finalVerdict.kind === "recheck" ? (
          <>
            <p>最終判定：{RECHECK_VERDICT_LABELS[display.finalVerdict.verdict]}</p>
            <p>初回判定（履歴）：{INITIAL_VERDICT_LABELS[display.initialVerdict]}</p>
          </>
        ) : display.finalVerdict.kind === "initial-unverified" ? (
          <p>未検証の初回判定：{INITIAL_VERDICT_LABELS[display.finalVerdict.verdict]}</p>
        ) : (
          <p>初回判定：{INITIAL_VERDICT_LABELS[display.finalVerdict.verdict]}</p>
        )}
        {/* 決定 12（行 2）：「再確認済み」＋ reasonKind・reason。reasonKind は stateLabel に
            既に含めているので、ここでは再確認の理由の本文（LLM の自由記述）を出す
            （仕様 5.4「指摘理由と、必要なら判断に迷う点」に対応）。 */}
        {finding.recheck !== null && finding.recheck.reason !== null && (
          <p className={styles.detailQuote}>{finding.recheck.reason}</p>
        )}
      </section>

      <section>
        <h3>採否</h3>
        {/* key に finding.id を付け、指摘を選び直すたびに作り直す（前の指摘の未保存入力を
            残さないため。judgment-control.tsx 冒頭のコメントを参照）。 */}
        <JudgmentControl
          key={finding.id}
          judgment={finding.judgment}
          onSave={(status, note) => onSaveJudgment(finding.id, status, note, finding.quote)}
        />
      </section>

      {(sameRange.length > 0 || overlapping.length > 0) && (
        <RelatedFindingsSection
          sameRange={sameRange}
          overlapping={overlapping}
          onSelectFinding={onSelectFinding}
        />
      )}

      {onNavigate !== undefined && (
        <button type="button" className={styles.detailNavigateButton} onClick={onNavigate}>
          本文の該当箇所へ移動
        </button>
      )}

      <details className={styles.detailRaw}>
        <summary>元候補・位置診断</summary>
        {detail === null ? (
          detailError !== null ? (
            <p className={styles.error}>{detailError}</p>
          ) : (
            <p>読み込み中…</p>
          )
        ) : (
          <>
            <CandidatesList candidates={detail.candidates} />
            <DiagnosticsList diagnostics={detail.diagnostics} />
          </>
        )}
      </details>
    </div>
  );
}

function RelatedFindingsSection(props: {
  readonly sameRange: readonly FindingDto[];
  readonly overlapping: readonly FindingDto[];
  readonly onSelectFinding: (findingId: string) => void;
}) {
  const { sameRange, overlapping, onSelectFinding } = props;
  return (
    <section>
      {sameRange.length > 0 && (
        <div>
          <h3>同じ範囲の他の指摘</h3>
          <RelatedFindingsList findings={sameRange} onSelectFinding={onSelectFinding} />
        </div>
      )}
      {overlapping.length > 0 && (
        <div>
          <h3>範囲が重なる他の指摘</h3>
          <RelatedFindingsList findings={overlapping} onSelectFinding={onSelectFinding} />
        </div>
      )}
    </section>
  );
}

function RelatedFindingsList(props: {
  readonly findings: readonly FindingDto[];
  readonly onSelectFinding: (findingId: string) => void;
}) {
  const { findings, onSelectFinding } = props;
  return (
    <ul className={styles.detailRelatedList}>
      {findings.map((finding) => (
        <li key={finding.id}>
          <button
            type="button"
            className={styles.detailRelatedButton}
            onClick={() => onSelectFinding(finding.id)}
          >
            {FINDING_CATEGORY_LABELS[finding.category]}：{finding.quote}
          </button>
        </li>
      ))}
    </ul>
  );
}

function CandidatesList(props: { readonly candidates: readonly CandidateDto[] }) {
  const { candidates } = props;
  if (candidates.length === 0) {
    return <p>元候補の記録はありません</p>;
  }
  return (
    <div>
      <h4>元候補</h4>
      <ul className={styles.detailRawList}>
        {candidates.map((candidate) => (
          <li key={candidate.id}>
            <p>
              {PERSPECTIVE_LABELS[candidate.perspective]} ／{" "}
              {CANDIDATE_LOCATE_STATUS_LABELS[candidate.locateStatus]}
            </p>
            <p className={styles.detailQuote}>{candidate.llm.quote}</p>
            <p>{candidate.llm.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiagnosticsList(props: { readonly diagnostics: readonly DiagnosticDto[] }) {
  const { diagnostics } = props;
  if (diagnostics.length === 0) {
    return <p>位置診断の記録はありません</p>;
  }
  return (
    <div>
      <h4>位置診断</h4>
      <ul className={styles.detailRawList}>
        {diagnostics.map((diagnostic) => (
          // `candidateId` は候補 1 件につき診断 1 件（`candidates` と 1 対 1）なので配列内で一意。
          <li key={diagnostic.candidateId}>
            <p>{CANDIDATE_LOCATE_STATUS_LABELS[diagnostic.reason]}</p>
            <p className={styles.detailQuote}>{diagnostic.quote}</p>
            {diagnostic.transformCandidates !== null &&
              diagnostic.transformCandidates.length > 0 && (
                <ul className={styles.detailRawList}>
                  {diagnostic.transformCandidates.map((candidate) => (
                    // 変換候補には安定した ID が無いため、変換の種類・変換後文字列・原文側範囲の組で
                    // key を作る（同じ診断内でこの組が重複することはない）。
                    <li
                      key={`${candidate.transform}-${candidate.text}-${candidate.range?.start ?? "null"}-${candidate.range?.end ?? "null"}`}
                    >
                      {DIAGNOSTIC_TRANSFORM_LABELS[candidate.transform]}：{candidate.text}
                    </li>
                  ))}
                </ul>
              )}
          </li>
        ))}
      </ul>
    </div>
  );
}
