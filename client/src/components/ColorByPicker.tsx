/**
 * Sidebar control for picking which column to color a table's entities by.
 *
 * The dropdown lists all columns the table's vis spec defines (with their
 * human-readable labels), plus a "None" option. The selection is stored
 * in chemrooms.colorBy[table] and used by the entity rendering layer
 * (once that's wired up — currently the entities still render as cyan).
 */

import React from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {Legend} from './Legend';

interface ColorByPickerProps {
  /** Table whose color-by selection this picker manipulates. */
  table: string;
  /** Display label, e.g. "Color locations by" */
  label: string;
}

export const ColorByPicker: React.FC<ColorByPickerProps> = ({table, label}) => {
  const visSpec = useChemroomsStore((s) => s.chemrooms.visSpecs[table]);
  const colorBy = useChemroomsStore((s) => s.chemrooms.colorBy[table]);
  const setColorBy = useChemroomsStore((s) => s.chemrooms.setColorBy);

  if (!visSpec) return null;

  const columns = Object.entries(visSpec.columns);
  if (columns.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="shrink-0">{label}</span>
        <select
          value={colorBy ?? ''}
          onChange={(e) => setColorBy(table, e.target.value || null)}
          className="rounded border bg-background px-2 py-1 text-sm"
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
