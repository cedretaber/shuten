/**
 * 原稿の口（PR10 決定 14・20）。
 *
 * `POST /api/manuscripts` は貼り付け、`POST /api/manuscripts/upload` はファイル入力。
 * どちらも「受け取った本文を一切加工せず保存する」ことだけが仕事（不変条件）。
 *
 * - 貼り付け：JSON の `body` 文字列をそのまま保存する。CRLF はそのまま残り、
 *   先頭に BOM（U+FEFF）が付いていても除外しない（BOM 除外はバイト入力だけの処理）。
 * - アップロード：`ingestUtf8Bytes` の結果だけを保存する。先頭の BOM だけを除外し、
 *   それ以外は無加工（CRLF もそのまま）。
 *
 * 空本文（`body.length === 0`）はどちらの経路でも 400 `empty-body`（決定 14。仕様 5.1
 * 「空の本文では検査を開始できない」を、保存できない形で守る）。孤立サロゲートは
 * `insertManuscriptVersion` が投げる `MalformedBodyError` を `errors.ts` が 400 `malformed-body`
 * に写す（ここでは捕まえない）。不正な UTF-8 バイト列は `ingestUtf8Bytes` が投げる
 * `Utf8DecodeError` を `errors.ts` が 400 `invalid-utf8` に写す（同様に、ここでは捕まえない）。
 */

import {
  createManuscriptRequestSchema,
  ingestUtf8Bytes,
  manuscriptVersionDtoSchema,
} from "@shuten/shared";
import type { Hono } from "hono";

import { findManuscriptVersion, insertManuscriptVersion } from "../db/repositories/manuscripts.ts";
import type { ApiDeps } from "./deps.ts";
import { toManuscriptVersionDto } from "./dto.ts";
import { ApiError, notFound, readJson, respond } from "./errors.ts";

/** 400 `empty-body` の本文。原稿の断片は入れない。 */
const EMPTY_BODY_MESSAGE = "本文が空です（原稿を保存できません）";

/** アップロードの `name`／`file` の検証に使う 400 `validation`。 */
function validationError(field: string): ApiError {
  return new ApiError(400, "validation", `入力の検証に失敗しました: ${field}`);
}

/**
 * multipart の `file` 項目を検証する。`File` でない、または同名項目が複数（配列）なら
 * `validation`（決定 20）。
 */
function resolveUploadedFile(value: unknown): File {
  if (value instanceof File) {
    return value;
  }
  throw validationError("file");
}

/**
 * multipart の `name` を解決する。明示の文字列 `name` があればそれを採用し、無ければ
 * `file.name` を使う。`name` が `File` や配列（同名項目の重複）なら `validation`（決定 20）。
 */
function resolveUploadedName(nameField: unknown, file: File): string {
  if (nameField === undefined) {
    return file.name;
  }
  if (typeof nameField === "string") {
    return nameField;
  }
  throw validationError("name");
}

export function registerManuscriptRoutes(router: Hono, deps: ApiDeps): void {
  router.post("/manuscripts", async (c) => {
    const body = createManuscriptRequestSchema.parse(await readJson(c));
    if (body.body.length === 0) {
      throw new ApiError(400, "empty-body", EMPTY_BODY_MESSAGE);
    }
    // 保存する文字列は要求の JSON からそのまま：CRLF もそのままで、BOM も除外しない。
    const record = insertManuscriptVersion(deps.db, { name: body.name, body: body.body });
    return respond(c, manuscriptVersionDtoSchema, toManuscriptVersionDto(record), 201);
  });

  router.post("/manuscripts/upload", async (c) => {
    // `all: true` が必須：付けないと同名項目は最後の値だけが残り、重複を検出できない。
    const form = await c.req.parseBody({ all: true });

    const file = resolveUploadedFile(form.file);
    const name = resolveUploadedName(form.name, file);
    // 採用した name に、JSON 経路と同じ 1〜200 文字の制約をかける（決定 20）。
    const parsedName = createManuscriptRequestSchema.shape.name.safeParse(name);
    if (!parsedName.success) {
      throw validationError("name");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    // BOM 除外だけを行い、それ以外は無加工（decodeUtf8Strict が Utf8DecodeError を投げうる）。
    const decoded = ingestUtf8Bytes(bytes);
    if (decoded.length === 0) {
      throw new ApiError(400, "empty-body", EMPTY_BODY_MESSAGE);
    }

    const record = insertManuscriptVersion(deps.db, { name: parsedName.data, body: decoded });
    return respond(c, manuscriptVersionDtoSchema, toManuscriptVersionDto(record), 201);
  });

  router.get("/manuscripts/:id", (c) => {
    const id = c.req.param("id");
    const record = findManuscriptVersion(deps.db, id);
    if (record === null) {
      throw notFound("原稿", id);
    }
    return respond(c, manuscriptVersionDtoSchema, toManuscriptVersionDto(record));
  });
}
