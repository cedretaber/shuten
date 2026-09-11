import { readFile, stat, writeFile } from "node:fs/promises";
import { parseLmStudioApiKey, parseLmStudioUrl } from "@shuten/server/config.ts";
import { hashBody } from "@shuten/server/hash.ts";
import { createLmStudioClient } from "@shuten/server/lmstudio/client.ts";
import type { LmStudioClient, LmStudioClientOptions } from "@shuten/server/lmstudio/types.ts";
import type { GenerationSettings } from "@shuten/server/prompts/types.ts";
import type { PipelineEvent } from "@shuten/server/run/events.ts";
import type { PipelineArgs } from "@shuten/server/run/pipeline.ts";
import { runPipeline as runPipelineImpl } from "@shuten/server/run/pipeline.ts";
import type { PipelineResult, PipelineRunStatus } from "@shuten/server/run/result.ts";
import { ingestUtf8Bytes } from "@shuten/shared";

import { parseAggregateArgs } from "./args/aggregate.ts";
import { parseEvaluateArgs } from "./args/evaluate.ts";
import { parseHashArgs } from "./args/hash.ts";
import { parseArgs } from "./args.ts";
import { aggregateRuns, checkRunConditions } from "./eval/aggregate.ts";
import { formatAggregateReport } from "./eval/aggregate-report.ts";
import { formatEvaluationReport } from "./eval/report.ts";
import type { EvaluationResultInput } from "./eval/result-schema.ts";
import { parseResultJson, validateFindingRanges } from "./eval/result-schema.ts";
import { scoreRun } from "./eval/score.ts";
import { resolveTruthEntries } from "./eval/truth.ts";
import type { FileIdentity, NamedPath } from "./io.ts";
import {
  checkOutputConflict,
  findPathConflict,
  readEvalResultText,
  readManuscriptText,
  readTruthFile,
  reportTruthResolveFailure,
  writeResultOrFixedError,
} from "./io.ts";

/**
 * server の既定値（`packages/server/src/config.ts` の `loadConfig`）と合わせる。
 * 未指定のときだけ使う。ここでは値をそのまま出力しないので露出の心配はない。
 */
const DEFAULT_LM_STUDIO_URL = "http://127.0.0.1:1234";

/** 同一ファイル判定に使う識別情報（`stat` の dev/ino）。`io.ts` の同名の型の再エクスポート。 */
export type { FileIdentity };

/**
 * main の外界依存をすべてここにまとめる。テストでは `runPipeline` などをモックに差し替え、
 * 実際の LM Studio や実ファイルシステムに触れずに検証する。`hash` サブコマンドも原稿読み込み・
 * 結果書き出しは同じ入出力経路（`readManuscriptBytes` / `writeResult`）を使う。
 * `evaluate` は正解ファイル・結果 JSON の読み込みに `readTruthBytes` / `readResultBytes` を、
 * 指標 JSON・レポートの書き出しに既存の `writeResult` をそのまま使う。
 */
export interface MainIO {
  readonly readManuscriptBytes: (path: string) => Promise<Uint8Array>;
  readonly readAllowedWordsBytes: (path: string) => Promise<Uint8Array>;
  readonly readTruthBytes: (path: string) => Promise<Uint8Array>;
  readonly readResultBytes: (path: string) => Promise<Uint8Array>;
  /** ファイルの識別情報。存在しない・取得できないときは null（比較を諦める）。 */
  readonly statFile: (path: string) => Promise<FileIdentity | null>;
  readonly writeResult: (outPath: string | null, json: string) => Promise<void>;
  readonly writeProgressLine: (line: string) => void;
  readonly writeErrorLine: (line: string) => void;
  readonly createClient: (options: LmStudioClientOptions) => LmStudioClient;
  readonly runPipeline: (args: PipelineArgs) => Promise<PipelineResult>;
}

