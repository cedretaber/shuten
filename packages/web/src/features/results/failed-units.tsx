/**
 * 失敗単位の一覧と個別再試行（Task 6、決定 6・12・36。仕様書 8.2「失敗した処理を個別に再試行できる」）。
 *
 * 裁定 R3：ヘッダー（`RunHeader`）の**下**に `results-page.tsx` が直接描く（`run-header.tsx` の
 * 中に入れない）。一覧であって上部の操作ではなく、上部の DOM を `run-header.tsx` に閉じ込める
 * という設計の趣旨にも合うため。
 *
 * 決定 12：`UnitFailureDto.message` は `LmStudioError.message` そのままで、**接続先 URL を
 * 含みうる**（`packages/server/src/api/messages.ts` の冒頭コメント）。`pendingNote`・
 * `finishReason`・`RecheckUnitDto.reason`（LLM の生の出力）も同様に実行時の生の文字列である。
 * **これらは受け取っても描画しない**（このコンポーネントは props の型からもこれらの項目を持たず、
 * `CheckUnitDto` / `RecheckUnitDto` をそのまま受け取って必要な項目だけを読む）。描画してよいのは
 * `status`・`perspective`・`targetIndex`（範囲の並び番号）・`failure.reason`・`failure.origin`・
 * `attempts`・`elapsedMs`・時刻だけ。
 *
 * `input-too-long` の検査単位は再試行すると 400 になる（`collectRetryTargets` が対象から除くため。
 * `orchestrator.ts` のコメント）ので、ボタンを置かず案内文だけを出す。再確認単位には同じ除外が
 * 無い（`retryableUnitIds`（`run-control.ts`）の意図的な非対称）。ここでは判定を書き写さず、
 * `retryableUnitIds(units)` の結果をそのまま使う。
 *
 * 再確認単位は `findingId` を持つので「指摘 → 再確認」と分かる表示にする。**指摘の本文（原稿の
 * 断片）は出さない**——そもそもこのコンポーネントは `FindingDto` を受け取らないので、原稿の断片を
 * 描く経路自体が無い。
 *
 * Task 7（レビュー指摘）：「すべて再試行」はヘッダーの操作列（`run-control.tsx` の `RunControl`）と
 * ここの 2 か所に出ていたが重複のため、一覧側からは消した（ヘッダーへ一本化）。個別の
 * 「この単位を再試行」はここに残す。
 */

import type { CheckUnitDto, RecheckUnitDto, RunDto, RunUnitsDto } from "@shuten/shared";
import { formatDateTime } from "./format-date-time.ts";
import {
  FAILURE_ORIGIN_LABELS,
  FAILURE_REASON_LABELS,
  PERSPECTIVE_LABELS,
  UNIT_STATUS_LABELS,
} from "./labels.ts";
import styles from "./results-page.module.css";
import { retryableUnitIds } from "./run-control.ts";

/** `input-too-long` の検査単位に出す案内（決定 6）。押すと 400 になるため、ボタンの代わりに出す。 */
const INPUT_TOO_LONG_NOTICE =
  "入力が長すぎるため再試行できません（分割長を見直して新しい検査を開始してください）";

export interface FailedUnitsProps {
  readonly run: RunDto;
  /** `GET /api/runs/:id/units` の応答。この画面では `state.kind === "loaded"` の間だけ描くため、
   *  常に取得済みのものを渡す（`run-header.tsx` 側の `units: RunUnitsDto | null` とは異なる）。 */
  readonly units: RunUnitsDto;
  /** 「この単位を再試行」（`{ unitIds: [unitId] }`）。 */
  readonly onRetryUnit: (unitId: string) => void;
  /** 送信中の操作（`run-control.tsx` の `pending` と同じ union）。null でなければ、この一覧の
   *  再試行ボタンもすべて `disabled` にする（`retry` 以外の操作の送信中も含む）。 */
  readonly pending: "stop" | "resume" | "retry" | "confirm" | null;
}

