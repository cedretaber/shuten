/**
 * `/settings` — 設定画面（決定 9・18、PR11c 決定 3）。
 *
 * 3 つの節を並べる器。保存先も効く時期も節ごとに異なるため、節をまたいで 1 つの `<form>` や
 * 保存ボタンにまとめない（決定の詳細は各節のコンポーネントの JSDoc を参照）。
 *
 * - LM Studio への接続（`ConnectionSection`）：サーバー保存。「保存」を押した時点で効く。
 * - 生成に使うモデル（`ModelSection`）：`localStorage` 保存。選んだ時点で効く。
 * - 詳細な検査設定（`AdvancedSettingsSection`）：`localStorage` 保存。変更した時点で保存し、
 *   次に開始する検査から効く。
 *
 * `features/connection/` と `features/settings/` の両方を束ねる画面なので、
 * 両者と同じ階層の `app/` に置く（`home-page.tsx` と同じ位置）。
 */

import { ConnectionSection } from "../features/connection/connection-section.tsx";
import { ModelSection } from "../features/connection/model-section.tsx";
import { AdvancedSettingsSection } from "../features/settings/advanced-settings-section.tsx";
import styles from "../features/settings/settings.module.css";

export function SettingsPage() {
  return (
    <div>
      <h1>設定</h1>
      <ConnectionSection />
      <ModelSection />
      {/* 上の 2 節は自分で `<section>` を描く。3 節目だけは中身の部品が入力欄しか持たないので、
          外枠と見出しをここで描き、上の 2 節と同じ見え方のクラスを当てる。 */}
      <section className={styles.pageSection}>
        <h2>詳細な検査設定</h2>
        <p className={styles.pageSectionDescription}>
          変更した時点でこのブラウザに保存し、次に開始する検査から使われます。
        </p>
        <AdvancedSettingsSection />
      </section>
    </div>
  );
}