function defaultIO(): MainIO {
  return {
    readManuscriptBytes: (path) => readFile(path),
    readAllowedWordsBytes: (path) => readFile(path),
    readTruthBytes: (path) => readFile(path),
    readResultBytes: (path) => readFile(path),
    // シンボリックリンクを追う stat を使う（リンク先が入力ファイルなら同一と判定したいため）。
    statFile: (path) =>
      stat(path).then(
        (stats) => ({ dev: stats.dev, ino: stats.ino }),
        () => null,
      ),
    writeResult: async (outPath, json) => {
      if (outPath === null) {
        process.stdout.write(`${json}\n`);
        return;
      }
      await writeFile(outPath, json, "utf8");
    },
    writeProgressLine: (line) => {
      process.stderr.write(`${line}\n`);
    },
    writeErrorLine: (line) => {
      process.stderr.write(`${line}\n`);
    },
    createClient: createLmStudioClient,
    runPipeline: runPipelineImpl,
  };
}

/**
 * `--out` が入力ファイルと同じ実体を指していないか調べる（決定 21）。衝突していればその
 * 入力側の引数名を返す。`io.ts` の `findPathConflict`（`--out` 対 全入力の一般化版）の薄い
 * ラッパーで、`run` の呼び出し形（結果は「`--out` と衝突した入力の引数名」の 1 つだけ）を保つ。
 *
 * 実原稿を結果 JSON で上書きする事故を防ぐための検査。パス文字列の正規化比較（`./x.txt` と
 * `x.txt` を同一と見る）に加えて、出力先が既存ファイルのときは `stat` の dev/ino も比べ、
 * シンボリックリンクとハードリンク経由の別名も捕まえる。
 */
