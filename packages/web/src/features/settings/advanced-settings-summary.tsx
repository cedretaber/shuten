/**
 * メイン画面（`/`）に出す詳細設定の要約（PR11c 決定 1・5・6）。
 *
 * 詳細設定そのものは設定画面へ移した。移しただけだと「自分が変えた覚えの無い設定で検査が走る」
 * 状態を作れてしまうので、ここに**既定値と違う項目を名前と値で**出す。件数だけの表示にはしない。
 * 長くなりすぎないよう、先頭 2 件だけを名前と値で出し、残りは「ほか N 項目」に畳む。
 *
 * この部品は**表示だけを持つ**。状態は `run-settings-form.tsx` が持ち、「既定値に戻す」は
 * `onReset` を呼ぶだけにする（保存と state の更新は呼び出し側が一度に行う。決定 5）。
 */

import { Link } from "react-router";
import { ROUTES } from "../../app/routes.ts";
import type { AdvancedRunSettings } from "../../storage/run-settings.ts";
import { type AdvancedChange, describeAdvancedChanges } from "./advanced-settings-description.ts";
import styles from "./settings.module.css";

/** 名前と値で出す件数。これを超えた分は「ほか N 項目」に畳む。 */
const SHOWN_CHANGE_COUNT = 2;

/** 要約の本文。すべて既定値なら「既定値」。 */
function summarize(changes: readonly AdvancedChange[]): string {
  if (changes.length === 0) return "既定値";

  const shown = changes
    .slice(0, SHOWN_CHANGE_COUNT)
    .map((change) => `${change.label} ${change.value}`);
  const rest = changes.length - shown.length;
  if (rest > 0) shown.push(`ほか ${rest} 項目`);
  return shown.join("、");
}

export interface AdvancedSettingsSummaryProps {
  readonly settings: AdvancedRunSettings;
  readonly onReset: () => void;
}

export function AdvancedSettingsSummary(props: AdvancedSettingsSummaryProps): React.JSX.Element {
  const { settings, onReset } = props;

  const changes = describeAdvancedChanges(settings);

  return (
    <div className={styles.advancedSummaryBox}>
      {/* 1 つの文字列として出す（要素で分けると読み上げも検索も分断される）。 */}
      <p className={styles.advancedSummaryText}>{`詳細設定：${summarize(changes)}`}</p>
      <div className={styles.advancedSummaryActions}>
        <Link to={ROUTES.settings}>設定を開く</Link>
        <button
          type="button"
          className={styles.advancedResetButton}
          onClick={onReset}
          disabled={changes.length === 0}
        >
          既定値に戻す
        </button>
      </div>
    </div>
  );
}
