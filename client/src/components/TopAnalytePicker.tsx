/**
 * Top-of-sidebar analyte selector. Drives the samples layer
 * aggregation/coloring via `chemrooms.config.coloringAnalyte`.
 *
 * The list of analytes comes from `v_analyte_summary` (which is loaded
 * from the chemduck SQL view at startup). When the user selects an
 * analyte, the samples layer SQL is rebuilt to call
 * `aggregate_results(...)` and the visual encoding switches to color
 * by the resulting concentration values.
 */

import React from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';

export const TopAnalytePicker: React.FC = () => {
  const analyteNames = useChemroomsStore(
    (s) => s.chemrooms.availableAnalyteNames,
  );
  const coloringAnalyte = useChemroomsStore(
    (s) => s.chemrooms.config.coloringAnalyte,
  );
  const setColoringAnalyte = useChemroomsStore(
    (s) => s.chemrooms.setColoringAnalyte,
  );

  const hasAnalytes = analyteNames.length > 0;

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Analyte
      </span>
      <select
        className="rounded border bg-background px-2 py-1 text-sm disabled:opacity-50"
        value={coloringAnalyte ?? ''}
        onChange={(e) =>
          setColoringAnalyte(e.target.value === '' ? null : e.target.value)
        }
        disabled={!hasAnalytes}
      >
        <option value="">— show all samples —</option>
        {analyteNames.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
    </label>
  );
};
