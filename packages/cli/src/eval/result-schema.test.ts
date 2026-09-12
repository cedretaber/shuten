import type { PipelineResult } from "@shuten/server/run/result.ts";
import { RESULT_VERSION } from "@shuten/server/run/result.ts";
import { describe, expect, it } from "vitest";

import type { EvaluationResultInput } from "./result-schema.ts";
import { parseResultJson, validateFindingRanges } from "./result-schema.ts";

// すべて合成のテキスト（実原稿の断片を含まない）。

const VALID_HASH = "a".repeat(64);

/**
 * `runPipeline` が返す実際の形の結果（`PipelineResult`）。`targets` と `checkUnits`
 * （評価が読まないキー）を含めることで、これが検証に通ることを T16 の証拠にする
 * （変異：`result-schema.ts` のスキーマに `.strict()` を付ける → このテストが落ちる）。
 * 型注釈を `PipelineResult` にすることで、フィクスチャ自体が本物の形からずれていないことも
 * コンパイル時に保証する。
 */
function validPipelineResult(): PipelineResult {
  return {
    status: "completed",
    stop: null,
    conditions: {
      startedAt: "2024-01-01T00:00:00.000Z",
      finishedAt: "2024-01-01T00:01:00.000Z",
      mode: "split",
      perspectives: ["typo", "naturalness"],
      generation: { model: "test-model", maxTokens: 512, temperature: 0.2 },
      model: null,
      chunkSettings: {
        targetGraphemes: 1500,
        contextGraphemes: 1000,
        recheckContextGraphemes: 3000,
        roundingTolerance: 0.2,
        maxInputGraphemes: 8000,
      },
      timeouts: { checkMs: 30000, recheckMs: 30000 },
      allowedWords: [],
      versions: {
        result: RESULT_VERSION,
        prompt: "1",
        allowedWordRule: "1",
        diagnosticTransform: "1",
      },
      manuscript: {
        utf16Length: 6,
        graphemeCount: 6,
        paragraphCount: 1,
        targetCount: 1,
        bodyHash: VALID_HASH,
      },
    },
    targets: [
      {
        target: { index: 0, range: { start: 0, end: 6 }, paragraphIds: [0] },
        input: {
          target: { index: 0, range: { start: 0, end: 6 }, paragraphIds: [0] },
          context: { before: null, after: null },
          inputRange: { start: 0, end: 6 },
        },
      },
    ],
    checkUnits: [
      {
        status: "done",
        targetIndex: 0,
        perspective: "typo",
        attempts: 1,
        usage: null,
        inputGraphemes: 6,
        elapsedMs: 10,
        findingCount: 1,
      },
    ],
    findings: [
      {
        targetIndex: 0,
        finding: {
          id: "f1",
          range: { start: 1, end: 4 },
          quote: "いうえ",
          category: "notation",
          suggestion: null,
          verdict: "likely-error",
          sources: [
            {
              id: "c1",
              perspective: "typo",
              llm: {
                paragraphId: 0,
                quote: "いうえ",
                before: "あ",
                after: "お。",
                category: "notation",
                reason: "テスト理由",
                suggestion: null,
                verdict: "likely-error",
              },
              locate: { status: "located", range: { start: 1, end: 4 } },
            },
          ],
        },
        suppression: null,
        recheck: { status: "disabled" },
      },
    ],
    unlocated: [
      {
        targetIndex: 0,
        candidate: {
          id: "c2",
          perspective: "naturalness",
          llm: {
            paragraphId: 0,
            quote: "かきくけ",
            before: "",
            after: "",
            category: "unclear",
            reason: "テスト理由2",
            suggestion: null,
            verdict: "confirm-with-author",
          },
          locate: { status: "failed", reason: "not-found", exactMatches: [], diagnostic: null },
        },
      },
    ],
    totals: {
      targets: 1,
      checkUnits: { done: 1, failed: 0, pending: 0 },
      requests: 1,
      candidates: 2,
      located: 1,
      unlocated: { notFound: 1, ambiguous: 0, outsideTarget: 0 },
      findings: 1,
      suppressed: 0,
      rechecks: { done: 0, failed: 0, pending: 0, suppressed: 0, disabled: 1 },
      elapsedMs: 100,
    },
  };
}

