/**
 * 検査進捗の描画（Task 3、決定 5・10・11。仕様書 9 節）。
 *
 * 仕様 9 節「進捗は完了した検査単位数と再確認件数を表示し、根拠のない残り時間を示さない」に従い、
 * **割合（%）・残り時間・完了予定時刻は出さない**。`<progress>` 要素も使わない（割合の表示に
 * なるため）。数値はすべて「n / m 件」の形で出し、`total === 0` のときだけ「準備中」と出す
 * （`0 / 0` を「完了」に見せないため）。
 *
 * 件数の行は常に見せ、内訳と観点別は「詳しい進捗」に折りたたむ（UI の見直し 1 節。仕様 5.3 の
 * 上部の観点別の進捗は折りたたみの中で満たす）。
 *
 * `results-page.tsx`（Task 5）が `run-header.tsx` の中に埋め込む想定だが、ここでは単独の
 * コンポーネントとして完結させる。
 */

import type { ProgressDto, RunUnitsDto } from "@shuten/shared";
import { PERSPECTIVE_LABELS, UNIT_STATUS_LABELS } from "./labels.ts";
import styles from "./results-page.module.css";
import { perspectiveTallies, tallyOf, type UnitTally } from "./run-progress.ts";

export interface RunProgressProps {
  readonly progress: ProgressDto;
  /** `GET /api/runs/:id/units` の応答（決定 5）。未取得・失敗なら null。 */
  readonly units: RunUnitsDto | null;
  /** 再確認の有効・無効（設定画面で切り替える）。false なら再確認の件数を出さない。 */
  readonly recheckEnabled: boolean;
  /** 決定 10：まだ `running` の遅延通知（`generation-slow`）の件数。 */
  readonly slowUnitCount: number;
}

export function RunProgress(props: RunProgressProps) {
  const { progress, units, recheckEnabled, slowUnitCount } = props;
  const checkTally = tallyOf(progress.checkUnits);
  const recheckTally = tallyOf(progress.recheckUnits);
  const perspectives = perspectiveTallies(units);
  const recheckNote =
    checkTally.done + checkTally.notApplicable < checkTally.total
      ? "検査が進むと件数が増えます"
      : null;

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
        {/*
         * I-1（レビュー指摘）：「完了 n / 全 m 件」だけでは残りが「対象外」か「処理中」か
         * 区別できない。決定 11「観点別：checkUnits を perspective で分け、状態別の件数を出す」
         * と仕様 11 節 3 項「観点ごとの処理状態」に従い、観点ごとに件数の行と状態別の内訳を
         * 組で出す。`perspectiveTallies` が返す観点は常に 1 件以上の単位を持つ（`units` に
         * 現れない観点は含まれない）ので、ここで `total === 0` の「準備中」になることはない。
         */}
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

function formatCount(tally: UnitTally): string {
  return `完了 ${tally.done} / 全 ${tally.total} 件`;
}
