import { hashBody } from "@shuten/server/hash.ts";
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
    readTruthBytes: () => Promise.reject(new Error("テストでは呼ばれない想定")),
    readResultBytes: () => Promise.reject(new Error("テストでは呼ばれない想定")),
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

  it("未知のサブコマンド名はエラーになる（終了コード1）", async () => {
    const captured = buildIO();
    const code = await main(["frobnicate", "--manuscript", "manuscript.txt"], {}, captured.io);
    expect(code).toBe(1);
    expect(captured.receivedPipelineArgs).toHaveLength(0);
    expect(captured.stderr.join("\n")).toContain("frobnicate");
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
