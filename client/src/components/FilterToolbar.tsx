/**
 * Global filter controls: matrix, fraction, non-detect method.
 */

import React from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import type {NonDetectMethod} from '../slices/chemrooms-slice';

export const FilterToolbar: React.FC = () => {
  const matrixFilter = useChemroomsStore(
    (s) => s.chemrooms.config.matrixFilter,
  );
  const fractionFilter = useChemroomsStore(
    (s) => s.chemrooms.config.fractionFilter,
  );
  const nonDetectMethod = useChemroomsStore(
    (s) => s.chemrooms.config.nonDetectMethod,
  );
  const availableMatrices = useChemroomsStore(
    (s) => s.chemrooms.availableMatrices,
  );
  const setMatrixFilter = useChemroomsStore(
    (s) => s.chemrooms.setMatrixFilter,
  );
  const setFractionFilter = useChemroomsStore(
    (s) => s.chemrooms.setFractionFilter,
  );
  const setNonDetectMethod = useChemroomsStore(
    (s) => s.chemrooms.setNonDetectMethod,
  );

  return (
    <div className="flex flex-col gap-2 rounded-md border p-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Filters
      </span>

      {/* Matrix */}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Matrix</span>
        <select
          className="rounded border bg-background px-2 py-1 text-sm"
          value={matrixFilter ?? ''}
          onChange={(e) =>
            setMatrixFilter(e.target.value === '' ? null : e.target.value)
          }
        >
          <option value="">All Matrices</option>
          {availableMatrices.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>

      {/* Fraction */}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Fraction</span>
        <select
          className="rounded border bg-background px-2 py-1 text-sm"
          value={fractionFilter ?? ''}
          onChange={(e) =>
            setFractionFilter(e.target.value === '' ? null : e.target.value)
          }
        >
          <option value="">All</option>
          <option value="Total">Total</option>
          <option value="Dissolved">Dissolved</option>
        </select>
      </label>

      {/* Non-detect method */}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Non-Detect Display</span>
        <select
          className="rounded border bg-background px-2 py-1 text-sm"
          value={nonDetectMethod}
          onChange={(e) =>
            setNonDetectMethod(e.target.value as NonDetectMethod)
          }
        >
          <option value="half_dl">Half Detection Limit</option>
          <option value="at_dl">At Detection Limit</option>
          <option value="zero">Zero</option>
          <option value="exclude">Exclude</option>
        </select>
      </label>
    </div>
  );
};
