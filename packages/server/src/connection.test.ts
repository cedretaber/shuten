import { describe, expect, it, vi } from "vitest";

import {
  createConnectionManager,
  fixedConnection,
  INVALID_STORED_LM_STUDIO_URL_MESSAGE,
} from "./connection.ts";
import { createDatabase } from "./db/client.ts";
import { applyMigrations } from "./db/migrate.ts";
import { getSetting, LM_STUDIO_URL_KEY, setSetting } from "./db/repositories/settings.ts";
import type { LmStudioClient, LmStudioClientOptions } from "./lmstudio/types.ts";

const ENV_URL = "http://127.0.0.1:1234";
const OTHER_URL = "http://127.0.0.1:5678";
const SECRET_API_KEY = "sk-this-is-a-secret-token";

/** テストごとにマイグレーション適用済みのメモリ DB を作る。 */
function setupDb() {
  const { db, close } = createDatabase(":memory:");
  applyMigrations(db);
  return { db, close };
}

/** `createConnectionManager` の `createClient` に渡すフェイク。生成された各クライアントの
 * 呼び出し引数（`baseUrl` / `apiKey`）と `close()` の呼び出し回数・結果を観測できる。 */
interface FakeClientRecord {
  readonly options: LmStudioClientOptions;
  closeCalls: number;
  closeResult: () => Promise<void>;
}

function createFakeClientFactory(): {
  readonly createClient: (options: LmStudioClientOptions) => LmStudioClient;
  readonly clients: FakeClientRecord[];
} {
  const clients: FakeClientRecord[] = [];
  const createClient = (options: LmStudioClientOptions): LmStudioClient => {
    const record: FakeClientRecord = {
      options,
      closeCalls: 0,
      closeResult: () => Promise.resolve(),
    };
    clients.push(record);
    return {
      listModels: () => Promise.resolve([]),
      ensureLoaded: () => Promise.reject(new Error("このテストでは使わない")),
      chat: () => Promise.reject(new Error("このテストでは使わない")),
      close: () => {
        record.closeCalls += 1;
        return record.closeResult();
      },
    };
  };
  return { createClient, clients };
}

describe("connection: fixedConnection", () => {
  it("CN0: current() は渡した client・endpointUrl をそのまま返す", () => {
    const client = createFakeClientFactory().createClient({ baseUrl: ENV_URL });
    const source = fixedConnection(client, ENV_URL);
    expect(source.current()).toEqual({ client, endpointUrl: ENV_URL });
  });
});

