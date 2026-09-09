/**
 * A2：原稿（`api/manuscripts.test.ts`。決定 14・20）。
 *
 * この Task の核心は「本文を一切加工せず保存する」ことなので、CRLF・BOM の期待値は
 * すべてこのファイル内の文字列リテラル／`Uint8Array` リテラルで作る（fixture ファイルにしない。
 * conventions）。
 */

import { describe, expect, it } from "vitest";

import type { ApiHarness } from "./test-support.ts";
import { createHarnessRegistry, JSON_HEADERS } from "./test-support.ts";

const { open } = createHarnessRegistry();

interface ManuscriptResponse {
  readonly status: number;
  readonly body: unknown;
}

async function postManuscript(harness: ApiHarness, body: unknown): Promise<ManuscriptResponse> {
  const res = await harness.app.request("/api/manuscripts", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function postManuscriptForm(
  harness: ApiHarness,
  form: FormData,
): Promise<ManuscriptResponse> {
  const res = await harness.app.request("/api/manuscripts/upload", {
    method: "POST",
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

async function getManuscript(harness: ApiHarness, id: string): Promise<ManuscriptResponse> {
  const res = await harness.app.request(`/api/manuscripts/${id}`);
  return { status: res.status, body: await res.json() };
}

describe("POST /api/manuscripts（貼り付け）", () => {
  it("201。body は無加工（CRLF・先頭 BOM 付きの文字列をそのまま保存し、BOM も除外しない）", async () => {
    const harness = open();
    const bodyWithCrlfAndBom = "\ufeff一行目\r\n二行目\r\n";

    const { status, body } = await postManuscript(harness, {
      name: "原稿A",
      body: bodyWithCrlfAndBom,
    });

    expect(status).toBe(201);
    const dto = body as { id: string; name: string; body: string; bodyHash: string };
    expect(dto.name).toBe("原稿A");
    expect(dto.body).toBe(bodyWithCrlfAndBom);
    // BOM は除外されない：先頭文字が U+FEFF のまま。
    expect(dto.body.charCodeAt(0)).toBe(0xfeff);
    // CRLF は保持される（LF に正規化されない）。
    expect(dto.body).toContain("\r\n");

    const fetched = await getManuscript(harness, dto.id);
    expect(fetched.status).toBe(200);
    expect((fetched.body as { body: string }).body).toBe(bodyWithCrlfAndBom);
  });

  it("空本文は 400 empty-body", async () => {
    const harness = open();

    const { status, body } = await postManuscript(harness, { name: "原稿", body: "" });

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("empty-body");
  });

  it("孤立サロゲートを含む本文は 400 malformed-body", async () => {
    const harness = open();
    const loneSurrogate = "\ud800";

    const { status, body } = await postManuscript(harness, { name: "原稿", body: loneSurrogate });

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("malformed-body");
  });

  it("name 欠落は 400 validation", async () => {
    const harness = open();

    const { status, body } = await postManuscript(harness, { body: "本文" });

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("validation");
  });
});

/** UTF-8 の BOM（U+FEFF）のバイト列。 */
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("POST /api/manuscripts/upload（アップロード）", () => {
  it("201。BOM 付き UTF-8 バイト列の BOM だけ除外し、CRLF は保持する", async () => {
    const harness = open();
    const encoder = new TextEncoder();
    const withCrlf = encoder.encode("一行目\r\n二行目\r\n");
    const bytes = concatBytes(UTF8_BOM, withCrlf);

    const form = new FormData();
    form.append("file", new File([bytes], "manuscript.txt"));
    form.append("name", "原稿B");

    const { status, body } = await postManuscriptForm(harness, form);

    expect(status).toBe(201);
    const dto = body as { body: string };
    expect(dto.body).toBe("一行目\r\n二行目\r\n");
    // BOM は除外される。
    expect(dto.body.charCodeAt(0)).not.toBe(0xfeff);
    // CRLF は LF に正規化されず保持される。
    expect(dto.body).toContain("\r\n");
  });

  it("不正な UTF-8 バイト列は 400 invalid-utf8", async () => {
    const harness = open();
    const invalidBytes = new Uint8Array([0x61, 0xff, 0x62]);

    const form = new FormData();
    form.append("file", new File([invalidBytes], "invalid.txt"));

    const { status, body } = await postManuscriptForm(harness, form);

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("invalid-utf8");
  });

  it("空本文（ファイルの中身が空）は 400 empty-body", async () => {
    const harness = open();

    const form = new FormData();
    form.append("file", new File([new Uint8Array()], "empty.txt"));
    form.append("name", "原稿");

    const { status, body } = await postManuscriptForm(harness, form);

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("empty-body");
  });

  it("BOM だけのファイル（BOM 除外後に空）も 400 empty-body（BOM 除外→空判定の順序を守る）", async () => {
    const harness = open();

    const form = new FormData();
    form.append("file", new File([UTF8_BOM], "bom-only.txt"));
    form.append("name", "原稿");

    const { status, body } = await postManuscriptForm(harness, form);

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("empty-body");
  });

  it("name 省略時は file.name を使う", async () => {
    const harness = open();

    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("本文")], "from-file-name.txt"));

    const { status, body } = await postManuscriptForm(harness, form);

    expect(status).toBe(201);
    expect((body as { name: string }).name).toBe("from-file-name.txt");
  });

  it("明示の name フィールドは file.name より優先する", async () => {
    const harness = open();

    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("本文")], "from-file-name.txt"));
    form.append("name", "明示の名前");

    const { status, body } = await postManuscriptForm(harness, form);

    expect(status).toBe(201);
    expect((body as { name: string }).name).toBe("明示の名前");
  });

  it("name が 201 文字は 400 validation", async () => {
    const harness = open();

    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("本文")], "a.txt"));
    form.append("name", "あ".repeat(201));

    const { status, body } = await postManuscriptForm(harness, form);

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("validation");
  });

  it("file が文字列（File でない）なら 400 validation", async () => {
    const harness = open();

    const form = new FormData();
    form.append("file", "not-a-file");
    form.append("name", "原稿");

    const { status, body } = await postManuscriptForm(harness, form);

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("validation");
  });

  it("name が File（文字列でない）なら 400 validation", async () => {
    const harness = open();

    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("本文")], "a.txt"));
    form.append("name", new File([new TextEncoder().encode("名前のつもり")], "name.txt"));

    const { status, body } = await postManuscriptForm(harness, form);

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("validation");
  });

  it("file 項目が重複（同名項目が複数）すると 400 validation", async () => {
    const harness = open();

    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("本文1")], "a.txt"));
    form.append("file", new File([new TextEncoder().encode("本文2")], "b.txt"));
    form.append("name", "原稿");

    const { status, body } = await postManuscriptForm(harness, form);

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("validation");
  });

  it("name 項目が重複（同名項目が複数）すると 400 validation", async () => {
    const harness = open();

    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("本文")], "a.txt"));
    form.append("name", "名前1");
    form.append("name", "名前2");

    const { status, body } = await postManuscriptForm(harness, form);

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("validation");
  });
});

describe("GET /api/manuscripts/:id", () => {
  it("200：保存した原稿版を返す", async () => {
    const harness = open();
    const created = await postManuscript(harness, { name: "原稿", body: "本文" });
    const id = (created.body as { id: string }).id;

    const { status, body } = await getManuscript(harness, id);

    expect(status).toBe(200);
    expect(body).toEqual(created.body);
  });

  it("404：存在しない ID", async () => {
    const harness = open();

    const { status, body } = await getManuscript(harness, "does-not-exist");

    expect(status).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe("not-found");
  });
});
