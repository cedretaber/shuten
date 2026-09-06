import { describe, expect, it } from "vitest";
import { loadConfig, parsePort } from "./config.ts";

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
});
