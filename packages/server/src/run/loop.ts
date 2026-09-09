/**
 * 単位駆動ループ（決定 19・25・26・27・31・34・35・39）。
 *
 * PR9b の部品（実行キュー・停止ゲート・復旧ゲート・状態遷移ラッパー・保存トランザクション）を
 * つないで、1 実行ぶんの検査単位と再確認単位を順に進める。初回実行と再開の区別を持たない：
 * どちらも「`pending` の単位を拾って進める」1 本の経路で、`claim` が false（＝すでに決着済み）
 * なら飛ばすだけである（決定 9 の増分統合が保存済み指摘への `mergeKey` 照合に一本化されて
 * いるため、統合をやり直す必要がない）。
 *
 * このファイルが負わない責務：停止（`stopRun`）・再開（`resumeRun`）・個別再試行
 * （`retryFailedUnits`）・起動時照合（`reconcileOnStartup`）・決定 33 の完全な例外処理
 * （`running` の単位を `pending` に戻し `internal-error` で終端化する）。いずれも Task 8・9。
 */

import type { CheckInput, Paragraph, Perspective } from "@shuten/shared";
import { splitParagraphs } from "@shuten/shared";

import type { AppDatabase } from "../db/client.ts";
import type {
  CheckUnitRecord,
  FindingRecord,
  RecheckNotApplicableReason,
  RunRecord,
  RunTargetRecord,
} from "../db/records.ts";
import {
  findCheckUnit,
  listCheckUnits,
  listUnfinishedCheckUnits,
} from "../db/repositories/check-units.ts";
import {
  listCandidateSourcesForFinding,
  listFindingsForTarget,
} from "../db/repositories/findings.ts";
import { findManuscriptVersion } from "../db/repositories/manuscripts.ts";
import {
  findRecheckUnitByFinding,
  insertRecheckUnit,
  listRecheckUnits,
} from "../db/repositories/rechecks.ts";
import { findRun, listRunTargets, toGenerationSettings } from "../db/repositories/runs.ts";
import type { LmStudioClient } from "../lmstudio/types.ts";
import type { OrchestratorEvent, PipelineEvent } from "./events.ts";
import { createExecutor } from "./executor.ts";
import { checkInputFromTargetRecord, mergedFindingFromRecords } from "./persist.ts";
import type { RequestQueue } from "./queue.ts";
import type { StopGate } from "./recovery.ts";
import type { RecoveryGate } from "./recovery-gate.ts";
import type { RunStop } from "./result.ts";
import { saveCheckUnitOutcome, saveRecheckOutcome } from "./save.ts";
import { runStatusForStop } from "./state.ts";
import type { RunStatus } from "./status.ts";
import {
  claimRecheckUnitChecked,
  claimUnitChecked,
  finishRunChecked,
  reopenSuppressedRecheckUnitChecked,
} from "./transitions.ts";
import { executeCheckUnit, executeRecheckUnit } from "./units.ts";

/** ループが必要とするもの。`createOrchestrator` が組み立てて渡す。 */
export interface RunLoopContext {
  readonly db: AppDatabase;
  readonly client: LmStudioClient;
  /** プロセス全体で 1 本の実行キュー（決定 2）。 */
  readonly queue: RequestQueue;
  /** プロセス全体の復旧ゲート（決定 39）。 */
  readonly recoveryGate: RecoveryGate;
  /**
   * この実行の停止ゲート（決定 26）。作るのは呼び出し元（`stopRun` が同じものを引ける
   * 必要があるため）。ループは `gate.signal` と `gate.stopRequested` を読み、
   * `beginRequest` / `endRequest` は**フック経由で executor にだけ**呼ばせる。
   */
  readonly gate: StopGate;
  readonly runId: string;
  readonly now: () => Date;
  /** 候補 ID・再確認単位 ID の採番。 */
  readonly createId: () => string;
  /** 進捗通知。例外は呼び出し元（`orchestrator.ts` の `emit`）が握る（決定 42）。 */
  readonly emit: (event: PipelineEvent | OrchestratorEvent) => void;
}

