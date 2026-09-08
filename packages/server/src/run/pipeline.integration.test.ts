import { readFileSync } from "node:fs";
import path from "node:path";

import type { ChunkSettings, Perspective } from "@shuten/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { parseLmStudioUrl } from "../config.ts";
import { createLmStudioClient } from "../lmstudio/client.ts";
import { readIntegrationEnv, selectGenerationModelId } from "../lmstudio/integration-support.ts";
import type { LmStudioClient } from "../lmstudio/types.ts";
import type { GenerationSettings } from "../prompts/types.ts";
import { runPipeline } from "./pipeline.ts";
import type { PipelineResult } from "./result.ts";

/**
 * runPipeline を実 LM Studio に対して動かす統合テスト（計画 docs/plans/2026-09-08-pr7-pipeline.md の
 * I 表、I1〜I3）。`SHUTEN_LM_STUDIO_URL` が未設定ならファイルごと skip する。実行には `pnpm test:llm` を使う。
 *
 * 実 LLM の応答は毎回変わるため、`status === "completed"` は assert しない。1 単位でも失敗すれば
 * `partially-failed` になるので、ここでは「実行が最後まで進んだこと」（`status !== "stopped"`）だけを見る。
 */

/** 分割・再確認方式（決定 8 の対照ではない、split-recheck）の分割設定。実測で決める初期値の暫定値。 */
const CHUNK_SETTINGS_SPLIT: ChunkSettings = {
  targetGraphemes: 1500,
  contextGraphemes: 1000,
  recheckContextGraphemes: 3000,
  roundingTolerance: 0.2,
  maxInputGraphemes: 12000,
};

/**
 * full-text 方式（決定 8）の分割設定。`maxInputGraphemes` は本文全体（約 5,000 字）が
 * 上限を超えないよう、split 方式より大きい値にする（決定 8 の注意書きどおり）。
 */
const CHUNK_SETTINGS_FULL_TEXT: ChunkSettings = {
  ...CHUNK_SETTINGS_SPLIT,
  maxInputGraphemes: 20000,
};

/** 1 要求あたりのタイムアウト。決定記録 0003・計画の「実測で決める初期値」の暫定値（思考ありに合わせた長め）。 */
const REQUEST_TIMEOUT_MS = 300_000;

/**
 * テスト自体（vitest）のタイムアウト。`reasoningEffort: "none"` で動かすため実際の所要時間は
 * ずっと短いはずだが（決定記録 0003：思考なしなら 1 要求 10 秒前後）、1 要求が
 * REQUEST_TIMEOUT_MS（決定 5(a) によりタイムアウト自体が実行全体を止める）一杯まで詰まっても、
 * パイプラインが自分で結果（stopped を含む）を返し終える前に vitest 側が強制終了しないよう
 * 余裕を見ている。
 */
const TEST_TIMEOUT_MS = 20 * 60_000;

const MANUSCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../../test/fixtures/trial/long-manuscript.txt",
);

/** 検査に使う観点。実行時間を抑えるため 1 観点だけにする（既存の prompts.integration.test.ts と同じ方針）。 */
const PERSPECTIVES: readonly Perspective[] = ["typo"];

/**
 * I3 の追加観測用。段落マーカーらしき並び（`[P12]` など）と、render.ts が使う区切りタグ。
 * render.ts の実装は import せず、ここで独立に定義する（観測を実装の変更から独立させるため）。
 */
const PARAGRAPH_MARKER_PATTERN = /\[P\d+\]/;
const DELIMITER_TAGS = [
  "<manuscript>",
  "</manuscript>",
  "<context_before>",
  "</context_before>",
  "<target>",
  "</target>",
  "<context_after>",
  "</context_after>",
] as const;

/** quote・before・after への注記混入を判定する。 */
function containsInjectedMarker(value: string): boolean {
  if (PARAGRAPH_MARKER_PATTERN.test(value)) {
    return true;
  }
  return DELIMITER_TAGS.some((tag) => value.includes(tag));
}

const env = readIntegrationEnv();

