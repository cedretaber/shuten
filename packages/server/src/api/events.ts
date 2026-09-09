/**
 * 実行イベントの購読（`GET /api/runs/:id/events`。PR10 決定 12・13）。
 *
 * 内部の `RunEvent` はそのまま流さず、`RunEventDto` に射影して流す。線上には「何が・どうなったか」
 * だけを載せ、内容はクライアントが API で取り直す（不変条件「SSE は通知手段、正本は DB」）。
 * `check-finished` の `CheckUnitResult`（`usage` など内部の結果型）は線上に出さない。
 *
 * 購読の規則（決定 12）：
 *
 * 1. 実行が無ければ 404。
 * 2. **先に hub へ購読してから** DB の状態を読む。逆にすると、読み取りと購読の間に決着した
 *    `run-settled` を取りこぼして、決着済みの実行を待ち続けるクライアントができる
 *    （JS は単一スレッドなので、購読を先に済ませれば決着は必ず届く）。
 * 3. 終端状態（`status !== "running"`）なら合成した `run-settled` を 1 件送って閉じる。
 * 4. `run-settled` を転送したら閉じる。
 * 5. `: ping` を一定間隔で送る（中継の無通信切断対策）。
 * 6. クライアント切断（`stream.onAbort`）では購読を解除するだけで、**実行は止めない**。
 * 7. 再送はしない（`id:` も付けない）。再接続したクライアントは `GET /api/runs/:id` と
 *    `findings` で復元する（仕様 8.2）。
 */

import type { RecheckNotApplicableReason, RunEventDto, UnitStatus } from "@shuten/shared";
import { runEventDtoSchema } from "@shuten/shared";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { findRun } from "../db/repositories/runs.ts";
import type { RunEvent } from "../run/events.ts";
import type { RecheckResult } from "../run/result.ts";
import type { ApiDeps } from "./deps.ts";
import { DEFAULT_SSE_PING_INTERVAL_MS } from "./deps.ts";
import { notFound } from "./errors.ts";

/**
 * 再確認の結果を線上の語彙に写す。`RecheckResult` の `disabled` / `suppressed` は `UnitStatus` に
 * 無いので `not-applicable` + 理由に写す。`pending` / `failed` / `done` はそのまま（理由は null）。
 */
function toRecheckStatus(result: RecheckResult): {
  readonly status: UnitStatus;
  readonly notApplicableReason: RecheckNotApplicableReason | null;
} {
  switch (result.status) {
    case "disabled":
      return { status: "not-applicable", notApplicableReason: "disabled" };
    case "suppressed":
      return { status: "not-applicable", notApplicableReason: "suppressed" };
    case "pending":
    case "failed":
    case "done":
      return { status: result.status, notApplicableReason: null };
  }
}

/**
 * `RunEvent`（server 内部）から `RunEventDto`（線上の形）への射影（決定 12）。
 *
 * `switch` に `default` を置かない（`packages/cli` の `formatEvent` と同じ書き方）。戻り値の型を
 * 宣言してあるので、イベントの union に値が増えたら「戻り値を返さない経路がある」として
 * コンパイルで落ちる。**`run-started` / `run-finished` はオーケストレーターが出さない**
 * （PR9b 決定 37）ので、写像を持たずに例外にする。この例外は hub が握りつぶす（決定 13）ので、
 * SSE の不具合が検査を止めることはない。
 */