/**
 * `targetId` → `perspective` → 検査単位の入れ子 `Map` を作る。複合キーを文字列連結で
 * 作らないことで、区切り文字の選択自体をなくす（`run/state.ts` の `buildTransitionMap` と
 * 同じ形・同じ理由。観点名や ID に含まれない文字を選ぶ、という判断が要らなくなる）。
 */
function buildUnitIndex(
  units: readonly CheckUnitRecord[],
): ReadonlyMap<string, ReadonlyMap<Perspective, CheckUnitRecord>> {
  const index = new Map<string, Map<Perspective, CheckUnitRecord>>();
  for (const unit of units) {
    const byPerspective = index.get(unit.targetId) ?? new Map<Perspective, CheckUnitRecord>();
    byPerspective.set(unit.perspective, unit);
    index.set(unit.targetId, byPerspective);
  }
  return index;
}

/**
 * 停止操作を受け、かつ実行中の生成要求が上限内に応答を返した（あるいは要求を 1 件も
 * 送っていなかった）場合に、ループが合成する停止（決定 26 の 3 番目の経路）。
 * `generationUnconfirmed` は false なので、実行は `stopped` になる（決定 23）。
 * `outcome.halt` が非 null ならそちらが勝つ（`stop ??=` の順で決める）。
 */
function abortedStop(): RunStop {
  return {
    reason: "aborted",
    message: "停止操作により実行を停止した",
    failure: null,
    generationUnconfirmed: false,
  };
}

/**
 * 1 実行ぶんの単位駆動ループを最後まで回し、終端状態まで更新した `RunRecord` を返す。
 *
 * 想定外の例外はここでは握らない（呼び出し元の `startRun` が `done` を reject させないために
 * 握る。決定 33 の完全な処理は Task 8）。
 */