async function findOutPathConflict(
  io: MainIO,
  outPath: string,
  manuscriptPath: string,
  allowedWordsPath: string | null,
): Promise<string | null> {
  const paths: NamedPath[] = [
    { name: "--out", path: outPath },
    { name: "--manuscript", path: manuscriptPath },
    ...(allowedWordsPath === null ? [] : [{ name: "--allowed-words", path: allowedWordsPath }]),
  ];
  const conflict = await findPathConflict(io, paths);
  if (conflict === null) {
    return null;
  }
  // `run` が関心を持つのは「--out が入力のどれかと衝突しているか」だけ。入力どうし
  // （--manuscript と --allowed-words）が同じ実体を指す組み合わせは、この関数の対象外
  // （決定 21 が `run` に課しているのは出力対入力の検査だけで、従来の挙動もそうだった）。
  if (conflict[0] === "--out") return conflict[1];
  if (conflict[1] === "--out") return conflict[0];
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitCodeForStatus(status: PipelineRunStatus): number {
  switch (status) {
    case "completed":
      return 0;
    case "partially-failed":
      return 2;
    case "stopped":
      return 3;
  }
}

/**
 * 進捗イベントを 1 行にする。原稿本文・引用・LLM の理由文は含めない（件数と状態だけ）。
 */
function formatEvent(event: PipelineEvent): string {
  switch (event.type) {
    case "run-started":
      return `run-started targets=${String(event.targetCount)} units=${String(event.unitCount)}`;
    case "check-started":
      return `check-started target=${String(event.targetIndex)} perspective=${event.perspective}`;
    case "check-finished":
      return `check-finished target=${String(event.result.targetIndex)} perspective=${event.result.perspective} status=${event.result.status}`;
    case "target-merged":
      return `target-merged target=${String(event.targetIndex)} findings=${String(event.findingCount)}`;
    case "recheck-started":
      return `recheck-started finding=${event.findingId}`;
    case "recheck-finished":
      return `recheck-finished finding=${event.findingId} status=${event.result.status}`;
    case "run-finished":
      // generationUnconfirmed が真なら、LM Studio 側で生成が走り続けている可能性がある。
      // 確認せずにすぐ再実行すると仕様 8.2 が禁じる「生成終了を確認しないままの後続送信」を
      // 人手で起こすため、試運転をする人が見る標準エラーに必ず出す。
      return `run-finished status=${event.status}${
        event.stop === null
          ? ""
          : ` stopReason=${event.stop.reason} generationUnconfirmed=${String(event.stop.generationUnconfirmed)}`
      }`;
  }
}

/**
 * `run` サブコマンドの本体。引数解釈・原稿読み込み・パイプライン実行・結果出力をつなぐだけで、
 * パイプラインの処理そのものは `@shuten/server` の `runPipeline` に委ねる。
 *
 * 戻り値は終了コード（決定 12）：0 = completed、2 = partially-failed、3 = stopped、1 = 引数・入出力の誤り。
 */
async function runRun(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: MainIO,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.writeErrorLine(`引数エラー: ${parsed.error}`);
    return 1;
  }
  const args = parsed.value;

  // 生成要求を送る前に（クライアントを作る前に）確かめる。原稿を結果 JSON で潰さないため。
  // エラーメッセージにパス文字列は含めない（利用者名を含むパスが標準エラーに出るのを避ける）。
  if (args.outPath !== null) {
    const conflict = await findOutPathConflict(
      io,
      args.outPath,
      args.manuscriptPath,
      args.allowedWordsPath,
    );
    if (conflict !== null) {
      io.writeErrorLine(`引数エラー: --out が ${conflict} と同じファイルを指しています`);
      return 1;
    }
  }

  // 接続先 URL は解析に失敗しても生の値を出さない（不正な env の値に接続情報が写り込みうるため）。
  let lmStudioUrl: string;
  try {
    lmStudioUrl = parseLmStudioUrl(env.SHUTEN_LM_STUDIO_URL ?? DEFAULT_LM_STUDIO_URL);
  } catch {
    io.writeErrorLine(
      "環境変数 SHUTEN_LM_STUDIO_URL が不正です（値は表示しません。http(s) のルート URL を指定してください）",
    );
    return 1;
  }
  const apiKey = parseLmStudioApiKey(env.SHUTEN_LM_STUDIO_API_KEY);

  const manuscriptText = await readManuscriptText(io, args.manuscriptPath);
  if (!manuscriptText.ok) {
    io.writeErrorLine(manuscriptText.error);
    return 1;
  }
  const text = manuscriptText.value;

  let allowedWordsRaw = "";
  if (args.allowedWordsPath !== null) {
    let allowedWordsBytes: Uint8Array;
    try {
      allowedWordsBytes = await io.readAllowedWordsBytes(args.allowedWordsPath);
    } catch {
      io.writeErrorLine("許容語ファイルを読み込めません");
      return 1;
    }
    try {
      // 分割・trim はしない。中身をそのまま allowedWordsRaw に渡す（パイプライン側で分割する）。
      allowedWordsRaw = ingestUtf8Bytes(allowedWordsBytes);
    } catch (error) {
      io.writeErrorLine(`許容語ファイルを UTF-8 として読み込めません: ${messageOf(error)}`);
      return 1;
    }
  }

  const client = io.createClient({ baseUrl: lmStudioUrl, apiKey });

  const generation: GenerationSettings = {
    model: args.model,
    maxTokens: args.maxTokens,
    temperature: args.temperature,
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    reasoningEffort: args.reasoningEffort,
  };

  let result: PipelineResult;
  try {
    result = await io.runPipeline({
      text,
      mode: args.mode,
      perspectives: args.perspectives,
      allowedWordsRaw,
      generation,
      chunkSettings: args.chunkSettings,
      timeouts: { checkMs: args.checkTimeoutMs, recheckMs: args.recheckTimeoutMs },
      client,
      onEvent: (event) => io.writeProgressLine(formatEvent(event)),
    });
  } catch {
    // runPipeline は接続・タイムアウト等を RunStop として結果に包むので、ここに来るのは
    // 想定外の例外だけ。原因（cause の連鎖など）に接続先や資格情報の断片が写り込みうるため、
    // メッセージは出さず固定文言だけを出す。
    io.writeErrorLine("パイプラインの実行中に想定外のエラーが発生した");
    return 1;
  }

  const json = JSON.stringify(result, null, 2);
  const written = await writeResultOrFixedError(io, args.outPath, json);
  if (!written.ok) {
    io.writeErrorLine(written.error);
    return 1;
  }

  return exitCodeForStatus(result.status);
}

