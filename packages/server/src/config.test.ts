import { describe, expect, it } from "vitest";
import { loadConfig, parseLmStudioApiKey, parseLmStudioUrl, parsePort } from "./config.ts";

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
