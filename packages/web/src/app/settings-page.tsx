/**
 * `/settings` — 設定画面（決定 9・18、PR11c 決定 3）。
 *
 * 3 つの節を並べる器。保存先も効く時期も節ごとに異なるため、節をまたいで 1 つの `<form>` や
 * 保存ボタンにまとめない（決定の詳細は各節のコンポーネントの JSDoc を参照）。
 *
 * - LM Studio への接続（`ConnectionSection`）：サーバー保存。「保存」を押した時点で効く。
 * - 生成に使うモデル（`ModelSection`）：`localStorage` 保存。選んだ時点で効く。
 * - 詳細な検査設定：`localStorage` 保存。次に開始する検査から効く（中身は Task 4 で入れる）。
 *
 * `features/connection/` と `features/settings/` の両方を束ねる画面なので、
 * 両者と同じ階層の `app/` に置く（`home-page.tsx` と同じ位置）。
 */

import { ConnectionSection } from "../features/connection/connection-section.tsx";
import { ModelSection } from "../features/connection/model-section.tsx";

export function SettingsPage() {
  return (
    <div>
      <h1>設定</h1>
      <ConnectionSection />
      <ModelSection />
      <section>
        <h2>詳細な検査設定</h2>
        <p>変更した時点でこのブラウザに保存し、次に開始する検査から使われます。</p>
      </section>
    </div>
  );
}