/**
 * `hash` サブコマンドの本体（決定 3・9）。原稿を読み込んで `hashBody` の結果を標準出力に
 * 1 行だけ書く。LM Studio には接続しない。
 */
async function runHash(argv: readonly string[], io: MainIO): Promise<number> {
  const parsed = parseHashArgs(argv);
  if (!parsed.ok) {
    io.writeErrorLine(`引数エラー: ${parsed.error}`);
    return 1;
  }
  const args = parsed.value;

  const manuscriptText = await readManuscriptText(io, args.manuscriptPath);
  if (!manuscriptText.ok) {
    io.writeErrorLine(manuscriptText.error);
    return 1;
  }

  const hash = hashBody(manuscriptText.value);
  // outPath は常に null（標準出力への 1 行だけ）。末尾の改行のみで、ほかには何も出さない。
  const written = await writeResultOrFixedError(io, null, hash);
  if (!written.ok) {
    io.writeErrorLine(written.error);
    return 1;
  }

  return 0;
}

/**
 * `evaluate` サブコマンドの本体（決定 3・4・9・10・13・18・21）。
 *
 * 処理の順序（Task 6 ブリーフの指定どおり）：
 * 1. 引数の解釈
 * 2. 出力先の衝突検査（決定 21。生成要求も読み込みもする前に）
 * 3. 原稿を読む
 * 4. 正解ファイルを読む → JSON.parse → `parseTruthFile`
 * 5. 結果 JSON を読む → JSON.parse → `parseResultJson`
 * 6. 3 方向のハッシュ照合（決定 3）
 * 7. `validateFindingRanges`（決定 18 の意味の検証）
 * 8. `resolveTruthEntries`（決定 4）
 * 9. `scoreRun`
 * 10. 出力（指標 JSON と、`--report` があれば Markdown。両方の文字列を組み立ててから書き出す。
 *     M-2 修正：--report の組み立てを --out の書き出しより後にすると、その間に失敗したとき
 *     部分的な状態が残る）
 *
 * どの段でも、失敗したら集計せずに終了コード 1 で終わる。指標の良し悪しでは終了コードを変えない
 * （決定 14）。
 */
