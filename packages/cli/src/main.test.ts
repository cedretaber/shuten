import { hashBody } from "@shuten/server/hash.ts";
import { LmStudioError } from "@shuten/server/lmstudio/errors.ts";
import type {
  ChatRequest,
  ChatResult,
  LmStudioClient,
  LmStudioClientOptions,
  ModelInfo,
} from "@shuten/server/lmstudio/types.ts";
import type { PipelineArgs } from "@shuten/server/run/pipeline.ts";
import type { PipelineResult, PipelineRunStatus, RunStop } from "@shuten/server/run/result.ts";
import { RESULT_VERSION } from "@shuten/server/run/result.ts";
import { ingestUtf8Bytes } from "@shuten/shared";
import { describe, expect, it, vi } from "vitest";

import * as aggregateReportModule from "./eval/aggregate-report.ts";
import * as reportModule from "./eval/report.ts";
import { FULL_CHAT_FORMAT_VERSION } from "./full-chat.ts";
import type { MainIO } from "./main.ts";
import { main } from "./main.ts";

const REQUIRED = ["--manuscript", "manuscript.txt", "--model", "test-model"];

/** main は実 LM Studio に接続しない。ここで返すクライアントのメソッドは呼ばれない想定。 */
function stubClient(): LmStudioClient {
  return {
    listModels: () => Promise.reject(new Error("テストでは呼ばれない想定")),
    ensureLoaded: () => Promise.reject(new Error("テストでは呼ばれない想定")),
    chat: () => Promise.reject(new Error("テストでは呼ばれない想定")),
    close: () => Promise.resolve(),
  };
}

function buildResult(status: PipelineRunStatus, stop: RunStop | null = null): PipelineResult {
  return {
    status,
    stop,
    conditions: {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      mode: "split",
      perspectives: ["typo"],
      generation: { model: "test-model", maxTokens: 16000, temperature: 0 },
      model: null,
      chunkSettings: {
        targetGraphemes: 1500,
        contextGraphemes: 1000,
        recheckContextGraphemes: 3000,
        roundingTolerance: 0.2,
        maxInputGraphemes: 12000,
      },
      timeouts: { checkMs: 300000, recheckMs: 300000 },
      allowedWords: [],
      versions: {
        result: RESULT_VERSION,
        prompt: "1",
        allowedWordRule: "1",
        diagnosticTransform: "1",
      },
      manuscript: {
        utf16Length: 4,
        graphemeCount: 4,
        paragraphCount: 1,
        targetCount: 1,
        bodyHash: "dummy-hash",
      },
    },
    targets: [],
    checkUnits: [],
    findings: [],
    unlocated: [],
    totals: {
      targets: 1,
      checkUnits: { done: 0, failed: 0, pending: 0 },
      requests: 0,
      candidates: 0,
      located: 0,
      unlocated: { notFound: 0, ambiguous: 0, outsideTarget: 0 },
      findings: 0,
      suppressed: 0,
      rechecks: { done: 0, failed: 0, pending: 0, suppressed: 0, disabled: 0 },
      elapsedMs: 1234,
    },
  };
}

interface CapturedIO {
  readonly io: MainIO;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly writtenFiles: { readonly path: string; readonly content: string }[];
  readonly receivedPipelineArgs: PipelineArgs[];
  readonly receivedClientOptions: LmStudioClientOptions[];
}

function buildIO(overrides: Partial<MainIO> = {}): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writtenFiles: { path: string; content: string }[] = [];
  const receivedPipelineArgs: PipelineArgs[] = [];
  const receivedClientOptions: LmStudioClientOptions[] = [];

  const io: MainIO = {
    readManuscriptBytes: () => Promise.resolve(new TextEncoder().encode("dummy")),
    readAllowedWordsBytes: () => Promise.resolve(new TextEncoder().encode("")),
    readPromptBytes: () => Promise.reject(new Error("テストでは呼ばれない想定")),
    readTruthBytes: () => Promise.reject(new Error("テストでは呼ばれない想定")),
    readResultBytes: () => Promise.reject(new Error("テストでは呼ばれない想定")),
    readExportBytes: () => Promise.reject(new Error("テストでは呼ばれない想定")),
    // 既定では「どのファイルも存在しない」。実体の比較が要るテストだけ上書きする。
    statFile: () => Promise.resolve(null),
    writeResult: (outPath, json) => {
      if (outPath === null) {
        stdout.push(json);
      } else {
        writtenFiles.push({ path: outPath, content: json });
      }
      return Promise.resolve();
    },
    writeProgressLine: (line) => {
      stderr.push(line);
    },
    writeErrorLine: (line) => {
      stderr.push(line);
    },
    createClient: (options) => {
      receivedClientOptions.push(options);
      return stubClient();
    },
    runPipeline: (args) => {
      receivedPipelineArgs.push(args);
      return Promise.resolve(buildResult("completed"));
    },
    ...overrides,
  };

  return { io, stdout, stderr, writtenFiles, receivedPipelineArgs, receivedClientOptions };
}

describe("main C5: 原稿ファイルの取り込み", () => {
  it("BOM 付き CRLF のバイト列を ingestUtf8Bytes に通した結果を text として渡す", async () => {
    const bomCrlf = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("一行目\r\n二行目\r\n"),
    ]);
    const captured = buildIO({
      readManuscriptBytes: () => Promise.resolve(bomCrlf),
    });

    const code = await main(REQUIRED, {}, captured.io);

    expect(code).toBe(0);
    expect(captured.receivedPipelineArgs).toHaveLength(1);
    expect(captured.receivedPipelineArgs[0]?.text).toBe(ingestUtf8Bytes(bomCrlf));
    // BOM は 1 文字だけ外れ、CRLF はそのまま残る（ingestUtf8Bytes の仕様）。
    expect(captured.receivedPipelineArgs[0]?.text.startsWith("﻿")).toBe(false);
    expect(captured.receivedPipelineArgs[0]?.text).toContain("\r\n");
  });

  it("原稿ファイルが読めないと終了コード 1 になる", async () => {
    const captured = buildIO({
      readManuscriptBytes: () => Promise.reject(new Error("ENOENT: no such file")),
    });
    const code = await main(REQUIRED, {}, captured.io);
    expect(code).toBe(1);
    expect(captured.receivedPipelineArgs).toHaveLength(0);
  });
});

describe("main C6: 許容語ファイルの取り込み", () => {
  it("中身を加工せずそのまま allowedWordsRaw に渡す（分割・trim は行わない）", async () => {
    const raw = "  ふー\r\n\r\nばー  \nふー\n";
    const bytes = new TextEncoder().encode(raw);
    const captured = buildIO({
      readAllowedWordsBytes: () => Promise.resolve(bytes),
    });

    const code = await main([...REQUIRED, "--allowed-words", "allowed.txt"], {}, captured.io);

    expect(code).toBe(0);
    expect(captured.receivedPipelineArgs[0]?.allowedWordsRaw).toBe(raw);
  });

  it("--allowed-words を省略すると空文字列を渡す", async () => {
    const captured = buildIO();
    const code = await main(REQUIRED, {}, captured.io);
    expect(code).toBe(0);
    expect(captured.receivedPipelineArgs[0]?.allowedWordsRaw).toBe("");
  });
});

describe("main C4: full-text でも recheck-context-graphemes が runPipeline に渡る", () => {
  it("--mode full-text でも chunkSettings.recheckContextGraphemes が実際の PipelineArgs に載る", async () => {
    const captured = buildIO();
    const code = await main(
      [...REQUIRED, "--mode", "full-text", "--recheck-context-graphemes", "500"],
      {},
      captured.io,
    );
    expect(code).toBe(0);
    expect(captured.receivedPipelineArgs[0]?.mode).toBe("full-text");
    expect(captured.receivedPipelineArgs[0]?.chunkSettings.recheckContextGraphemes).toBe(500);
  });
});

describe("main C7: 結果 JSON の往復", () => {
  it("JSON.parse で構造が保たれる", async () => {
    const result = buildResult("completed");
    const captured = buildIO({ runPipeline: () => Promise.resolve(result) });

    await main(REQUIRED, {}, captured.io);

    expect(captured.stdout).toHaveLength(1);
    const parsed = JSON.parse(captured.stdout[0] ?? "") as unknown;
    expect(parsed).toEqual(result);
  });

  it("--out を指定するとファイルへ書き出し、標準出力には書かない", async () => {
    const result = buildResult("completed");
    const captured = buildIO({ runPipeline: () => Promise.resolve(result) });

    await main([...REQUIRED, "--out", "result.json"], {}, captured.io);

    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(1);
    expect(captured.writtenFiles[0]?.path).toBe("result.json");
    const parsed = JSON.parse(captured.writtenFiles[0]?.content ?? "") as unknown;
    expect(parsed).toEqual(result);
  });
});