describe("connection: createConnectionManager", () => {
  it("CN1: settings に行が無ければ env.lmStudioUrl を使う", () => {
    const { db, close } = setupDb();
    const { createClient, clients } = createFakeClientFactory();
    const manager = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: null },
      createClient,
    });
    expect(manager.describe().endpointUrl).toBe(ENV_URL);
    expect(manager.current().endpointUrl).toBe(ENV_URL);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.options.baseUrl).toBe(ENV_URL);
    close();
  });

  it("CN2: describe() は hasApiKey だけを返し、API キー本体は含まない", () => {
    const { db, close } = setupDb();
    const { createClient } = createFakeClientFactory();
    const manager = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: SECRET_API_KEY },
      createClient,
    });
    const described = manager.describe();
    expect(Object.keys(described).sort()).toEqual(["endpointUrl", "hasApiKey"]);
    expect(described.hasApiKey).toBe(true);
    expect(JSON.stringify(described)).not.toContain(SECRET_API_KEY);
    close();
  });

  it("CN3: update は settings に書き、作り直した manager が環境変数より DB を優先する（決定 5）", () => {
    const { db, close } = setupDb();
    const { createClient } = createFakeClientFactory();
    const manager = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: null },
      createClient,
    });
    manager.update({ endpointUrl: OTHER_URL });
    expect(getSetting(db, LM_STUDIO_URL_KEY)).toBe(OTHER_URL);

    // 同じ DB から作り直した別の manager は、env.lmStudioUrl（ENV_URL）ではなく
    // settings に保存された OTHER_URL を使う。
    const { createClient: createClient2 } = createFakeClientFactory();
    const reopened = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: null },
      createClient: createClient2,
    });
    expect(reopened.describe().endpointUrl).toBe(OTHER_URL);
    close();
  });

  it("CN4: update の apiKey 省略は現在の値を維持する", () => {
    const { db, close } = setupDb();
    const { createClient, clients } = createFakeClientFactory();
    const manager = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: SECRET_API_KEY },
      createClient,
    });
    manager.update({ endpointUrl: OTHER_URL });
    expect(manager.describe().hasApiKey).toBe(true);
    expect(clients.at(-1)?.options.apiKey).toBe(SECRET_API_KEY);
    close();
  });

  it("CN5: update の apiKey: null は消去する", () => {
    const { db, close } = setupDb();
    const { createClient, clients } = createFakeClientFactory();
    const manager = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: SECRET_API_KEY },
      createClient,
    });
    manager.update({ endpointUrl: OTHER_URL, apiKey: null });
    expect(manager.describe().hasApiKey).toBe(false);
    expect(clients.at(-1)?.options.apiKey).toBeNull();
    close();
  });

  it("CN6: update の apiKey: 文字列は設定し、空白のみは消去扱いになる", () => {
    const { db, close } = setupDb();
    const { createClient, clients } = createFakeClientFactory();
    const manager = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: null },
      createClient,
    });
    manager.update({ endpointUrl: ENV_URL, apiKey: "new-secret" });
    expect(manager.describe().hasApiKey).toBe(true);
    expect(clients.at(-1)?.options.apiKey).toBe("new-secret");

    manager.update({ endpointUrl: ENV_URL, apiKey: "   " });
    expect(manager.describe().hasApiKey).toBe(false);
    expect(clients.at(-1)?.options.apiKey).toBeNull();
    close();
  });

  it("CN7: 不正な URL を渡すと update は例外を投げ、settings・endpointUrl・client のいずれも変わらない", () => {
    const { db, close } = setupDb();
    const { createClient, clients } = createFakeClientFactory();
    const manager = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: null },
      createClient,
    });
    const clientBefore = manager.current().client;

    expect(() => manager.update({ endpointUrl: "not a url" })).toThrow();

    expect(manager.describe().endpointUrl).toBe(ENV_URL);
    expect(manager.current().client).toBe(clientBefore);
    expect(getSetting(db, LM_STUDIO_URL_KEY)).toBeNull();
    expect(clients).toHaveLength(1);
    close();
  });

  it("CN8: update 後の current() は新しいクライアントを返し、古いクライアントの close が呼ばれる", () => {
    const { db, close } = setupDb();
    const { createClient, clients } = createFakeClientFactory();
    const manager = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: null },
      createClient,
    });
    const before = manager.current().client;
    expect(clients[0]?.closeCalls).toBe(0);

    manager.update({ endpointUrl: OTHER_URL });

    const after = manager.current().client;
    expect(after).not.toBe(before);
    expect(clients).toHaveLength(2);
    expect(clients[0]?.closeCalls).toBe(1);
    expect(clients[1]?.closeCalls).toBe(0);
    close();
  });

  it("CN9: close が reject しても update は成功し、unhandledRejection にならない。ログにはクラス名だけを出す", async () => {
    const { db, close } = setupDb();
    const { createClient, clients } = createFakeClientFactory();
    const manager = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: null },
      createClient,
    });

    // 1 回目の update で作られたクライアント（clients[1]）を、2 回目の update で
    // 「古いクライアント」として close させる。close は reject するよう仕込む。
    manager.update({ endpointUrl: OTHER_URL });
    const rejecting = clients[1];
    if (rejecting === undefined) {
      throw new Error("フェイクが期待どおり作られていない");
    }
    rejecting.closeResult = () =>
      Promise.reject(
        new Error(`接続先 ${OTHER_URL} への接続に失敗した（このメッセージは出てはいけない）`),
      );

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => manager.update({ endpointUrl: ENV_URL })).not.toThrow();

      // reject の伝播をマクロタスク境界を挟んで待つ。
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith("client close failed:", "Error");
      for (const call of errorSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(OTHER_URL);
      }
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      errorSpy.mockRestore();
      close();
    }
  });

  it("CN10: settings の値が parseLmStudioUrl を通らないと、作成時に例外を投げ、メッセージに URL を含まない", () => {
    const { db, close } = setupDb();
    const invalidStoredUrl = "http://127.0.0.1:1234/v1";
    setSetting(db, LM_STUDIO_URL_KEY, invalidStoredUrl);
    const { createClient } = createFakeClientFactory();

    let caught: unknown;
    try {
      createConnectionManager({
        db,
        env: { lmStudioUrl: ENV_URL, lmStudioApiKey: null },
        createClient,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toBe(INVALID_STORED_LM_STUDIO_URL_MESSAGE);
    expect(message).not.toContain(invalidStoredUrl);
    expect(message).not.toContain("127.0.0.1");
    close();
  });
});

describe("connection: update の書き込み順序（Finding 1: 作成 → DB 書き込み → 差し替え）", () => {
  it("CN12: createClient が差し替え時に投げると、update は例外を伝播し、settings・describe()・current() は旧値のまま。旧クライアントは close されない", () => {
    const { db, close } = setupDb();
    const { createClient: baseCreateClient, clients } = createFakeClientFactory();
    let callCount = 0;
    const createClient = (options: LmStudioClientOptions): LmStudioClient => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error("createClient が 2 回目の呼び出しで失敗する（差し替え時を模す）");
      }
      return baseCreateClient(options);
    };
    const manager = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: null },
      createClient,
    });
    const before = manager.current().client;

    expect(() => manager.update({ endpointUrl: OTHER_URL })).toThrow();

    expect(getSetting(db, LM_STUDIO_URL_KEY)).toBeNull();
    expect(manager.describe().endpointUrl).toBe(ENV_URL);
    expect(manager.current().client).toBe(before);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.closeCalls).toBe(0);
    close();
  });

  it("CN13: setSetting（DB 書き込み）が失敗すると、update は例外を伝播し、in-memory の状態は変えない。新しく作ったクライアントだけを閉じ、旧クライアントは閉じない", () => {
    const { db, close } = setupDb();
    const { createClient, clients } = createFakeClientFactory();
    const manager = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: SECRET_API_KEY },
      createClient,
    });
    const before = manager.current().client;

    // sqlite ハンドルを閉じ、以降の書き込み（setSetting の insert().run()）を失敗させる。
    close();

    // apiKey も変えようとするが、DB 書き込みが失敗するので client / endpointUrl と同じく
    // 巻き戻らず、旧い hasApiKey（true）のままであることまで確かめる。
    expect(() => manager.update({ endpointUrl: OTHER_URL, apiKey: null })).toThrow();

    expect(manager.current().client).toBe(before);
    expect(manager.describe().endpointUrl).toBe(ENV_URL);
    expect(manager.describe().hasApiKey).toBe(true);
    expect(clients).toHaveLength(2);
    // 旧クライアント（使用中のまま）は閉じられていない。
    expect(clients[0]?.closeCalls).toBe(0);
    // 新しく作ったが使われなかったクライアントは閉じられている。
    expect(clients[1]?.closeCalls).toBe(1);
  });
});

describe("connection: createConnectionManager の既定の createClient", () => {
  it("CN11: createClient を省略すると本物の createLmStudioClient が使われる（型チェックの範囲での確認）", () => {
    const { db, close } = setupDb();
    const manager = createConnectionManager({
      db,
      env: { lmStudioUrl: ENV_URL, lmStudioApiKey: null },
    });
    // 実 HTTP には繋がないため、listModels などは呼ばない。作れること・describe() が
    // 素直に読めることだけを確認する。
    expect(manager.describe().endpointUrl).toBe(ENV_URL);
    expect(manager.describe().hasApiKey).toBe(false);
    close();
  });
});