async function runEvaluate(argv: readonly string[], io: MainIO): Promise<number> {
  const parsed = parseEvaluateArgs(argv);
  if (!parsed.ok) {
    io.writeErrorLine(`引数エラー: ${parsed.error}`);
    return 1;
  }
  const args = parsed.value;

  // 2. 出力先の衝突検査（決定 21）。--out/--report 対 全入力、--out と --report どうしだけを見る。
  //    入力どうし（--manuscript と --truth が同じ実体、など）は決定 21 が挙げている組ではない。
  //    ここでは何も言わず、後続の読み込み・検証がより的確な原因（JSON として読めない、
  //    ハッシュが食い違う等）を報告する（`checkOutputConflict` の絞り込み。`io.ts`）。
  const conflictCheck = await checkOutputConflict(io, args.outPath, args.reportPath, [
    { name: "--manuscript", path: args.manuscriptPath },
    { name: "--truth", path: args.truthPath },
    { name: "--result", path: args.resultPath },
  ]);
  if (conflictCheck.handled) {
    return 1;
  }

  // 3. 原稿を読む。
  const manuscriptText = await readManuscriptText(io, args.manuscriptPath);
  if (!manuscriptText.ok) {
    io.writeErrorLine(manuscriptText.error);
    return 1;
  }
  const text = manuscriptText.value;

  // 4. 正解ファイルを読む → JSON.parse → parseTruthFile（`readTruthFile`。`io.ts`）。
  const truthResult = await readTruthFile(io, args.truthPath);
  if (!truthResult.ok) {
    io.writeErrorLine(truthResult.error);
    return 1;
  }
  const truth = truthResult.value;

  // 5. 結果 JSON を読む → JSON.parse → parseResultJson。
  const resultText = await readEvalResultText(io, args.resultPath);
  if (!resultText.ok) {
    io.writeErrorLine(resultText.error);
    return 1;
  }
  let resultJson: unknown;
  try {
    resultJson = JSON.parse(resultText.value);
  } catch {
    io.writeErrorLine("結果ファイルの JSON 構文が不正です");
    return 1;
  }
  const parsedResult = parseResultJson(resultJson);
  if (!parsedResult.ok) {
    io.writeErrorLine(`結果ファイルの検証に失敗しました: ${parsedResult.errors.join("; ")}`);
    return 1;
  }
  const result = parsedResult.value;

  // 6. 3 方向のハッシュ照合（決定 3）。ハッシュ値そのものは原稿の内容ではないので出してよいが、
  //    パス文字列は出さない。
  const manuscriptHash = hashBody(text);
  const hashMismatches: string[] = [];
  if (manuscriptHash !== truth.manuscript.bodyHash) {
    hashMismatches.push(
      `原稿と正解ファイルの bodyHash が一致しません（原稿: ${manuscriptHash}、正解ファイル: ${truth.manuscript.bodyHash}）`,
    );
  }
  if (manuscriptHash !== result.conditions.manuscript.bodyHash) {
    hashMismatches.push(
      `原稿と結果 JSON の bodyHash が一致しません（原稿: ${manuscriptHash}、結果 JSON: ${result.conditions.manuscript.bodyHash}）`,
    );
  }
  if (hashMismatches.length > 0) {
    for (const message of hashMismatches) {
      io.writeErrorLine(message);
    }
    return 1;
  }

  // 7. validateFindingRanges（決定 18 の意味の検証）。
  const rangeCheck = validateFindingRanges(result, text);
  if (!rangeCheck.ok) {
    for (const message of rangeCheck.errors) {
      io.writeErrorLine(message);
    }
    return 1;
  }

  // 8. resolveTruthEntries（決定 4）。失敗は集計せず、--report があるときだけ詳細を書く
  //    （`reportTruthResolveFailure`。`io.ts`）。
  const resolved = resolveTruthEntries(truth, text);
  if (!resolved.ok) {
    await reportTruthResolveFailure(io, resolved.failures, text, args.reportPath);
    return 1;
  }

  // 9. scoreRun。
  const metrics = scoreRun(resolved.value, result);

  // 10. 出力。--out 未指定なら標準出力へ（run と同じ方針）。両方の文字列を先に組み立ててから
  //     書き出す（M-2 修正：--report の組み立てを --out の書き出しより後で行うと、その間に
  //     失敗したとき既に --out へ書き出し済みという部分的な状態になりうる）。
  const json = JSON.stringify(metrics, null, 2);
  const report =
    args.reportPath === null ? null : formatEvaluationReport({ metrics, truth, result });

  const written = await writeResultOrFixedError(io, args.outPath, json, "指標");
  if (!written.ok) {
    io.writeErrorLine(written.error);
    return 1;
  }

  if (args.reportPath !== null && report !== null) {
    const writtenReport = await writeResultOrFixedError(io, args.reportPath, report, "レポート");
    if (!writtenReport.ok) {
      io.writeErrorLine(writtenReport.error);
      return 1;
    }
  }

  // 決定 14：指標の良し悪しで終了コードを変えない。集計できたら常に 0。
  return 0;
}

