// fixture を再生成するスクリプト。`node packages/shared/test/fixtures/generate.mjs` で実行する。
// CRLF・単独 CR・BOM・不正 UTF-8 をバイト単位で書き出す。エディタで開いて保存しないこと。
import { writeFileSync } from "node:fs";
import path from "node:path";

const dir = import.meta.dirname;
const utf8 = (text) => new TextEncoder().encode(text);
const concat = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));

const files = {
  // CRLF のみ。空行と全角スペースの字下げを含む
  "crlf.txt": utf8("一行目\r\n二行目\r\n\r\n　三行目\r\n"),
  // 単独 CR、LF、CRLF の混在。末尾改行なし
  "cr-mixed.txt": utf8("甲\r乙\n丙\r\n丁"),
  // BOM 付き CRLF
  "bom-crlf.txt": concat([0xef, 0xbb, 0xbf], utf8("見出し\r\n本文")),
  // 「あ」の後に不正バイト 0xFF、続けて LF
  "invalid-utf8.txt": Buffer.from([0xe3, 0x81, 0x82, 0xff, 0x0a]),
};

for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(path.join(dir, name), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