/**
 * `stop` が非 null（`failure` も非 null）の実際の形。`status: "stopped"` はこの評価ツールが
 * 扱う中心的な結果状態の 1 つ（実行が途中で止まった結果を採点する場面）なので、`stop` を
 * まるごと読む経路（`runStopSchema` / `unitFailureSchema`、`STOP_REASONS` / `FAILURE_REASONS` /
 * `UNIT_FAILURE_ORIGINS`）を実際にパースするテストを持つ。
 */
function stoppedPipelineResult(): PipelineResult {
  return {
    ...validPipelineResult(),
    status: "stopped",
    stop: {
      reason: "connection-lost",
      message: "LM Studio への接続が失われました",
      failure: {
        reason: "connection",
        message: "接続エラー",
        finishReason: null,
        origin: "chat",
      },
      generationUnconfirmed: true,
    },
  };
}

/** JSON をネストしたパスで書き換えるための小道具（テスト用。値の型は問わない）。 */
function withPatch(json: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const clone = structuredClone(json) as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (key === undefined) throw new Error("起こりえない");
    cursor = cursor[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1];
  if (lastKey === undefined) throw new Error("起こりえない");
  cursor[lastKey] = value;
  return clone;
}

function deleteAt(json: unknown, path: readonly (string | number)[]): unknown {
  const clone = structuredClone(json) as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (key === undefined) throw new Error("起こりえない");
    cursor = cursor[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1];
  if (lastKey === undefined) throw new Error("起こりえない");
  delete cursor[lastKey];
  return clone;
}

