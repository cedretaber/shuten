import { hashBody } from "@shuten/server/hash.ts";
import type { StopReason } from "@shuten/server/run/result.ts";
import type {
  CandidateDto,
  DiagnosticDto,
  RecheckSummaryDto,
  RecheckUnitDto,
  RunExportDto,
  RunStopReason,
  UnitFailureDto,
} from "@shuten/shared";
import { countGraphemes, runExportDtoSchema, splitParagraphs } from "@shuten/shared";

import type { EvaluationResultInput } from "./result-schema.ts";
import { formatIssues } from "./result-schema.ts";

/**
 * エクスポート JSON を評価入力（`EvaluationResultInput`）に変換するアダプター
 * （PR13a-2 Task 10。計画書の決定 27・28・30・31・32）。
 *
 * 純粋関数だけを置く。`node:fs`・HTTP・時計には依存しない。読み込みと CLI 配線は
 * `io.ts` / `main.ts`（Task 11）の責務。エクスポート JSON 自体の検証は `shared` の
 * `runExportDtoSchema` で行う（形の正本を 2 つ持たない）。
 */

// --- 評価入力の部分型（`EvaluationResultInput` から引く。`score.test.ts` と同じやり方） --------

type FindingInput = EvaluationResultInput["findings"][number];
type UnlocatedInput = EvaluationResultInput["unlocated"][number];
type RecheckInput = FindingInput["recheck"];
type DiagnosticInput = UnlocatedInput["candidate"]["locate"]["diagnostic"];

// --- parseExportJson -------------------------------------------------------------------------

export type ExportParseResult =
  | { readonly ok: true; readonly value: RunExportDto }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * エクスポート JSON（`JSON.parse` の戻り値）の形を検証する。`runExportDtoSchema`
 * （`@shuten/shared`）を正本とし、形の正本を 2 つ持たない。
 */
export function parseExportJson(json: unknown): ExportParseResult {
  const result = runExportDtoSchema.safeParse(json);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, errors: formatIssues(result.error.issues) };
}

// --- adaptExportToResult -----------------------------------------------------------------------

export type AdaptResult =
  | { readonly ok: true; readonly value: EvaluationResultInput }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * `RunStopReason`（サーバー。8 値）と `StopReason`（`PipelineResult`。7 値）の対応（決定 30）。
 * 全キー必須の対応表でコンパイル時に縛る。`backend-restarted` だけ `PipelineResult` の
 * `StopReason` に無いので `null`（変換不能として拒否する）にする。
 */
const STOP_REASON_MAP = {
  "model-not-loaded": "model-not-loaded",
  "recovery-needed": "recovery-needed",
  "connection-lost": "connection-lost",
  settings: "settings",
  aborted: "aborted",
  "internal-error": "internal-error",
  "recovery-blocked": "recovery-blocked",
  "backend-restarted": null,
} as const satisfies Record<RunStopReason, StopReason | null>;

/** 位置未確定の候補 1 件の診断を探す。無ければ `errors` に積んで `{ ok: false }` を返す（決定 30）。 */
function lookupDiagnosticInput(
  candidateId: string,
  diagnosticsByCandidateId: ReadonlyMap<string, readonly DiagnosticDto[]>,
  errors: string[],
): { readonly ok: true; readonly value: DiagnosticInput } | { readonly ok: false } {
  const diagnostics = diagnosticsByCandidateId.get(candidateId);
  const diagnostic = diagnostics?.[0];
  if (diagnostic === undefined) {
    errors.push(`位置未確定の候補に対応する診断がありません（candidateId: ${candidateId}）`);
    return { ok: false };
  }
  if (diagnostic.transformCandidates === null) {
    return { ok: true, value: null };
  }
  return {
    ok: true,
    value: { candidates: diagnostic.transformCandidates.map((c) => ({ transform: c.transform })) },
  };
}

