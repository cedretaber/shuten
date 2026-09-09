import { describe, expect, it } from "vitest";
import {
  loadConfig,
  parseLmStudioApiKey,
  parseLmStudioUrl,
  parsePort,
  parseRecoveryConfirmMs,
} from "./config.ts";

describe("parsePort", () => {
  it("十進の整数表記を受け付ける", () => {
    expect(parsePort("3000")).toBe(3000);
    expect(parsePort(" 8080 ")).toBe(8080);
    expect(parsePort("65535")).toBe(65535);
  });

  it.each(["3000oops", "3000.5", "3e3", "0x1f", "", " ", "-1", "+80"])(
    "整数表記でない %j を拒否する",
    (raw) => {
      expect(() => parsePort(raw)).toThrow(/不正/);
    },
  );

  it.each(["0", "65536", "99999"])("範囲外の %s を拒否する", (raw) => {
    expect(() => parsePort(raw)).toThrow(/範囲外/);
  });
});

describe("loadConfig", () => {
  it("未指定なら 127.0.0.1:3000 を使う", () => {
    const config = loadConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3000);
  });

  it("SHUTEN_PORT の不正値で例外を投げる", () => {
    expect(() => loadConfig({ SHUTEN_PORT: "3e3" })).toThrow();
  });

  it("未指定なら LM Studio の既定値を使う", () => {
    const config = loadConfig({});
    expect(config.lmStudioUrl).toBe("http://127.0.0.1:1234");
    expect(config.lmStudioApiKey).toBeNull();
  });
});

describe("parseLmStudioUrl", () => {
  it("既定値をそのまま受け付ける", () => {
    expect(parseLmStudioUrl("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234");
  });

  it("末尾のスラッシュを 1 個除去する", () => {
    expect(parseLmStudioUrl("http://127.0.0.1:1234/")).toBe("http://127.0.0.1:1234");
  });

  it("末尾のスラッシュを複数個除去する", () => {
    expect(parseLmStudioUrl("http://127.0.0.1:1234//")).toBe("http://127.0.0.1:1234");
  });

  it("http でも https でもないスキームを拒否する", () => {
    expect(() => parseLmStudioUrl("ftp://127.0.0.1:1234")).toThrow(/http/);
  });

  it("解析できない URL を拒否する", () => {
    expect(() => parseLmStudioUrl("not a url")).toThrow();
  });

  it("パス付きの URL を拒否する（例: /v1）", () => {
    expect(() => parseLmStudioUrl("http://127.0.0.1:1234/v1")).toThrow();
  });

  it("末尾が // だけのパスは受理する", () => {
    expect(() => parseLmStudioUrl("http://127.0.0.1:1234//")).not.toThrow();
  });

  it("クエリ文字列付きの URL を拒否する", () => {
    expect(() => parseLmStudioUrl("http://127.0.0.1:1234/?a=1")).toThrow();
  });

  it("フラグメント付きの URL を拒否する", () => {
    expect(() => parseLmStudioUrl("http://127.0.0.1:1234/#frag")).toThrow();
  });

  it("資格情報（userinfo）付きの URL を拒否する", () => {
    expect(() => parseLmStudioUrl("http://user:pass@127.0.0.1:1234")).toThrow();
  });

  it("資格情報付き URL の例外メッセージにパスワードを含めない", () => {
    let thrown: unknown;
    try {
      parseLmStudioUrl("http://user:hunter2@127.0.0.1:1234");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(String(thrown)).not.toContain("hunter2");
  });
});

describe("parseLmStudioApiKey", () => {
  it("未設定なら null", () => {
    expect(parseLmStudioApiKey(undefined)).toBeNull();
  });

  it("空文字なら null", () => {
    expect(parseLmStudioApiKey("")).toBeNull();
  });

  it("空白のみなら null", () => {
    expect(parseLmStudioApiKey("   ")).toBeNull();
    expect(parseLmStudioApiKey("\t\n")).toBeNull();
  });

  it("値があればそのまま返す", () => {
    expect(parseLmStudioApiKey("sk-secret-token")).toBe("sk-secret-token");
  });

  it("前後の空白（改行を含む）を trim して返す", () => {
    expect(parseLmStudioApiKey(" sk-secret-token ")).toBe("sk-secret-token");
    expect(parseLmStudioApiKey("\nsk-secret-token\n")).toBe("sk-secret-token");
  });

  it("例外メッセージに API キーの値を含めない（不正な URL との組み合わせで確認）", () => {
    let thrown: unknown;
    try {
      loadConfig({ SHUTEN_LM_STUDIO_URL: "not a url", SHUTEN_LM_STUDIO_API_KEY: "sk-secret-xyz" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(String(thrown)).not.toContain("sk-secret-xyz");
  });
});

describe("parseRecoveryConfirmMs（決定 43）", () => {
  it("C3a: 未指定なら既定 120000", () => {
    expect(parseRecoveryConfirmMs(undefined)).toBe(120_000);
  });

  it("C3b: 0 を許可する（checkMs がそのままハード上限という意味。決定 8）", () => {
    expect(parseRecoveryConfirmMs("0")).toBe(0);
  });

  it("C3c: 前後の空白を trim して受け付ける", () => {
    expect(parseRecoveryConfirmMs(" 100 ")).toBe(100);
  });

  it("C3d: setTimeout の実用上限（2147483647）を受け付ける", () => {
    expect(parseRecoveryConfirmMs("2147483647")).toBe(2_147_483_647);
  });

  it("C3e: 実用上限を 1 でも超えたら拒否する", () => {
    expect(() => parseRecoveryConfirmMs("2147483648")).toThrow(/上限/);
  });

  it.each(["-1", "1.5", "1e3", "3000oops", " ", "+80", "0x1f"])(
    "C3f: 整数表記でない %j を拒否する",
    (raw) => {
      expect(() => parseRecoveryConfirmMs(raw)).toThrow(/不正/);
    },
  );

  it("C3g: 空文字は既定値に丸めず例外にする（`undefined` の未指定と違い、失敗を正常な値に置き換えない）", () => {
    expect(() => parseRecoveryConfirmMs("")).toThrow(/不正/);
  });

  it("C3h: loadConfig は未指定で既定 120000 を使う", () => {
    expect(loadConfig({}).recoveryConfirmMs).toBe(120_000);
  });

  it("C3i: loadConfig は SHUTEN_RECOVERY_CONFIRM_MS の不正値で例外を投げる", () => {
    expect(() => loadConfig({ SHUTEN_RECOVERY_CONFIRM_MS: "-1" })).toThrow();
  });

  it("C3j: loadConfig は SHUTEN_RECOVERY_CONFIRM_MS を正しく読む", () => {
    expect(loadConfig({ SHUTEN_RECOVERY_CONFIRM_MS: "500" }).recoveryConfirmMs).toBe(500);
  });
});
