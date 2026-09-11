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

import { parseEvaluateArgs } from "./args/evaluate.ts";
import { parseHashArgs } from "./args/hash.ts";
import { parseArgs } from "./args.ts";
import { formatEvaluationReport, formatTruthResolveFailureReport } from "./eval/report.ts";
import { parseResultJson, validateFindingRanges } from "./eval/result-schema.ts";
import { scoreRun } from "./eval/score.ts";
import { parseTruthFile, resolveTruthEntries } from "./eval/truth.ts";
import type { FileIdentity, NamedPath } from "./io.ts";
import {
  findPathConflict,
  readEvalResultText,
  readManuscriptText,
  readTruthText,
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
 * 10. 出力（指標 JSON と、`--report` があれば Markdown）
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
  //    `findPathConflict` は渡した配列の全組み合わせを見るため、入力を混ぜて渡したうえで
  //    「衝突の片方が --out か --report でなければ無視する」形に絞る（`run` の
  //    `findOutPathConflict` が --out だけに絞っているのと同じ形）。入力どうしが同じファイルを
  //    指す場合は、ここでは何も言わず、後続の読み込み・検証がより的確な原因（JSON として読めない、
  //    ハッシュが食い違う等）を報告する。
  const namedPaths: NamedPath[] = [
    ...(args.outPath === null ? [] : [{ name: "--out", path: args.outPath }]),
    ...(args.reportPath === null ? [] : [{ name: "--report", path: args.reportPath }]),
    { name: "--manuscript", path: args.manuscriptPath },
    { name: "--truth", path: args.truthPath },
    { name: "--result", path: args.resultPath },
  ];
  const rawConflict = await findPathConflict(io, namedPaths);
  // pair の並び順（`findPathConflict` は配列内で先に現れた方を [0] に置く）には依存しない。
  const isOutputName = (name: string): boolean => name === "--out" || name === "--report";
  const outputConflict =
    rawConflict !== null && (isOutputName(rawConflict[0]) || isOutputName(rawConflict[1]))
      ? rawConflict
      : null;
  if (outputConflict !== null) {
    io.writeErrorLine(
      `引数エラー: ${outputConflict[0]} と ${outputConflict[1]} が同じファイルを指しています`,
    );
    return 1;
  }

  // 3. 原稿を読む。
  const manuscriptText = await readManuscriptText(io, args.manuscriptPath);
  if (!manuscriptText.ok) {
    io.writeErrorLine(manuscriptText.error);
    return 1;
  }
  const text = manuscriptText.value;

  // 4. 正解ファイルを読む → JSON.parse → parseTruthFile。
  const truthText = await readTruthText(io, args.truthPath);
  if (!truthText.ok) {
    io.writeErrorLine(truthText.error);
    return 1;
  }
  let truthJson: unknown;
  try {
    truthJson = JSON.parse(truthText.value);
  } catch {
    // JSON.parse の例外メッセージは不正な断片を含みうるため連結しない（決定 9 と同じ姿勢）。
    io.writeErrorLine("正解ファイルの JSON 構文が不正です");
    return 1;
  }
  const parsedTruth = parseTruthFile(truthJson);
  if (!parsedTruth.ok) {
    io.writeErrorLine(`正解ファイルの検証に失敗しました: ${parsedTruth.errors.join("; ")}`);
    return 1;
  }
  const truth = parsedTruth.value;

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

  // 8. resolveTruthEntries（決定 4）。失敗は集計せず、--report があるときだけ詳細を書く。
  const resolved = resolveTruthEntries(truth, text);
  if (!resolved.ok) {
    for (const failure of resolved.failures) {
      io.writeErrorLine(failure.message);
    }
    if (args.reportPath !== null) {
      const failureReport = formatTruthResolveFailureReport({ failures: resolved.failures, text });
      const writtenReport = await writeResultOrFixedError(
        io,
        args.reportPath,
        failureReport,
        "レポート",
      );
      if (!writtenReport.ok) {
        io.writeErrorLine(writtenReport.error);
      }
    }
    return 1;
  }

  // 9. scoreRun。
  const metrics = scoreRun(resolved.value, result);

  // 10. 出力。--out 未指定なら標準出力へ（run と同じ方針）。
  const json = JSON.stringify(metrics, null, 2);
  const written = await writeResultOrFixedError(io, args.outPath, json, "指標");
  if (!written.ok) {
    io.writeErrorLine(written.error);
    return 1;
  }

  if (args.reportPath !== null) {
    const report = formatEvaluationReport({ metrics, truth, result });
    const writtenReport = await writeResultOrFixedError(io, args.reportPath, report, "レポート");
    if (!writtenReport.ok) {
      io.writeErrorLine(writtenReport.error);
      return 1;
    }
  }

  // 決定 14：指標の良し悪しで終了コードを変えない。集計できたら常に 0。
  return 0;
}

type SubcommandDispatch =
  | { readonly subcommand: "run"; readonly rest: readonly string[] }
  | { readonly subcommand: "hash"; readonly rest: readonly string[] }
  | { readonly subcommand: "evaluate"; readonly rest: readonly string[] }
  | { readonly subcommand: "unknown"; readonly name: string };

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
  return { subcommand: "unknown", name: first };
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
    case "unknown":
      io.writeErrorLine(`引数エラー: 未知のサブコマンドです: ${dispatch.name}`);
      return 1;
  }
}