/**
 * 位置確定済みの指摘 1 件の再確認を決定 27・32 の優先順位で写す。
 *
 * **再確認単位が無いときを `disabled` に丸めない。** `recheckEnabled === false` → `disabled`、
 * 位置確定済みの指摘の抑制 → `suppressed`、それ以外は `pending`（`issueRechecks` の起票前に
 * 止まった実行を復元する）。写せない値（`done` の項目欠落・`running`・不整合な
 * `notApplicableReason`）は `errors` に積んで `undefined` を返す。
 */
function buildRecheckInput(args: {
  readonly recheckEnabled: boolean;
  readonly suppression: { readonly word: string; readonly ruleVersion: string } | null;
  readonly recheckUnit: RecheckUnitDto | undefined;
  readonly findingId: string;
  readonly errors: string[];
}): RecheckInput | undefined {
  const { recheckEnabled, suppression, recheckUnit, findingId, errors } = args;

  if (recheckUnit === undefined) {
    if (!recheckEnabled) {
      return { status: "disabled" };
    }
    if (suppression !== null) {
      return { status: "suppressed" };
    }
    return { status: "pending" };
  }

  switch (recheckUnit.status) {
    case "done": {
      const { verdict, reasonKind, reason, suggestionValid } = recheckUnit;
      if (verdict === null || reasonKind === null || reason === null || suggestionValid === null) {
        errors.push(
          `再確認が done なのに判定の項目が欠けています（findingId: ${findingId}, recheckUnitId: ${recheckUnit.id}）`,
        );
        return undefined;
      }
      return { status: "done", output: { verdict, reasonKind, reason, suggestionValid } };
    }
    case "failed":
      return { status: "failed" };
    case "pending":
      return { status: "pending" };
    case "not-applicable": {
      if (recheckUnit.notApplicableReason === "disabled") {
        return { status: "disabled" };
      }
      if (recheckUnit.notApplicableReason === "suppressed") {
        return { status: "suppressed" };
      }
      // "unlocated"（位置未確定の指摘に付くはずの理由）や null が、位置確定済みの指摘に
      // 付いているのは参照整合が壊れている（決定 30 の表には無い追加の検査。ブリーフ参照）。
      errors.push(
        `位置確定済みの指摘に不整合な再確認の状態があります` +
          `（findingId: ${findingId}, notApplicableReason: ${String(recheckUnit.notApplicableReason)}）`,
      );
      return undefined;
    }
    case "running":
      // 「再確認単位に running がある」は呼び出し元がエクスポート全体から既に検出して
      // errors に積んでいる（決定 30）。ここでは二重にメッセージを積まず、写せないとだけ扱う。
      return undefined;
    default: {
      const exhaustive: never = recheckUnit.status;
      throw new Error(`到達しないはずの再確認単位の状態です: ${String(exhaustive)}`);
    }
  }
}

/** `UnitFailureDto | null` どうしの構造比較（`findings[].recheck` と `recheckUnits[]` の突き合わせ用）。 */
function unitFailureEquals(a: UnitFailureDto | null, b: UnitFailureDto | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.reason === b.reason &&
    a.message === b.message &&
    a.finishReason === b.finishReason &&
    a.origin === b.origin
  );
}

/**
 * `RecheckSummaryDto`（`findings[].recheck`）と `RecheckUnitDto`（`recheckUnits[]`）の
 * 共通項目（`id` / `status` / `notApplicableReason` / `verdict` / `reasonKind` / `reason` /
 * `suggestionValid` / `failure`）を比較し、食い違う項目名を返す（決定 30・32）。
 * 値そのものはエラー文に出さない（`reason` は原稿由来ではないが LLM の応答本文なので、
 * 決定 9 の「本文を出さない」と同じ扱いにする）。
 */