export function toRunEventDto(event: RunEvent): RunEventDto {
  const inner = event.event;
  switch (inner.type) {
    case "target-planned":
      return {
        type: "target-planned",
        targetIndex: inner.targetIndex,
        // 範囲は項目を並べて写す（`TargetRange` など余分な項目を持つ値をそのまま渡さない）。
        target: { start: inner.target.start, end: inner.target.end },
        input: { start: inner.input.start, end: inner.input.end },
      };
    case "check-started":
      return {
        type: "check-started",
        targetIndex: inner.targetIndex,
        perspective: inner.perspective,
      };
    case "check-finished":
      // `CheckUnitResult` からは「どの対象・どの観点・どうなったか」だけを写す（決定 12）。
      return {
        type: "check-finished",
        targetIndex: inner.result.targetIndex,
        perspective: inner.result.perspective,
        status: inner.result.status,
      };
    case "target-merged":
      return {
        type: "target-merged",
        targetIndex: inner.targetIndex,
        findingCount: inner.findingCount,
      };
    case "recheck-started":
      return { type: "recheck-started", findingId: inner.findingId };
    case "recheck-finished": {
      const { status, notApplicableReason } = toRecheckStatus(inner.result);
      return { type: "recheck-finished", findingId: inner.findingId, status, notApplicableReason };
    }
    case "generation-slow":
      return { type: "generation-slow", unitId: inner.unitId, elapsedMs: inner.elapsedMs };
    case "save-rolled-back":
      return { type: "save-rolled-back", unitId: inner.unitId, kind: inner.kind };
    case "stop-requested":
      return { type: "stop-requested" };
    case "run-settled":
      return {
        type: "run-settled",
        status: inner.status,
        stopReason: inner.stop === null ? null : inner.stop.reason,
      };
    case "run-started":
    case "run-finished":
      // PR9b 決定 37：オーケストレーターはこの 2 つを出さない（開始・終了は `target-planned` と
      // `run-settled` で表す）。型名だけを載せる（イベントの中身は載せない）。
      throw new Error(`SSE に写せない実行イベントです: ${inner.type}`);
  }
}

export function registerEventRoutes(router: Hono, deps: ApiDeps): void {
  const pingIntervalMs = deps.ssePingIntervalMs ?? DEFAULT_SSE_PING_INTERVAL_MS;

  router.get("/runs/:id/events", (c) => {
    const runId = c.req.param("id");
    if (findRun(deps.db, runId) === null) {
      throw notFound("実行", runId);
    }

    return streamSSE(c, async (stream) => {
      /**
       * 購読 1 つにつき 1 本の Promise chain（決定 12）。`writeSSE` は Promise を返し、同期の
       * `try/catch` では reject を捕まえられない。直列化しないと、同じ tick に出た 2 件の
       * 書き込みが入り混じって順序が崩れる。`: ping` も同じ chain に乗せる。
       */
      let chain: Promise<void> = Promise.resolve();

      // コールバックが返るとストリーム本体が完了する。`closed` の resolve がその引き金。
      let done!: () => void;
      const closed = new Promise<void>((resolve) => {
        done = resolve;
      });

      let finished = false;
      let unsubscribe: (() => void) | null = null;

      // `finish` より前に作る（`finish` が clearInterval で参照するため）。
      const ping = setInterval(() => {
        chain = chain
          .then(async () => {
            await stream.write(": ping\n\n");
          })
          .catch(finish);
      }, pingIntervalMs);

      /** 購読を解除し、心拍を止め、ストリームを完了させる。何度呼んでも 1 度だけ効く。 */
      function finish(): void {
        if (finished) {
          return;
        }
        finished = true;
        unsubscribe?.();
        clearInterval(ping);
        done();
      }

      function send(dto: RunEventDto): void {
        if (finished) {
          return;
        }
        // 決定 3：線上に出す前に必ず検証する。失敗したらこの購読を閉じる（検証を通らない値は書かない）。
        const parsed = runEventDtoSchema.safeParse(dto);
        if (!parsed.success) {
          // 値は載せない（原稿の断片・接続先が混ざりうる）。種別だけを出す。
          console.error("SSE event rejected by schema", dto.type);
          finish();
          return;
        }
        chain = chain
          .then(() => stream.writeSSE({ event: dto.type, data: JSON.stringify(parsed.data) }))
          .catch(finish);
      }

      // 決定 12 の順序：**購読が先**。この後で DB を読む。
      unsubscribe = deps.hub.subscribe(runId, {
        onEvent: (runEvent) => {
          const dto = toRunEventDto(runEvent);
          send(dto);
          if (dto.type === "run-settled") {
            // 書き終えてから閉じる（chain に乗せた書き込みの後に finish が来るようにする）。
            chain.then(finish, finish);
          }
        },
        onClose: finish,
      });

      // 購読の後に読む。終端状態なら合成した `run-settled` を 1 件だけ送って閉じる。
      const current = findRun(deps.db, runId);
      if (current !== null && current.status !== "running") {
        send({ type: "run-settled", status: current.status, stopReason: current.stopReason });
        chain.then(finish, finish);
      }

      // クライアント切断。購読を解除するだけで、**実行は止めない**（決定 12 の 5）。
      stream.onAbort(finish);

      await closed;
    });
  });
}
