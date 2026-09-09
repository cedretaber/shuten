/**
 * 保存トランザクション（決定 15・22・28）。
 *
 * 1 回の生成要求（1 検査単位、または 1 件の再確認）から生じる DB への書き込みをすべて
 * 1 つの `db.transaction` にまとめる。理由は決定 15：先に検査単位を `done` にしてプロセスが
 * 落ちると、再開時にその単位が飛ばされ、LLM の応答から得た候補が永久に失われる。逆に候補を
 * 先に書いて単位の更新前に落ちると、再開時に同じ単位を実行して候補が重複する。両方を同時に
 * 避けられるのは 1 トランザクションだけ。
 *
 * better-sqlite3 は同期 API なので、この中で `await` してはならない（呼び出し元は
 * 生成要求の完了後に同期的にこれを呼ぶ。DB トランザクションに LLM 応答待ちを含めない）。
 *
 * ロールバックは番兵例外 `SaveRolledBack` を投げて `db.transaction` を抜け、この内部で
 * 捕まえて `{ rolledBack: true }` に変える。呼び出し元に例外を漏らさない。他の例外
 * （`PersistBoundaryError` / `MalformedBodyError` / `InvalidTransitionError` など）は
 * そのまま外へ伝播させる（ロールバックは better-sqlite3 の例外時ロールバックで起きる）。
 */

import type { Candidate, LocatedCandidate, Paragraph, UnlocatedCandidate } from "@shuten/shared";

import type { AppDatabase, AppDatabaseLike } from "../db/client.ts";
import type {
  CheckUnitRecord,
  RecheckNotApplicableReason,
  RecheckUnitRecord,
  RunRecord,
  RunTargetRecord,
  UnitFailureRecord,
} from "../db/records.ts";
import { nextCandidateIndex, saveUnlocatedCandidate } from "../db/repositories/findings.ts";
import { insertRecheckUnit } from "../db/repositories/rechecks.ts";
import { updateRunModelInfo } from "../db/repositories/runs.ts";
import type { ModelInfo } from "../lmstudio/types.ts";
import { mergeCandidateIntoRun } from "./merge-store.ts";
import { assertUnlocatedFindingBoundary, deriveParagraphId } from "./persist.ts";
import { finishCheckUnitChecked, finishRecheckUnitChecked } from "./transitions.ts";
import type { CheckUnitOutcome, RecheckUnitOutcome } from "./units.ts";

/**
 * 条件付き更新（`finish*Checked`）が 0 行だった（停止などで先に決着していた）ことを示す
 * 番兵例外。`db.transaction` を抜けるためだけに使う。モジュール外には漏らさない。
 */
class SaveRolledBack extends Error {}

/** `UnitFailure`（`run/result.ts`）を DB の `UnitFailureRecord` に写す。持ち物は同一。 */
function toFailureRecord(failure: {
  readonly reason: UnitFailureRecord["reason"];
  readonly message: string;
  readonly finishReason: string | null;
  readonly origin: UnitFailureRecord["origin"];
}): UnitFailureRecord {
  return {
    reason: failure.reason,
    message: failure.message,
    finishReason: failure.finishReason,
    origin: failure.origin,
  };
}

/** `Candidate`（`@shuten/shared`）が位置確定済みかを判定する。`locate.status` はネストしているため型ガードで明示する。 */
function isLocatedCandidate(candidate: Candidate): candidate is LocatedCandidate {
  return candidate.locate.status === "located";
}

/** ---------------------------------------------------------------------- */
/** saveCheckUnitOutcome */
/** ---------------------------------------------------------------------- */

export interface SaveCheckUnitInput {
  readonly run: RunRecord;
  readonly target: RunTargetRecord;
  /** 状態は running（claim 済み）。`attempts` は今回の要求より前の累計値（決定 41）。 */
  readonly unit: CheckUnitRecord;
  readonly outcome: CheckUnitOutcome;
  readonly body: string;
  readonly paragraphs: readonly Paragraph[];
  readonly allowedWords: readonly string[];
  readonly now: Date;
  /**
   * `executor.modelInfo`（呼び出し元が読んだ現在値）。決定 28 の手順 4・決定 30。
   * `run.modelInfo` がまだ null で、これが非 null なら `updateRunModelInfo` を呼ぶ。
   * `updateRunModelInfo` 自体が `WHERE model_info IS NULL` の条件付き更新なので、
   * `run`（呼び出し元が読んだスナップショット）が多少古くても二重に書き込むことはない。
   */
  readonly modelInfo: ModelInfo | null;
}