/**
 * `aggregate` サブコマンドの本体（決定 3・4・9・10・12・13・18・21。Task 7 ブリーフ）。
 * `evaluate`（Task 6）と同じ部品を、`--result` の本数ぶん回して使う。
 *
 * 処理の順序（`evaluate` と同じ並び：ハッシュ照合を `validateFindingRanges` より先に行う。
 * コーディネーターの指摘により、最初の実装にあった逆順を修正した）：
 * 1. 引数の解釈
 * 2. 出力先の衝突検査（決定 21。`--result` どうしの重複は、他の入力の衝突に先を越されないよう
 *    別に検査する。M-3 修正）
 * 3. 原稿を読む
 * 4. 正解ファイルを読む
 * 5. 各結果 JSON を 1 本ずつ `parseResultJson`（形の検証だけ）
 * 6. 3 方向のハッシュ照合（結果は本数ぶん）。原稿の取り違えはここで「bodyHash が一致しません」
 *    という一言で分かる形にする（`validateFindingRanges` より後ろだと「quote が本文と一致しません」
 *    という分かりにくいエラーが先に出てしまう）
 * 7. 各結果に `validateFindingRanges`（決定 18 の意味の検証）
 * 8. 条件の一致検査（決定 12。`resolveTruthEntries`・`scoreRun` という重い処理の前に fail-fast する）
 * 9. `resolveTruthEntries`
 * 10. 各実行に `scoreRun`
 * 11. 集計（`aggregateRuns`。内部でも条件の一致検査を行うが、8 で既に確認済みなのでここでは
 *     必ず成功する。二重に検査するのは、`aggregateRuns` 単体でも条件不一致を拒否できることを
 *     保証する契約（Task 7 ブリーフが固定した型）を保ちながら、CLI 経路では無駄な計算を避けるため）
 * 12. 出力（集計 JSON と、`--report` があれば Markdown レポート。両方の文字列を組み立ててから
 *     書き出す。M-2 修正：--report の組み立てを --out の書き出しより後にすると、その間に失敗
 *     したとき部分的な状態が残る）
 *
 * どの段でも、失敗したら集計せずに終了コード 1 で終わる。部分的な数字は見せない。
 */
