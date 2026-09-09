/**
 * テスト用のフェイク LM Studio クライアント（PR10 Task 4）。
 *
 * `run/loop.test.ts` にあった `scriptedClient` をここに移して、実行まわりのテストと
 * `api/test-support.ts` の `setupApi()` で共用する。台本（`ChatStep` の配列）どおりに応答し、
 * 使い切ったあとに要求が来たら例外にする（「送らないはずの生成要求」を黙って成功させない）。
 *
 * **失敗の台本で投げる `LmStudioError` の `message` には必ず接続先 URL を埋め込む**
 * （`failure()` がそうする）。実クライアントの最悪の形を模すためで、これが無いと
 * 「接続先 URL を応答・ログ・SSE・エラーに出さない」の検査（Task 10 の A0）が
 * 空振りで通ってしまう（URL の入っていない失敗経路を見ても何も分からない）。
 */

import type { FailureReason } from "@shuten/shared";

import { LmStudioError } from "../lmstudio/errors.ts";
import type { ChatRequest, ChatResult, LmStudioClient, ModelInfo } from "../lmstudio/types.ts";

/** 台本のクライアントが既定で名乗る接続先。テストではループバックのリテラルだけを使う。 */
export const SCRIPTED_ENDPOINT_URL = "http://127.0.0.1:1234";

/** ロード済みのモデル 1 件。`listModels` / `ensureLoaded` の既定の応答。 */
export const SCRIPTED_LOADED_MODEL: ModelInfo = {
  id: "model-a",
  type: "llm",
  state: "loaded",
  quantization: null,
  maxContextLength: 4096,
  loadedContextLength: 2048,
};

/** 台本の関数が受け取る共通の文脈。`failure` は接続先 URL を埋め込んだ例外を作る。 */
export interface FakeCallContext {
  readonly endpointUrl: string;
  /**
   * 失敗の台本で投げる例外。`message` に**必ず**接続先 URL を埋め込む
   * （実クライアントは接続先を含むメッセージを投げうる）。
   */
  failure(kind: FailureReason, note?: string): LmStudioError;
}

/** 1 回の生成要求への応答を決める関数。`index` は 0 始まりの通し番号。 */
export type ChatStep = (
  context: FakeCallContext & {
    readonly request: ChatRequest;
    readonly index: number;
    readonly signal: AbortSignal | undefined;
  },
) => ChatResult | Promise<ChatResult>;

export interface ScriptedClientOptions {
  /** 既定 `SCRIPTED_ENDPOINT_URL`。`bind()` で作るクライアントはこの値を上書きする。 */
  readonly endpointUrl?: string | undefined;
  readonly listModels?: ((context: FakeCallContext) => Promise<readonly ModelInfo[]>) | undefined;
  readonly ensureLoaded?:
    | ((context: FakeCallContext & { readonly modelId: string }) => Promise<ModelInfo>)
    | undefined;
}

export interface ScriptedClient {
  /** 既定の接続先に結んだクライアント。 */
  readonly client: LmStudioClient;
  readonly endpointUrl: string;
  /** 台本。テストの途中で `push` して足せる。 */
  readonly steps: ChatStep[];
  /** 送られた生成要求（再試行を含む）。 */
  readonly requests: ChatRequest[];
  readonly ensureLoadedCalls: string[];
  readonly listModelsCalls: number;
  readonly closeCalls: number;
  /** 既定の接続先に結んだ失敗。台本の外（`listModels` の差し替えなど）で使う。 */
  failure(kind: FailureReason, note?: string): LmStudioError;
  /**
   * 接続先 URL だけを差し替えたクライアント。台本・記録・呼び出し回数は共有する。
   * `createConnectionManager({ createClient })` が接続設定の更新のたびに新しい
   * クライアントを作るので、その差し替え先として使う。
   */
  bind(endpointUrl: string): LmStudioClient;
}

/** 接続先 URL を埋め込んだ `LmStudioError`。 */
function failureFor(endpointUrl: string, kind: FailureReason, note?: string): LmStudioError {
  const detail = note ?? "生成要求に失敗した";
  return new LmStudioError(kind, `${detail}（接続先: ${endpointUrl}）`, { raw: null });
}

export function scriptedClient(
  steps: readonly ChatStep[],
  options: ScriptedClientOptions = {},
): ScriptedClient {
  const script: ChatStep[] = [...steps];
  const requests: ChatRequest[] = [];
  const ensureLoadedCalls: string[] = [];
  let listModelsCalls = 0;
  let closeCalls = 0;

  const defaultEndpointUrl = options.endpointUrl ?? SCRIPTED_ENDPOINT_URL;

  function bind(endpointUrl: string): LmStudioClient {
    const context: FakeCallContext = {
      endpointUrl,
      failure: (kind, note) => failureFor(endpointUrl, kind, note),
    };
    return {
      listModels: async () => {
        listModelsCalls += 1;
        return options.listModels === undefined
          ? [SCRIPTED_LOADED_MODEL]
          : [...(await options.listModels(context))];
      },
      ensureLoaded: async (modelId) => {
        ensureLoadedCalls.push(modelId);
        return options.ensureLoaded === undefined
          ? SCRIPTED_LOADED_MODEL
          : await options.ensureLoaded({ ...context, modelId });
      },
      chat: async (request, chatOptions) => {
        const index = requests.length;
        requests.push(request);
        const step = script[index];
        if (step === undefined) {
          throw new Error(`台本にない生成要求（${String(index)} 件目）`);
        }
        return await step({ ...context, request, index, signal: chatOptions.signal });
      },
      close: () => {
        closeCalls += 1;
        return Promise.resolve();
      },
    };
  }

  return {
    client: bind(defaultEndpointUrl),
    endpointUrl: defaultEndpointUrl,
    steps: script,
    requests,
    ensureLoadedCalls,
    get listModelsCalls(): number {
      return listModelsCalls;
    },
    get closeCalls(): number {
      return closeCalls;
    },
    failure: (kind, note) => failureFor(defaultEndpointUrl, kind, note),
    bind,
  };
}
