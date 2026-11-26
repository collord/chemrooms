/**
 * Recipe filter controls: matrix, fraction, method class, non-detect display.
 *
 * The non-detect control is a DISPLAY choice (setup/ndDisplay.ts): which
 * result a point shows is the dataset's non-detect policy's, under
 * ChemDuck's shared rules; this only changes how a selected non-detect is
 * drawn, or hides it. It used to list ChemDuck 0.1's substitutions from the
 * `aggregation_rules` catalog, which also changed the selection.
 *
 * The method class picker appears only when the analyte, in the chosen
 * matrix and fraction, is measured by more than one class. A field and a
 * lab pH are two variables; with no class chosen each is its own point,
 * drawn at the same place.
 *
 * All controls grey out together via the `disabled` prop. SidebarPanel
 * passes `disabled={!coloringAnalyte}` since these are part of the
 * recipe being authored — only meaningful once an analyte is picked.
 */

import {selectChemduckReady} from '../slices/selectors';
import React, {useEffect, useMemo} from 'react';
import {useSql} from '@sqlrooms/duckdb';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import type {NdMethod} from '../slices/chemrooms-slice';
import {ND_DISPLAY_OPTIONS, normalizeNdDisplay} from '../setup/ndDisplay';
import {RowScopeControls} from './RowScopeControls';

interface FilterToolbarProps {
  disabled?: boolean;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const selectClass = 'rounded border bg-background px-2 py-1 text-sm disabled:opacity-50';

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
          className={selectClass}
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
          className={selectClass}
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

      <MethodClassPicker disabled={disabled} />

      <RowScopeControls disabled={disabled} />

      {/* Non-detect display */}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Non-Detect Display</span>
        <select
          className={selectClass}
          value={normalizeNdDisplay(ndMethod)}
          disabled={disabled}
          title={ND_DISPLAY_OPTIONS.find((o) => o.name === normalizeNdDisplay(ndMethod))?.description}
          onChange={(e) => setNdMethod(e.target.value as NdMethod)}
        >
          {ND_DISPLAY_OPTIONS.map((o) => (
            <option key={o.name} value={o.name} title={o.description}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
};

/**
 * The analyte's method classes in the chosen matrix and fraction, from
 * `variable_catalog` (initEntityLayers): ChemDuck's catalogue, never a
 * scan of the results. Hidden when there is only one.
 */
const MethodClassPicker: React.FC<{disabled: boolean}> = ({disabled}) => {
  const analyte = useChemroomsStore((s) => s.chemrooms.config.coloringAnalyte);
  const matrix = useChemroomsStore((s) => s.chemrooms.config.matrixFilter);
  const fraction = useChemroomsStore((s) => s.chemrooms.config.fractionFilter);
  const methodClass = useChemroomsStore((s) => s.chemrooms.config.methodClass);
  const setMethodClass = useChemroomsStore((s) => s.chemrooms.setMethodClass);
  const hasSchema = useChemroomsStore(selectChemduckReady);

  const {data} = useSql<{method_class: string | null; n: number}>({
    query: analyte
      ? `SELECT method_class, SUM(n_results)::INTEGER AS n FROM variable_catalog
         WHERE analyte = ${lit(analyte)}
           ${matrix ? `AND matrix = ${lit(matrix)}` : ''}
           ${fraction ? `AND fraction = ${lit(fraction)}` : ''}
         GROUP BY 1 ORDER BY n DESC, 1`
      : 'SELECT NULL AS method_class, 0 AS n WHERE FALSE',
    enabled: Boolean(analyte) && hasSchema,
  });
  const classes = useMemo(
    () =>
      data
        ? data
            .toArray()
            .map((r) => ({name: r.method_class ?? '', n: Number(r.n)}))
            .filter((c) => c.name !== '')
        : [],
    [data],
  );

  // A class the new analyte (or matrix, fraction) doesn't have would map
  // nothing: let it go.
  useEffect(() => {
    if (data && methodClass && !classes.some((c) => c.name === methodClass)) {
      setMethodClass(null);
    }
  }, [data, classes, methodClass, setMethodClass]);

  if (classes.length < 2) return null;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">Method class</span>
      <select
        className={selectClass}
        value={methodClass ?? ''}
        disabled={disabled}
        title="A field and a lab measurement are different variables, never combined"
        onChange={(e) => setMethodClass(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">Each its own point</option>
        {classes.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} ({c.n.toLocaleString()} results)
          </option>
        ))}
      </select>
    </label>
  );
};
