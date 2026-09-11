/**
 * 検査進捗の描画（Task 3、決定 5・10・11。仕様書 9 節）。
 *
 * 仕様 9 節「進捗は完了した検査単位数と再確認件数を表示し、根拠のない残り時間を示さない」に従い、
 * **割合（%）・残り時間・完了予定時刻は出さない**。`<progress>` 要素も使わない（割合の表示に
 * なるため）。数値はすべて「n / m 件」の形で出し、`total === 0` のときだけ「準備中」と出す
 * （`0 / 0` を「完了」に見せないため）。
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

  return (
    <div className={styles.progress}>
      <UnitTallySection label="検査" tally={checkTally} />

      {recheckEnabled ? (
        <UnitTallySection label="再確認" tally={recheckTally} />
      ) : (
        <p className={styles.progressLine}>再確認なし</p>
      )}

      {perspectives.length > 0 && (
        <ul className={styles.progressPerspectiveList}>
          {perspectives.map(({ perspective, tally }) => (
            <li key={perspective}>
              {PERSPECTIVE_LABELS[perspective]}: {formatCount(tally)}
            </li>
          ))}
        </ul>
      )}

      {slowUnitCount > 0 && (
        <p className={styles.progressSlowNotice}>
          生成が遅延しています（{slowUnitCount} 件）。応答を待っています。
        </p>
      )}
    </div>
  );
}

function UnitTallySection(props: { readonly label: string; readonly tally: UnitTally }) {
  const { label, tally } = props;

  if (tally.total === 0) {
    return <p className={styles.progressLine}>{label}: 準備中</p>;
  }

  return (
    <div className={styles.progressSection}>
      <p className={styles.progressLine}>
        {label}: {formatCount(tally)}
      </p>
      {/* 決定 11：対象外（not-applicable）は分母に含めたうえで内訳として別に出す。ついでに
          失敗・処理中・未処理も内訳として出す（割合ではなく件数のみ）。 */}
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