describe("parseResultJson", () => {
  describe("正常系", () => {
    it("実際の形（targets・checkUnits を含む）の結果 JSON を検証できる", () => {
      // 契約は「JSON.parse の戻り値」なので、実際に文字列化して読み戻したものを渡す。
      const result = parseResultJson(JSON.parse(JSON.stringify(validPipelineResult())));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // targets・checkUnits は評価が読まないキーなので EvaluationResultInput には現れない。
      expect(result.value).not.toHaveProperty("targets");
      expect(result.value).not.toHaveProperty("checkUnits");
      expect(result.value.status).toBe("completed");
      expect(result.value.findings).toHaveLength(1);
      expect(result.value.unlocated).toHaveLength(1);
      expect(result.value.conditions.versions.result).toBe(RESULT_VERSION);
      // sources[] は id / perspective / llm だけを読む。locate は現れない。
      expect(result.value.findings[0]?.finding.sources[0]).not.toHaveProperty("locate");
    });

    it("recheck が done のとき output を読む", () => {
      const base = validPipelineResult();
      const json = withPatch(base, ["findings", 0, "recheck"], {
        status: "done",
        attempts: 1,
        output: {
          reason: "テスト理由",
          reasonKind: "error-confirmed",
          verdict: "keep",
          suggestionValid: true,
        },
        usage: null,
        inputRange: { start: 0, end: 6 },
        inputGraphemes: 6,
        elapsedMs: 5,
      });
      const result = parseResultJson(json);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const recheck = result.value.findings[0]?.recheck;
      expect(recheck?.status).toBe("done");
      if (recheck?.status !== "done") return;
      expect(recheck.output.verdict).toBe("keep");
      // attempts・usage・inputRange など評価が読まない項目は EvaluationResultInput に現れない。
      expect(recheck).not.toHaveProperty("attempts");
      expect(recheck).not.toHaveProperty("usage");
    });

    it("unlocated[].candidate.locate.diagnostic は候補の transform だけを読む（決定8 追記）", () => {
      const base = validPipelineResult();
      const json = withPatch(base, ["unlocated", 0, "candidate", "locate"], {
        status: "failed",
        reason: "not-found",
        exactMatches: [],
        diagnostic: {
          transformVersion: "1",
          candidates: [
            { transform: "newline", text: "秘密の原稿断片1", range: { start: 0, end: 1 } },
            { transform: "nfc", text: "秘密の原稿断片2", range: null },
          ],
          omitted: 1,
          tied: true,
        },
      });
      const result = parseResultJson(json);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const diagnostic = result.value.unlocated[0]?.candidate.locate.diagnostic;
      expect(diagnostic).toEqual({
        candidates: [{ transform: "newline" }, { transform: "nfc" }],
      });
      // transformVersion・omitted・tied・text・range は評価が読まないので現れない。
      expect(diagnostic).not.toHaveProperty("transformVersion");
      expect(diagnostic).not.toHaveProperty("omitted");
      expect(diagnostic).not.toHaveProperty("tied");
      expect(diagnostic?.candidates[0]).not.toHaveProperty("text");
      expect(diagnostic?.candidates[0]).not.toHaveProperty("range");
    });

    it("unlocated[].candidate.locate.diagnostic が null の候補も通る", () => {
      // validPipelineResult() の unlocated[0] は既に diagnostic: null（not-found）。
      const result = parseResultJson(JSON.parse(JSON.stringify(validPipelineResult())));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.unlocated[0]?.candidate.locate.diagnostic).toBeNull();
    });

    it("stop が非 null（failure を含む）の結果 JSON を検証できる", () => {
      const result = parseResultJson(JSON.parse(JSON.stringify(stoppedPipelineResult())));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("stopped");
      expect(result.value.stop).toEqual({
        reason: "connection-lost",
        message: "LM Studio への接続が失われました",
        failure: {
          reason: "connection",
          message: "接続エラー",
          finishReason: null,
          origin: "chat",
        },
        generationUnconfirmed: true,
      });
    });
  });

  // T16：項目の欠落・未知の enum・versions.result の不一致でそれぞれ集計せずエラー終了する。
  describe("T16 項目の欠落・未知の enum・versions.result の不一致", () => {
    it("status が欠けていれば拒否する", () => {
      const json = deleteAt(validPipelineResult(), ["status"]);
      const result = parseResultJson(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.startsWith("status:"))).toBe(true);
    });

    it("conditions.manuscript.bodyHash が欠けていれば拒否する", () => {
      const json = deleteAt(validPipelineResult(), ["conditions", "manuscript", "bodyHash"]);
      const result = parseResultJson(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.startsWith("conditions.manuscript.bodyHash:"))).toBe(true);
    });

    it("status が未知の値なら拒否する", () => {
      const json = withPatch(validPipelineResult(), ["status"], "unknown-status");
      const result = parseResultJson(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.startsWith("status:"))).toBe(true);
      // 値そのものは出さない。
      expect(result.errors.join(" ")).not.toContain("unknown-status");
    });

    it("findings[].finding.category が未知の値なら拒否する", () => {
      const json = withPatch(
        validPipelineResult(),
        ["findings", 0, "finding", "category"],
        "not-a-category",
      );
      const result = parseResultJson(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.startsWith("findings.0.finding.category:"))).toBe(true);
    });

    it("conditions.versions.result が RESULT_VERSION と一致しなければ拒否する", () => {
      const json = withPatch(validPipelineResult(), ["conditions", "versions", "result"], "999");
      const result = parseResultJson(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.startsWith("conditions.versions.result:"))).toBe(true);
      expect(result.errors.join(" ")).not.toContain("999");
    });

    it("stop.reason が未知の値なら拒否する", () => {
      const json = withPatch(stoppedPipelineResult(), ["stop", "reason"], "not-a-reason");
      const result = parseResultJson(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.startsWith("stop.reason:"))).toBe(true);
      expect(result.errors.join(" ")).not.toContain("not-a-reason");
    });

    it("unlocated[].candidate.locate.diagnostic.candidates[].transform が未知の値なら拒否する", () => {
      const json = withPatch(validPipelineResult(), ["unlocated", 0, "candidate", "locate"], {
        status: "failed",
        reason: "not-found",
        exactMatches: [],
        diagnostic: {
          transformVersion: "1",
          candidates: [{ transform: "not-a-transform", text: "x", range: null }],
          omitted: 0,
          tied: false,
        },
      });
      const result = parseResultJson(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.errors.some((e) =>
          e.startsWith("unlocated.0.candidate.locate.diagnostic.candidates.0.transform:"),
        ),
      ).toBe(true);
      expect(result.errors.join(" ")).not.toContain("not-a-transform");
    });

    it("stop.failure.origin が未知の値なら拒否する", () => {
      const json = withPatch(
        stoppedPipelineResult(),
        ["stop", "failure", "origin"],
        "not-an-origin",
      );
      const result = parseResultJson(json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.startsWith("stop.failure.origin:"))).toBe(true);
      expect(result.errors.join(" ")).not.toContain("not-an-origin");
    });

    it("エラー文言に path と code だけを出し、値そのものを出さない", () => {
      const json = withPatch(
        validPipelineResult(),
        ["findings", 0, "finding", "quote"],
        "秘密の原稿断片",
      );
      // quote は string なので型自体は通る。代わりに category を壊して issue を発生させつつ、
      // 別のフィールド（quote）に機微な値を混ぜても漏れないことを確認する。
      const broken = withPatch(json, ["findings", 0, "finding", "category"], "invalid");
      const result = parseResultJson(broken);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.join(" ")).not.toContain("秘密の原稿断片");
      // 各エラーは "path: code" の形。
      for (const error of result.errors) {
        expect(error).toMatch(/^[^:]+: [a-z_]+$/);
      }
    });
  });

  describe("T34 決定39: 全文チャット方式の結果は自動採点しない", () => {
    it("formatVersion が full-chat/ で始まる結果は ok:false になり、errors に「全文チャット方式」を含む", () => {
      const result = parseResultJson({ formatVersion: "full-chat/1", status: "completed" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.join(";")).toContain("全文チャット方式");
    });

    it("formatVersion が full-chat/ で始まらない値は、通常どおり zod の検証に進む（誤爆しない）", () => {
      const result = parseResultJson({ formatVersion: "other/1" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.join(";")).not.toContain("全文チャット方式");
    });

    it("既存の正しい結果 JSON は今までどおり通る（前置き検査が誤爆しない）", () => {
      const result = parseResultJson(JSON.parse(JSON.stringify(validPipelineResult())));
      expect(result.ok).toBe(true);
    });

    it("full-chat/2 のように版が上がっても拒否する", () => {
      // 接頭辞で見る理由。=== "full-chat/1" にすると、版を上げた結果 JSON が
      // 黙って zod の必須項目欠落として落ち、「形式が違う」ことが読めなくなる（レビュー指摘）。
      const result = parseResultJson({ formatVersion: "full-chat/2", status: "completed" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.join(";")).toContain("全文チャット方式");
    });

    it("zod として正しくても formatVersion が full-chat/ なら拒否する（前置き検査が先に効く）", () => {
      // 結果スキーマは未知のキーを許すので、正しい結果 JSON に formatVersion を足したものは
      // zod を通ってしまう。前置き検査を zod の後ろに移す変異を捕まえるための一件（レビュー指摘）。
      const disguised = {
        ...JSON.parse(JSON.stringify(validPipelineResult())),
        formatVersion: "full-chat/1",
      };
      const result = parseResultJson(disguised);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.join(";")).toContain("全文チャット方式");
    });
  });
});

