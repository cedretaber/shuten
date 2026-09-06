// Node の fetch + AbortController で切断したとき、LM Studio の生成が止まるかを観察する。
//
// 使い方:
//   LM_STUDIO_URL=http://<host>:1234 LMS=<lms の実行ファイル> node abort-test.mjs <request.json>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const url = `${process.env.LM_STUDIO_URL ?? "http://127.0.0.1:1234"}/v1/chat/completions`;
const lms = process.env.LMS;
if (!lms) throw new Error("LMS（lms 実行ファイルのパス）を指定してください");
const body = readFileSync(process.argv[2], "utf8");

// lms ps の出力にはバナーが付くので、IDENTIFIER で始まるヘッダー行の次の行を読む
const status = () => {
  const lines = execFileSync(lms, ["ps"]).toString().split("\n");
  const header = lines.findIndex((l) => l.trimStart().startsWith("IDENTIFIER"));
  const row = header >= 0 ? lines.slice(header + 1).find((l) => l.trim()) : undefined;
  return row ? row.trim().split(/\s+/)[2] : "?";
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ac = new AbortController();
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(0);
const p = fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
  signal: ac.signal,
})
  .then((r) => r.text())
  .catch((e) => `fetch rejected: ${e.name}`);

await sleep(3000);
console.log(`t+${elapsed()}s connected: ${status()}`);
ac.abort();
console.log(`abort() called; fetch -> ${await p}`);
for (let i = 0; i < 5; i++) {
  await sleep(1000);
  console.log(`t+${elapsed()}s after abort: ${status()}`);
}