async function runAggregate(argv: readonly string[], io: MainIO): Promise<number> {
  const parsed = parseAggregateArgs(argv);
  if (!parsed.ok) {
    io.writeErrorLine(`引数エラー: ${parsed.error}`);
    return 1;
  }
  const args = parsed.value;

  // 2. 出力先の衝突検査（決定 21）。
  //    --out/--report 対 全入力・--out と --report どうし（evaluate と同じ組。`checkOutputConflict`。
  //    `io.ts`）に加えて、--result どうしの重複（決定 21 の追加分。aggregate 固有）を見る。
  //    --manuscript・--truth・--result が互いに衝突していてもここでは何も言わない
  //    （決定 21 が挙げている組ではない。evaluate と同じ絞り込み）。
  const conflictCheck = await checkOutputConflict(io, args.outPath, args.reportPath, [
    { name: "--manuscript", path: args.manuscriptPath },
    { name: "--truth", path: args.truthPath },
    ...args.resultPaths.map((path) => ({ name: "--result", path })),
  ]);
  if (conflictCheck.handled) {
    return 1;
  }
  // --result どうしの重複だけを、上とは別に単独で検査する（M-3 修正）。`findPathConflict` は
  // 最初に見つかった 1 組だけを返すため、上の検査に --manuscript・--truth・--result をまとめて
  // 渡すと、--manuscript と --truth の衝突（決定 21 の対象外なので握りつぶす）が先に見つかった
  // 場合、その後ろに並ぶ --result どうしの重複が一度も検査されない。「ぶれを偽装しない」という
  // 決定 21 の要である --result の重複検査を、他の入力の衝突の有無に左右されない形にする。
  const resultConflict = await findPathConflict(
    io,
    args.resultPaths.map((path) => ({ name: "--result", path })),
  );
  if (resultConflict !== null) {
    // 同じ実行を2回数えると分散が小さく出て、ぶれを偽装する（決定 21）。パスは出さない。
    io.writeErrorLine("引数エラー: --result に同じファイルが重複して指定されています");
    return 1;
  }

  // 3. 原稿を読む。
  const manuscriptText = await readManuscriptText(io, args.manuscriptPath);
  if (!manuscriptText.ok) {
    io.writeErrorLine(manuscriptText.error);
    return 1;
  }
  const text = manuscriptText.value;

  // 4. 正解ファイルを読む → JSON.parse → parseTruthFile（`readTruthFile`。`io.ts`）。
  const truthResult = await readTruthFile(io, args.truthPath);
  if (!truthResult.ok) {
    io.writeErrorLine(truthResult.error);
    return 1;
  }
  const truth = truthResult.value;

  // 5. 各結果 JSON を1本ずつ parseResultJson（形の検証だけ。意味の検証は7で行う）。
  const results: EvaluationResultInput[] = [];
  for (const [index, resultPath] of args.resultPaths.entries()) {
    const resultText = await readEvalResultText(io, resultPath);
    if (!resultText.ok) {
      io.writeErrorLine(resultText.error);
      return 1;
    }
    let resultJson: unknown;
    try {
      resultJson = JSON.parse(resultText.value);
    } catch {
      io.writeErrorLine(`結果 JSON ${String(index + 1)} 本目: JSON 構文が不正です`);
      return 1;
    }
    const parsedResult = parseResultJson(resultJson);
    if (!parsedResult.ok) {
      io.writeErrorLine(
        `結果 JSON ${String(index + 1)} 本目: 検証に失敗しました: ${parsedResult.errors.join("; ")}`,
      );
      return 1;
    }
    results.push(parsedResult.value);
  }

  // 6. 3方向のハッシュ照合（決定 3。結果は本数ぶん）。evaluate と同じく、意味の検証
  //    （validateFindingRanges）より先に行う。原稿の取り違えを「bodyHash が一致しません」という
  //    一言で分かる形にするため（後ろだと「quote が本文と一致しません」が先に出て分かりにくい）。
  const manuscriptHash = hashBody(text);
  const hashMismatches: string[] = [];
  if (manuscriptHash !== truth.manuscript.bodyHash) {
    hashMismatches.push(
      `原稿と正解ファイルの bodyHash が一致しません（原稿: ${manuscriptHash}、正解ファイル: ${truth.manuscript.bodyHash}）`,
    );
  }
  results.forEach((result, index) => {
    if (manuscriptHash !== result.conditions.manuscript.bodyHash) {
      hashMismatches.push(
        `原稿と結果 JSON ${String(index + 1)} 本目の bodyHash が一致しません（原稿: ${manuscriptHash}、結果 JSON: ${result.conditions.manuscript.bodyHash}）`,
      );
    }
  });
  if (hashMismatches.length > 0) {
    for (const message of hashMismatches) {
      io.writeErrorLine(message);
    }
    return 1;
  }

  // 7. 各結果に validateFindingRanges（決定 18 の意味の検証）。ハッシュが一致した後なので、
  //    ここに来る不一致は「同じ原稿だが範囲が壊れている」ことを意味する。
  for (const [index, result] of results.entries()) {
    const rangeCheck = validateFindingRanges(result, text);
    if (!rangeCheck.ok) {
      for (const message of rangeCheck.errors) {
        io.writeErrorLine(`結果 JSON ${String(index + 1)} 本目: ${message}`);
      }
      return 1;
    }
  }

  // 8. 条件の一致検査（決定 12）。resolveTruthEntries・scoreRun という重い処理をする前に、
  //    集計不能なら先に失敗させる。
  const conditionCheck = checkRunConditions(results);
  if (conditionCheck.errors.length > 0) {
    for (const message of conditionCheck.errors) {
      io.writeErrorLine(message);
    }
    return 1;
  }

  // 9. resolveTruthEntries（決定 4）。失敗は集計せず、--report があるときだけ詳細を書く
  //    （`reportTruthResolveFailure`。`io.ts`）。
  const resolved = resolveTruthEntries(truth, text);
  if (!resolved.ok) {
    await reportTruthResolveFailure(io, resolved.failures, text, args.reportPath);
    return 1;
  }

  // 10. 各実行に scoreRun（同じ resolveTruthEntries の結果を使う。全実行が同じ正解項目集合に対して
  //     採点されることを、正解項目ごとの k/N の分母が意味を持つための前提として保証する）。
  const metricsList = results.map((result) => scoreRun(resolved.value, result));

  // 11. 集計。
  const outcome = aggregateRuns(metricsList, results);
  if (!outcome.ok) {
    // 8 で条件は確認済みなので通常は起こらないが、防御的に扱う。
    for (const message of outcome.errors) {
      io.writeErrorLine(message);
    }
    return 1;
  }

  // 12. 出力。--out 未指定なら標準出力へ（evaluate と同じ方針）。両方の文字列を先に組み立てて
  //     から書き出す（M-2 修正。理由は runEvaluate と同じ）。
  const json = JSON.stringify(outcome.value, null, 2);
  const report = args.reportPath === null ? null : formatAggregateReport(outcome.value);

  const written = await writeResultOrFixedError(io, args.outPath, json, "集計");
  if (!written.ok) {
    io.writeErrorLine(written.error);
    return 1;
  }

  if (args.reportPath !== null && report !== null) {
    const writtenReport = await writeResultOrFixedError(io, args.reportPath, report, "レポート");
    if (!writtenReport.ok) {
      io.writeErrorLine(writtenReport.error);
      return 1;
    }
  }

  return 0;
}