function findRecheckSummaryMismatches(
  summary: RecheckSummaryDto,
  unit: RecheckUnitDto,
): readonly string[] {
  const mismatches: string[] = [];
  if (summary.id !== unit.id) mismatches.push("id");
  if (summary.status !== unit.status) mismatches.push("status");
  if (summary.notApplicableReason !== unit.notApplicableReason) {
    mismatches.push("notApplicableReason");
  }
  if (summary.verdict !== unit.verdict) mismatches.push("verdict");
  if (summary.reasonKind !== unit.reasonKind) mismatches.push("reasonKind");
  if (summary.reason !== unit.reason) mismatches.push("reason");
  if (summary.suggestionValid !== unit.suggestionValid) mismatches.push("suggestionValid");
  if (!unitFailureEquals(summary.failure, unit.failure)) mismatches.push("failure");
  return mismatches;
}

/**
 * エクスポート JSON（決定 16・23・32）を評価入力（`EvaluationResultInput`。決定 18）に写す
 * （決定 27・28・30・31）。
 *
 * 失敗は原則すべて集めて返す（決定 30）。唯一の早期リターンは `run.status` が
 * `completed` / `partially-failed` / `stopped` のいずれでもないとき——`stop` の形自体が
 * 決まらず、後続の検査を組み立てる土台が無いため。
 */