export interface SaveCheckUnitResult {
  /** 条件付き更新が 0 行で、トランザクション全体をロールバックした（決定 15）。 */
  readonly rolledBack: boolean;
  /** このトランザクションで新規作成、または統合先として書き込んだ指摘の ID。 */
  readonly findingIds: readonly string[];
}

/**
 * 位置特定失敗の 1 候補を保存する（決定 4 の下 3 行・決定 11）。
 * `assertUnlocatedFindingBoundary` を通してから `saveUnlocatedCandidate` を呼び、
 * `not-found` / `ambiguous` で指摘ができたら続けて `not-applicable` の再確認単位を作る。
 * 新規に指摘を作った場合はその ID を返す（`outside-target` では null）。
 */
function saveUnlocated(
  tx: AppDatabaseLike,
  run: RunRecord,
  target: RunTargetRecord,
  unit: CheckUnitRecord,
  candidate: UnlocatedCandidate,
  candidateIndex: number,
  body: string,
  now: Date,
): string | null {
  assertUnlocatedFindingBoundary(
    { quote: candidate.llm.quote, suggestion: candidate.llm.suggestion },
    body,
  );

  const result = saveUnlocatedCandidate(tx, {
    runId: run.id,
    checkUnitId: unit.id,
    candidateIndex,
    llm: candidate.llm,
    manuscriptVersionId: run.manuscriptVersionId,
    targetId: target.id,
    searchRange: target.input,
    locate: candidate.locate,
    candidateId: candidate.id,
    createdAt: now,
  });

  if (result.finding === null) {
    // outside-target：指摘を作らないので再確認単位も作らない（決定 4）。
    return null;
  }

  // 理由の優先順位（決定 11）：disabled → unlocated。位置未確定の指摘は抑制の対象になり得ない
  // （抑制は located かつ suggestion !== null の指摘だけが対象。persist.ts の assertFindingBoundary）
  // ため、ここで suppressed になることはない。
  const notApplicableReason: RecheckNotApplicableReason = run.recheckEnabled
    ? "unlocated"
    : "disabled";

  insertRecheckUnit(tx, {
    runId: run.id,
    findingId: result.finding.id,
    inputRange: null,
    status: "not-applicable",
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
    finishedAt: now,
  });

  return result.finding.id;
}

/**
 * 検査単位 1 回ぶんの生成結果を 1 トランザクションで保存する（決定 28）。
 *
 * 1. `nextCandidateIndex` を 1 度だけ読み、`outcome.candidates` を LLM が返した順のまま
 *    （`partitionCandidates` などで位置確定済み／失敗に分けない。順序を崩すと決定 22 に反する）
 *    連番で採番する。
 * 2. 位置確定済みの候補 → `mergeCandidateIntoRun`。
 * 3. 位置特定失敗の候補 → `assertUnlocatedFindingBoundary` を通してから `saveUnlocatedCandidate`、
 *    続けて `not-applicable` の再確認単位（決定 11）。
 * 4. `runs.model_info` が未設定で `modelInfo` が取れていれば `updateRunModelInfo`（決定 30）。
 * 5. `finishCheckUnitChecked` で `running` → `done` / `failed` / `pending`。0 行ならロールバック。
 *    `attempts` は `unit.attempts + outcome.unit.attempts`（決定 41：実行をまたいだ累計）。
 */
