import { randomUUID } from "node:crypto";

/** 永続化する各表の主キーを採番する。PR9 が検査パイプラインの採番器としてこれを注入する。 */
export function createId(): string {
  return randomUUID();
}