describe.skipIf(!env.rawUrl)("パイプラインの実行（実 LM Studio）", () => {
  // describe.skipIf はテストを skip 扱いにするだけで、describe 本体は skip 時にも実行される。
  // そのため rawUrl の解析はここで先に済ませず、未設定・空白のみのときに例外が飛ばないようにする。
  const baseUrl = env.rawUrl ? parseLmStudioUrl(env.rawUrl) : "";

  let client: LmStudioClient;
  /** 生成テスト用のモデル ID。ロード済みかつ種別が生成に使えるモデルが無ければ null（該当テストは ctx.skip()）。 */
  let generationModelId: string | null;
  /** I3 が I1 の結果を使うための橋渡し。I1 が ctx.skip() したら null のまま（I3 も skip する）。 */
  let splitRecheckResult: PipelineResult | null = null;

  beforeAll(async () => {
    client = createLmStudioClient({ baseUrl, apiKey: env.apiKey });
    const models = await client.listModels();
    generationModelId = selectGenerationModelId(models, env.requestedModelId);
  });

  /** generationModelId が null でないことを呼び出し元が確認済みの前提で GenerationSettings を組む。 */
  function makeGeneration(): GenerationSettings {
    if (generationModelId === null) {
      throw new Error("generationModelId が null（呼び出し前に ctx.skip() すること）");
    }
    return {
      model: generationModelId,
      maxTokens: 16000,
      temperature: 0,
      reasoningEffort: "none",
    };
  }

  function readManuscript(): string {
    return readFileSync(MANUSCRIPT_PATH, "utf8");
  }

  it(
    "I1: 合成の長文で mode: split-recheck が通る（複数の検査対象・再確認を含む）",
    async (ctx) => {
      if (generationModelId === null) {
        ctx.skip();
        return;
      }
      const result = await runPipeline({
        text: readManuscript(),
        mode: "split-recheck",
        perspectives: PERSPECTIVES,
        allowedWordsRaw: "",
        generation: makeGeneration(),
        chunkSettings: CHUNK_SETTINGS_SPLIT,
        timeouts: { checkMs: REQUEST_TIMEOUT_MS, recheckMs: REQUEST_TIMEOUT_MS },
        client,
      });
      // ログと I3 への橋渡しは assert より先に行う。stopped で失敗しても、何が起きたかを残す。
      console.log(
        "I1: 実行結果",
        JSON.stringify({
          status: result.status,
          stop: result.stop,
          targets: result.totals.targets,
          checkUnits: result.totals.checkUnits,
          findings: result.totals.findings,
          rechecks: result.totals.rechecks,
          elapsedMs: result.totals.elapsedMs,
        }),
      );
      splitRecheckResult = result;
      // 実 LLM の応答は毎回変わるので completed は assert しない（1 単位でも失敗すれば partially-failed）。
      expect(result.status).not.toBe("stopped");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "I2: 合成の長文で mode: full-text が通る（本文全体を 1 検査対象として送る）",
    async (ctx) => {
      if (generationModelId === null) {
        ctx.skip();
        return;
      }
      const result = await runPipeline({
        text: readManuscript(),
        mode: "full-text",
        perspectives: PERSPECTIVES,
        allowedWordsRaw: "",
        generation: makeGeneration(),
        chunkSettings: CHUNK_SETTINGS_FULL_TEXT,
        timeouts: { checkMs: REQUEST_TIMEOUT_MS, recheckMs: REQUEST_TIMEOUT_MS },
        client,
      });
      console.log(
        "I2: 実行結果",
        JSON.stringify({
          status: result.status,
          stop: result.stop,
          targets: result.totals.targets,
          checkUnits: result.totals.checkUnits,
          findings: result.totals.findings,
          elapsedMs: result.totals.elapsedMs,
        }),
      );
      expect(result.status).not.toBe("stopped");
    },
    TEST_TIMEOUT_MS,
  );

  it("I3: I1 の結果から換算係数・locateQuote の内訳・注記混入を集計する（assert は usage の非 null だけ）", (ctx) => {
    if (splitRecheckResult === null) {
      ctx.skip();
      return;
    }
    const result = splitRecheckResult;

    // (1) 各要求の inputGraphemes と usage.promptTokens（と両者の比）。
    // 換算係数（書記素あたりのトークン数 = promptTokens / inputGraphemes）は done（応答をスキーマまで
    // 通せた要求）だけで集計する。failed は usage が null になりうる（応答を受け取る前の失敗など）ので、
    // ログには残すが usage の非 null は assert しない。
    const ratios: number[] = [];
    for (const unit of result.checkUnits) {
      if (unit.status === "pending") {
        continue;
      }
      if (unit.status === "done") {
        expect(unit.usage).not.toBeNull();
      }
      if (unit.usage !== null) {
        const ratio = unit.usage.promptTokens / unit.inputGraphemes;
        if (unit.status === "done") {
          ratios.push(ratio);
        }
        console.log(
          `I3: 検査要求(${unit.status}) target=${String(unit.targetIndex)} perspective=${unit.perspective} ` +
            `inputGraphemes=${String(unit.inputGraphemes)} promptTokens=${String(unit.usage.promptTokens)} ` +
            `tokensPerGrapheme=${ratio.toFixed(3)}`,
        );
      }
    }
    for (const findingResult of result.findings) {
      const recheck = findingResult.recheck;
      if (recheck.status !== "done" && recheck.status !== "failed") {
        continue;
      }
      if (recheck.status === "done") {
        expect(recheck.usage).not.toBeNull();
      }
      if (recheck.usage !== null && recheck.status === "done") {
        const ratio = recheck.usage.promptTokens / recheck.inputGraphemes;
        ratios.push(ratio);
        console.log(
          `I3: 再確認要求(done) finding=${findingResult.finding.id} ` +
            `inputGraphemes=${String(recheck.inputGraphemes)} promptTokens=${String(recheck.usage.promptTokens)} ` +
            `tokensPerGrapheme=${ratio.toFixed(3)}`,
        );
      } else if (recheck.usage !== null) {
        console.log(
          `I3: 再確認要求(failed) finding=${findingResult.finding.id} promptTokens=${String(recheck.usage.promptTokens)}`,
        );
      }
    }
    if (ratios.length > 0) {
      const avg = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
      // promptTokens には system プロンプトや区切りタグの分も乗るため、この値は
      // 「本文だけを送った場合」の換算係数の上限として読む（試運転の記録に書く）。
      console.log(
        `I3: 書記素あたりのトークン数（promptTokens / inputGraphemes、done のみ）の平均 ${avg.toFixed(3)}`,
      );
    }

    // (2) locateQuote の内訳。パイプラインが実際に行った位置確定の結果を totals から読む
    // （locateQuote を呼び直すと入力の対応関係を別途組み直す必要があり、実行結果と食い違う恐れがある）。
    console.log("I3: locateQuote の結果件数", {
      located: result.totals.located,
      "not-found": result.totals.unlocated.notFound,
      ambiguous: result.totals.unlocated.ambiguous,
      "outside-target": result.totals.unlocated.outsideTarget,
    });

    // 検査対象の終端をまたぐ引用の件数。located の range.end が、その候補を生んだ検査対象の
    // range.end を超えているものを数える（locateQuote は初回検査の CheckInput で行われるため、
    // 引用が検査対象の後続文脈（context_after）へはみ出した場合に起こりうる）。
    const targetEndByIndex = new Map<number, number>(
      result.targets.map((plan) => [plan.target.index, plan.target.range.end]),
    );
    let crossingTargetEnd = 0;
    for (const findingResult of result.findings) {
      const targetEnd = targetEndByIndex.get(findingResult.targetIndex);
      for (const source of findingResult.finding.sources) {
        if (targetEnd !== undefined && source.locate.range.end > targetEnd) {
          crossingTargetEnd += 1;
        }
      }
    }
    console.log("I3: 検査対象の終端をまたぐ引用の件数", crossingTargetEnd);

    // (3) quote・before・after への段落マーカー・区切りタグの混入件数と、before/after が空文字だった件数。
    // located（result.findings の sources）と unlocated（result.unlocated）の両方を対象にする。
    const injectionCounts = { quote: 0, before: 0, after: 0 };
    const emptyCounts = { before: 0, after: 0 };
    let candidateCount = 0;
    const observe = (llm: { quote: string; before: string; after: string }): void => {
      candidateCount += 1;
      if (containsInjectedMarker(llm.quote)) {
        injectionCounts.quote += 1;
      }
      if (llm.before === "") {
        emptyCounts.before += 1;
      } else if (containsInjectedMarker(llm.before)) {
        injectionCounts.before += 1;
      }
      if (llm.after === "") {
        emptyCounts.after += 1;
      } else if (containsInjectedMarker(llm.after)) {
        injectionCounts.after += 1;
      }
    };
    for (const findingResult of result.findings) {
      for (const source of findingResult.finding.sources) {
        observe(source.llm);
      }
    }
    for (const entry of result.unlocated) {
      observe(entry.candidate.llm);
    }
    console.log(
      "I3: quote/before/after への注記混入件数",
      injectionCounts,
      "before/after が空文字だった件数",
      emptyCounts,
      "候補の総数",
      candidateCount,
    );
  });
});
