import { readFile, writeFile } from "node:fs/promises";
import { parseLmStudioApiKey, parseLmStudioUrl } from "@shuten/server/config.ts";
import { createLmStudioClient } from "@shuten/server/lmstudio/client.ts";
import type { LmStudioClient, LmStudioClientOptions } from "@shuten/server/lmstudio/types.ts";
import type { GenerationSettings } from "@shuten/server/prompts/types.ts";
import type { PipelineEvent } from "@shuten/server/run/events.ts";
import type { PipelineArgs } from "@shuten/server/run/pipeline.ts";
import { runPipeline as runPipelineImpl } from "@shuten/server/run/pipeline.ts";
import type { PipelineResult, RunStatus } from "@shuten/server/run/result.ts";
import { ingestUtf8Bytes } from "@shuten/shared";

import { parseArgs } from "./args.ts";

/**
 * server の既定値（`packages/server/src/config.ts` の `loadConfig`）と合わせる。
 * 未指定のときだけ使う。ここでは値をそのまま出力しないので露出の心配はない。
 */
const DEFAULT_LM_STUDIO_URL = "http://127.0.0.1:1234";

/**
 * main の外界依存をすべてここにまとめる。テストでは `runPipeline` などをモックに差し替え、
 * 実際の LM Studio や実ファイルシステムに触れずに検証する。
 */
export interface MainIO {
  readonly readManuscriptBytes: (path: string) => Promise<Uint8Array>;
  readonly readAllowedWordsBytes: (path: string) => Promise<Uint8Array>;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitCodeForStatus(status: RunStatus): number {
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
      return `run-finished status=${event.status}${event.stop === null ? "" : ` stopReason=${event.stop.reason}`}`;
  }
}

/**
 * 評価用 CLI の本体。引数解釈・原稿読み込み・パイプライン実行・結果出力をつなぐだけで、
 * パイプラインの処理そのものは `@shuten/server` の `runPipeline` に委ねる。
 *
 * 戻り値は終了コード（決定 12）：0 = completed、2 = partially-failed、3 = stopped、1 = 引数・入出力の誤り。
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: MainIO = defaultIO(),
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.writeErrorLine(`引数エラー: ${parsed.error}`);
    return 1;
  }
  const args = parsed.value;

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
  } catch (error) {
    io.writeErrorLine(`原稿ファイルを読み込めません: ${messageOf(error)}`);
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
    } catch (error) {
      io.writeErrorLine(`許容語ファイルを読み込めません: ${messageOf(error)}`);
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
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
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
  } catch (error) {
    io.writeErrorLine(`結果の書き出しに失敗しました: ${messageOf(error)}`);
    return 1;
  }

  return exitCodeForStatus(result.status);
}
