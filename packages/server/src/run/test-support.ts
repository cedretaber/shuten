/**
 * テスト用のフェイク LM Studio クライアント（PR10 Task 4）。
 *
 * `run/loop.test.ts` にあった `scriptedClient` をここに移して、実行まわりのテストと
 * `api/test-support.ts` の `setupApi()` で共用する。台本（`ChatStep` の配列）どおりに応答し、
 * 使い切ったあとに要求が来たら例外にする（「送らないはずの生成要求」を黙って成功させない）。
 *
 * **失敗の台本が投げる `LmStudioError` の `message` に接続先 URL は入れない**（裁定 R12）。
 * 実クライアント（`lmstudio/client.ts`）が投げる `message` は定型文・モデル ID・HTTP 状態・
 * タイムアウト値だけでできており、接続先 URL は `cause` にしか現れない。`cause` は
 * `executor.ts` の `toFailure` が写さないので保存も射影もされない。フェイクが URL を
 * 埋め込むと、系が約束していない漏えいを A0 に検出させることになる。
 *
 * 代わりに `failure()` は `FAKE_FAILURE_MARKER` を頭に付けた定型文を使う。A0（Task 10）は
 * この印を探すことで「失敗経路を実際に通ったか」を確かめられる（通っていなければ、番兵の
 * 検査は空振りで通ってしまう）。実クライアント側の保証は
 * `lmstudio/client.test.ts` の C52・C53（`message` に接続先 URL を入れない）が持つ。
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

/**
 * A0（Task 10）が「失敗経路を実際に通った」ことを確かめるための印。`failure()` が作る
 * `LmStudioError` の `message` に必ず入る。接続先 URL・API キーは入らない。
 */
export const FAKE_FAILURE_MARKER = "FAKE-FAILURE";

/** 台本の関数が受け取る共通の文脈。 */
export interface FakeCallContext {
  /** そのクライアントが結ばれている接続先。`message` には入らない（裁定 R12）。 */
  readonly endpointUrl: string;
  /**
   * 失敗の台本で投げる例外。`message` は `FAKE-FAILURE-<kind>: <note>` で、
   * **接続先 URL も API キーも含まない**（実クライアントの `message` と同じ性質）。
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
  /** 失敗の例外を作る。台本の外（`listModels` の差し替えなど）で使う。 */
  failure(kind: FailureReason, note?: string): LmStudioError;
  /**
   * 接続先 URL だけを差し替えたクライアント。台本・記録・呼び出し回数は共有する。
   * `createConnectionManager({ createClient })` が接続設定の更新のたびに新しい
   * クライアントを作るので、その差し替え先として使う。
   */
  bind(endpointUrl: string): LmStudioClient;
}

/** 失敗の印だけを入れた `LmStudioError`。接続先 URL は入れない（裁定 R12）。 */
function failureFor(kind: FailureReason, note?: string): LmStudioError {
  const detail = note ?? "生成要求に失敗した";
  return new LmStudioError(kind, `${FAKE_FAILURE_MARKER}-${kind}: ${detail}`, { raw: null });
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
      failure: (kind, note) => failureFor(kind, note),
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
    failure: (kind, note) => failureFor(kind, note),
    bind,
  };
}