export function adaptExportToResult(exported: RunExportDto): AdaptResult {
  const errors: string[] = [];
  const run = exported.run;

  // 決定 30：終わっていない実行は拒否する（唯一の早期リターン）。
  if (run.status !== "completed" && run.status !== "partially-failed" && run.status !== "stopped") {
    return {
      ok: false,
      errors: [`run.status を評価入力の status に写せません（status: ${run.status}）`],
    };
  }

  // --- 本文とハッシュの照合（決定 30） ---------------------------------------------------------
  if (hashBody(exported.manuscript.body) !== exported.manuscript.bodyHash) {
    errors.push("manuscript.body と manuscript.bodyHash が一致しません");
  }

  // --- finishedAt（決定 30） -------------------------------------------------------------------
  const finishedAt = run.finishedAt;
  if (finishedAt === null) {
    errors.push("run.finishedAt が null です（elapsedMs を作れません）");
  }

  // --- status / stop（決定 27・30） -----------------------------------------------------------
  const status: EvaluationResultInput["status"] = run.status === "stopped" ? "stopped" : run.status;
  let stop: EvaluationResultInput["stop"] = null;
  if (run.status === "stopped") {
    const { stopReason, stopMessage, generationUnconfirmed } = run;
    if (stopReason === null) {
      errors.push("run.status が stopped なのに run.stopReason が null です");
    }
    if (stopMessage === null) {
      errors.push("run.status が stopped なのに run.stopMessage が null です");
    }
    if (stopReason !== null && stopMessage !== null) {
      const mapped = STOP_REASON_MAP[stopReason];
      if (mapped === null) {
        errors.push(
          `run.stopReason を評価入力の stop.reason に写せません（stopReason: ${stopReason}）`,
        );
      } else {
        stop = { reason: mapped, message: stopMessage, failure: null, generationUnconfirmed };
      }
    }
  } else if (run.stopReason !== null || run.stopMessage !== null || run.generationUnconfirmed) {
    errors.push(
      "run.status が completed/partially-failed なのに停止情報（stopReason/stopMessage/" +
        "generationUnconfirmed）が残っています",
    );
  }

  // --- targets / checkUnits / recheckUnits の対応表 -------------------------------------------
  const targets = exported.targets;
  const targetIndexByTargetId = new Map(targets.map((t) => [t.id, t.targetIndex] as const));
  const checkUnits = exported.checkUnits;
  const checkUnitById = new Map(checkUnits.map((u) => [u.id, u] as const));

  let checkUnitsDone = 0;
  let checkUnitsFailed = 0;
  let checkUnitsPending = 0;
  let requestsFromCheckUnits = 0;
  for (const unit of checkUnits) {
    requestsFromCheckUnits += unit.attempts;
    if (unit.status === "done") {
      checkUnitsDone += 1;
    } else if (unit.status === "failed") {
      checkUnitsFailed += 1;
    } else if (unit.status === "pending") {
      checkUnitsPending += 1;
    } else {
      errors.push(
        `検査単位の状態を評価入力に写せません（checkUnitId: ${unit.id}, status: ${unit.status}）`,
      );
    }
  }

  const recheckUnits = exported.recheckUnits;
  const recheckUnitsByFindingId = new Map<string, RecheckUnitDto[]>();
  let requestsFromRecheckUnits = 0;
  for (const unit of recheckUnits) {
    requestsFromRecheckUnits += unit.attempts;
    if (unit.status === "running") {
      errors.push(
        `再確認単位の状態を評価入力に写せません（recheckUnitId: ${unit.id}, status: running）`,
      );
    }
    const bucket = recheckUnitsByFindingId.get(unit.findingId);
    if (bucket !== undefined) {
      bucket.push(unit);
    } else {
      recheckUnitsByFindingId.set(unit.findingId, [unit]);
    }
  }
  const findingsById = new Map(exported.findings.map((f) => [f.id, f] as const));
  for (const [findingId, units] of recheckUnitsByFindingId) {
    const finding = findingsById.get(findingId);
    if (finding === undefined) {
      errors.push(`再確認単位が指す指摘が見つかりません（findingId: ${findingId}）`);
    } else if (finding.recheck === null) {
      // 逆方向（単位はあるが要約が null）。根拠は組み立て側（`server/api/run-export.ts`）に
      // ある：`recheckByFindingId`（190 行）は `recheckUnits`（=このエクスポートの
      // `recheckUnits[]` と同じ配列）から作られ、`toFindingDto` の `recheck` 引数
      // （202 行）にそのまま渡って要約になる。つまり要約と `recheckUnits[]` は同じ
      // `listRecheckUnits` の結果から作られており（223 行）、`recheckUnits[]` に
      // `findingId` の行がある指摘の要約が null になることは正常なエクスポートでは
      // 起こらない。したがって「参照先が見つからない」と同じ扱いにする（決定 30・32）。
      errors.push(
        `再確認単位があるのに、対応する指摘の再確認要約（recheck）が null です（findingId: ${findingId}）`,
      );
    }
    if (units.length > 1) {
      errors.push(`同じ指摘を指す再確認単位が複数あります（findingId: ${findingId}）`);
    }
  }

  // 決定 32：同じ DB 行の 2 つの控え（要約 `findings[].recheck` と全項目 `recheckUnits[]`）が
  // 食い違っていないかを検査する。アダプター自身は後者だけを読むので、ここで検査しないと
  // 画面表示（要約）と評価結果（単位）が黙って食い違う。
  for (const finding of exported.findings) {
    if (finding.recheck === null) {
      continue;
    }
    const recheckUnit = recheckUnitsByFindingId.get(finding.id)?.[0];
    if (recheckUnit === undefined) {
      errors.push(
        `指摘の再確認要約（recheck）が非 null なのに、対応する再確認単位がありません（findingId: ${finding.id}）`,
      );
      continue;
    }
    const mismatches = findRecheckSummaryMismatches(finding.recheck, recheckUnit);
    if (mismatches.length > 0) {
      errors.push(
        `指摘の再確認要約と再確認単位が食い違います` +
          `（findingId: ${finding.id}, 項目: ${mismatches.join("・")}）`,
      );
    }
  }

  // --- 候補・診断の対応表（決定 30 の関連条件。zod では書けない） -------------------------------
  const candidatesById = new Map<string, CandidateDto>();
  const registerCandidate = (candidate: CandidateDto): void => {
    if (candidatesById.has(candidate.id)) {
      errors.push(`同じ候補 ID が複数の場所にあります（candidateId: ${candidate.id}）`);
      return;
    }
    candidatesById.set(candidate.id, candidate);
  };
  for (const finding of exported.findings) {
    for (const candidate of finding.candidates) {
      registerCandidate(candidate);
    }
  }
  for (const candidate of exported.unlocatedCandidates) {
    registerCandidate(candidate);
  }

  // 指摘に紐づく候補が指す検査単位も、`unlocatedCandidates` 側（下の outside-target のループ）と
  // 同じく参照整合を検査する（決定 30「候補・指摘・検査単位の参照先が見つからない」）。
  // 併せて `candidate.perspective` が参照先の検査単位の `perspective` と一致するかも検査する
  // （PR8 決定 19：`perspective` は候補の行ではなく `check_units` から導いた値）。
  for (const finding of exported.findings) {
    for (const candidate of finding.candidates) {
      const checkUnit = checkUnitById.get(candidate.checkUnitId);
      if (checkUnit === undefined) {
        errors.push(`候補が指す検査単位が見つかりません（candidateId: ${candidate.id}）`);
        continue;
      }
      if (candidate.perspective !== checkUnit.perspective) {
        errors.push(
          `候補の観点が検査単位の観点と食い違います` +
            `（candidateId: ${candidate.id}, 候補: ${candidate.perspective}, ` +
            `検査単位: ${checkUnit.perspective}）`,
        );
      }
    }
  }

  const diagnosticsByCandidateId = new Map<string, DiagnosticDto[]>();
  const addDiagnostic = (diagnostic: DiagnosticDto): void => {
    const bucket = diagnosticsByCandidateId.get(diagnostic.candidateId);
    if (bucket !== undefined) {
      bucket.push(diagnostic);
    } else {
      diagnosticsByCandidateId.set(diagnostic.candidateId, [diagnostic]);
    }
  };
  for (const finding of exported.findings) {
    for (const diagnostic of finding.diagnostics) {
      addDiagnostic(diagnostic);
    }
  }
  for (const diagnostic of exported.unlocatedDiagnostics) {
    addDiagnostic(diagnostic);
  }
  for (const [candidateId, diagnostics] of diagnosticsByCandidateId) {
    if (!candidatesById.has(candidateId)) {
      errors.push(`どの候補にも紐づかない診断があります（candidateId: ${candidateId}）`);
    }
    if (diagnostics.length > 1) {
      errors.push(`同じ候補を指す診断が複数あります（candidateId: ${candidateId}）`);
    }
  }

  // --- findings / unlocated（決定 27） ---------------------------------------------------------
  const evaluationFindings: FindingInput[] = [];
  const unlocatedFromFindings: UnlocatedInput[] = [];

  for (const finding of exported.findings) {
    const targetIndex = targetIndexByTargetId.get(finding.targetId);
    if (targetIndex === undefined) {
      errors.push(`指摘が指す検査対象が見つかりません（findingId: ${finding.id}）`);
      continue;
    }

    if (finding.locateStatus === "located") {
      if (finding.range === null) {
        errors.push(`位置確定済みの指摘の range が null です（findingId: ${finding.id}）`);
        continue;
      }
      if (finding.candidates.length === 0) {
        errors.push(`位置確定済みの指摘に候補がありません（findingId: ${finding.id}）`);
        continue;
      }
      if (finding.candidates.some((c) => c.locateStatus !== "located")) {
        errors.push(
          `位置確定済みの指摘に located でない候補が含まれています（findingId: ${finding.id}）`,
        );
        continue;
      }

      const recheckUnit = recheckUnitsByFindingId.get(finding.id)?.[0];
      const recheck = buildRecheckInput({
        recheckEnabled: run.recheckEnabled,
        suppression: finding.suppression,
        recheckUnit,
        findingId: finding.id,
        errors,
      });
      if (recheck === undefined) {
        continue;
      }

      evaluationFindings.push({
        targetIndex,
        finding: {
          id: finding.id,
          range: finding.range,
          quote: finding.quote,
          category: finding.category,
          suggestion: finding.suggestion,
          verdict: finding.initialVerdict,
          sources: finding.candidates.map((c) => ({
            id: c.id,
            perspective: c.perspective,
            llm: c.llm,
          })),
        },
        suppression: finding.suppression,
        recheck,
      });
      continue;
    }

    // not-found / ambiguous：1 候補 1 指摘で保存される（決定 23 の表）。
    if (finding.candidates.length !== 1) {
      errors.push(
        `位置特定失敗の指摘の候補数が 1 件ではありません` +
          `（findingId: ${finding.id}, 件数: ${String(finding.candidates.length)}）`,
      );
      continue;
    }
    const candidate = finding.candidates[0];
    if (candidate === undefined) {
      continue;
    }
    if (candidate.locateStatus !== finding.locateStatus) {
      errors.push(`指摘と候補の locateStatus が食い違います（findingId: ${finding.id}）`);
      continue;
    }
    const diagnosticResult = lookupDiagnosticInput(candidate.id, diagnosticsByCandidateId, errors);
    if (!diagnosticResult.ok) {
      continue;
    }
    unlocatedFromFindings.push({
      targetIndex,
      candidate: {
        id: candidate.id,
        perspective: candidate.perspective,
        llm: candidate.llm,
        // 直前の比較で candidate.locateStatus === finding.locateStatus が確認済み。
        // finding.locateStatus はここでは "not-found" | "ambiguous"（located 分岐は上で処理済み）。
        locate: { reason: finding.locateStatus, diagnostic: diagnosticResult.value },
      },
    });
  }

  // outside-target：unlocatedCandidates[]（決定 23・27）。
  const unlocatedFromCandidates: UnlocatedInput[] = [];
  for (const candidate of exported.unlocatedCandidates) {
    const checkUnit = checkUnitById.get(candidate.checkUnitId);
    if (checkUnit === undefined) {
      errors.push(`候補が指す検査単位が見つかりません（candidateId: ${candidate.id}）`);
      continue;
    }
    // `unlocatedCandidates` に入るのは `finding_id` が null の候補＝`outside-target` だけ
    // （決定 23）。`not-found` / `ambiguous` が混ざると、指摘側（findings[].candidates）と
    // 二重に数えたうえ、位置特定失敗の内訳（決定 8）が変わる（決定 30）。
    if (candidate.locateStatus !== "outside-target") {
      errors.push(
        `位置未確定の候補の一覧に outside-target でない候補が含まれています` +
          `（candidateId: ${candidate.id}, locateStatus: ${candidate.locateStatus}）`,
      );
      continue;
    }
    if (candidate.perspective !== checkUnit.perspective) {
      errors.push(
        `候補の観点が検査単位の観点と食い違います` +
          `（candidateId: ${candidate.id}, 候補: ${candidate.perspective}, ` +
          `検査単位: ${checkUnit.perspective}）`,
      );
      continue;
    }
    const diagnosticResult = lookupDiagnosticInput(candidate.id, diagnosticsByCandidateId, errors);
    if (!diagnosticResult.ok) {
      continue;
    }
    unlocatedFromCandidates.push({
      targetIndex: checkUnit.targetIndex,
      candidate: {
        id: candidate.id,
        perspective: candidate.perspective,
        llm: candidate.llm,
        locate: { reason: candidate.locateStatus, diagnostic: diagnosticResult.value },
      },
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // ここに到達するのは errors が空のときだけであり、finishedAt が null なら必ず上で
  // errors に積んでいる（決定 30）ので、この分岐には到達しないはずである。値の型アサーション
  // （`as string`）に頼らず、型を絞り込む形の防御にする。
  if (finishedAt === null) {
    return { ok: false, errors: ["run.finishedAt が null です（elapsedMs を作れません）"] };
  }
  const finishedAtValue = finishedAt;

  // --- conditions（決定 27・28・31） ------------------------------------------------------------
  const conditions: EvaluationResultInput["conditions"] = {
    startedAt: run.startedAt,
    finishedAt: finishedAtValue,
    mode: run.recheckEnabled ? "split-recheck" : "split",
    perspectives: run.perspectives,
    generation: { model: run.modelId, ...run.generationSettings },
    model: run.modelInfo,
    chunkSettings: run.chunkSettings,
    // 決定 31：recoveryConfirmMs を含む実効上限にする。
    timeouts: {
      checkMs: run.timeouts.checkMs + run.recoveryConfirmMs,
      recheckMs: run.timeouts.recheckMs + run.recoveryConfirmMs,
    },
    allowedWords: run.allowedWords,
    versions: {
      // 決定 28：CLI 経由の結果 JSON（RESULT_VERSION）と混ざらないようにする。
      result: "export/1",
      prompt: run.promptVersion,
      allowedWordRule: run.allowedWordRuleVersion,
      diagnosticTransform: run.diagnosticTransformVersion,
    },
    manuscript: {
      utf16Length: exported.manuscript.body.length,
      graphemeCount: countGraphemes(exported.manuscript.body),
      paragraphCount: splitParagraphs(exported.manuscript.body).length,
      targetCount: targets.length,
      bodyHash: exported.manuscript.bodyHash,
    },
  };

  // 決定 27 の順序（1. not-found/ambiguous の指摘 → 2. unlocatedCandidates）で固定する。
  const unlocated: readonly UnlocatedInput[] = [
    ...unlocatedFromFindings,
    ...unlocatedFromCandidates,
  ];

  // --- totals（`run/pipeline.ts` の作り方に合わせる。決定 27・32） ------------------------------
  const locatedFindings = exported.findings.filter((f) => f.locateStatus === "located");

  const totals: EvaluationResultInput["totals"] = {
    targets: targets.length,
    checkUnits: { done: checkUnitsDone, failed: checkUnitsFailed, pending: checkUnitsPending },
    // 決定 32：再確認側の要求送信回数は recheckUnits[].attempts（エクスポート直下）から数える。
    requests: requestsFromCheckUnits + requestsFromRecheckUnits,
    candidates:
      exported.findings.reduce((sum, f) => sum + f.candidates.length, 0) +
      exported.unlocatedCandidates.length,
    located: locatedFindings.reduce((sum, f) => sum + f.candidates.length, 0),
    // `unlocatedCandidates` は「outside-target だけ」のはずだが（決定 23）、その前提を数え方の
    // 正本にはしない。組み上がった `unlocated[]` の `locate.reason` から数えることで、一覧
    // （`unlocated[]`）と件数（`totals.unlocated.*`）が構造的に食い違わないようにする
    // （`run/pipeline.ts` も `unlocated[]` 自体から数えている）。
    unlocated: {
      notFound: unlocated.filter((u) => u.candidate.locate.reason === "not-found").length,
      ambiguous: unlocated.filter((u) => u.candidate.locate.reason === "ambiguous").length,
      outsideTarget: unlocated.filter((u) => u.candidate.locate.reason === "outside-target").length,
    },
    findings: locatedFindings.length,
    suppressed: locatedFindings.filter((f) => f.suppression !== null).length,
    rechecks: {
      done: evaluationFindings.filter((f) => f.recheck.status === "done").length,
      failed: evaluationFindings.filter((f) => f.recheck.status === "failed").length,
      pending: evaluationFindings.filter((f) => f.recheck.status === "pending").length,
      suppressed: evaluationFindings.filter((f) => f.recheck.status === "suppressed").length,
      disabled: evaluationFindings.filter((f) => f.recheck.status === "disabled").length,
    },
    elapsedMs: Date.parse(finishedAtValue) - Date.parse(run.startedAt),
  };

  return {
    ok: true,
    value: {
      status,
      stop,
      conditions,
      findings: evaluationFindings,
      unlocated,
      totals,
    },
  };
}