export function FailedUnits(props: FailedUnitsProps) {
  const { run, units, onRetryUnit, pending } = props;

  // 仕様書 8.2・画面ごとの仕様「失敗単位の一覧」：`partially-failed` か `stopped` のときだけ出す。
  if (run.status !== "partially-failed" && run.status !== "stopped") {
    return null;
  }

  const failedCheckUnits = units.checkUnits.filter((unit) => unit.status === "failed");
  const failedRecheckUnits = units.recheckUnits.filter((unit) => unit.status === "failed");
  if (failedCheckUnits.length === 0 && failedRecheckUnits.length === 0) {
    return null;
  }

  const busy = pending !== null;
  // 決定 6・36：再試行できる失敗単位の ID（検査単位の `input-too-long` だけ除く）。判定はここで
  // 書き写さず、`run-control.ts` の純関数をそのまま使う。「すべて再試行」の要否判定として直接は
  // 使わないが（ボタン自体をヘッダーへ一本化したため）、`RetryControl`（下）が個別ボタンの出し分けに使う。
  const retryable = new Set(retryableUnitIds(units));

  return (
    <div className={styles.failedUnits}>
      <h2 className={styles.failedUnitsHeading}>失敗した処理</h2>

      <ul className={styles.failedUnitList}>
        {failedCheckUnits.map((unit) => (
          <FailedCheckUnitRow
            key={unit.id}
            unit={unit}
            canRetry={retryable.has(unit.id)}
            onRetry={onRetryUnit}
            disabled={busy}
          />
        ))}
        {failedRecheckUnits.map((unit) => (
          <FailedRecheckUnitRow
            key={unit.id}
            unit={unit}
            canRetry={retryable.has(unit.id)}
            onRetry={onRetryUnit}
            disabled={busy}
          />
        ))}
      </ul>
    </div>
  );
}

function FailedCheckUnitRow(props: {
  readonly unit: CheckUnitDto;
  readonly canRetry: boolean;
  readonly onRetry: (unitId: string) => void;
  readonly disabled: boolean;
}) {
  const { unit, canRetry, onRetry, disabled } = props;
  return (
    <li className={styles.failedUnitItem}>
      <p className={styles.failedUnitMeta}>
        {UNIT_STATUS_LABELS[unit.status]}
        {" / "}
        {/* `targetIndex` は 0 始まりの内部連番（`packages/server/src/run/pipeline.ts` の
            `planFullTextTargets` 等）なので、並び番号として見せるために 1 を足す。 */}
        範囲 {unit.targetIndex + 1}
        {" / "}
        {PERSPECTIVE_LABELS[unit.perspective]}
        <FailureMeta failure={unit.failure} />
        {" / 試行 "}
        {unit.attempts} 回{unit.elapsedMs !== null && <> / {unit.elapsedMs} ms</>}
      </p>
      <UnitTimes startedAt={unit.startedAt} finishedAt={unit.finishedAt} />
      <RetryControl unitId={unit.id} canRetry={canRetry} onRetry={onRetry} disabled={disabled} />
    </li>
  );
}

function FailedRecheckUnitRow(props: {
  readonly unit: RecheckUnitDto;
  readonly canRetry: boolean;
  readonly onRetry: (unitId: string) => void;
  readonly disabled: boolean;
}) {
  const { unit, canRetry, onRetry, disabled } = props;
  return (
    <li className={styles.failedUnitItem}>
      <p className={styles.failedUnitMeta}>
        {UNIT_STATUS_LABELS[unit.status]}
        {" / "}
        指摘 → 再確認（指摘 ID: {unit.findingId}）
        <FailureMeta failure={unit.failure} />
        {" / 試行 "}
        {unit.attempts} 回{unit.elapsedMs !== null && <> / {unit.elapsedMs} ms</>}
      </p>
      <UnitTimes startedAt={unit.startedAt} finishedAt={unit.finishedAt} />
      <RetryControl unitId={unit.id} canRetry={canRetry} onRetry={onRetry} disabled={disabled} />
    </li>
  );
}

/** `failure.reason` / `failure.origin` だけを出す（`message`・`finishReason` は読まない）。 */
function FailureMeta(props: { readonly failure: CheckUnitDto["failure"] }) {
  const { failure } = props;
  if (failure === null) return null;
  return (
    <>
      {" / "}
      {FAILURE_REASON_LABELS[failure.reason]}
      {" / "}
      {FAILURE_ORIGIN_LABELS[failure.origin]}
    </>
  );
}

function UnitTimes(props: {
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}) {
  const { startedAt, finishedAt } = props;
  if (startedAt === null && finishedAt === null) return null;
  return (
    <p className={styles.failedUnitTimes}>
      {startedAt !== null && (
        <>開始: {formatDateTime(startedAt, -new Date(startedAt).getTimezoneOffset())}</>
      )}
      {startedAt !== null && finishedAt !== null && " / "}
      {finishedAt !== null && (
        <>終了: {formatDateTime(finishedAt, -new Date(finishedAt).getTimezoneOffset())}</>
      )}
    </p>
  );
}

function RetryControl(props: {
  readonly unitId: string;
  readonly canRetry: boolean;
  readonly onRetry: (unitId: string) => void;
  readonly disabled: boolean;
}) {
  const { unitId, canRetry, onRetry, disabled } = props;
  if (!canRetry) {
    return <p className={styles.failedUnitNotice}>{INPUT_TOO_LONG_NOTICE}</p>;
  }
  return (
    <button
      type="button"
      className={styles.controlButton}
      onClick={() => onRetry(unitId)}
      disabled={disabled}
    >
      この単位を再試行
    </button>
  );
}