export function saveCheckUnitOutcome(
  db: AppDatabase,
  input: SaveCheckUnitInput,
): SaveCheckUnitResult {
  try {
    return db.transaction((tx): SaveCheckUnitResult => {
      const base = nextCandidateIndex(tx, input.run.id);
      const findingIds: string[] = [];

      input.outcome.candidates.forEach((candidate, offset) => {
        const candidateIndex = base + offset;
        if (isLocatedCandidate(candidate)) {
          const paragraphId = deriveParagraphId(input.paragraphs, candidate.locate.range.start);
          const merged = mergeCandidateIntoRun(tx, {
            runId: input.run.id,
            manuscriptVersionId: input.run.manuscriptVersionId,
            targetId: input.target.id,
            checkUnitId: input.unit.id,
            candidateIndex,
            candidate,
            paragraphId,
            allowedWords: input.allowedWords,
            now: input.now,
            body: input.body,
            paragraphs: input.paragraphs,
          });
          findingIds.push(merged.finding.id);
        } else {
          const findingId = saveUnlocated(
            tx,
            input.run,
            input.target,
            input.unit,
            candidate,
            candidateIndex,
            input.body,
            input.now,
          );
          if (findingId !== null) {
            findingIds.push(findingId);
          }
        }
      });

      if (input.run.modelInfo === null && input.modelInfo !== null) {
        updateRunModelInfo(tx, input.run.id, input.modelInfo);
      }

      const finishInput = toFinishCheckUnitInput(input.unit, input.outcome, input.now);
      const finished = finishCheckUnitChecked(tx, input.unit.id, finishInput);
      if (!finished) {
        throw new SaveRolledBack();
      }

      return { rolledBack: false, findingIds };
    });
  } catch (error) {
    if (error instanceof SaveRolledBack) {
      return { rolledBack: true, findingIds: [] };
    }
    throw error;
  }
}

/** `CheckUnitOutcome` を `finishCheckUnitChecked` の入力に写す。`attempts` は累計（決定 41）。 */
function toFinishCheckUnitInput(
  unit: CheckUnitRecord,
  outcome: CheckUnitOutcome,
  finishedAt: Date,
): Parameters<typeof finishCheckUnitChecked>[2] {
  const result = outcome.unit;
  const attempts = unit.attempts + result.attempts;
  if (result.status === "done") {
    return {
      expectedStatus: "running",
      status: "done",
      attempts,
      failure: null,
      pendingNote: null,
      usage: result.usage,
      inputGraphemes: result.inputGraphemes,
      elapsedMs: result.elapsedMs,
      finishedAt,
    };
  }
  if (result.status === "failed") {
    return {
      expectedStatus: "running",
      status: "failed",
      attempts,
      failure: toFailureRecord(result.failure),
      pendingNote: null,
      usage: result.usage,
      inputGraphemes: result.inputGraphemes,
      elapsedMs: result.elapsedMs,
      finishedAt,
    };
  }
  // pending：CheckUnitResult の pending は failure / usage / inputGraphemes / elapsedMs を
  // 持たない（result.ts）が、決定 20 は「pending にしても失敗の事実は捨てない」と定める
  // （failure_reason / failure_message / failure_origin / attempts / elapsed_ms を同じ更新で
  // 保存する）。この失敗の記録は `CheckUnitOutcome.failure`（トップレベル。pending でも
  // 非 null になりうる）に別途保持されているので、そちらから書く。usage / elapsedMs も同じ理由
  // で outcome 側（executor.execute が計測した値）を使う。
  return {
    expectedStatus: "running",
    status: "pending",
    attempts,
    failure: outcome.failure !== null ? toFailureRecord(outcome.failure) : null,
    pendingNote: result.note,
    usage: outcome.usage,
    inputGraphemes: null,
    elapsedMs: outcome.elapsedMs,
    finishedAt,
  };
}

/** ---------------------------------------------------------------------- */
/** saveRecheckOutcome */
/** ---------------------------------------------------------------------- */

export interface SaveRecheckInput {
  readonly run: RunRecord;
  /** 状態は running（claim 済み）。`attempts` は今回の要求より前の累計値（決定 41）。 */
  readonly unit: RecheckUnitRecord;
  readonly outcome: RecheckUnitOutcome;
  readonly now: Date;
}

export interface SaveRecheckResult {
  /** 条件付き更新が 0 行で、トランザクション全体をロールバックした（決定 15）。 */
  readonly rolledBack: boolean;
}

/**
 * 再確認 1 件ぶんの生成結果を 1 トランザクションで保存する（決定 28）。
 * 結果列（`verdict` / `reasonKind` / `reason` / `suggestionValid` / `usage`）と状態の
 * `running` → `done` / `failed` / `pending` を 1 トランザクションで行う。0 行ならロールバック。
 */
