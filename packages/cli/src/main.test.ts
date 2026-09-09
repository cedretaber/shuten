import type { LmStudioClient, LmStudioClientOptions } from "@shuten/server/lmstudio/types.ts";
import type { PipelineArgs } from "@shuten/server/run/pipeline.ts";
import type { PipelineResult, PipelineRunStatus, RunStop } from "@shuten/server/run/result.ts";
import { RESULT_VERSION } from "@shuten/server/run/result.ts";
import { ingestUtf8Bytes } from "@shuten/shared";
import { describe, expect, it } from "vitest";

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
      manuscript: { utf16Length: 4, graphemeCount: 4, paragraphCount: 1, targetCount: 1 },
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
