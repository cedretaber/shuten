/**
 * 実行制御の出し分けと案内（Task 4、決定 6・7・8・9。Task 7 で `showStopButton` を追加）。
 *
 * ここに置くのは純関数だけ（DOM は次の Task の役割）。
 * - `controlAvailability`：決定 6 の表。どのボタンを出すかは「押せる見込みがあるものだけ」の
 *   判断であって、最終判断はサーバー（`orchestrator.ts`）。表とサーバーの判定がずれたら
 *   409 が返る（`controlFailureOf` が受ける）。
 * - `showStopButton`：決定 6。停止ボタンを表示するか（`canStop` とは別の、表示条件だけの判定。
 *   `run-control.tsx` の JSDoc 参照）。
 * - `retryableUnitIds`：決定 6・36。再試行できる失敗単位の ID（`input-too-long` の検査単位を
 *   除く）。サーバーの `collectRetryTargets`（`orchestrator.ts`）と同じ条件。
 * - `statusNotice`：決定 9。中間状態の案内文。優先順は上から（`stopRequestedAt` が最優先）。
 *   `recovery-waiting` は `generationUnconfirmed` より先に判定して null を返す
 *   （仕様 8.2 の定型文は `recovery-notice.tsx` が持つ。レビュー指摘 I-1）。
 * - `controlFailureOf`：決定 8。操作の失敗を案内文に写す。`ApiRequestError` の `code` だけを見て、
 *   `message`（実行 ID を含み、文面もサーバー都合で変わる）は転記しない。未知の `code` と
 *   `ApiRequestError` 以外の例外は既定の文に落ちる。
 */

import type { RunDto, RunUnitsDto } from "@shuten/shared";
import { ApiRequestError } from "../../api/errors.ts";

export interface ControlAvailability {
  readonly canStop: boolean;
  readonly canResume: boolean;
  readonly canRetryFailed: boolean;
  /** 決定 7：復旧待ちの 2 つの操作のうち、副（確認だけ記録する）を出すか。 */
  readonly canConfirmRecovery: boolean;
}

/**
 * 決定 6・36：再試行できる失敗単位の ID。
 *
 * - 検査単位：`status === "failed"` かつ `failure?.reason !== "input-too-long"`。
 *   `input-too-long` を除くのは `collectRetryTargets`（`orchestrator.ts`）が同じ条件で対象から
 *   除くためで、除かずに出すと 400 `invalid-retry-target` になる。
 * - 再確認単位：`status === "failed"` であれば足りる。`input-too-long` でも除外しない
 *   （`collectRetryTargets` の意図的な非対称。再確認の入力は毎回組み直すので、検査単位のような
 *   「暫定値から狭い入力を組み直してしまう」危険が無い）。
 *
 * `units` が null（未取得・失敗）のときは失敗単位が分からないので空配列を返す。
 */
export function retryableUnitIds(units: RunUnitsDto | null): readonly string[] {
  if (units === null) {
    return [];
  }
  const ids: string[] = [];
  for (const unit of units.checkUnits) {
    if (unit.status === "failed" && unit.failure?.reason !== "input-too-long") {
      ids.push(unit.id);
    }
  }
  for (const unit of units.recheckUnits) {
    if (unit.status === "failed") {
      ids.push(unit.id);
    }
  }
  return ids;
}

/**
 * 決定 6：操作の出し分け。表と実際の判定がずれたら 409 が返る（`controlFailureOf` が受ける）ので、
 * ここは「押せる見込みがあるものだけ見せる」ための判定であって、最終判断はサーバー側にある。
 *
 * - 停止：`running` かつ `stopRequestedAt === null` のときだけ（2 回目以降は押せない）。
 * - 再開：`recovery-waiting`（決定 7 の「確認して再開」）、または `stopped` で
 *   `stopReason !== "settings"`。
 * - 復旧確認（副）：`recovery-waiting` かつ `recoveryConfirmedAt === null`。確認済みなら隠す
 *   （決定 7。主の「確認して再開」＝`canResume` は確認後も残す）。
 * - 失敗単位の再試行：`stopped`（`stopReason` を問わない）または `partially-failed` で、かつ
 *   `retryableUnitIds` が 1 件以上あるとき。`units` が null のときは失敗単位が分からないので false。
 */
export function controlAvailability(run: RunDto, units: RunUnitsDto | null): ControlAvailability {
  const canStop = run.status === "running" && run.stopRequestedAt === null;
  const canResume =
    run.status === "recovery-waiting" ||
    (run.status === "stopped" && run.stopReason !== "settings");
  const canConfirmRecovery = run.status === "recovery-waiting" && run.recoveryConfirmedAt === null;
  const canRetryFailed =
    (run.status === "stopped" || run.status === "partially-failed") &&
    retryableUnitIds(units).length > 0;
  return { canStop, canResume, canRetryFailed, canConfirmRecovery };
}

