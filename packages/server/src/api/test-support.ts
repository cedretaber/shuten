/**
 * API のテスト基盤（PR10 Task 4）。
 *
 * `setupApi()` はメモリ DB・フェイクの LM Studio クライアント・オーケストレーター・
 * event hub を組んで `createApp` まで作る。以降の Task のエンドポイントのテストは、
 * すべてこの入口から `app.request(...)` を呼ぶ。
 *
 * 差し替えられる継ぎ目は 3 つ。
 *
 * - `env`：`createConnectionManager` に渡す起動時の既定値。番兵（`http://sentinel.invalid:9` /
 *   `sentinel-api-key`）を入れて漏えい検査（Task 10 の A0）に使う。
 * - `ssePingIntervalMs`：SSE の心拍間隔（Task 9 が短い値を使う）。
 * - フェイククライアントの台本（`steps` / `listModels` / `ensureLoaded`）。
 *
 * フェイクは `createClient` の `baseUrl` に**結び直される**（`client.bind`）。接続設定を
 * 更新すると新しい接続先に結んだクライアントができ、台本はその URL を
 * `ChatStep` の文脈（`endpointUrl`）から読める。**失敗の `message` に接続先 URL は入らない**
 * （裁定 R12。実クライアントも入れない）。代わりに `FAKE_FAILURE_MARKER` が入るので、
 * A0（Task 10）は「失敗経路を実際に通ったか」をその印で確かめる。
 */

import { Hono } from "hono";
import { afterEach } from "vitest";

import { createApp } from "../app.ts";
import type { ConnectionManager } from "../connection.ts";
import { createConnectionManager } from "../connection.ts";
import type { AppDatabase, AppDatabaseLike } from "../db/client.ts";
import { createDatabase } from "../db/client.ts";
import { applyMigrations } from "../db/migrate.ts";
import type { RunRecord } from "../db/records.ts";
import { findRun } from "../db/repositories/runs.ts";
import type { RunEventHub } from "../run/event-hub.ts";
import { createRunEventHub } from "../run/event-hub.ts";
import type { Orchestrator } from "../run/orchestrator.ts";
import { createOrchestrator } from "../run/orchestrator.ts";
import { createRequestQueue } from "../run/queue.ts";
import type { RecoveryGate } from "../run/recovery-gate.ts";
import { createRecoveryGate } from "../run/recovery-gate.ts";
import type { ChatStep, ScriptedClient, ScriptedClientOptions } from "../run/test-support.ts";
import { SCRIPTED_ENDPOINT_URL, scriptedClient } from "../run/test-support.ts";

/**
 * `webDistDir` の既定。存在しないパスを渡して静的配信を無効にする
 * （機器固有の値を書かないため、相対でも絶対でもない固定のリテラルにする）。
 */
export const NO_WEB_DIST_DIR = "/nonexistent";

export interface SetupApiOverrides {
  /** `createConnectionManager` に渡す起動時の既定値。既定はループバックの接続先・API キーなし。 */
  readonly env?:
    | { readonly lmStudioUrl: string; readonly lmStudioApiKey: string | null }
    | undefined;
  /** フェイククライアントの台本（生成要求への応答）。 */
  readonly steps?: readonly ChatStep[] | undefined;
  readonly listModels?: ScriptedClientOptions["listModels"];
  readonly ensureLoaded?: ScriptedClientOptions["ensureLoaded"];
  /**
   * 復旧確認の待機上限。既定 0（`checkMs` がそのままハード上限という従来の意味。決定 8）。
   * テストが停止のたびに待たされないようにするため。
   */
  readonly recoveryConfirmMs?: number | undefined;
  /** SSE の心拍間隔（Task 9）。省略時は `ApiDeps` の既定。 */
  readonly ssePingIntervalMs?: number | undefined;
  /** 静的配信の元。既定 `NO_WEB_DIST_DIR`（存在しないので静的配信は付かない）。 */
  readonly webDistDir?: string | undefined;
  readonly createId?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * 実行された SQL 文を 1 本ずつ受け取る（PR12c 決定 7）。`createDatabase` へ素通しする
   * テスト基盤側の継ぎ目で、本番の配線には影響しない。
   */
  readonly onStatement?: ((sql: string) => void) | undefined;
  /**
   * テスト用の継ぎ目。`/api` に**追加のサブルーターをマウント**して route を足す
   * （`createApp` が組んだ実物のアプリに、`createApiRouter` と同じ `app.route("/api", ...)` で足す）。
   *
   * 例外の写像を「実配線を通って」確かめるために使う。追加のルーターには `onError` を**付けない**ので、
   * 投げた例外は親の `app.onError` まで落ちる。つまりこの継ぎ目で見ているのは
   * 「マウントしたルーターの route が投げた例外が、1 形式の JSON になる」という契約そのもので、
   * サブアプリの `onError` が効くかどうかという Hono の内部仕様には依存しない。
   *
   * **エンドポイントの実装には使わない**（Task 5 以降の route は `api/router.ts` に足すこと）。
   */
  readonly extendRouter?: ((router: Hono) => void) | undefined;
}

export interface ApiHarness {
  readonly app: Hono;
  readonly db: AppDatabase;
  readonly orchestrator: Orchestrator;
  readonly hub: RunEventHub;
  readonly gate: RecoveryGate;
  /** フェイククライアントの操作口（台本・記録・`bind`）。 */
  readonly client: ScriptedClient;
  readonly connection: ConnectionManager;
  /**
   * ハーネスが持っている資源を解放する（メモリ DB を閉じ、event hub の購読を閉じる）。
   * テストの `afterEach` などで呼ぶこと。呼ばないと `setupApi()` のたびに
   * better-sqlite3 のハンドルが積み上がる。冪等。
   */
  close(): void;
}