describe("main C8: 終了コードが PipelineRunStatus に対応する", () => {
  it("completed は 0", async () => {
    const captured = buildIO({ runPipeline: () => Promise.resolve(buildResult("completed")) });
    expect(await main(REQUIRED, {}, captured.io)).toBe(0);
  });

  it("partially-failed は 2", async () => {
    const captured = buildIO({
      runPipeline: () => Promise.resolve(buildResult("partially-failed")),
    });
    expect(await main(REQUIRED, {}, captured.io)).toBe(2);
  });

  it("stopped は 3", async () => {
    const stop: RunStop = {
      reason: "aborted",
      message: "中断された",
      failure: null,
      generationUnconfirmed: false,
    };
    const captured = buildIO({
      runPipeline: () => Promise.resolve(buildResult("stopped", stop)),
    });
    expect(await main(REQUIRED, {}, captured.io)).toBe(3);
  });

  it("引数エラーは 1", async () => {
    const captured = buildIO();
    expect(await main([], {}, captured.io)).toBe(1);
  });

  it("runPipeline が想定外の例外を投げても 1 で、原因は表示しない", async () => {
    const captured = buildIO({
      runPipeline: () => Promise.reject(new Error("boom", { cause: new Error("ECONNREFUSED") })),
    });
    const code = await main(REQUIRED, {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain("ECONNREFUSED");
  });
});

describe("main: run-finished の進捗行に generationUnconfirmed を出す", () => {
  function runWithStop(stop: RunStop | null): Promise<CapturedIO> {
    const captured = buildIO({
      runPipeline: (args) => {
        args.onEvent?.({
          type: "run-finished",
          status: stop === null ? "completed" : "stopped",
          stop,
        });
        return Promise.resolve(buildResult(stop === null ? "completed" : "stopped", stop));
      },
    });
    return main(REQUIRED, {}, captured.io).then(() => captured);
  }

  it("停止したときは stopReason とともに generationUnconfirmed を出す", async () => {
    const captured = await runWithStop({
      reason: "recovery-needed",
      message: "生成要求がタイムアウトしたため実行を停止した",
      failure: null,
      generationUnconfirmed: true,
    });

    expect(captured.stderr).toContain(
      "run-finished status=stopped stopReason=recovery-needed generationUnconfirmed=true",
    );
  });

  it("generationUnconfirmed が偽なら false と出す", async () => {
    const captured = await runWithStop({
      reason: "model-not-loaded",
      message: "モデルがロードされていないため実行を停止した",
      failure: null,
      generationUnconfirmed: false,
    });

    expect(captured.stderr).toContain(
      "run-finished status=stopped stopReason=model-not-loaded generationUnconfirmed=false",
    );
  });

  it("stop が null のときは出さない", async () => {
    const captured = await runWithStop(null);

    expect(captured.stderr).toContain("run-finished status=completed");
    expect(captured.stderr.join("\n")).not.toContain("generationUnconfirmed");
  });
});

describe("main C9: 接続先 URL と API キーが出力に現れない", () => {
  const SECRET_URL = "http://secret-lmstudio-host.internal:19999";
  const SECRET_KEY = "sk-super-secret-token-xyz";

  it("進捗・結果・エラーのどこにも現れない（正常系）", async () => {
    const captured = buildIO({
      runPipeline: (args) => {
        // onEvent を一通り叩いて進捗行にも紛れ込まないことを確認する。
        args.onEvent?.({ type: "run-started", targetCount: 1, unitCount: 1 });
        args.onEvent?.({ type: "check-started", targetIndex: 0, perspective: "typo" });
        args.onEvent?.({
          type: "check-finished",
          result: {
            status: "done",
            targetIndex: 0,
            perspective: "typo",
            attempts: 1,
            usage: null,
            inputGraphemes: 4,
            elapsedMs: 10,
            findingCount: 0,
          },
        });
        args.onEvent?.({ type: "target-merged", targetIndex: 0, findingCount: 0 });
        args.onEvent?.({ type: "run-finished", status: "completed", stop: null });
        return Promise.resolve(buildResult("completed"));
      },
    });

    const code = await main(
      REQUIRED,
      { SHUTEN_LM_STUDIO_URL: SECRET_URL, SHUTEN_LM_STUDIO_API_KEY: SECRET_KEY },
      captured.io,
    );

    expect(code).toBe(0);
    // クライアントには正しく渡っている（内部利用は問題ない）。出力にだけ現れないことを確認する。
    expect(captured.receivedClientOptions[0]?.baseUrl).toBe(SECRET_URL);
    expect(captured.receivedClientOptions[0]?.apiKey).toBe(SECRET_KEY);

    const allOutput = [
      ...captured.stdout,
      ...captured.stderr,
      ...captured.writtenFiles.map((f) => f.content),
    ].join("\n");
    expect(allOutput).not.toContain(SECRET_URL);
    expect(allOutput).not.toContain("secret-lmstudio-host");
    expect(allOutput).not.toContain(SECRET_KEY);
  });

  it("接続先 URL が不正な環境変数値でも、エラーメッセージに値そのものを含めない", async () => {
    const captured = buildIO();
    const code = await main(
      REQUIRED,
      { SHUTEN_LM_STUDIO_URL: `${SECRET_URL}/with-a-path` },
      captured.io,
    );

    expect(code).toBe(1);
    const allOutput = [...captured.stdout, ...captured.stderr].join("\n");
    expect(allOutput).not.toContain(SECRET_URL);
    expect(allOutput).not.toContain("secret-lmstudio-host");
  });

  it("結果 JSON にも接続先 URL・API キーが含まれない（runPipeline の結果を素通し）", async () => {
    const result = buildResult("completed");
    const captured = buildIO({ runPipeline: () => Promise.resolve(result) });

    await main(
      REQUIRED,
      { SHUTEN_LM_STUDIO_URL: SECRET_URL, SHUTEN_LM_STUDIO_API_KEY: SECRET_KEY },
      captured.io,
    );

    const json = captured.stdout[0] ?? "";
    expect(json).not.toContain(SECRET_URL);
    expect(json).not.toContain(SECRET_KEY);
  });
});

describe("main: --out が入力ファイルを上書きしないこと", () => {
  it("--out が --manuscript と同じパス文字列なら引数エラーで終了する", async () => {
    const captured = buildIO();
    const code = await main(
      ["--manuscript", "novel.txt", "--model", "test-model", "--out", "novel.txt"],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.receivedPipelineArgs).toHaveLength(0);
    expect(captured.receivedClientOptions).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
    expect(captured.stderr.join("\n")).toContain("--manuscript");
  });

  it("相対表記の違い（./novel.txt と novel.txt）でも拒否する", async () => {
    const captured = buildIO();
    const code = await main(
      ["--manuscript", "novel.txt", "--model", "test-model", "--out", "./novel.txt"],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.receivedPipelineArgs).toHaveLength(0);
    expect(captured.receivedClientOptions).toHaveLength(0);
  });

  it("dev/ino が一致する別パス（シンボリックリンク相当）でも拒否する", async () => {
    const captured = buildIO({
      statFile: (path) =>
        Promise.resolve(
          path === "out.json" || path === "novel.txt" ? { dev: 1, ino: 42 } : { dev: 1, ino: 7 },
        ),
    });
    const code = await main(
      ["--manuscript", "novel.txt", "--model", "test-model", "--out", "out.json"],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.receivedPipelineArgs).toHaveLength(0);
    expect(captured.receivedClientOptions).toHaveLength(0);
  });

  it("--out が --allowed-words と同じ実体でも拒否する", async () => {
    const captured = buildIO({
      statFile: (path) =>
        Promise.resolve(
          path === "out.json" || path === "words.txt" ? { dev: 1, ino: 99 } : { dev: 1, ino: 7 },
        ),
    });
    const code = await main(
      [
        "--manuscript",
        "novel.txt",
        "--model",
        "test-model",
        "--allowed-words",
        "words.txt",
        "--out",
        "out.json",
      ],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).toContain("--allowed-words");
    expect(captured.receivedPipelineArgs).toHaveLength(0);
  });

  it("エラーメッセージにパス文字列を含めない", async () => {
    const captured = buildIO();
    await main(
      ["--manuscript", "novel.txt", "--model", "test-model", "--out", "novel.txt"],
      {},
      captured.io,
    );

    expect(captured.stderr.join("\n")).not.toContain("novel.txt");
  });

  it("既存の別ファイルを指す --out なら従来どおり成功する", async () => {
    const captured = buildIO({
      statFile: (path) =>
        Promise.resolve(path === "out.json" ? { dev: 1, ino: 8 } : { dev: 1, ino: 7 }),
    });
    const code = await main(
      ["--manuscript", "novel.txt", "--model", "test-model", "--out", "out.json"],
      {},
      captured.io,
    );

    expect(code).toBe(0);
    expect(captured.receivedPipelineArgs).toHaveLength(1);
    expect(captured.writtenFiles.map((file) => file.path)).toEqual(["out.json"]);
  });

  it("出力先が存在しない新規ファイルなら成功する", async () => {
    const captured = buildIO({
      statFile: (path) => Promise.resolve(path === "out.json" ? null : { dev: 1, ino: 7 }),
    });
    const code = await main(
      ["--manuscript", "novel.txt", "--model", "test-model", "--out", "out.json"],
      {},
      captured.io,
    );

    expect(code).toBe(0);
    expect(captured.receivedPipelineArgs).toHaveLength(1);
    expect(captured.writtenFiles.map((file) => file.path)).toEqual(["out.json"]);
  });
});

describe("main T2: サブコマンドの振り分け（決定9）", () => {
  it("空の argv は run に振られる（既存の「必須オプションがありません」のまま）", async () => {
    const captured = buildIO();
    const code = await main([], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).toContain("--manuscript");
    expect(captured.receivedPipelineArgs).toHaveLength(0);
  });

  it("-- 始まりの argv は run に振られる（既存の起動をそのまま通す）", async () => {
    const captured = buildIO();
    const code = await main(REQUIRED, {}, captured.io);
    expect(code).toBe(0);
    expect(captured.receivedPipelineArgs).toHaveLength(1);
  });

  it("run を明示しても同じ結果になる", async () => {
    const captured = buildIO();
    const code = await main(["run", ...REQUIRED], {}, captured.io);
    expect(code).toBe(0);
    expect(captured.receivedPipelineArgs).toHaveLength(1);
  });

  it("hash サブコマンドに振り分けられ、パイプラインは実行しない", async () => {
    const captured = buildIO();
    const code = await main(["hash", "--manuscript", "manuscript.txt"], {}, captured.io);
    expect(code).toBe(0);
    expect(captured.receivedPipelineArgs).toHaveLength(0);
    expect(captured.receivedClientOptions).toHaveLength(0);
  });

  it("未知のサブコマンド名はエラーになる（終了コード1）。固定文言でパスは出さない（M-1修正）", async () => {
    const captured = buildIO();
    const code = await main(["frobnicate", "--manuscript", "manuscript.txt"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.receivedPipelineArgs).toHaveLength(0);
    // 先頭トークンは `--` で始まらなければ何でもサブコマンド名扱いになるため、打ち間違えた
    // パスがそのまま入りうる（決定9）。固定文言だけを出し、受け取った文字列は出さない。
    expect(captured.stderr.join("\n")).not.toContain("frobnicate");
    expect(captured.stderr.join("\n")).toContain(
      "引数エラー: 先頭の引数がサブコマンド名ではありません（run / hash / evaluate / aggregate / full-chat）",
    );
  });

  it("run の --out は今までどおり重複を拒否する", async () => {
    const captured = buildIO();
    const code = await main([...REQUIRED, "--out", "a.json", "--out", "b.json"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.receivedPipelineArgs).toHaveLength(0);
  });
});

describe("main T22: パスの漏えいを防ぐ（決定9）", () => {
  // fs の例外メッセージにパスが混入する典型例を模した番兵。実在のパスではない。
  const SENTINEL_PATH = "/private/leak-should-not-appear/manuscript.txt";
  const sentinelError = (prefix: string) =>
    new Error(`${prefix}: no such file or directory, open '${SENTINEL_PATH}'`);

  it("run: 原稿読み込み失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildIO({
      readManuscriptBytes: () => Promise.reject(sentinelError("ENOENT")),
    });
    const code = await main(REQUIRED, {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("run: 許容語読み込み失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildIO({
      readAllowedWordsBytes: () => Promise.reject(sentinelError("ENOENT")),
    });
    const code = await main([...REQUIRED, "--allowed-words", "words.txt"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("run: 結果の書き出し失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildIO({
      writeResult: () => Promise.reject(sentinelError("EACCES")),
    });
    const code = await main([...REQUIRED, "--out", "out.json"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("hash: 原稿読み込み失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildIO({
      readManuscriptBytes: () => Promise.reject(sentinelError("ENOENT")),
    });
    const code = await main(["hash", "--manuscript", "manuscript.txt"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("hash: 結果の書き出し失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildIO({
      writeResult: () => Promise.reject(sentinelError("EACCES")),
    });
    const code = await main(["hash", "--manuscript", "manuscript.txt"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });
});

describe("main T1後半: hash サブコマンド", () => {
  it("hashBody(text) の結果を標準出力に1行だけ書く", async () => {
    const captured = buildIO({
      readManuscriptBytes: () => Promise.resolve(new TextEncoder().encode("hello")),
    });
    const code = await main(["hash", "--manuscript", "manuscript.txt"], {}, captured.io);
    expect(code).toBe(0);
    expect(captured.stdout).toEqual([hashBody("hello")]);
    expect(captured.stderr).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
  });

  it("BOM 付きバイト列も ingestUtf8Bytes を通してからハッシュ化する", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hello")]);
    const captured = buildIO({ readManuscriptBytes: () => Promise.resolve(bom) });
    const code = await main(["hash", "--manuscript", "manuscript.txt"], {}, captured.io);
    expect(code).toBe(0);
    expect(captured.stdout).toEqual([hashBody("hello")]);
  });

  it("LM Studio クライアントを作らない", async () => {
    const captured = buildIO();
    await main(["hash", "--manuscript", "manuscript.txt"], {}, captured.io);
    expect(captured.receivedClientOptions).toHaveLength(0);
  });

  it("原稿が読めないと終了コード1になる", async () => {
    const captured = buildIO({
      readManuscriptBytes: () => Promise.reject(new Error("ENOENT")),
    });
    const code = await main(["hash", "--manuscript", "manuscript.txt"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
  });

  it("--manuscript がないと引数エラーで終了コード1になる", async () => {
    const captured = buildIO();
    const code = await main(["hash"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).toContain("--manuscript");
  });
});

// --- evaluate サブコマンド（Task 6：決定 3・4・9・10・11・13・18・21） ---------------------------
//
// すべて合成のテキスト・合成の JSON（実原稿の断片を含まない）。

const EVAL_TEXT = "あいうえお";
const EVAL_HASH = hashBody(EVAL_TEXT);
const EVAL_ARGS = [
  "evaluate",
  "--manuscript",
  "manuscript.txt",
  "--truth",
  "truth.json",
  "--result",
  "result.json",
];

function evalTruthJson(overrides: { bodyHash?: string } = {}): unknown {
  return {
    formatVersion: "1",
    manuscript: { name: "テスト原稿", bodyHash: overrides.bodyHash ?? EVAL_HASH },
    entries: [
      {
        id: "e1",
        kind: "error",
        perspective: "typo",
        paragraphId: 0,
        quote: "いう",
        occurrence: 1,
        expected: "直した形",
        note: "備考",
      },
    ],
  };
}

function evalResultJson(
  overrides: { bodyHash?: string; omitBodyHash?: boolean; mode?: string } = {},
): unknown {
  const manuscriptConditions: Record<string, unknown> = {
    utf16Length: 5,
    graphemeCount: 5,
    paragraphCount: 1,
    targetCount: 1,
  };
  if (overrides.omitBodyHash !== true) {
    manuscriptConditions.bodyHash = overrides.bodyHash ?? EVAL_HASH;
  }
  return {
    status: "completed",
    stop: null,
    conditions: {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      mode: overrides.mode ?? "split",
      perspectives: ["typo"],
      generation: { model: "test-model", maxTokens: 16000, temperature: 0 },
      model: null,
      chunkSettings: {
        targetGraphemes: 1500,
        contextGraphemes: 1000,
        recheckContextGraphemes: 3000,
        roundingTolerance: 0.2,
        maxInputGraphemes: 12000,
      },
      timeouts: { checkMs: 300000, recheckMs: 300000 },
      allowedWords: [],
      versions: {
        result: RESULT_VERSION,
        prompt: "1",
        allowedWordRule: "1",
        diagnosticTransform: "1",
      },
      manuscript: manuscriptConditions,
    },
    findings: [
      {
        targetIndex: 0,
        finding: {
          id: "f1",
          range: { start: 1, end: 3 },
          quote: "いう",
          category: "notation",
          suggestion: "直した形",
          verdict: "likely-error",
          sources: [
            {
              id: "f1-c0",
              perspective: "typo",
              llm: {
                paragraphId: 0,
                quote: "いう",
                before: "あ",
                after: "えお",
                category: "notation",
                reason: "テスト理由",
                suggestion: "直した形",
                verdict: "likely-error",
              },
            },
          ],
        },
        suppression: null,
        recheck: { status: "disabled" },
      },
    ],
    unlocated: [],
    totals: {
      targets: 1,
      checkUnits: { done: 1, failed: 0, pending: 0 },
      requests: 1,
      candidates: 1,
      located: 1,
      unlocated: { notFound: 0, ambiguous: 0, outsideTarget: 0 },
      findings: 1,
      suppressed: 0,
      rechecks: { done: 0, failed: 0, pending: 0, suppressed: 0, disabled: 1 },
      elapsedMs: 100,
    },
  };
}

/**
 * 「別の原稿に対する結果 JSON」を模す：`bodyHash` が違い、かつ `finding.range`/`quote` も
 * 実際の原稿（`EVAL_TEXT`）の該当範囲と一致しない。`aggregate` の T10 順序検査
 * （ハッシュ照合を `validateFindingRanges` より先に行う）専用の fixture。
 */
function evalResultJsonForDifferentManuscript(): unknown {
  const base = evalResultJson({ bodyHash: "f".repeat(64) }) as Record<string, unknown>;
  return {
    ...base,
    findings: [
      {
        targetIndex: 0,
        finding: {
          id: "f-other",
          range: { start: 0, end: 5 },
          quote: "ぜんぜんちがう",
          category: "notation",
          suggestion: null,
          verdict: "likely-error",
          sources: [
            {
              id: "f-other-c0",
              perspective: "typo",
              llm: {
                paragraphId: 0,
                quote: "ぜんぜんちがう",
                before: "",
                after: "",
                category: "notation",
                reason: "テスト理由",
                suggestion: null,
                verdict: "likely-error",
              },
            },
          ],
        },
        suppression: null,
        recheck: { status: "disabled" },
      },
    ],
  };
}

function buildEvalIO(overrides: Partial<MainIO> = {}): CapturedIO {
  return buildIO({
    readManuscriptBytes: () => Promise.resolve(new TextEncoder().encode(EVAL_TEXT)),
    readTruthBytes: () =>
      Promise.resolve(new TextEncoder().encode(JSON.stringify(evalTruthJson()))),
    readResultBytes: () =>
      Promise.resolve(new TextEncoder().encode(JSON.stringify(evalResultJson()))),
    ...overrides,
  });
}

describe("main evaluate T11: 出力（決定10・11・13）", () => {
  it("--out 未指定なら指標 JSON を標準出力に書き、formatVersion を含む", async () => {
    const captured = buildEvalIO();
    const code = await main(EVAL_ARGS, {}, captured.io);

    expect(code).toBe(0);
    expect(captured.stdout).toHaveLength(1);
    expect(captured.writtenFiles).toHaveLength(0);
    const parsed = JSON.parse(captured.stdout[0] ?? "") as { formatVersion?: unknown };
    expect(parsed.formatVersion).toBe("1");
  });

  it("--out を指定するとファイルへ書き出し、標準出力には書かない", async () => {
    const captured = buildEvalIO();
    const code = await main([...EVAL_ARGS, "--out", "metrics.json"], {}, captured.io);

    expect(code).toBe(0);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(1);
    expect(captured.writtenFiles[0]?.path).toBe("metrics.json");
    const parsed = JSON.parse(captured.writtenFiles[0]?.content ?? "") as {
      formatVersion?: unknown;
    };
    expect(parsed.formatVersion).toBe("1");
  });

  it("--report を指定すると Markdown レポートに人手の欄が空で出る（決定11）", async () => {
    const captured = buildEvalIO();
    const code = await main([...EVAL_ARGS, "--report", "report.md"], {}, captured.io);

    expect(code).toBe(0);
    const reportFile = captured.writtenFiles.find((file) => file.path === "report.md");
    expect(reportFile).toBeDefined();
    expect(reportFile?.content).toContain(
      "| **修正案の妥当性** | **人** | レポートの誤検出・検出一覧に空欄の列を置く |",
    );
    expect(reportFile?.content).toContain(
      "| **人間の確認負担** | **人** | ツールは測らない（`docs/experiments/` に記録する） |",
    );
  });

  it("--report を指定しなければレポートを書かない", async () => {
    const captured = buildEvalIO();
    const code = await main(EVAL_ARGS, {}, captured.io);

    expect(code).toBe(0);
    expect(captured.writtenFiles).toHaveLength(0);
  });

  it("レポートの組み立てが失敗しても --out に何も書き出さない（M-2修正）", async () => {
    // 両方の文字列を組み立ててから書き出すようにしたことの検証：レポートの組み立て
    // （formatEvaluationReport）が --out の書き出しより前に行われるので、それが失敗すると
    // --out にも一切書き出されない（部分的な出力が残らない）。
    const spy = vi.spyOn(reportModule, "formatEvaluationReport").mockImplementation(() => {
      throw new Error("レポート組み立ての失敗（テスト用）");
    });
    try {
      const captured = buildEvalIO();
      await expect(
        main([...EVAL_ARGS, "--out", "metrics.json", "--report", "report.md"], {}, captured.io),
      ).rejects.toThrow("レポート組み立ての失敗（テスト用）");
      expect(captured.writtenFiles).toHaveLength(0);
      expect(captured.stdout).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("main evaluate T4: 3 方向のハッシュ照合（決定3）", () => {
  it("原稿と正解ファイルの bodyHash が食い違うと集計せずエラー終了し、計算したハッシュ値が出る", async () => {
    const otherHash = "b".repeat(64);
    const captured = buildEvalIO({
      readTruthBytes: () =>
        Promise.resolve(
          new TextEncoder().encode(JSON.stringify(evalTruthJson({ bodyHash: otherHash }))),
        ),
    });
    const code = await main(EVAL_ARGS, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain(EVAL_HASH);
    expect(stderr).toContain(otherHash);
  });

  it("原稿と結果 JSON の bodyHash が食い違うと集計せずエラー終了し、計算したハッシュ値が出る", async () => {
    const otherHash = "c".repeat(64);
    const captured = buildEvalIO({
      readResultBytes: () =>
        Promise.resolve(
          new TextEncoder().encode(JSON.stringify(evalResultJson({ bodyHash: otherHash }))),
        ),
    });
    const code = await main(EVAL_ARGS, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain(EVAL_HASH);
    expect(stderr).toContain(otherHash);
  });

  it("原稿そのものが違うと（正解・結果双方とハッシュが食い違う）集計せずエラー終了する", async () => {
    const captured = buildEvalIO({
      readManuscriptBytes: () => Promise.resolve(new TextEncoder().encode("かきくけこ")),
    });
    const code = await main(EVAL_ARGS, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
  });

  it("結果 JSON に conditions.manuscript.bodyHash が無いと拒否する", async () => {
    const captured = buildEvalIO({
      readResultBytes: () =>
        Promise.resolve(
          new TextEncoder().encode(JSON.stringify(evalResultJson({ omitBodyHash: true }))),
        ),
    });
    const code = await main(EVAL_ARGS, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
  });

  it("ハッシュが 3 つとも一致していれば集計できる", async () => {
    const captured = buildEvalIO();
    const code = await main(EVAL_ARGS, {}, captured.io);
    expect(code).toBe(0);
  });
});

describe("main evaluate 決定4: 正解の解決に失敗したとき", () => {
  it("段落 ID が範囲外だと集計せず終了コード1になり、標準エラーは安全な1行だけ", async () => {
    const captured = buildEvalIO({
      readTruthBytes: () =>
        Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify({
              formatVersion: "1",
              manuscript: { name: "テスト原稿", bodyHash: EVAL_HASH },
              entries: [
                {
                  id: "e-out-of-range",
                  kind: "error",
                  perspective: "typo",
                  paragraphId: 99,
                  quote: "いう",
                  occurrence: 1,
                },
              ],
            }),
          ),
        ),
    });
    const code = await main(EVAL_ARGS, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
    expect(captured.stderr.join("\n")).toContain("e-out-of-range");
  });

  it("--report があるときだけ失敗した段落の本文を書く", async () => {
    const captured = buildEvalIO({
      readTruthBytes: () =>
        Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify({
              formatVersion: "1",
              manuscript: { name: "テスト原稿", bodyHash: EVAL_HASH },
              entries: [
                {
                  id: "e-no-match",
                  kind: "error",
                  perspective: "typo",
                  paragraphId: 0,
                  quote: "存在しない引用",
                  occurrence: 1,
                },
              ],
            }),
          ),
        ),
    });
    const code = await main([...EVAL_ARGS, "--report", "report.md"], {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    const reportFile = captured.writtenFiles.find((file) => file.path === "report.md");
    expect(reportFile).toBeDefined();
    expect(reportFile?.content).toContain(EVAL_TEXT);
  });
});

describe("main evaluate T19: 出力先の衝突（決定21）", () => {
  it("--out と --report が同じパス文字列ならエラー", async () => {
    const captured = buildEvalIO();
    const code = await main(
      [...EVAL_ARGS, "--out", "same.json", "--report", "same.json"],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("--out");
    expect(stderr).toContain("--report");
  });

  it("--out が --manuscript と同じパス文字列ならエラー", async () => {
    const captured = buildEvalIO();
    const code = await main([...EVAL_ARGS, "--out", "manuscript.txt"], {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.stderr.join("\n")).toContain("--manuscript");
  });

  it("--report が --truth と同じ実体（dev/ino 一致。シンボリックリンク・ハードリンク経由の別名を想定）ならエラー", async () => {
    const identities: Readonly<Record<string, { dev: number; ino: number }>> = {
      "report.md": { dev: 1, ino: 100 },
      "truth.json": { dev: 1, ino: 100 },
      "manuscript.txt": { dev: 1, ino: 1 },
      "result.json": { dev: 1, ino: 2 },
    };
    const captured = buildEvalIO({
      statFile: (path) => Promise.resolve(identities[path] ?? null),
    });
    const code = await main([...EVAL_ARGS, "--report", "report.md"], {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.stderr.join("\n")).toContain("--truth");
  });

  it("--result どうしは evaluate では 1 本しか渡せない（衝突以前に引数エラー）", async () => {
    const captured = buildEvalIO();
    const code = await main([...EVAL_ARGS, "--result", "result2.json"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
  });

  it("エラーメッセージにパス文字列を含めない", async () => {
    const captured = buildEvalIO();
    const code = await main([...EVAL_ARGS, "--out", "manuscript.txt"], {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain("manuscript.txt");
  });

  it("衝突が無ければ従来どおり評価が実行される", async () => {
    const captured = buildEvalIO();
    const code = await main(
      [...EVAL_ARGS, "--out", "metrics.json", "--report", "report.md"],
      {},
      captured.io,
    );
    expect(code).toBe(0);
    expect(captured.writtenFiles.map((file) => file.path)).toEqual(["metrics.json", "report.md"]);
  });

  it("入力どうし（--manuscript と --truth）が同じ実体でも衝突エラーにはならず、後段の JSON 解析エラーになる（決定21の絞り込み）", async () => {
    // --manuscript と同じパスを --truth にも渡す。正解ファイルとして読むと原稿の生テキストは
    // 不正な JSON なので、後続の JSON.parse が失敗する。この失敗こそが正しい診断であり、
    // 「引数が衝突しています」という曖昧なエラーで上書きしてはならない（決定21は out/report 対
    // 入力・out 対 report だけを衝突として扱う）。
    const captured = buildEvalIO({
      readTruthBytes: (path) =>
        path === "manuscript.txt"
          ? Promise.resolve(new TextEncoder().encode(EVAL_TEXT))
          : Promise.resolve(new TextEncoder().encode(JSON.stringify(evalTruthJson()))),
    });
    const code = await main(
      [
        "evaluate",
        "--manuscript",
        "manuscript.txt",
        "--truth",
        "manuscript.txt",
        "--result",
        "result.json",
      ],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).not.toContain("が同じファイルを指しています");
    expect(stderr).toContain("正解ファイルの JSON 構文が不正です");
  });
});

describe("main evaluate T22: パスの漏えいを防ぐ（決定9）", () => {
  const SENTINEL_PATH = "/private/leak-should-not-appear/eval.json";
  const sentinelError = (prefix: string) =>
    new Error(`${prefix}: no such file or directory, open '${SENTINEL_PATH}'`);

  it("原稿読み込み失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildEvalIO({
      readManuscriptBytes: () => Promise.reject(sentinelError("ENOENT")),
    });
    const code = await main(EVAL_ARGS, {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("正解ファイル読み込み失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildEvalIO({
      readTruthBytes: () => Promise.reject(sentinelError("ENOENT")),
    });
    const code = await main(EVAL_ARGS, {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("結果ファイル読み込み失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildEvalIO({
      readResultBytes: () => Promise.reject(sentinelError("ENOENT")),
    });
    const code = await main(EVAL_ARGS, {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("指標 JSON の書き出し失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildEvalIO({
      writeResult: () => Promise.reject(sentinelError("EACCES")),
    });
    const code = await main([...EVAL_ARGS, "--out", "metrics.json"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("レポートの書き出し失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildEvalIO({
      writeResult: (outPath) =>
        outPath === "report.md" ? Promise.reject(sentinelError("EACCES")) : Promise.resolve(),
    });
    const code = await main([...EVAL_ARGS, "--report", "report.md"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });
});

// --- evaluate の --export（Task 11：決定 29） ---------------------------------------------------
//
// エクスポート JSON はすべて合成の値（実原稿・実行結果の断片を含まない）。`manuscript.body` は
// `EVAL_TEXT` と同じにし、`--result` 系のテスト（正解ファイル `evalTruthJson()`）とハッシュ・
// 本文の両方を揃える。

const EVAL_ARGS_EXPORT = ["evaluate", "--truth", "truth.json", "--export", "export.json"];

function evalExportJson(overrides: { body?: string; runId?: string } = {}): unknown {
  const body = overrides.body ?? EVAL_TEXT;
  return {
    formatVersion: "1",
    exportedAt: "2026-01-01T00:02:00.000Z",
    run: {
      id: overrides.runId ?? "r1",
      manuscriptVersionId: "mv1",
      modelId: "model-a",
      modelInfo: null,
      generationSettings: { maxTokens: 512, temperature: 0.2 },
      chunkSettings: {
        targetGraphemes: 1500,
        contextGraphemes: 1000,
        recheckContextGraphemes: 3000,
        roundingTolerance: 0.2,
        maxInputGraphemes: 8000,
      },
      timeouts: { checkMs: 60_000, recheckMs: 60_000 },
      perspectives: ["typo", "naturalness"],
      recheckEnabled: true,
      allowedWords: [],
      allowedWordRuleVersion: "1",
      promptVersion: "1",
      diagnosticTransformVersion: "1",
      status: "completed",
      stopReason: null,
      stopMessage: null,
      generationUnconfirmed: false,
      stopRequestedAt: null,
      recoveryConfirmedAt: null,
      recoveryConfirmMs: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
    },
    manuscript: {
      id: "mv1",
      name: "テスト原稿",
      body,
      bodyHash: hashBody(body),
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    targets: [],
    checkUnits: [],
    recheckUnits: [],
    findings: [],
    unlocatedCandidates: [],
    unlocatedDiagnostics: [],
  };
}

/**
 * `evalExportJson` に加えて、本文と**合わない** quote/range を持つ「located」の指摘を 1 件持つ
 * エクスポート JSON（レビュー指摘 Important 1(a)(c)）。`adaptExportToResult` 自体は
 * quote/range を本文と突き合わせないため（`export-adapter.ts` は `range === null` しか見ない）、
 * この指摘は変換自体には成功する。3 方向のハッシュ照合が `validateFindingRanges` より
 * **前**であることを検査するための素材：順序が入れ替わっていれば
 * 「quote が本文の該当範囲と一致しません」が先に出てしまう。
 */
function evalExportJsonWithMismatchedFinding(
  overrides: { body?: string; runId?: string } = {},
): unknown {
  const body = overrides.body ?? EVAL_TEXT;
  const base = evalExportJson({
    body,
    ...(overrides.runId === undefined ? {} : { runId: overrides.runId }),
  }) as Record<string, unknown>;
  const rangeEnd = Math.min(5, body.length);
  return {
    ...base,
    targets: [
      {
        id: "t1",
        targetIndex: 0,
        target: { start: 0, end: body.length },
        contextBefore: null,
        contextAfter: null,
        input: { start: 0, end: body.length },
        paragraphIds: [0],
      },
    ],
    checkUnits: [
      {
        id: "cu1",
        targetId: "t1",
        targetIndex: 0,
        perspective: "typo",
        status: "done",
        attempts: 1,
        failure: null,
        pendingNote: null,
        elapsedMs: 10,
        startedAt: null,
        finishedAt: null,
      },
    ],
    findings: [
      {
        id: "f-mismatch",
        runId: "r1",
        targetId: "t1",
        locateStatus: "located",
        range: { start: 0, end: rangeEnd },
        paragraphId: 0,
        quote: "ぜんぜんちがう",
        suggestion: null,
        category: "notation",
        initialVerdict: "likely-error",
        suppression: null,
        reasons: [],
        recheck: null,
        judgment: {
          findingId: "f-mismatch",
          status: "undecided",
          note: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        candidates: [
          {
            id: "c-mismatch",
            checkUnitId: "cu1",
            perspective: "typo",
            candidateIndex: 0,
            llm: {
              paragraphId: 0,
              quote: "ぜんぜんちがう",
              before: "",
              after: "",
              category: "notation",
              reason: "テスト理由",
              suggestion: null,
              verdict: "likely-error",
            },
            locateStatus: "located",
            range: { start: 0, end: rangeEnd },
          },
        ],
        diagnostics: [],
      },
    ],
  };
}

function buildEvalExportIO(overrides: Partial<MainIO> = {}): CapturedIO {
  return buildIO({
    readTruthBytes: () =>
      Promise.resolve(new TextEncoder().encode(JSON.stringify(evalTruthJson()))),
    readExportBytes: () =>
      Promise.resolve(new TextEncoder().encode(JSON.stringify(evalExportJson()))),
    ...overrides,
  });
}

describe("main evaluate T24: --export の配線（決定29）", () => {
  it("--result と --export の両方を指定すると引数エラーになる", async () => {
    const captured = buildEvalExportIO();
    const code = await main(
      ["evaluate", "--truth", "truth.json", "--result", "result.json", "--export", "export.json"],
      {},
      captured.io,
    );
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).toContain("--result と --export は同時に指定できません");
  });

  it("--result も --export も指定しないと引数エラーになる", async () => {
    const captured = buildEvalExportIO();
    const code = await main(["evaluate", "--truth", "truth.json"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).toContain(
      "--result か --export のどちらかを指定してください",
    );
  });

  it("--export と --manuscript を併用すると引数エラーになる", async () => {
    const captured = buildEvalExportIO();
    const code = await main(
      [...EVAL_ARGS_EXPORT, "--manuscript", "manuscript.txt"],
      {},
      captured.io,
    );
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).toContain(
      "--export を指定したときは --manuscript を指定できません",
    );
  });

  it("--export が無く --manuscript も無いと引数エラーになる", async () => {
    const captured = buildEvalExportIO();
    const code = await main(
      ["evaluate", "--truth", "truth.json", "--result", "result.json"],
      {},
      captured.io,
    );
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).toContain("--manuscript がありません");
  });

  it("--export だけで evaluate が通り、--report 未指定なら formatEvaluationReport を呼ばない", async () => {
    const spy = vi.spyOn(reportModule, "formatEvaluationReport");
    try {
      const captured = buildEvalExportIO();
      const code = await main(EVAL_ARGS_EXPORT, {}, captured.io);

      expect(code).toBe(0);
      expect(spy).not.toHaveBeenCalled(); // --report 未指定なら呼ばれない
    } finally {
      spy.mockRestore();
    }
  });

  it('--export だけで evaluate が通り、--report 指定時に formatEvaluationReport へ source: "export" が渡る', async () => {
    const spy = vi.spyOn(reportModule, "formatEvaluationReport");
    try {
      const captured = buildEvalExportIO();
      const code = await main([...EVAL_ARGS_EXPORT, "--report", "report.md"], {}, captured.io);

      expect(code).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0]?.[0];
      expect(call?.source).toBe("export");
      expect(captured.writtenFiles.some((file) => file.path === "report.md")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("出力先の衝突検査に --export が入る（--out と同じパス文字列の --export → 拒否）", async () => {
    const captured = buildEvalExportIO();
    const code = await main([...EVAL_ARGS_EXPORT, "--out", "export.json"], {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("--out");
    expect(stderr).toContain("--export");
  });
});

// レビュー指摘 Important 1：runEvaluate の「ハッシュ照合 → validateFindingRanges」という順序が
// --export 経路にも --result 経路にも固定されていなかった（段 6 と段 7 を入れ替える変異が
// main.test.ts 100 件すべてを素通りした）。ここでロックする。
describe("main evaluate T24: 処理の順序（ハッシュ照合が validateFindingRanges より前。レビュー指摘 Important 1）", () => {
  it("--export：正解ファイルの bodyHash が違い、かつ指摘の quote/range も本文と合わないとき、bodyHash の食い違いだけが出る", async () => {
    const otherHash = "b".repeat(64);
    const captured = buildEvalExportIO({
      readTruthBytes: () =>
        Promise.resolve(
          new TextEncoder().encode(JSON.stringify(evalTruthJson({ bodyHash: otherHash }))),
        ),
      readExportBytes: () =>
        Promise.resolve(
          new TextEncoder().encode(JSON.stringify(evalExportJsonWithMismatchedFinding())),
        ),
    });
    const code = await main(EVAL_ARGS_EXPORT, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("bodyHash が一致しません");
    expect(stderr).not.toContain("quote が本文の該当範囲と一致しません");
  });

  it("--result：結果 JSON が別原稿のもの（bodyHash も quote/range も食い違う）でも、bodyHash の食い違いだけが出る", async () => {
    const captured = buildEvalIO({
      readResultBytes: () =>
        Promise.resolve(
          new TextEncoder().encode(JSON.stringify(evalResultJsonForDifferentManuscript())),
        ),
    });
    const code = await main(EVAL_ARGS, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("bodyHash が一致しません");
    expect(stderr).not.toContain("quote が本文の該当範囲と一致しません");
  });
});

describe("main evaluate T24: --export の読み込み失敗（パスの漏えいを防ぐ。決定9・29）", () => {
  const SENTINEL_PATH = "/private/leak-should-not-appear/export.json";
  const sentinelError = (prefix: string) =>
    new Error(`${prefix}: no such file or directory, open '${SENTINEL_PATH}'`);

  it("存在しないファイル：例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildEvalExportIO({
      readExportBytes: () => Promise.reject(sentinelError("ENOENT")),
    });
    const code = await main(EVAL_ARGS_EXPORT, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("壊れた JSON：固定文言のエラーになる", async () => {
    const captured = buildEvalExportIO({
      readExportBytes: () => Promise.resolve(new TextEncoder().encode("{ 壊れた json")),
    });
    const code = await main(EVAL_ARGS_EXPORT, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).toContain("エクスポートファイルの JSON 構文が不正です");
  });

  it("スキーマ違反（必須項目の欠落）：固定文言のエラーになりパスを含まない", async () => {
    const invalid = evalExportJson() as Record<string, unknown>;
    delete invalid.manuscript;
    const captured = buildEvalExportIO({
      readExportBytes: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(invalid))),
    });
    const code = await main(EVAL_ARGS_EXPORT, {}, captured.io);

    expect(code).toBe(1);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("エクスポートファイルの検証に失敗しました");
    expect(stderr).not.toContain(SENTINEL_PATH);
    expect(stderr).not.toContain("export.json");
  });
});

// --- aggregate サブコマンド（Task 7：決定 3・4・9・10・12・13・18・21） ------------------------------
//
// すべて合成のテキスト・合成の JSON（実原稿の断片を含まない）。`evaluate` が使う部品
// （parseResultJson・resolveTruthEntries・scoreRun）をそのまま流用する。

const AGGREGATE_ARGS = [
  "aggregate",
  "--manuscript",
  "manuscript.txt",
  "--truth",
  "truth.json",
  "--result",
  "result1.json",
  "--result",
  "result2.json",
];

/**
 * 既定では2本の --result がどちらも同じ内容（evalResultJson()）を返す（条件が一致するので
 * 集計が成功する）。個別の結果 JSON を変えたいテストは readResultBytes をパスで分岐して上書きする。
 */
function buildAggregateIO(overrides: Partial<MainIO> = {}): CapturedIO {
  return buildIO({
    readManuscriptBytes: () => Promise.resolve(new TextEncoder().encode(EVAL_TEXT)),
    readTruthBytes: () =>
      Promise.resolve(new TextEncoder().encode(JSON.stringify(evalTruthJson()))),
    readResultBytes: () =>
      Promise.resolve(new TextEncoder().encode(JSON.stringify(evalResultJson()))),
    ...overrides,
  });
}

describe("main aggregate T10: 複数回実行の集計（決定12）", () => {
  it("条件が一致していれば集計JSONを標準出力に書く", async () => {
    const captured = buildAggregateIO();
    const code = await main(AGGREGATE_ARGS, {}, captured.io);

    expect(code).toBe(0);
    expect(captured.stdout).toHaveLength(1);
    const parsed = JSON.parse(captured.stdout[0] ?? "") as {
      formatVersion?: unknown;
      runCount?: unknown;
    };
    expect(parsed.formatVersion).toBe("1");
    expect(parsed.runCount).toBe(2);
  });

  it("条件が食い違う結果を混ぜると集計せずエラー終了する（決定12）", async () => {
    const captured = buildAggregateIO({
      readResultBytes: (path) =>
        Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify(
              path === "result2.json" ? evalResultJson({ mode: "full-text" }) : evalResultJson(),
            ),
          ),
        ),
    });
    const code = await main(AGGREGATE_ARGS, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
    expect(captured.stderr.join("\n")).toContain("mode");
  });

  it("処理の順序：ハッシュ照合を validateFindingRanges より先に行う（evaluate と同じ順序）", async () => {
    // 2本目が「別の原稿に対する結果 JSON」（bodyHash も違い、quote/range も本文と一致しない）。
    // ハッシュ照合が先なら「bodyHash が一致しません」という分かりやすいエラーになる。
    // 順序を入れ替える変異（validateFindingRanges を先に行う）だと、分かりにくい
    // 「quote が本文の該当範囲と一致しません」が先に出て、このテストは落ちる。
    const captured = buildAggregateIO({
      readResultBytes: (path) =>
        Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify(
              path === "result2.json" ? evalResultJsonForDifferentManuscript() : evalResultJson(),
            ),
          ),
        ),
    });
    const code = await main(AGGREGATE_ARGS, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("bodyHash が一致しません");
    expect(stderr).not.toContain("quote が本文の該当範囲と一致しません");
  });
});

describe("main aggregate T34: 全文チャットの結果は受け取らない（決定39）", () => {
  it("--result に全文チャットの結果を渡すと拒否される", async () => {
    // 防壁は evaluate と共有の parseResultJson だが、aggregate 側でも閉じていることを
    // 記録に残す（最終レビュー m-4）。
    const captured = buildAggregateIO({
      readResultBytes: () =>
        Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify({ formatVersion: "full-chat/1", status: "completed" }),
          ),
        ),
    });
    const code = await main(AGGREGATE_ARGS, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.stderr.join("\n")).toContain("全文チャット方式");
  });
});

describe("main aggregate T19: 出力先の衝突（決定21）", () => {
  it("--out と --report が同じパス文字列ならエラー", async () => {
    const captured = buildAggregateIO();
    const code = await main(
      [...AGGREGATE_ARGS, "--out", "same.json", "--report", "same.json"],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("--out");
    expect(stderr).toContain("--report");
  });

  it("--out が --manuscript と同じパス文字列ならエラー", async () => {
    const captured = buildAggregateIO();
    const code = await main([...AGGREGATE_ARGS, "--out", "manuscript.txt"], {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.stderr.join("\n")).toContain("--manuscript");
  });

  it("--report が --truth と同じ実体（dev/ino 一致。シンボリックリンク・ハードリンク経由の別名を想定）ならエラー", async () => {
    const identities: Readonly<Record<string, { dev: number; ino: number }>> = {
      "report.md": { dev: 1, ino: 100 },
      "truth.json": { dev: 1, ino: 100 },
      "manuscript.txt": { dev: 1, ino: 1 },
      "result1.json": { dev: 1, ino: 2 },
      "result2.json": { dev: 1, ino: 3 },
    };
    const captured = buildAggregateIO({
      statFile: (path) => Promise.resolve(identities[path] ?? null),
    });
    const code = await main([...AGGREGATE_ARGS, "--report", "report.md"], {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.stderr.join("\n")).toContain("--truth");
  });

  it("--result どうしが同じパス文字列なら重複としてエラー（ぶれを偽装するため。決定21）", async () => {
    const captured = buildAggregateIO();
    const code = await main(
      [
        "aggregate",
        "--manuscript",
        "manuscript.txt",
        "--truth",
        "truth.json",
        "--result",
        "same-result.json",
        "--result",
        "same-result.json",
      ],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("--result");
    expect(stderr).not.toContain("same-result.json");
  });

  it("--result どうしが同じ実体（dev/ino 一致。シンボリックリンク・ハードリンク経由の別名を想定）なら重複としてエラー", async () => {
    const identities: Readonly<Record<string, { dev: number; ino: number }>> = {
      "manuscript.txt": { dev: 1, ino: 1 },
      "truth.json": { dev: 1, ino: 2 },
      "result-a.json": { dev: 1, ino: 100 },
      "result-b-link.json": { dev: 1, ino: 100 },
    };
    const captured = buildAggregateIO({
      statFile: (path) => Promise.resolve(identities[path] ?? null),
    });
    const code = await main(
      [
        "aggregate",
        "--manuscript",
        "manuscript.txt",
        "--truth",
        "truth.json",
        "--result",
        "result-a.json",
        "--result",
        "result-b-link.json",
      ],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.stderr.join("\n")).toContain("--result");
  });

  it("3本目以降で重複していても検出する（1本目と3本目の重複）", async () => {
    const captured = buildAggregateIO();
    const code = await main(
      [
        "aggregate",
        "--manuscript",
        "manuscript.txt",
        "--truth",
        "truth.json",
        "--result",
        "a.json",
        "--result",
        "b.json",
        "--result",
        "a.json",
      ],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).toContain("--result");
  });

  it("エラーメッセージにパス文字列を含めない", async () => {
    const captured = buildAggregateIO();
    const code = await main([...AGGREGATE_ARGS, "--out", "manuscript.txt"], {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain("manuscript.txt");
  });

  it("入力どうし（--manuscript と --truth）が同じ実体でも衝突エラーにはならず、後段の JSON 解析エラーになる（決定21の絞り込み）", async () => {
    const captured = buildAggregateIO({
      readTruthBytes: (path) =>
        path === "manuscript.txt"
          ? Promise.resolve(new TextEncoder().encode(EVAL_TEXT))
          : Promise.resolve(new TextEncoder().encode(JSON.stringify(evalTruthJson()))),
    });
    const code = await main(
      [
        "aggregate",
        "--manuscript",
        "manuscript.txt",
        "--truth",
        "manuscript.txt",
        "--result",
        "result1.json",
        "--result",
        "result2.json",
      ],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).not.toContain("が同じファイルを指しています");
    expect(stderr).toContain("正解ファイルの JSON 構文が不正です");
  });

  it("--manuscript と --truth が同じ実体でも、--result どうしの重複を見逃さない（M-3修正）", async () => {
    // --manuscript と --truth の衝突（決定21の対象外）が namedPaths の並びで --result より先に
    // 現れるため、findPathConflict を1回しか呼ばないと --result の重複が見逃されていた
    // （修正前のバグ）。--result どうしの検査を別に呼ぶことで、この組み合わせでも検出できる。
    const captured = buildAggregateIO();
    const code = await main(
      [
        "aggregate",
        "--manuscript",
        "manuscript.txt",
        "--truth",
        "manuscript.txt",
        "--result",
        "same-result.json",
        "--result",
        "same-result.json",
      ],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("--result");
    expect(stderr).not.toContain("same-result.json");
    // 後段（正解ファイルの JSON 解析）まで進まず、--result の重複検査で先に失敗したことの確認。
    expect(stderr).not.toContain("正解ファイルの JSON 構文が不正です");
    expect(stderr).not.toContain("が同じファイルを指しています");
  });

  it("衝突が無ければ従来どおり集計が実行される", async () => {
    const captured = buildAggregateIO();
    const code = await main(
      [...AGGREGATE_ARGS, "--out", "aggregate.json", "--report", "report.md"],
      {},
      captured.io,
    );
    expect(code).toBe(0);
    expect(captured.writtenFiles.map((file) => file.path)).toEqual(["aggregate.json", "report.md"]);
  });

  it("レポートの組み立てが失敗しても --out に何も書き出さない（M-2修正）", async () => {
    // evaluate と同じ検証：formatAggregateReport が --out の書き出しより前に呼ばれるので、
    // それが失敗すると --out にも一切書き出されない。
    const spy = vi.spyOn(aggregateReportModule, "formatAggregateReport").mockImplementation(() => {
      throw new Error("レポート組み立ての失敗（テスト用）");
    });
    try {
      const captured = buildAggregateIO();
      await expect(
        main(
          [...AGGREGATE_ARGS, "--out", "aggregate.json", "--report", "report.md"],
          {},
          captured.io,
        ),
      ).rejects.toThrow("レポート組み立ての失敗（テスト用）");
      expect(captured.writtenFiles).toHaveLength(0);
      expect(captured.stdout).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

// --- aggregate の --export（Task 11：決定 29） ---------------------------------------------------

describe("main aggregate T24: --export の配線（決定29）", () => {
  it("入力（--result / --export）が合計1本だと引数エラーになる", async () => {
    const captured = buildAggregateIO();
    const code = await main(
      ["aggregate", "--truth", "truth.json", "--export", "export.json"],
      {},
      captured.io,
    );
    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("--result");
    expect(stderr).toContain("--export");
  });

  it("--export を2本渡すと集計できる（--manuscript 不要。本文は最初の --export の埋め込み本文）", async () => {
    // run.id をファイルごとに変える（決定33：同じ run.id を2本渡すと拒否されるため。T27）。
    const captured = buildAggregateIO({
      readExportBytes: (path) =>
        Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify(evalExportJson({ runId: path === "b.json" ? "r2" : "r1" })),
          ),
        ),
    });
    const code = await main(
      ["aggregate", "--truth", "truth.json", "--export", "a.json", "--export", "b.json"],
      {},
      captured.io,
    );

    expect(code).toBe(0);
    expect(captured.stdout).toHaveLength(1);
    const parsed = JSON.parse(captured.stdout[0] ?? "") as {
      formatVersion?: unknown;
      runCount?: unknown;
    };
    expect(parsed.formatVersion).toBe("1");
    expect(parsed.runCount).toBe(2);
  });

  // T28（決定28(c)）：--export を含む集計のレポートに出どころの行が出て、--result だけの集計
  // では出ない。main.ts の配線（formatAggregateReport に渡す第2引数）を確かめる。
  it('--export を含む集計では formatAggregateReport へ "export" が渡り、レポートに出どころの行が出る', async () => {
    const spy = vi.spyOn(aggregateReportModule, "formatAggregateReport");
    try {
      const captured = buildAggregateIO({
        readExportBytes: (path) =>
          Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify(evalExportJson({ runId: path === "b.json" ? "r2" : "r1" })),
            ),
          ),
      });
      const code = await main(
        [
          "aggregate",
          "--truth",
          "truth.json",
          "--export",
          "a.json",
          "--export",
          "b.json",
          "--report",
          "report.md",
        ],
        {},
        captured.io,
      );

      expect(code).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[1]).toBe("export");
      const reportFile = captured.writtenFiles.find((file) => file.path === "report.md");
      expect(reportFile?.content).toContain("入力：エクスポート JSON（サーバー経由の実行）");
    } finally {
      spy.mockRestore();
    }
  });

  it('--result だけの集計では formatAggregateReport へ "result" が渡り、レポートに出どころの行が出ない', async () => {
    const spy = vi.spyOn(aggregateReportModule, "formatAggregateReport");
    try {
      const captured = buildAggregateIO();
      const code = await main(
        [...AGGREGATE_ARGS, "--out", "aggregate.json", "--report", "report.md"],
        {},
        captured.io,
      );

      expect(code).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[1]).toBe("result");
      const reportFile = captured.writtenFiles.find((file) => file.path === "report.md");
      expect(reportFile?.content).not.toContain("入力：エクスポート JSON");
    } finally {
      spy.mockRestore();
    }
  });

  // レビュー指摘 Important 1(c)：本文は「最初の --export」から採るが、2 本目以降の本文が
  // 違っていても（かつ 2 本目の指摘の quote/range が 1 本目の本文と食い違っていても）
  // ハッシュ照合が validateFindingRanges より先に働き、bodyHash の食い違いだけが報告される
  // ことを検査する。
  it("処理の順序：--export 2本の本文が違うとき、ハッシュ照合が validateFindingRanges より先に働く", async () => {
    const secondBody = "かきくけこ";
    // run.id をファイルごとに変える（決定33の重複検査に引っかからないようにするため。T27）。
    const captured = buildAggregateIO({
      readExportBytes: (path) =>
        Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify(
              path === "b.json"
                ? evalExportJsonWithMismatchedFinding({ body: secondBody, runId: "r2" })
                : evalExportJson(),
            ),
          ),
        ),
    });
    const code = await main(
      ["aggregate", "--truth", "truth.json", "--export", "a.json", "--export", "b.json"],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("bodyHash が一致しません");
    expect(stderr).not.toContain("quote が本文の該当範囲と一致しません");
  });

  it("--export どうしが同じパス文字列なら重複としてエラー（--result と同じ扱い。決定21・29）", async () => {
    const captured = buildAggregateIO();
    const code = await main(
      [
        "aggregate",
        "--truth",
        "truth.json",
        "--export",
        "same-export.json",
        "--export",
        "same-export.json",
      ],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("--export");
    expect(stderr).not.toContain("same-export.json");
  });

  it("--export どうしが同じ実体（dev/ino 一致）なら重複としてエラー", async () => {
    const identities: Readonly<Record<string, { dev: number; ino: number }>> = {
      "truth.json": { dev: 1, ino: 1 },
      "export-a.json": { dev: 1, ino: 100 },
      "export-b-link.json": { dev: 1, ino: 100 },
    };
    const captured = buildAggregateIO({
      statFile: (path) => Promise.resolve(identities[path] ?? null),
    });
    const code = await main(
      [
        "aggregate",
        "--truth",
        "truth.json",
        "--export",
        "export-a.json",
        "--export",
        "export-b-link.json",
      ],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.stderr.join("\n")).toContain("--export");
  });

  it("出力先の衝突検査に --export が入る（--out と同じパス文字列の --export → 拒否）", async () => {
    const captured = buildAggregateIO();
    const code = await main(
      [
        "aggregate",
        "--truth",
        "truth.json",
        "--export",
        "a.json",
        "--export",
        "b.json",
        "--out",
        "a.json",
      ],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("--out");
    expect(stderr).toContain("--export");
  });

  it("--export の読み込み失敗（存在しないファイル）：パスを出さずに固定文のエラーになる", async () => {
    const SENTINEL_PATH = "/private/leak-should-not-appear/aggregate-export.json";
    const captured = buildAggregateIO({
      readExportBytes: () =>
        Promise.reject(new Error(`ENOENT: no such file or directory, open '${SENTINEL_PATH}'`)),
    });
    const code = await main(
      ["aggregate", "--truth", "truth.json", "--export", "a.json", "--export", "b.json"],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });
});

// --- aggregate の --export：同じ実行の二重集計を拒否する（決定33。T27） ---------------------------
//
// 決定21の重複検査（ファイルの実体＝正規化パス＋dev/ino）は、同じ実行を2回エクスポートした
// 2ファイル（内容はほぼ同じで exportedAt だけ違う）を別物と判定してしまう。--export は run.id を
// 持つので、ここに限って run.id の重複を別途拒否する。--result どうし・--result と --export の
// 間では見ない（決定33。手がかりが無いため）。

describe("main aggregate T27: 同じ実行の二重集計を拒否する（決定33）", () => {
  it("同じ run.id を持つ2つの --export は拒否され、メッセージに実行 ID が出てパスは出ない", async () => {
    const captured = buildAggregateIO({
      readExportBytes: (path) =>
        Promise.resolve(
          new TextEncoder().encode(
            // a.json・b.json とも run.id は既定の "r1"（実体・パス文字列はどちらも異なる）。
            JSON.stringify(evalExportJson({ body: path === "b.json" ? "かきくけこ" : EVAL_TEXT })),
          ),
        ),
    });
    const code = await main(
      ["aggregate", "--truth", "truth.json", "--export", "a.json", "--export", "b.json"],
      {},
      captured.io,
    );

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("--export");
    expect(stderr).toContain("r1");
    expect(stderr).not.toContain("a.json");
    expect(stderr).not.toContain("b.json");
  });

  it("run.id が異なる --export どうしは重複とみなされず、そのまま集計できる", async () => {
    const captured = buildAggregateIO({
      readExportBytes: (path) =>
        Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify(evalExportJson({ runId: path === "b.json" ? "r2" : "r1" })),
          ),
        ),
    });
    const code = await main(
      ["aggregate", "--truth", "truth.json", "--export", "a.json", "--export", "b.json"],
      {},
      captured.io,
    );

    expect(code).toBe(0);
    expect(captured.stdout).toHaveLength(1);
    const parsed = JSON.parse(captured.stdout[0] ?? "") as { runCount?: unknown };
    expect(parsed.runCount).toBe(2);
  });
});

describe("main aggregate T22: パスの漏えいを防ぐ（決定9）", () => {
  const SENTINEL_PATH = "/private/leak-should-not-appear/aggregate.json";
  const sentinelError = (prefix: string) =>
    new Error(`${prefix}: no such file or directory, open '${SENTINEL_PATH}'`);

  it("原稿読み込み失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildAggregateIO({
      readManuscriptBytes: () => Promise.reject(sentinelError("ENOENT")),
    });
    const code = await main(AGGREGATE_ARGS, {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("正解ファイル読み込み失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildAggregateIO({
      readTruthBytes: () => Promise.reject(sentinelError("ENOENT")),
    });
    const code = await main(AGGREGATE_ARGS, {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("結果ファイル読み込み失敗の例外にパスが含まれても標準エラーに出さない（2本目で失敗）", async () => {
    const captured = buildAggregateIO({
      readResultBytes: (path) =>
        path === "result2.json"
          ? Promise.reject(sentinelError("ENOENT"))
          : Promise.resolve(new TextEncoder().encode(JSON.stringify(evalResultJson()))),
    });
    const code = await main(AGGREGATE_ARGS, {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("集計 JSON の書き出し失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildAggregateIO({
      writeResult: () => Promise.reject(sentinelError("EACCES")),
    });
    const code = await main([...AGGREGATE_ARGS, "--out", "aggregate.json"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });

  it("レポートの書き出し失敗の例外にパスが含まれても標準エラーに出さない", async () => {
    const captured = buildAggregateIO({
      writeResult: (outPath) =>
        outPath === "report.md" ? Promise.reject(sentinelError("EACCES")) : Promise.resolve(),
    });
    const code = await main([...AGGREGATE_ARGS, "--report", "report.md"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SENTINEL_PATH);
    expect(captured.stdout.join("\n")).not.toContain(SENTINEL_PATH);
  });
});

// --- full-chat サブコマンド（Task 15：決定 15・34・37・38・39） ---------------------------------
//
// すべて合成のテキスト・合成のプロンプト（実原稿の断片を含まない）。実 LM Studio には触れない。

const FULL_CHAT_ARGS = [
  "full-chat",
  "--manuscript",
  "manuscript.txt",
  "--model",
  "test-model",
  "--prompt-file",
  "prompt.txt",
];

const FULL_CHAT_PROMPT = "指示。\n{{manuscript}}\n以上。";
const FULL_CHAT_TEXT = "これは合成の原稿です。";

function fullChatModelInfo(): ModelInfo {
  return {
    id: "test-model",
    type: "llm",
    state: "loaded",
    quantization: null,
    maxContextLength: null,
    loadedContextLength: null,
  };
}

function fullChatChatResult(overrides: Partial<ChatResult> = {}): ChatResult {
  return {
    content: "応答本文",
    reasoningContent: null,
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, reasoningTokens: null },
    raw: { dummy: true },
    ...overrides,
  };
}

interface FullChatClientHandle {
  readonly client: LmStudioClient;
  readonly ensureLoaded: ReturnType<typeof vi.fn>;
  readonly chat: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

/** `full-chat` の `createClient` が返すクライアント。呼ばれたかどうかをテストから見える形にする。 */
function makeFullChatClient(
  overrides: {
    readonly ensureLoaded?: LmStudioClient["ensureLoaded"];
    readonly chat?: LmStudioClient["chat"];
    readonly close?: LmStudioClient["close"];
  } = {},
): FullChatClientHandle {
  const ensureLoaded = vi.fn(
    overrides.ensureLoaded ?? (() => Promise.resolve(fullChatModelInfo())),
  );
  const chat = vi.fn(overrides.chat ?? (() => Promise.resolve(fullChatChatResult())));
  const close = vi.fn(overrides.close ?? (() => Promise.resolve(undefined)));
  const client: LmStudioClient = {
    listModels: () => Promise.reject(new Error("テストでは呼ばれない想定")),
    ensureLoaded,
    chat,
    close,
  };
  return { client, ensureLoaded, chat, close };
}

function buildFullChatIO(
  overrides: Partial<MainIO> = {},
  clientOverrides: {
    readonly ensureLoaded?: LmStudioClient["ensureLoaded"];
    readonly chat?: LmStudioClient["chat"];
    readonly close?: LmStudioClient["close"];
  } = {},
): CapturedIO & { readonly fullChatClient: FullChatClientHandle } {
  const fullChatClient = makeFullChatClient(clientOverrides);
  const receivedClientOptions: LmStudioClientOptions[] = [];
  const captured = buildIO({
    readManuscriptBytes: () => Promise.resolve(new TextEncoder().encode(FULL_CHAT_TEXT)),
    readPromptBytes: () => Promise.resolve(new TextEncoder().encode(FULL_CHAT_PROMPT)),
    createClient: (options) => {
      receivedClientOptions.push(options);
      return fullChatClient.client;
    },
    ...overrides,
  });
  return { ...captured, receivedClientOptions, fullChatClient };
}

describe("main full-chat T32: 出力先の衝突（決定38）", () => {
  it("--out と --manuscript が同じ実体のとき、終了コード1で拒否され createClient/ensureLoaded/chat を呼ばない", async () => {
    const captured = buildFullChatIO({
      statFile: (path) =>
        Promise.resolve(
          path === "out.json" || path === "manuscript.txt" ? { dev: 1, ino: 1 } : null,
        ),
    });
    const code = await main([...FULL_CHAT_ARGS, "--out", "out.json"], {}, captured.io);

    expect(code).toBe(1);
    expect(captured.receivedClientOptions).toHaveLength(0);
    expect(captured.fullChatClient.ensureLoaded).not.toHaveBeenCalled();
    expect(captured.fullChatClient.chat).not.toHaveBeenCalled();
    expect(captured.writtenFiles).toHaveLength(0);
  });

  it("--out と --prompt-file が同じ実体のときも同様に拒否する", async () => {
    const captured = buildFullChatIO({
      statFile: (path) =>
        Promise.resolve(path === "out.json" || path === "prompt.txt" ? { dev: 2, ino: 2 } : null),
    });
    const code = await main([...FULL_CHAT_ARGS, "--out", "out.json"], {}, captured.io);

    expect(code).toBe(1);
    expect(captured.receivedClientOptions).toHaveLength(0);
    expect(captured.fullChatClient.ensureLoaded).not.toHaveBeenCalled();
    expect(captured.fullChatClient.chat).not.toHaveBeenCalled();
    expect(captured.writtenFiles).toHaveLength(0);
  });
});

describe("main full-chat T33: パスの漏えいを防ぐ（決定9・38）", () => {
  const SENTINEL_PATH = "/private/leak-should-not-appear/prompt.txt";
  const sentinelError = (prefix: string) =>
    new Error(`${prefix}: no such file or directory, open '${SENTINEL_PATH}'`);

  function expectNoLeak(stderr: readonly string[]): void {
    const all = stderr.join("\n");
    expect(all).not.toContain(SENTINEL_PATH);
    expect(all).not.toContain("manuscript.txt");
    expect(all).not.toContain("prompt.txt");
    expect(all).not.toContain(FULL_CHAT_PROMPT);
    expect(all).not.toContain(FULL_CHAT_TEXT);
  }

  it("プロンプトファイルが読めないとき、標準エラーにパス・原稿・プロンプトを含めない", async () => {
    const captured = buildFullChatIO({
      readPromptBytes: () => Promise.reject(sentinelError("ENOENT")),
    });
    const code = await main(FULL_CHAT_ARGS, {}, captured.io);
    expect(code).toBe(1);
    expectNoLeak(captured.stderr);
  });

  it("プロンプトファイルが UTF-8 でないとき、標準エラーにパス・原稿・プロンプトを含めない", async () => {
    const captured = buildFullChatIO({
      readPromptBytes: () => Promise.resolve(new Uint8Array([0xff])),
    });
    const code = await main(FULL_CHAT_ARGS, {}, captured.io);
    expect(code).toBe(1);
    expectNoLeak(captured.stderr);
  });

  it("SHUTEN_LM_STUDIO_URL が不正なとき、標準エラーにその値を含めない", async () => {
    const SECRET_URL = "http://secret-lmstudio-host.internal:19999/with-a-path";
    const captured = buildFullChatIO();
    const code = await main(FULL_CHAT_ARGS, { SHUTEN_LM_STUDIO_URL: SECRET_URL }, captured.io);
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain(SECRET_URL);
    expect(captured.stderr.join("\n")).not.toContain("secret-lmstudio-host");
  });

  it("必須オプションが欠けているとき、標準エラーにパスを含めない", async () => {
    const captured = buildFullChatIO();
    const code = await main(
      ["full-chat", "--model", "test-model", "--prompt-file", "prompt-path-should-not-leak.txt"],
      {},
      captured.io,
    );
    expect(code).toBe(1);
    expect(captured.stderr.join("\n")).not.toContain("prompt-path-should-not-leak.txt");
  });
});

describe("main evaluate T34: full-chat 方式の結果は evaluate に渡せない（決定39）", () => {
  it("--result に full-chat 方式の結果を渡すと終了コードが 0 以外になり、標準エラーに「全文チャット方式」を含む", async () => {
    const fullChatResultJson = {
      formatVersion: FULL_CHAT_FORMAT_VERSION,
      status: "completed",
      content: "本文",
      reasoningContent: null,
      finishReason: "stop",
      usage: null,
      failure: null,
      conditions: {
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        model: null,
        generation: { model: "test-model", maxTokens: 100, temperature: 0.2 },
        timeouts: { checkMs: 300000 },
        manuscript: { utf16Length: 5, graphemeCount: 5, paragraphCount: 1, bodyHash: EVAL_HASH },
        promptHash: "dummy-hash",
      },
    };
    const captured = buildEvalIO({
      readResultBytes: () =>
        Promise.resolve(new TextEncoder().encode(JSON.stringify(fullChatResultJson))),
    });

    const code = await main(EVAL_ARGS, {}, captured.io);

    expect(code).not.toBe(0);
    expect(captured.stderr.join("\n")).toContain("全文チャット方式");
  });
});

describe("main full-chat: 通し", () => {
  it("成功時、終了コード0で書かれたJSONのformatVersionがfull-chat/1になる", async () => {
    const captured = buildFullChatIO();
    const code = await main(FULL_CHAT_ARGS, {}, captured.io);

    expect(code).toBe(0);
    expect(captured.stdout).toHaveLength(1);
    const parsed = JSON.parse(captured.stdout[0] ?? "") as {
      formatVersion: string;
      status: string;
    };
    expect(parsed.formatVersion).toBe(FULL_CHAT_FORMAT_VERSION);
    expect(parsed.status).toBe("completed");
  });

  it("引数の生成設定とタイムアウトが、要求にも結果の実行条件にも写る", async () => {
    // 最終レビュー I-1：main.ts の generation の組み立てと timeoutMs の受け渡し、
    // full-chat.ts の ChatRequest と conditions を、どのテストも守っていなかった
    // （max_tokens と temperature を入れ替える変異が全テストを通り抜けた）。
    // PR13b は「4 方式を同じ条件で比較した」ことを conditions で示すので、ここがずれると
    // 比較の前提が静かに崩れる。任意オプションを全部渡した 1 本でまとめて固定する。
    const captured = buildFullChatIO();
    const code = await main(
      [
        ...FULL_CHAT_ARGS,
        "--max-tokens",
        "1234",
        "--temperature",
        "0.25",
        "--seed",
        "99",
        "--reasoning-effort",
        "medium",
        "--check-timeout-ms",
        "45678",
      ],
      {},
      captured.io,
    );

    expect(code).toBe(0);

    const [request, options] = captured.fullChatClient.chat.mock.calls[0] as [
      ChatRequest,
      { readonly timeoutMs: number },
    ];
    expect(request.model).toBe("test-model");
    expect(request.maxTokens).toBe(1234);
    expect(request.temperature).toBe(0.25);
    expect(request.seed).toBe(99);
    expect(request.reasoningEffort).toBe("medium");
    expect(options.timeoutMs).toBe(45678);

    const parsed = JSON.parse(captured.stdout[0] ?? "") as {
      conditions: {
        generation: {
          model: string;
          maxTokens: number;
          temperature: number;
          seed?: number;
          reasoningEffort: string;
        };
        timeouts: { checkMs: number };
      };
    };
    expect(parsed.conditions.generation).toEqual({
      model: "test-model",
      maxTokens: 1234,
      temperature: 0.25,
      seed: 99,
      reasoningEffort: "medium",
    });
    expect(parsed.conditions.timeouts.checkMs).toBe(45678);
  });

  it("client.close() が失敗しても結果 JSON は書かれ、終了コードは変わらない", async () => {
    // 最終レビュー m-1：close の失敗で書き出しが飛ぶと、決定 37 の
    // 「失敗でも結果 JSON は書く」が破れ、bin に catch が無いので未処理の拒否になる。
    const captured = buildFullChatIO(
      {},
      { close: () => Promise.reject(new Error("閉じられない")) },
    );
    const code = await main(FULL_CHAT_ARGS, {}, captured.io);

    expect(code).toBe(0);
    expect(captured.stdout).toHaveLength(1);
  });

  it("--out を指定すると出力先ファイルに書き出す", async () => {
    const captured = buildFullChatIO();
    const code = await main([...FULL_CHAT_ARGS, "--out", "result.json"], {}, captured.io);

    expect(code).toBe(0);
    expect(captured.writtenFiles).toHaveLength(1);
    expect(captured.writtenFiles[0]?.path).toBe("result.json");
  });

  it("失敗時（chat が truncated を投げる）、終了コード2で、writeResult が呼ばれている", async () => {
    const captured = buildFullChatIO(
      {},
      {
        chat: () =>
          Promise.reject(
            new LmStudioError("truncated", "生成が通常どおり終わらなかった", {
              finishReason: "length",
            }),
          ),
      },
    );

    const code = await main(FULL_CHAT_ARGS, {}, captured.io);

    expect(code).toBe(2);
    expect(captured.stdout).toHaveLength(1);
    const parsed = JSON.parse(captured.stdout[0] ?? "") as { status: string };
    expect(parsed.status).toBe("failed");
  });

  it("client.close() が成功時に呼ばれる", async () => {
    const captured = buildFullChatIO();
    await main(FULL_CHAT_ARGS, {}, captured.io);
    expect(captured.fullChatClient.close).toHaveBeenCalledTimes(1);
  });

  it("client.close() が失敗時にも呼ばれる", async () => {
    const captured = buildFullChatIO(
      {},
      {
        chat: () =>
          Promise.reject(new LmStudioError("truncated", "失敗", { finishReason: "length" })),
      },
    );
    await main(FULL_CHAT_ARGS, {}, captured.io);
    expect(captured.fullChatClient.close).toHaveBeenCalledTimes(1);
  });

  it("runFullChat が想定外の例外を投げても終了コード1で、原因は表示せず、client.close() は呼ばれる", async () => {
    const captured = buildFullChatIO(
      {},
      {
        chat: () => Promise.reject(new Error("boom", { cause: new Error("ECONNREFUSED") })),
      },
    );

    const code = await main(FULL_CHAT_ARGS, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
    expect(captured.stderr.join("\n")).toContain("全文チャットの実行中に想定外のエラーが発生した");
    expect(captured.stderr.join("\n")).not.toContain("boom");
    expect(captured.stderr.join("\n")).not.toContain("ECONNREFUSED");
    expect(captured.fullChatClient.close).toHaveBeenCalledTimes(1);
  });

  it("{{manuscript}} が無いプロンプトのとき、終了コード1で結果 JSON を書かない", async () => {
    const captured = buildFullChatIO({
      readPromptBytes: () =>
        Promise.resolve(new TextEncoder().encode("差し込み口が無いプロンプト")),
    });
    const code = await main(FULL_CHAT_ARGS, {}, captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toHaveLength(0);
    expect(captured.writtenFiles).toHaveLength(0);
    expect(captured.fullChatClient.ensureLoaded).not.toHaveBeenCalled();
  });
});
