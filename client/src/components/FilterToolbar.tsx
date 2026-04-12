/**
 * Recipe filter controls: matrix, fraction, non-detect method.
 *
 * The non-detect method dropdown is driven by the chemduck
 * `aggregation_rules` catalog (category = 'nd_method'), so new
 * ND-handling strategies added in chemduck surface here automatically.
 *
 * All controls grey out together via the `disabled` prop. SidebarPanel
 * passes `disabled={!coloringAnalyte}` since these are part of the
 * recipe being authored — only meaningful once an analyte is picked.
 */

import React from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import type {NdMethod} from '../slices/chemrooms-slice';
import {AggregationRulePicker} from './AggregationRulePicker';

interface FilterToolbarProps {
  disabled?: boolean;
}

export const FilterToolbar: React.FC<FilterToolbarProps> = ({
  disabled = false,
}) => {
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
    <>
      {/* Matrix */}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Matrix</span>
        <select
          className="rounded border bg-background px-2 py-1 text-sm disabled:opacity-50"
          value={matrixFilter ?? ''}
          disabled={disabled}
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
          className="rounded border bg-background px-2 py-1 text-sm disabled:opacity-50"
          value={fractionFilter ?? ''}
          disabled={disabled}
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
        disabled={disabled}
      />
    </>
  );
};