describe("validateFindingRanges", () => {
  const text = "あいうえお。かきくけこ。";
  // "いうえ" は text の [1, 4) と一致する。

  function baseResult(): EvaluationResultInput {
    const parsed = parseResultJson(validPipelineResult());
    if (!parsed.ok)
      throw new Error("フィクスチャの検証に失敗しました（テストの前提が壊れています）");
    return parsed.value;
  }

  /** フィクスチャの findings[0] を取り出す。noUncheckedIndexedAccess 対応のガード。 */
  function firstFinding(input: EvaluationResultInput) {
    const finding = input.findings[0];
    if (finding === undefined)
      throw new Error("起こりえない（フィクスチャは findings を 1 件持つ）");
    return finding;
  }

  /** findings[0].finding だけを部分的に書き換えた `EvaluationResultInput` を作る。 */
  function withFirstFindingPatch(
    input: EvaluationResultInput,
    patch: Partial<ReturnType<typeof firstFinding>["finding"]>,
  ): EvaluationResultInput {
    const original = firstFinding(input);
    return {
      ...input,
      findings: [{ ...original, finding: { ...original.finding, ...patch } }],
    };
  }

  it("範囲が本文と整合していれば ok", () => {
    const result = validateFindingRanges(baseResult(), text);
    expect(result.ok).toBe(true);
  });

  it("end < start なら拒否する", () => {
    const broken = withFirstFindingPatch(baseResult(), { range: { start: 4, end: 1 } });
    const result = validateFindingRanges(broken, text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("f1");
    expect(result.errors[0]).not.toContain("いうえ");
  });

  it("start === end（ゼロ長）なら拒否する", () => {
    const broken = withFirstFindingPatch(baseResult(), { range: { start: 1, end: 1 } });
    const result = validateFindingRanges(broken, text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
  });

  it("end > text.length なら拒否する", () => {
    const broken = withFirstFindingPatch(baseResult(), {
      range: { start: 1, end: text.length + 10 },
    });
    const result = validateFindingRanges(broken, text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
  });

  it("端が書記素クラスタの内側に落ちるなら拒否する", () => {
    // サロゲートペアの絵文字を挟んだ本文で、境界の内側を指す range を作る。
    const surrogateText = "あ😀い";
    const broken = withFirstFindingPatch(baseResult(), {
      // "😀" は UTF-16 で 2 コード単位（サロゲートペア）。end をその内側（1 の位置）に置く。
      range: { start: 1, end: 2 },
      quote: surrogateText.slice(1, 2),
    });
    const result = validateFindingRanges(broken, surrogateText);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("書記素境界");
  });

  it("text.slice(start, end) !== quote なら拒否する", () => {
    // range は本文と整合するが quote だけ食い違わせる。
    const broken = withFirstFindingPatch(baseResult(), { quote: "ちがうくじ" });
    const result = validateFindingRanges(broken, text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).not.toContain("ちがうくじ");
    expect(result.errors[0]).not.toContain("いうえ");
  });

  it("複数の指摘が壊れていれば全件をまとめて返す（1 件目で止めない）", () => {
    const input = baseResult();
    const original = firstFinding(input);
    const broken: EvaluationResultInput = {
      ...input,
      findings: [
        {
          ...original,
          finding: { ...original.finding, id: "f1", range: { start: 4, end: 1 } },
        },
        {
          ...original,
          finding: { ...original.finding, id: "f2", quote: "ちがう" },
        },
      ],
    };
    const result = validateFindingRanges(broken, text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(2);
    expect(result.errors.some((e) => e.includes("f1"))).toBe(true);
    expect(result.errors.some((e) => e.includes("f2"))).toBe(true);
  });

  it("位置未確定の候補（unlocated）は検査の対象外", () => {
    // unlocated[0].candidate.llm.quote を本文に存在しない文字列にしても、
    // validateFindingRanges は findings しか見ないため ok のままになる。
    const json = withPatch(
      validPipelineResult(),
      ["unlocated", 0, "candidate", "llm", "quote"],
      "存在しない語",
    );
    const parsed = parseResultJson(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = validateFindingRanges(parsed.value, text);
    expect(result.ok).toBe(true);
  });
});