type SubcommandDispatch =
  | { readonly subcommand: "run"; readonly rest: readonly string[] }
  | { readonly subcommand: "hash"; readonly rest: readonly string[] }
  | { readonly subcommand: "evaluate"; readonly rest: readonly string[] }
  | { readonly subcommand: "aggregate"; readonly rest: readonly string[] }
  | { readonly subcommand: "unknown" };

/**
 * 先頭トークンでサブコマンドを振り分ける（決定 9）。`--` 始まりと空の argv は `run` を補う。
 * サブコマンド名がハイフンで始まることはないので曖昧さがない。
 */
function dispatchSubcommand(argv: readonly string[]): SubcommandDispatch {
  const first = argv[0];
  if (first === undefined || first.startsWith("--")) {
    return { subcommand: "run", rest: argv };
  }
  if (first === "run") {
    return { subcommand: "run", rest: argv.slice(1) };
  }
  if (first === "hash") {
    return { subcommand: "hash", rest: argv.slice(1) };
  }
  if (first === "evaluate") {
    return { subcommand: "evaluate", rest: argv.slice(1) };
  }
  if (first === "aggregate") {
    return { subcommand: "aggregate", rest: argv.slice(1) };
  }
  return { subcommand: "unknown" };
}

/**
 * 評価用 CLI の入口。先頭トークンでサブコマンドへ振り分ける（決定 9）。
 * 既存の起動（`--manuscript ... --model ...`）は `run` にそのまま通る。
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: MainIO = defaultIO(),
): Promise<number> {
  const dispatch = dispatchSubcommand(argv);
  switch (dispatch.subcommand) {
    case "run":
      return runRun(dispatch.rest, env, io);
    case "hash":
      return runHash(dispatch.rest, io);
    case "evaluate":
      return runEvaluate(dispatch.rest, io);
    case "aggregate":
      return runAggregate(dispatch.rest, io);
    case "unknown":
      // 先頭トークンが `--` で始まらなければ何でもサブコマンド名扱いなので、打ち間違えた
      // パス（例：原稿ファイルのパス）がそのまま入りうる。固定文言のみを返す（決定 9。M-1 修正）。
      io.writeErrorLine(
        "引数エラー: 先頭の引数がサブコマンド名ではありません（run / hash / evaluate / aggregate）",
      );
      return 1;
  }
}
