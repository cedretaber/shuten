import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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

import { parseHashArgs } from "./args/hash.ts";
import { parseArgs } from "./args.ts";

/**
 * server の既定値（`packages/server/src/config.ts` の `loadConfig`）と合わせる。
 * 未指定のときだけ使う。ここでは値をそのまま出力しないので露出の心配はない。
 */
const DEFAULT_LM_STUDIO_URL = "http://127.0.0.1:1234";

/** 同一ファイル判定に使う識別情報（`stat` の dev/ino）。 */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/**
 * main の外界依存をすべてここにまとめる。テストでは `runPipeline` などをモックに差し替え、
 * 実際の LM Studio や実ファイルシステムに触れずに検証する。`hash` サブコマンドも原稿読み込み・
 * 結果書き出しは同じ入出力経路（`readManuscriptBytes` / `writeResult`）を使う。
 */
export interface MainIO {
  readonly readManuscriptBytes: (path: string) => Promise<Uint8Array>;
  readonly readAllowedWordsBytes: (path: string) => Promise<Uint8Array>;
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
 * `--out` が入力ファイルと同じ実体を指していないか調べる。衝突していればその引数名を返す。
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
  const inputs: readonly (readonly [string, string])[] = [
    ["--manuscript", manuscriptPath],
    ...(allowedWordsPath === null ? [] : ([["--allowed-words", allowedWordsPath]] as const)),
  ];

  const resolvedOut = resolve(outPath);
  for (const [name, inputPath] of inputs) {
    if (resolve(inputPath) === resolvedOut) {
      return name;
    }
  }

  // 出力先が存在しない（これから作る）なら実体の比較はできないので、ここで終わる。
  const outIdentity = await io.statFile(outPath);
  if (outIdentity === null) {
    return null;
  }
  for (const [name, inputPath] of inputs) {
    const inputIdentity = await io.statFile(inputPath);
    if (
      inputIdentity !== null &&
      inputIdentity.dev === outIdentity.dev &&
      inputIdentity.ino === outIdentity.ino
    ) {
      return name;
    }
  }
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

  let manuscriptBytes: Uint8Array;
  try {
    manuscriptBytes = await io.readManuscriptBytes(args.manuscriptPath);
  } catch {
    // Node の fs の例外メッセージはパスを含むため、原因を連結せず固定文言だけを出す（決定 9）。
    io.writeErrorLine("原稿ファイルを読み込めません");
    return 1;
  }
  let text: string;
  try {
    text = ingestUtf8Bytes(manuscriptBytes);
  } catch (error) {
    io.writeErrorLine(`原稿ファイルを UTF-8 として読み込めません: ${messageOf(error)}`);
    return 1;
  }

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
  try {
    await io.writeResult(args.outPath, json);
  } catch {
    // fs の書き出し失敗のメッセージも書き込み先パスを含みうるため、固定文言だけを出す（決定 9）。
    io.writeErrorLine("結果の書き出しに失敗しました");
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

  let manuscriptBytes: Uint8Array;
  try {
    manuscriptBytes = await io.readManuscriptBytes(args.manuscriptPath);
  } catch {
    io.writeErrorLine("原稿ファイルを読み込めません");
    return 1;
  }
  let text: string;
  try {
    text = ingestUtf8Bytes(manuscriptBytes);
  } catch (error) {
    io.writeErrorLine(`原稿ファイルを UTF-8 として読み込めません: ${messageOf(error)}`);
    return 1;
  }

  const hash = hashBody(text);
  try {
    // outPath は常に null（標準出力への 1 行だけ）。末尾の改行のみで、ほかには何も出さない。
    await io.writeResult(null, hash);
  } catch {
    io.writeErrorLine("結果の書き出しに失敗しました");
    return 1;
  }

  return 0;
}

type SubcommandDispatch =
  | { readonly subcommand: "run"; readonly rest: readonly string[] }
  | { readonly subcommand: "hash"; readonly rest: readonly string[] }
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
    case "unknown":
      io.writeErrorLine(`引数エラー: 未知のサブコマンドです: ${dispatch.name}`);
      return 1;
  }
}