export function setupApi(overrides: SetupApiOverrides = {}): ApiHarness {
  const env = overrides.env ?? { lmStudioUrl: SCRIPTED_ENDPOINT_URL, lmStudioApiKey: null };

  const { db, close: closeDb } = createDatabase(
    ":memory:",
    overrides.onStatement === undefined ? undefined : { onStatement: overrides.onStatement },
  );
  applyMigrations(db);

  const client = scriptedClient(overrides.steps ?? [], {
    endpointUrl: env.lmStudioUrl,
    listModels: overrides.listModels,
    ensureLoaded: overrides.ensureLoaded,
  });

  const connection = createConnectionManager({
    db,
    env,
    // 接続先が変わるたびに、その URL に結び直したフェイクを返す（台本と記録は共有）。
    createClient: (options) => client.bind(options.baseUrl),
  });

  const queue = createRequestQueue();
  const gate = createRecoveryGate();
  const hub = createRunEventHub();
  const recoveryConfirmMs = overrides.recoveryConfirmMs ?? 0;

  const orchestrator = createOrchestrator({
    db,
    connection,
    queue,
    recoveryGate: gate,
    recoveryConfirmMs,
    onEvent: hub.emit,
    ...(overrides.createId === undefined ? {} : { createId: overrides.createId }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });

  const app = createApp(
    { webDistDir: overrides.webDistDir ?? NO_WEB_DIST_DIR },
    {
      db,
      connection,
      recoveryGate: gate,
      orchestrator,
      hub,
      recoveryConfirmMs,
      ...(overrides.ssePingIntervalMs === undefined
        ? {}
        : { ssePingIntervalMs: overrides.ssePingIntervalMs }),
    },
  );

  if (overrides.extendRouter !== undefined) {
    // `createApp` が組んだアプリに、実配線と同じ `route()` で追加のサブルーターをマウントする。
    // 静的配信のラッパーは `/api` 配下を `next()` に流すので、あとから足しても route が勝つ。
    const extra = new Hono();
    overrides.extendRouter(extra);
    app.route("/api", extra);
  }

  let closed = false;
  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    hub.closeAll();
    closeDb();
  }

  return { app, db, orchestrator, hub, gate, client, connection, close };
}

/** JSON を送る要求に共通のヘッダー。各ルートのテストファイルで共用する。 */
export const JSON_HEADERS = { "content-type": "application/json" };

/**
 * 実行が決着する（`status` が `running` でなくなる）まで待ち、決着後の `RunRecord` を返す。
 *
 * API 経由では `startRun` の戻り値（`done`）を受け取れないので、`run-settled` を購読して待つ。
 * **先に `hub.subscribe` してから `findRun` で状態を読む**（決定 12 と同じ順序）。逆にすると、
 * 読み取りと購読の間に決着した `run-settled` を取りこぼして永久に待つ。ループは DB を書いてから
 * `run-settled` を出す（`run/loop.ts` の `finalizeRun`、`run/orchestrator.ts` の `settleInternalError`）
 * ので、イベントを受けた時点で DB は決着済みであり、**状態の正本として DB を読み直す**。
 * ただし `run-settled` を受けて読み直した値が `running` のままのこともある（決定 33 の後始末自体が
 * 失敗した場合。イベントは DB の実際の値を載せるので嘘は無い）。「解決した＝終端状態」ではない。
 *
 * ハブが `closeAll()` された場合（ハーネスの `close()`）は、そのときの DB の値で解決する
 * （待ち続けてテストをタイムアウトさせない）。決着していない値が返りうるので、
 * 呼び出し側は「決着を待つ」用途でハーネスを閉じないこと。
 */
export function waitSettled(
  hub: RunEventHub,
  db: AppDatabaseLike,
  runId: string,
): Promise<RunRecord> {
  return new Promise<RunRecord>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let done = false;

    /** DB を読み直して解決する。読めなければ reject（実行が消えるのは想定外）。 */
    function settle(): void {
      if (done) {
        return;
      }
      done = true;
      unsubscribe?.();
      const current = findRun(db, runId);
      if (current === null) {
        reject(new Error(`決着を待っていた検査実行が見つかりません（実行 ID: ${runId}）`));
        return;
      }
      resolve(current);
    }

    unsubscribe = hub.subscribe(runId, {
      onEvent: (event) => {
        if (event.event.type === "run-settled") {
          settle();
        }
      },
      onClose: () => {
        settle();
      },
    });

    // 購読より後に読む（この順序が肝）。既に決着していれば、その場で解決する。
    const current = findRun(db, runId);
    if (current === null) {
      done = true;
      unsubscribe();
      reject(new Error(`決着を待っていた検査実行が見つかりません（実行 ID: ${runId}）`));
      return;
    }
    if (current.status !== "running") {
      settle();
    }
  });
}

/**
 * `setupApi` で作ったハーネスを控え、`afterEach` で必ず閉じる定型（`open`/`opened`/`afterEach` の
 * 三点セット）。各ルートのテストファイルがほぼ同じ形を書いていたので、3 つ目の重複が出たところで
 * ここへ集約した（Task 6 の申し送り）。呼び出しはテストファイルのトップレベルで 1 回だけ行うこと
 * （`afterEach` はモジュール読み込み時に登録される）。
 */
export function createHarnessRegistry(): { open(overrides?: SetupApiOverrides): ApiHarness } {
  const opened: ApiHarness[] = [];
  afterEach(() => {
    for (const harness of opened.splice(0)) {
      harness.close();
    }
  });
  return {
    open(overrides?: SetupApiOverrides): ApiHarness {
      const harness = setupApi(overrides);
      opened.push(harness);
      return harness;
    },
  };
}
