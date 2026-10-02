/**
 * 選択した指摘の詳細（Task 7、決定 3・9・12。仕様書 5.4）。
 *
 * `results-page.tsx` が選択中の `FindingDto`（一覧が持つ情報）と、`getFinding` で取得した
 * `FindingDetailDto`（元候補・位置診断を含む）を分けて渡す。取得中（`detail === null` かつ
 * `detailError === null`）は元候補・位置診断の欄だけ「読み込み中」にし、それ以外（分類・引用・
 * 修正案・理由・判定・採否・範囲が重なる他の指摘）は `finding`（一覧の情報）だけで描く——選択直後から
 * 引用や理由が出る（決定 3 と同じ、部分描画を厭わない方の作法。一覧全体の取得とは別に、詳細だけが
 * 遅れて埋まる）。
 *
 * `detail` と `detailError` の組み合わせは 3 通りある（PR12b Task 8 の再レビュー）。
 *
 * | `detail` | `detailError` | 出すもの |
 * | --- | --- | --- |
 * | `null` | `null` | 「読み込み中…」（選択直後の初回取得） |
 * | `null` | あり | その欄にエラー（初回取得の失敗） |
 * | あり | あり | **前の値＋「更新できませんでした」の 1 行**（背景の取り直しの失敗） |
 *
 * 3 行目は Task 8 で生まれた組み合わせである。自動更新のたびに欄を「読み込み中…」へ戻すと
 * 点滅するので前の値を残すようにしたが、そのままだと失敗が画面に一度も出ず、古い元候補・位置診断が
 * 最新の正しい値であるかのように出続ける。この PR は `autoRefreshError` / `refreshError` /
 * `controlFailure` / `findingsFreshness` と一貫して「失敗を黙って消さない」方針なので、
 * 詳細パネルもそれに合わせる。
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
 *
 * 区画の順（PR14b の計画の決定 7）は 見出し・原文（1 回）・指摘ごとに［許容語の注記・修正案・採否・
 * 理由・判定・更新の失敗の 1 行・元候補・位置診断］・絞り込みで非表示・範囲が重なる他の指摘・
 * 本文への移動。採否を修正案の直後に置く（PR14a。右の列の上の限られた高さで、選んですぐ採否を
 * 付けられるように。ユーザーの決定 2026-10-02）。
 *
 * 同じ範囲の指摘のまとめ（PR14b）：範囲が完全に一致する指摘は 1 つのまとめとして `members` で
 * 受け取り、見出しと原文を 1 回だけ出したうえで、指摘ごとの区画（修正案・採否・理由・判定・
 * 元候補・位置診断）を先頭から縦に並べる。区画は `key={finding.id}` で作り、1 件のときも 2 件以上の
 * ときも同じ要素の構造にする（件数が変わっても、採否と判断メモの書きかけを作り直さないため。
 * 絞り込みで先頭が外れて件数が減る場面を想定している）。1 件だけのときは「案 n」の見出しを出さず、
 * 見出しの階層も PR14a までと同じにする。「同じ範囲の他の指摘」の欄は、まとめで縦に並ぶように
 * なったのでなくした。範囲が一部だけ重なる他のまとめは、まとめごとに 1 つのリンクにする。
 */

import type {
  CandidateDto,
  CandidateLocateStatus,
  DiagnosticDto,
  FindingDetailDto,
  FindingDto,
  JudgmentStatus,
} from "@shuten/shared";
import { describeRecheck } from "./finding-detail.ts";
import { type FindingGroup, summarizeCategories } from "./finding-group.ts";
import { JudgmentControl } from "./judgment-control.tsx";
import {
  FINDING_CATEGORY_LABELS,
  INITIAL_VERDICT_LABELS,
  PERSPECTIVE_LABELS,
  PERSPECTIVE_ORDER,
  RECHECK_VERDICT_LABELS,
} from "./labels.ts";
import styles from "./results-page.module.css";

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

/**
 * 背景の取り直し（`useFindingDetails` の `refresh`）に失敗したときの 1 行。前の値は残すので、
 * それが古いかもしれないことだけを伝える。
 */
const STALE_DETAIL_NOTICE =
  "この指摘の詳細を更新できませんでした。表示中の内容は古い可能性があります。";

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
  // `quote.heading` から見出しの出し分けを再判定する（`finding.range` の null 絞り込みを
  // 上のオブジェクト生成式で使い切っているため、ここで独立に再判定すると絞り込みが効かない）。
  const resolved = quote.heading === "原文";

  return (
    <div className={styles.detail}>
      {/*
       * 仕様 5.4「分類と短い見出し」。裁定：見出しは「分類ラベル ＋ 原文」の 1 行にする。
       * 位置特定失敗時は `finding.quote`（LLM の引用）を使い、見出しからも未確認だと分かるよう
       * 注記を添える（切り詰めない。はみ出しは CSS の省略表示に任せる。一覧の見出しと同じ理由）。
       * まとめたときの分類は `summarizeCategories` で 1 行にまとめる。
       */}
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

      <section>
        <Heading>修正案</Heading>
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
        <Heading>採否</Heading>
        {/* key に finding.id を付け、指摘を選び直すたびに作り直す（前の指摘の未保存入力を
            残さないため。judgment-control.tsx 冒頭のコメントを参照）。 */}
        <JudgmentControl
          key={finding.id}
          judgment={finding.judgment}
          onSave={(status, note) => onSaveJudgment(finding.id, status, note, finding.quote)}
        />
      </section>

      <section>
        <Heading>理由</Heading>
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
        <Heading>判定</Heading>
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

      {/* 背景の取り直しが失敗したとき（`detail !== null` かつ `detailError !== null`）。
          `<details>` は閉じていることがあるので、その外側に出して必ず見えるようにする。
          サーバー由来の文面（`detailError`）は転記しない——`refreshError` と違い、ここは
          「表示中の値が古いかもしれない」ことだけを伝えれば足りる。 */}
      {detail !== null && detailError !== null && (
        <p className={styles.error}>{STALE_DETAIL_NOTICE}</p>
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
    </>
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