export function saveRecheckOutcome(db: AppDatabase, input: SaveRecheckInput): SaveRecheckResult {
  try {
    return db.transaction((tx): SaveRecheckResult => {
      const finishInput = toFinishRecheckUnitInput(input.unit, input.outcome, input.now);
      const finished = finishRecheckUnitChecked(tx, input.unit.id, finishInput);
      if (!finished) {
        throw new SaveRolledBack();
      }
      return { rolledBack: false };
    });
  } catch (error) {
    if (error instanceof SaveRolledBack) {
      return { rolledBack: true };
    }
    throw error;
  }
}

/**
 * `RecheckUnitOutcome` を `finishRecheckUnitChecked` の入力に写す。`attempts` は累計（決定 41）。
 *
 * `executeRecheckUnit`（`run/units.ts`）が実際に返しうるのは `suppressed` / `pending` /
 * `failed` / `done` の 4 通り（`disabled` は `pipeline.ts` 側の判定であり `executeRecheckUnit`
 * 自身は返さない）。`saveRecheckOutcome` は `running`（claim 済み）の再確認単位だけを扱うが、
 * `running` はもともと「対象外ではない」ことが決定 34 で確定した単位にしか付かない状態なので、
 * `disabled` / `suppressed` は理論上ここに到達しない。表にない遷移（`running` → `not-applicable`
 * は許容表に無い。`run/state.ts`）を要求してしまう組み立てミスなので、DB に触れる前に
 * 通常の例外にする（番兵例外 `SaveRolledBack` ではない。ロールバックすべき正常系ではないため）。
 */
function toFinishRecheckUnitInput(
  unit: RecheckUnitRecord,
  outcome: RecheckUnitOutcome,
  finishedAt: Date,
): Parameters<typeof finishRecheckUnitChecked>[2] {
  const result = outcome.result;
  if (result.status === "disabled" || result.status === "suppressed") {
    throw new Error(
      `再確認単位は running から直接 ${result.status} にはできません` +
        `（再確認単位 ID: ${unit.id}。not-applicable への遷移は起票時にのみ許される）`,
    );
  }

  const attempts = unit.attempts + result.attempts;
  if (result.status === "done") {
    return {
      expectedStatus: "running",
      status: "done",
      attempts,
      failure: null,
      pendingNote: null,
      notApplicableReason: null,
      verdict: result.output.verdict,
      reasonKind: result.output.reasonKind,
      reason: result.output.reason,
      suggestionValid: result.output.suggestionValid,
      usage: result.usage,
      inputGraphemes: result.inputGraphemes,
      elapsedMs: result.elapsedMs,
      finishedAt,
      // 実際に生成要求へ送った入力範囲（I6）。`done` では必ず非 null（result.ts）。
      inputRange: result.inputRange,
    };
  }
  if (result.status === "failed") {
    return {
      expectedStatus: "running",
      status: "failed",
      attempts,
      failure: toFailureRecord(result.failure),
      pendingNote: null,
      notApplicableReason: null,
      verdict: null,
      reasonKind: null,
      reason: null,
      suggestionValid: null,
      usage: result.usage,
      inputGraphemes: null,
      elapsedMs: result.elapsedMs,
      finishedAt,
      // `buildRecheckInput` が InputTooLongError で送信前に終わったときは null（result.ts）。
      inputRange: result.inputRange,
    };
  }
  // pending：RecheckResult の pending は failure / usage / inputGraphemes / elapsedMs を
  // 持たない（result.ts）が、決定 20 は pending でも失敗の事実を捨てないと定める
  // （saveCheckUnitOutcome の pending 分岐と同じ理由）。failure / usage / elapsedMs は
  // outcome 側（トップレベル。pending でも取れていれば入る）の値を使う。
  return {
    expectedStatus: "running",
    status: "pending",
    attempts,
    failure: outcome.failure !== null ? toFailureRecord(outcome.failure) : null,
    pendingNote: result.note,
    notApplicableReason: null,
    verdict: null,
    reasonKind: null,
    reason: null,
    suggestionValid: null,
    usage: outcome.usage,
    inputGraphemes: null,
    elapsedMs: outcome.elapsedMs,
    finishedAt,
    // 入力を組み立てる前に終わっていれば null（result.ts）。
    inputRange: result.inputRange,
  };
}
