import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createConnectionManager } from "./connection.ts";
import { createDatabase } from "./db/client.ts";
import { applyMigrations } from "./db/migrate.ts";
import { resolveDatabaseFile } from "./db/path.ts";
import { createRunEventHub } from "./run/event-hub.ts";
import { createOrchestrator } from "./run/orchestrator.ts";
import { createRequestQueue } from "./run/queue.ts";
import { createRecoveryGate } from "./run/recovery-gate.ts";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

// マイグレーションは起動時、API 受付前に適用する（決定 2）。
// 例外は捕まえずに（接続先 URL・API キーを出さずに）プロセスを非ゼロ終了させる。
const { db, close: closeDb } = createDatabase(resolveDatabaseFile(config));
applyMigrations(db);

// 接続の供給元（PR10 決定 5・6）。接続先 URL は settings 表 → 環境変数の順で決める。
// 保存済みの値が不正なときの例外は捕まえない（URL を含まない定型文で非ゼロ終了する）。
const connection = createConnectionManager({
  db,
  env: { lmStudioUrl: config.lmStudioUrl, lmStudioApiKey: config.lmStudioApiKey },
});

// キューと復旧ゲートはプロセス内に 1 個だけ作り、オーケストレーターへ渡す（決定 24）。
// オーケストレーターの内側で作ると、同じインスタンスを共有すべき接続確認が使えない。
const queue = createRequestQueue();
const recoveryGate = createRecoveryGate();

// 実行イベントの配信元（PR10 決定 13）。`emit` をそのままオーケストレーターの `onEvent` に渡す。
const hub = createRunEventHub();

const orchestrator = createOrchestrator({
  db,
  connection,
  queue,
  recoveryGate,
  recoveryConfirmMs: config.recoveryConfirmMs,
  onEvent: hub.emit,
});

// 起動時照合（決定 13）：マイグレーション適用後・API 受付前に行う。自動では再開しない。
// 例外は捕まえずに（接続先 URL・API キーを出さずに）プロセスを非ゼロ終了させる。
orchestrator.reconcileOnStartup();

const app = createApp(config, {
  db,
  connection,
  recoveryGate,
  orchestrator,
  hub,
  // validateHardTimeouts に渡す（決定 14）。queue は API が使わない（決定 8）。
  recoveryConfirmMs: config.recoveryConfirmMs,
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`shuten server: http://${info.address}:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
});

/** 終了手順**全体**の上限（決定 18）。超えたら諦めて非ゼロ終了する。 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

let shuttingDown = false;

/**
 * graceful shutdown（PR10 決定 18）。**走っている検査実行は待たない。**
 *
 * LM Studio 側の生成はこちらからは止められないので、待っても「終わった」ことにはならない。
 * 次回起動の `reconcileOnStartup` が `backend-restarted` として照合する（PR9 決定 13）。
 *
 * 順序には理由がある。
 *
 * 1. `server.close(cb)`：新規の接続を受け付けなくする。**`await` しない。** Node の `close` は
 *    「すべての接続が終わる」まで `cb` を呼ばないが、SSE の接続は自然には終わらないので、
 *    先に待つと必ず上限まで固まる。
 * 2. `hub.closeAll()`：SSE を閉じる（購読者の `onClose` がストリームのコールバックを返させる）。
 *    これが 1 の `cb` を呼べるようにする当のもの。
 * 3. `server.closeAllConnections()`：残った keep-alive の接続を切る。
 * 4. ここで初めて `cb`（1 の完了）を待つ。
 * 5. `connection.current().client.close()`：undici の `Agent.close()`。進行中の要求は流す。
 * 6. DB を閉じて `process.exit(0)`。
 *
 * 全体に `SHUTDOWN_TIMEOUT_MS` の上限を置き、超えたら `process.exit(1)`（タイマーは `unref()` する
 * ので、手順が先に終われば残らない）。2 回目のシグナルは即 `process.exit(1)`。
 *
 * **上限に達しうるのは実質 5 である。** undici の `Agent.close()` は進行中の要求が完了するまで
 * 解決しないので、LM Studio が応答を返す前に終了すると（生成中の Ctrl+C）この段で待たされ、
 * `shutdown: timeout` で非ゼロ終了する。生成そのものはどのみち止められないので、実害は
 * 「5 秒待って終了コードが 1 になる」ことだけ（DB は WAL なので次回起動時に復旧する）。
 *
 * Windows には `SIGTERM` が届かない。対象はコンソールの Ctrl+C（`SIGINT`）だけになる。
 */
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    // 2 回目のシグナルは待たずに落とす（利用者が「もう待てない」と言っている）。
    console.log("shutdown: forced");
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`shutdown: ${signal}`);

  setTimeout(() => {
    console.log("shutdown: timeout");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  void (async () => {
    try {
      // 1：新規受付を止める（await しない）。
      const closedServer = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });

      // 2：SSE を閉じる。3：残った接続を切る。
      hub.closeAll();
      // `ServerType` は `Http2Server` を含み、そちらに `closeAllConnections` は無い
      // （実際に返るのは `node:http` の `Server`）。型の絞り込みで確かめてから呼ぶ。
      if ("closeAllConnections" in server) {
        server.closeAllConnections();
      }

      // 4：ここで待つ。
      await closedServer;

      // 5：進行中の要求を流してから接続を捨てる。
      await connection.current().client.close();
    } catch (error) {
      // 接続先 URL・API キーを出さない（例外の `message` は含みうる）。クラス名だけ出す。
      console.error(`shutdown: error ${error instanceof Error ? error.name : typeof error}`);
    }

    // 6：DB を閉じる。ここまで来たら成功とみなす（DB を閉じ損ねても 0 で終わる）。
    try {
      closeDb();
    } catch (error) {
      console.error(`shutdown: error ${error instanceof Error ? error.name : typeof error}`);
    }
    console.log("shutdown: done");
    process.exit(0);
  })();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(signal));
}
