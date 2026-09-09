export interface EnqueueOptions {
  /** 順番が来る前にこれが abort されたら、ジョブを呼ばずに `QueueCancelledError` で決着させる。 */
  readonly signal?: AbortSignal | undefined;
}

/**
 * 順番が来る前に取り消されたことを表す（決定 45-2）。ジョブは 1 度も呼ばれていない
 * ＝生成要求を 1 件も送っていないので、呼び出し元はこれを「送らなかった」経路に写す。
 */
export class QueueCancelledError extends Error {
  constructor(message = "キューの順番が来る前に取り消された") {
    super(message);
    this.name = "QueueCancelledError";
  }
}

/**
 * バックエンド全体で 1 本だけ持つ実行キュー（仕様書 2 節、決定 2）。
 *
 * LM Studio への生成要求（`chat`）は同時に 1 本しか投げない、という制約は 1 つの実行
 * （`runPipeline` 1 回）の中だけでは満たせない。複数タブ・複数原稿から別々の実行が
 * 同時に始まると、それぞれの `executor` が持つ直列化（`tail`）は互いを知らないため要求が
 * 並んでしまう。このキューはプロセス全体で共有し、`createExecutor` の `options.queue` に
 * 渡すことで、実行をまたいだ直列化を実現する。
 *
 * PR10 で追加される接続確認（モデル一覧・軽い生成要求によるヘルスチェック）も、同じ
 * 「LM Studio への要求は同時に 1 本」という制約を受けるため、将来このキューを通す想定で
 * 作ってある。ジョブの中身が「実行 1 単位」か「接続確認 1 回」かをキュー自身は区別しない。
 */
export interface RequestQueue {
  /**
   * ジョブを投入する。FIFO で、前のジョブが解決してから次を始める。
   * `options.signal` を渡すと、**順番が来る前**にそれが abort された時点で、前のジョブの
   * 解決を待たずに `QueueCancelledError` で決着する（決定 45-2）。すでに走り始めた
   * ジョブは取り消さない（その場合はジョブ自身の結果で決着する）。
   */
  enqueue<T>(job: () => Promise<T>, options?: EnqueueOptions): Promise<T>;
  /** 現在待機中（実行中を含む）のジョブ数。 */
  readonly size: number;
}

export function createRequestQueue(): RequestQueue {
  let size = 0;
  // 直前に投入されたジョブの完了（成功・失敗いずれか）を表す Promise。
  // 常に resolve 側だけを連鎖させることで、あるジョブの失敗が後続のジョブを止めない。
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(job: () => Promise<T>, options?: EnqueueOptions): Promise<T> {
    size += 1;
    const signal = options?.signal;
    // "waiting"（順番待ち）→ "running"（ジョブ実行中）か "cancelled"（順番前に取り消し）。
    // 取り消しの冪等性をこの 1 変数で担保する。
    let state: "waiting" | "running" | "cancelled" = "waiting";
    let rejectCancelled: (error: Error) => void = () => undefined;
    const cancellation = new Promise<never>((_, reject) => {
      rejectCancelled = reject;
    });
    // 取り消しが起きなかった場合に未処理拒否として扱われないようにする。
    cancellation.catch(() => undefined);

    const onAbort = (): void => {
      if (state !== "waiting") {
        // すでに走り始めている（あるいは取り消し済み）。走っているジョブは取り消さない。
        return;
      }
      state = "cancelled";
      rejectCancelled(new QueueCancelledError());
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // 順番が来たときの処理。取り消し済みなら job を呼ばずに投げるだけで、tail の連鎖は
    // 下の行で必ず続く（ここで連鎖を切ると後続ジョブの順序が壊れる）。
    const turn = tail.then(() => {
      signal?.removeEventListener("abort", onAbort);
      if (state === "cancelled") {
        throw new QueueCancelledError();
      }
      state = "running";
      return job();
    });
    tail = turn.then(
      () => undefined,
      () => undefined,
    );
    // size の減算は turn にだけ付ける。turn は必ず 1 度だけ決着するので二重減算にならない
    // （早期取り消しで呼び出し元が先に決着しても、キューの席が空くのは順番が来たときである）。
    void turn.then(
      () => {
        size -= 1;
      },
      () => {
        size -= 1;
      },
    );

    // 早期取り消しと「順番が来て skip」のどちらでも同じ QueueCancelledError で決着する。
    return Promise.race([turn, cancellation]);
  }

  return {
    enqueue,
    get size(): number {
      return size;
    },
  };
}
