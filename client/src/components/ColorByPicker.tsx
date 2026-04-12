/**
 * Sidebar control for picking which column to color the active layer by.
 *
 * Two modes:
 *
 * - **Static** (`table` prop): bound to a specific vis spec table.
 *   Used when the layer's data source is fixed.
 *
 * - **Analyte-aware** (default in SidebarPanel): the underlying vis
 *   spec table switches based on whether an analyte is selected:
 *     - No analyte → 'samples' (the cyan overview)
 *     - Analyte selected → 'v_results_denormalized' (joined results)
 *   The user never sees the table-name plumbing — they just see one
 *   "Color by" dropdown that shows the right options for the current
 *   view.
 *
 * The dropdown lists all columns the active vis spec defines (with
 * their human-readable labels), plus a "None" option. The selection
 * is stored in chemrooms.colorBy[table] and used by useChemroomsEntities
 * to render per-row colors.
 */

import React from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {Legend} from './Legend';

interface ColorByPickerProps {
  /**
   * Specific vis spec table to bind to. If omitted, the picker is
   * analyte-aware: it switches between 'samples' and
   * 'v_results_denormalized' based on whether coloringAnalyte is set.
   */
  table?: string;
  /** Display label, defaults to "Color by" in analyte-aware mode. */
  label?: string;
  /** When true, render greyed out and ignore changes. */
  disabled?: boolean;
}

export const ColorByPicker: React.FC<ColorByPickerProps> = ({
  table: tableProp,
  label,
  disabled = false,
}) => {
  const coloringAnalyte = useChemroomsStore(
    (s) => s.chemrooms.config.coloringAnalyte,
  );

  // Resolve which vis spec table to bind to. In analyte-aware mode,
  // switch based on whether an analyte is selected.
  const table =
    tableProp ??
    (coloringAnalyte ? 'v_results_denormalized' : 'samples');
  const effectiveLabel = label ?? 'Color by';

  const visSpec = useChemroomsStore((s) => s.chemrooms.visSpecs[table]);
  const colorBy = useChemroomsStore((s) => s.chemrooms.colorBy[table]);
  const setColorBy = useChemroomsStore((s) => s.chemrooms.setColorBy);

  if (!visSpec) return null;

  const columns = Object.entries(visSpec.columns);
  if (columns.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span className="shrink-0">{effectiveLabel}</span>
        <select
          value={colorBy ?? ''}
          onChange={(e) => setColorBy(table, e.target.value || null)}
          disabled={disabled}
          className="rounded border bg-background px-2 py-1 text-sm disabled:opacity-50"
        >
          <option value="">None</option>
          {columns.map(([name, spec]) => (
            <option key={name} value={name}>
              {spec.label ?? name}
            </option>
          ))}
        </select>
      </label>
      {colorBy && <Legend table={table} />}
    </div>
  );
};
