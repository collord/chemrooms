/**
 * Global filter controls: matrix, fraction, non-detect method.
 *
 * The non-detect method dropdown is driven by the chemduck
 * `aggregation_rules` catalog (category = 'nd_method'), so new
 * ND-handling strategies added in chemduck surface here automatically.
 */

import React from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import type {NdMethod} from '../slices/chemrooms-slice';
import {AggregationRulePicker} from './AggregationRulePicker';

export const FilterToolbar: React.FC = () => {
  const matrixFilter = useChemroomsStore(
    (s) => s.chemrooms.config.matrixFilter,
  );
  const fractionFilter = useChemroomsStore(
    (s) => s.chemrooms.config.fractionFilter,
  );
  const ndMethod = useChemroomsStore((s) => s.chemrooms.config.ndMethod);
  const availableMatrices = useChemroomsStore(
    (s) => s.chemrooms.availableMatrices,
  );
  const setMatrixFilter = useChemroomsStore(
    (s) => s.chemrooms.setMatrixFilter,
  );
  const setFractionFilter = useChemroomsStore(
    (s) => s.chemrooms.setFractionFilter,
  );
  const setNdMethod = useChemroomsStore((s) => s.chemrooms.setNdMethod);

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

      {/* Non-detect method — driven by chemduck catalog */}
      <AggregationRulePicker
        category="nd_method"
        label="Non-Detect Display"
        value={ndMethod}
        onChange={(name) => setNdMethod(name as NdMethod)}
      />
    </div>
  );
};
