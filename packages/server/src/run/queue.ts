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
  /** ジョブを投入する。FIFO で、前のジョブが解決してから次を始める。 */
  enqueue<T>(job: () => Promise<T>): Promise<T>;
  /** 現在待機中（実行中を含む）のジョブ数。 */
  readonly size: number;
}

export function createRequestQueue(): RequestQueue {
  let size = 0;
  // 直前に投入されたジョブの完了（成功・失敗いずれか）を表す Promise。
  // 常に resolve 側だけを連鎖させることで、あるジョブの失敗が後続のジョブを止めない。
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    size += 1;
    const result = tail.then(job);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    // 呼び出し元に例外を返しつつ、キューの残数を必ず 1 減らす。
    void result.then(
      () => {
        size -= 1;
      },
      () => {
        size -= 1;
      },
    );
    return result;
  }

  return {
    enqueue,
    get size(): number {
      return size;
    },
  };
}