export async function runLoop(context: RunLoopContext): Promise<RunRecord> {
  const { db, gate, runId } = context;

  const found = findRun(db, runId);
  if (found === null) {
    throw new Error(`検査実行が見つかりません（実行 ID: ${runId}）`);
  }
  // 明示的に型を書くのは、下の関数宣言（巻き上げられる `runRechecks` など）の中でも
  // 「null ではない」ことが伝わるようにするため。
  const run: RunRecord = found;
  const manuscript = findManuscriptVersion(db, run.manuscriptVersionId);
  if (manuscript === null) {
    throw new Error(`原稿版が見つかりません（実行 ID: ${runId}）`);
  }

  // 決定 31：設定と本文はここで 1 度だけ読んで固定する。候補ごと・単位ごとに読み直さない
  // （特に allowedWords が途中で変わると、統合済み指摘の抑制判定が候補の処理順に左右される）。
  const body = manuscript.body;
  const paragraphs: readonly Paragraph[] = splitParagraphs(body);
  const allowedWords = run.allowedWords;
  const generation = toGenerationSettings(run);
  const chunkSettings = run.chunkSettings;
  const checkMs = run.timeouts.checkMs;
  const recheckMs = run.timeouts.recheckMs;
  const perspectives = run.perspectives;
  const recheckEnabled = run.recheckEnabled;
  const recoveryConfirmMs = run.recoveryConfirmMs;

  // 決定 39：executor を作るのはこのループなので、復旧ゲートと onRecoveryRequired の配線も
  // ここで行う。onRecoveryRequired は block 以外の副作用を持たせない（同じ実行で複数回
  // 呼ばれうるため。`recoveryGate.block` 自体は冪等）。
  const executor = createExecutor(context.client, {
    signal: gate.signal,
    queue: context.queue,
    recoveryGate: context.recoveryGate,
    onRecoveryRequired: () => {
      context.recoveryGate.block(runId);
    },
  });

  let stop: RunStop | null = null;

  // 決定 25：走査順は DB の索引順に頼らない。対象は target_index 昇順（listRunTargets）、
  // 対象内の観点は runs.perspectives の配列順。check_units の既定の並びは target_id
  // （ランダム UUID）順なので、対象の順序とは無関係であり、走査順には使えない。
  const targets = listRunTargets(db, runId);
  const unitsByTarget = buildUnitIndex(listCheckUnits(db, runId));

  /** 再確認の起票・実行を 1 度だけ行った対象。 */
  const settledTargets = new Set<string>();

  /**
   * 決定 34：ある対象の検査単位に `pending` / `running` が 1 つも無いことを**DB を読み直して**
   * 確かめてから、再確認単位を対象ごとに 1 トランザクションで起票し、`pending` のものを走らせる。
   * ループ開始時のスナップショット（`unitsByTarget`）では判定できない（保存のたびに古くなる）。
   *
   * この順序を破ると、対象内の他の観点がまだ終わっていない中間状態の統合結果を読んで、
   * 抑制の有無・`category` の集約を誤判定する。
   */
  const settleTarget = async (target: RunTargetRecord): Promise<void> => {
    if (settledTargets.has(target.id)) {
      return;
    }
    const unfinished = listUnfinishedCheckUnits(db, runId).some(
      (unit) => unit.targetId === target.id,
    );
    if (unfinished) {
      return;
    }
    settledTargets.add(target.id);

    const findings = listFindingsForTarget(db, target.id);
    // target-merged の findingCount は `pipeline.ts` と同じく**位置確定済みの指摘の件数**にする
    // （`runPipeline` は `mergeCandidates(partitioned.located)` の件数を載せ、位置特定失敗の
    // 候補は `unlocated` に分けて数えない）。`listFindingsForTarget` は位置特定失敗の指摘も
    // 含むので、そのまま `length` を使うと購読側から見た意味が変わってしまう。
    context.emit({
      type: "target-merged",
      targetIndex: target.targetIndex,
      findingCount: findings.filter((finding) => finding.locateStatus === "located").length,
    });

    issueRechecks(findings);
    await runRechecks(target);
  };

  /**
   * 決定 34 の起票。対象の指摘のうち `recheck_units` を持たないものだけを作る（すでに持つものは
   * 原則触らない）。冪等なので、起票の直前に落ちても再開時に同じ判定でやり直せる。
   * 位置特定失敗の指摘の `not-applicable(unlocated)` は保存トランザクション（`save.ts`）が
   * すでに作っているため、ここでは通常到達しない（防御的に残す）。
   *
   * 例外が 1 つある（決定 45-4）：すでに `not-applicable(suppressed)` の単位があっても、
   * **抑制が外れていれば `pending` に戻して起票し直す**。失敗観点の再試行で同じ範囲・引用・
   * 修正案の別分類の候補が加わると、`merge-store.ts` が `category` を `unclear` に変えて抑制を
   * 解除するため、そのままにすると再確認が 1 度も実行されない。`disabled` / `unlocated` と
   * `done` は戻さない（前者 2 つは実行中に変わらない事実、`done` は終端）。
   */
  function issueRechecks(findings: readonly FindingRecord[]): void {
    const now = context.now();
    db.transaction((tx) => {
      for (const finding of findings) {
        const existing = findRecheckUnitByFinding(tx, finding.id);
        if (existing !== null) {
          if (
            existing.status === "not-applicable" &&
            existing.notApplicableReason === "suppressed" &&
            recheckEnabled &&
            finding.locateStatus === "located" &&
            finding.suppression === null
          ) {
            reopenSuppressedRecheckUnitChecked(tx, existing.id);
          }
          continue;
        }
        // 理由の優先順位（決定 11）：disabled → unlocated → suppressed。
        const notApplicableReason: RecheckNotApplicableReason | null = !recheckEnabled
          ? "disabled"
          : finding.locateStatus !== "located"
            ? "unlocated"
            : finding.suppression !== null
              ? "suppressed"
              : null;
        insertRecheckUnit(tx, {
          id: context.createId(),
          runId,
          findingId: finding.id,
          inputRange: null,
          status: notApplicableReason === null ? "pending" : "not-applicable",
          notApplicableReason,
          attempts: 0,
          failure: null,
          pendingNote: null,
          verdict: null,
          reasonKind: null,
          reason: null,
          suggestionValid: null,
          usage: null,
          inputGraphemes: null,
          elapsedMs: null,
          startedAt: null,
          finishedAt: notApplicableReason === null ? null : now,
        });
      }
    });
  }

  /**
   * 対象内の `pending` な再確認単位を、決定 25 の順（`listFindingsForTarget` の並び）で走らせる。
   * `not-applicable` の単位は claim しない（`saveRecheckOutcome` が例外を投げる。決定 34）。
   */
  async function runRechecks(target: RunTargetRecord): Promise<void> {
    const initialInput: CheckInput = checkInputFromTargetRecord(target);
    for (const finding of listFindingsForTarget(db, target.id)) {
      if (stop !== null) {
        return;
      }
      const existing = findRecheckUnitByFinding(db, finding.id);
      if (existing === null || existing.status !== "pending") {
        continue;
      }

      // 入力の組み立ては claim の**前**に行う。`mergedFindingFromRecords` は壊れた行に対して
      // `PersistBoundaryError` を投げるため、先に claim すると `running` の単位を残したまま
      // 例外が抜ける（決定 33 の完全な処理は Task 8）。
      const merged = mergedFindingFromRecords(
        finding,
        listCandidateSourcesForFinding(db, finding.id),
      );

      // 決定 26 の 3 番目の経路：停止要求を受けていて、まだ止まる理由が決まっていなければ
      // ここで合成する（新しい生成要求を送らない。仕様 8.2）。
      if (gate.stopRequested) {
        stop = abortedStop();
        return;
      }
      if (
        !claimRecheckUnitChecked(db, existing.id, "pending", "running", {
          startedAt: context.now(),
        })
      ) {
        continue;
      }
      const unit = findRecheckUnitByFinding(db, finding.id);
      if (unit === null) {
        throw new Error(`claim 直後の再確認単位が見つかりません（指摘 ID: ${finding.id}）`);
      }

      const outcome = await executeRecheckUnit({
        text: body,
        paragraphs,
        finding: merged,
        initialInput,
        // 抑制された指摘は起票の時点で not-applicable(suppressed) になり、pending にならない。
        suppressed: false,
        chunkSettings,
        allowedWords,
        generation,
        recheckMs,
        recoveryConfirmMs,
        // 決定 45-3：オーケストレーター経路であることを待機時間ではなくこのフラグで示す。
        treatUnconfirmedAsPending: true,
        executor,
        onSlow: (elapsedMs) => {
          // 1 回の生成要求で最大 2 回出る（executor が内部で 1 回だけ再試行し、そのたびに
          // 測り直すため）。購読側は重複に耐える必要がある。
          context.emit({ type: "generation-slow", unitId: unit.id, elapsedMs });
        },
        // 決定 26・27：停止ゲートの出入りは executor のフック経由でだけ行う。ループが
        // beginRequest / endRequest を直接呼ぶと、キュー待ちと ensureLoaded が
        // 「実行中の生成」に含まれ、停止の 3 経路の区別が壊れる。
        onSend: gate.beginRequest,
        onSettled: gate.endRequest,
        onStarted: () => {
          context.emit({ type: "recheck-started", findingId: finding.id });
        },
      });
      if (outcome.halt !== null) {
        stop ??= outcome.halt;
      }
      // 決定 15：await から戻った後に同期的に 1 トランザクションで書く。
      const saved = saveRecheckOutcome(db, { run, unit, outcome, now: context.now() });
      if (saved.rolledBack) {
        // 条件付き更新が 0 行＝この再確認は決着していない（他の経路が先に決着させた）。
        // recheck-finished は出さない（決定 15）。
        context.emit({ type: "save-rolled-back", unitId: unit.id, kind: "recheck" });
      } else {
        context.emit({ type: "recheck-finished", findingId: finding.id, result: outcome.result });
      }
    }
  }

  for (const target of targets) {
    if (stop !== null) {
      break;
    }
    const input: CheckInput = checkInputFromTargetRecord(target);

    for (const perspective of perspectives) {
      if (stop !== null) {
        break;
      }
      const snapshot = unitsByTarget.get(target.id)?.get(perspective);
      if (snapshot === undefined) {
        // startRun は対象 × 観点の全組み合わせに検査単位を作る（決定 18）。無いのは
        // データの破損であり、黙って飛ばすと対象が永久に決着しない。
        throw new Error(
          `検査単位が見つかりません（対象 index: ${String(target.targetIndex)}, 観点: ${perspective}）`,
        );
      }

      if (gate.stopRequested) {
        stop = abortedStop();
        break;
      }
      if (!claimUnitChecked(db, snapshot.id, "pending", "running", { startedAt: context.now() })) {
        // すでに決着済み（done / failed）か、他の経路が先に取った。飛ばす。
        continue;
      }
      const unit = findCheckUnit(db, snapshot.id);
      if (unit === null) {
        throw new Error(`claim 直後の検査単位が見つかりません（検査単位 ID: ${snapshot.id}）`);
      }

      context.emit({ type: "check-started", targetIndex: target.targetIndex, perspective });
      const outcome = await executeCheckUnit({
        text: body,
        paragraphs,
        input,
        targetIndex: target.targetIndex,
        perspective,
        allowedWords,
        generation,
        checkMs,
        recoveryConfirmMs,
        // 決定 45-3：オーケストレーター経路であることを待機時間ではなくこのフラグで示す。
        treatUnconfirmedAsPending: true,
        executor,
        createCandidateId: context.createId,
        onSlow: (elapsedMs) => {
          context.emit({ type: "generation-slow", unitId: unit.id, elapsedMs });
        },
        onSend: gate.beginRequest,
        onSettled: gate.endRequest,
      });
      if (outcome.halt !== null) {
        stop ??= outcome.halt;
      }
      // 決定 15：1 検査単位ぶんの書き込み（候補・診断・指摘・判断・not-applicable な
      // 再確認単位・単位の状態）を 1 トランザクションで書く。
      const saved = saveCheckUnitOutcome(db, {
        run,
        target,
        unit,
        outcome,
        body,
        paragraphs,
        allowedWords,
        now: context.now(),
        modelInfo: executor.modelInfo,
      });
      if (saved.rolledBack) {
        // 条件付き更新が 0 行＝この検査単位は決着していない（他の経路が先に決着させた）。
        // check-finished は出さない（決定 15）。候補もロールバック済みで 1 行も残っていない。
        context.emit({ type: "save-rolled-back", unitId: unit.id, kind: "check" });
      } else {
        context.emit({ type: "check-finished", result: outcome.unit });
      }

      if (stop !== null) {
        break;
      }
      // 決定 19・34：保存が終わるたびに「この対象の単位が全部決着したか」を確かめる。
      await settleTarget(target);
    }

    if (stop !== null) {
      break;
    }
    // 1 単位も実行しなかった対象（再開時：検査単位はすべて決着済みで再確認だけ残っている）
    // でも、起票と再確認の実行に入れるようにする（決定 19・O8）。
    await settleTarget(target);
  }

  return finalizeRun();

  /**
   * 決定 35：終了状態を決めて `runs` を終端化する。`completed` / `partially-failed` の判定は
   * **DB を読み直して**行う（ループがメモリ上で数えた集計では、条件付き更新が 0 行だった単位を
   * 取りこぼす）。
   */
  function finalizeRun(): RunRecord {
    const finishedAt = context.now();
    let status: RunStatus;
    if (stop !== null) {
      status = runStatusForStop(stop);
      if (stop.generationUnconfirmed) {
        // 決定 39：ゲートを閉じるのは executor の onRecoveryRequired が本筋。ここは
        // 冪等な安全網（executor を経由しない停止でも復旧待ちなら門を閉じる）。
        context.recoveryGate.block(runId);
      }
    } else {
      const failed =
        listCheckUnits(db, runId).some((unit) => unit.status === "failed") ||
        listRecheckUnits(db, runId).some((unit) => unit.status === "failed");
      status = failed ? "partially-failed" : "completed";
    }

    finishRunChecked(db, runId, {
      expectedStatus: "running",
      status,
      stopReason: stop?.reason ?? null,
      stopMessage: stop?.message ?? null,
      generationUnconfirmed: stop?.generationUnconfirmed ?? false,
      finishedAt,
    });

    // 条件付き更新が 0 行（他の経路が先に決着させた）でも、通知と戻り値は DB の実際の値にする。
    const finalRun = findRun(db, runId);
    if (finalRun === null) {
      throw new Error(`終端化した検査実行が見つかりません（実行 ID: ${runId}）`);
    }
    context.emit({ type: "run-settled", status: finalRun.status, stop });
    return finalRun;
  }
}