/**
 * 決定 6・レビュー指摘（Task 5 M-1）：停止ボタンを表示するか。`canStop`（押せるか）とは別の判断。
 *
 * `running` の間はずっと表示し続ける——`canStop` をそのまま表示条件にすると、停止要求後
 * （`stopRequestedAt !== null`）にボタン自体が消えてしまい、`disabled` にして「押せなくなった
 * 理由」を見せ続けることができない（`run-control.tsx` の JSDoc に同じ説明あり）。
 */
export function showStopButton(run: RunDto): boolean {
  return run.status === "running";
}

/**
 * 決定 9：中間状態の案内文。出さないときは null。優先順は上から（`stopRequestedAt` が最優先）。
 *
 * `recovery-waiting` は `generationUnconfirmed` より先に判定し、null を返す——仕様 8.2 の定型文
 * （「生成の停止を確認できません。LM Studio側を確認して再開してください」）は `RecoveryNotice`
 * （決定 7）が持つので、ここでは出さない（レビュー指摘 I-1）。
 *
 * サーバー側の不変条件として `recovery-waiting` は必ず `generationUnconfirmed === true` を伴って
 * 書かれる（`packages/server/src/run/state.ts`・`orchestrator.ts`。`confirmRecovery` はどちらも
 * 変えない）。`generationUnconfirmed` を `recovery-waiting` より先に判定すると、「`recovery-waiting`
 * かつ `generationUnconfirmed === false`」という実運用で到達しない組み合わせのときだけ仕様文が
 * 出て、実際に起こる「`recovery-waiting` かつ `generationUnconfirmed === true`」では
 * `generationUnconfirmed` の文（「LM Studio 側の生成が終了したか確認できていません。」）に
 * 奪われて仕様文が一度も出ない、という誤りになる。`recovery-waiting` を先に判定することで、
 * `generationUnconfirmed` の案内は `recovery-waiting` 以外の状態（`stopped` など）でだけ出る。
 *
 * `completed` かつ他の条件に当たらないときだけ null になり、そのときは未処理が無いことを
 * 前提にした表示（「指摘はありません」を含む）を許す。
 */
export function statusNotice(run: RunDto): string | null {
  if (run.status === "running" && run.stopRequestedAt !== null) {
    return "停止を要求しました。実行中の要求の終了を待っています。";
  }
  if (run.status === "recovery-waiting") {
    return null;
  }
  if (run.generationUnconfirmed) {
    return "LM Studio 側の生成が終了したか確認できていません。";
  }
  if (run.status === "partially-failed") {
    return "一部の検査が失敗しました。未処理の範囲があります。";
  }
  if (run.status === "stopped") {
    return "停止中です。未処理の範囲が残っている可能性があります。";
  }
  return null;
}

/** 決定 8：操作の失敗を案内文に写す。追加で出すリンク（`"home"` = 新しい検査、`"settings"` = 接続設定）。 */
export interface ControlFailure {
  readonly message: string;
  readonly links: readonly ("home" | "settings")[];
}

/** 決定 8 が定める既定の案内文（未知の `code`・`ApiRequestError` 以外の例外はここに落ちる）。 */
const DEFAULT_CONTROL_FAILURE: ControlFailure = {
  message: "操作を受け付けられませんでした。時間をおいて試してください。",
  links: [],
};

/**
 * 決定 8 の表。`code` から引くだけの索引にし、`Record` の網羅にしない
 * （サーバー側が `code` を増やしても画面が落ちないようにするため）。
 */
const CONTROL_FAILURE_MESSAGES: Record<string, ControlFailure> = {
  "run-not-active": {
    message: "この検査はすでに動いていません。最新の状態を取得しました。",
    links: [],
  },
  "run-rejected-running": {
    message: "すでに実行中です。最新の状態を取得しました。",
    links: [],
  },
  "run-rejected-settings": {
    message:
      "設定エラーで停止した検査は再開できません。設定を見直して新しい検査を開始してください。",
    links: ["home"],
  },
  "run-rejected-stale-version": {
    message:
      "アプリの更新で版が変わったため、この検査は再開・再試行できません。新しい検査を開始してください。",
    links: ["home"],
  },
  "run-rejected-connection": {
    message:
      "接続先が検査開始時と異なるため再開・再試行できません。接続設定を戻すか、新しい検査を開始してください。",
    links: ["settings", "home"],
  },
  "run-rejected-status": {
    message: "現在の状態からは受け付けられません。最新の状態を取得しました。",
    links: [],
  },
  "invalid-retry-target": {
    message: "再試行できる失敗単位がありません。",
    links: [],
  },
};

/**
 * 決定 8：操作の失敗を案内文に写す。`ApiRequestError` の `code` だけを見る。`message`（実行 ID を
 * 含み、文面もサーバー都合で変わる）は転記しない。`ApiRequestError` 以外（通信の失敗・応答の
 * 契約違反など）は既定の文にする。
 */
export function controlFailureOf(cause: unknown): ControlFailure {
  if (!(cause instanceof ApiRequestError)) {
    return DEFAULT_CONTROL_FAILURE;
  }
  return CONTROL_FAILURE_MESSAGES[cause.code] ?? DEFAULT_CONTROL_FAILURE;
}
