/**
 * 絞り込みの操作子（Task 6、決定 7・8・10）。
 *
 * 判定そのものは `finding-filter.ts` の純関数（`matchesFilter` 等）が持つ。ここはチェックボックス
 * 群を描き、`onChange` で次の `FindingFilter` を返すだけの操作子。絞り込みの状態自体は
 * `results-page.tsx` が持つ（URL にも `localStorage` にも保存しない）。
 */

import type { FindingCategory, JudgmentStatus } from "@shuten/shared";
import type { FindingFilter, LocateState, RecheckState } from "./finding-filter.ts";
import {
  FILTER_CATEGORY_OPTIONS,
  FILTER_JUDGMENT_OPTIONS,
  LOCATE_STATE_LABELS,
  LOCATE_STATES,
  RECHECK_STATE_LABELS,
  RECHECK_STATES,
  toggleFilterValue,
} from "./finding-filter.ts";
import { FINDING_CATEGORY_LABELS, JUDGMENT_STATUS_LABELS } from "./labels.ts";
import styles from "./results-page.module.css";

export interface FindingFilterControlsProps {
  readonly filter: FindingFilter;
  readonly onChange: (next: FindingFilter) => void;
}

export function FindingFilterControls(props: FindingFilterControlsProps) {
  const { filter, onChange } = props;

  return (
    <div className={styles.filter}>
      <CheckboxGroup
        legend="分類"
        options={FILTER_CATEGORY_OPTIONS}
        selected={filter.categories}
        labelOf={(value: FindingCategory) => FINDING_CATEGORY_LABELS[value]}
        onToggle={(value) =>
          onChange({
            ...filter,
            categories: toggleFilterValue(filter.categories, FILTER_CATEGORY_OPTIONS, value),
          })
        }
      />
      <CheckboxGroup
        legend="採否"
        options={FILTER_JUDGMENT_OPTIONS}
        selected={filter.judgments}
        labelOf={(value: JudgmentStatus) => JUDGMENT_STATUS_LABELS[value]}
        onToggle={(value) =>
          onChange({
            ...filter,
            judgments: toggleFilterValue(filter.judgments, FILTER_JUDGMENT_OPTIONS, value),
          })
        }
      />
      <CheckboxGroup
        legend="再確認"
        options={RECHECK_STATES}
        selected={filter.recheckStates}
        labelOf={(value: RecheckState) => RECHECK_STATE_LABELS[value]}
        onToggle={(value) =>
          onChange({
            ...filter,
            recheckStates: toggleFilterValue(filter.recheckStates, RECHECK_STATES, value),
          })
        }
      />
      <CheckboxGroup
        legend="位置特定"
        options={LOCATE_STATES}
        selected={filter.locateStates}
        labelOf={(value: LocateState) => LOCATE_STATE_LABELS[value]}
        onToggle={(value) =>
          onChange({
            ...filter,
            locateStates: toggleFilterValue(filter.locateStates, LOCATE_STATES, value),
          })
        }
      />

      <label className={styles.filterOption}>
        <input
          type="checkbox"
          checked={filter.showSuppressed}
          onChange={(event) => onChange({ ...filter, showSuppressed: event.target.checked })}
        />
        抑制された指摘も表示する
      </label>
      <label className={styles.filterOption}>
        <input
          type="checkbox"
          checked={filter.showWithdrawn}
          onChange={(event) => onChange({ ...filter, showWithdrawn: event.target.checked })}
        />
        撤回された指摘も表示する
      </label>
    </div>
  );
}

interface CheckboxGroupProps<T extends string> {
  readonly legend: string;
  readonly options: readonly T[];
  /** null は「すべて選択」——チェックボックスはすべてチェック済みとして描く。 */
  readonly selected: readonly T[] | null;
  readonly labelOf: (value: T) => string;
  readonly onToggle: (value: T) => void;
}

function CheckboxGroup<T extends string>(props: CheckboxGroupProps<T>) {
  const { legend, options, selected, labelOf, onToggle } = props;

  return (
    <fieldset className={styles.filterFieldset}>
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option} className={styles.filterOption}>
          <input
            type="checkbox"
            checked={selected === null || selected.includes(option)}
            onChange={() => onToggle(option)}
          />
          {labelOf(option)}
        </label>
      ))}
    </fieldset>
  );
}
