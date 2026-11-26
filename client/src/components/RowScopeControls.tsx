/**
 * The row scope controls (setup/rowScope.ts): which results every map and
 * chart reads. Collapsed to one line that says what is in force.
 *
 * The lists offered are read from UNSCOPED rows, as the QGIS plugin's are,
 * so ticking a choice never shrinks its own list:
 *  - sample types, dates and depth units from `samples`, a local table
 *    for every kind of project;
 *  - reported units from the picked analyte's results, read only while
 *    this panel is open: over an ARII source that reads the analyte's row
 *    groups, the cost of drawing its map, never the whole facility.
 * A control whose data has nothing to choose (one sample type, no reported
 * units) is left out.
 */

import React, {useMemo, useState} from 'react';
import {useSql} from '@sqlrooms/duckdb';
import {ChevronDown, ChevronRight} from 'lucide-react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {selectChemduckReady} from '../slices/selectors';
import {describeRowScope, isDefaultRowScope} from '../setup/rowScope';

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const inputClass = 'w-full rounded border bg-background px-2 py-1 text-sm disabled:opacity-50';
const NO_ROWS = 'SELECT NULL WHERE FALSE';

/** Length units ChemDuck converts between exactly, besides what the data uses. */
const COMMON_DEPTH_UNITS = ['m', 'ft', 'cm', 'in'];

export const RowScopeControls: React.FC<{disabled?: boolean}> = ({disabled = false}) => {
  const [open, setOpen] = useState(false);
  const scope = useChemroomsStore((s) => s.chemrooms.config.rowScope);
  const setRowScope = useChemroomsStore((s) => s.chemrooms.setRowScope);
  const analyte = useChemroomsStore((s) => s.chemrooms.config.coloringAnalyte);
  const samplesTable = useChemroomsStore((s) => s.db.findTableByName('samples'));
  const ready = useChemroomsStore(selectChemduckReady);

  const {data: facts} = useSql<{lo: string | null; hi: string | null}>({
    query: `SELECT CAST(min(sample_date) AS VARCHAR) AS lo, CAST(max(sample_date) AS VARCHAR) AS hi FROM samples`,
    enabled: Boolean(samplesTable),
  });
  const {data: typesData} = useSql<{t: string | null; n: number}>({
    query: `SELECT sample_type AS t, count(*)::INTEGER AS n FROM samples GROUP BY 1 ORDER BY 2 DESC`,
    enabled: Boolean(samplesTable),
  });
  const {data: depthUnitsData} = useSql<{u: string; n: number}>({
    query: `SELECT depth_units AS u, count(*)::INTEGER AS n FROM samples
            WHERE depth_units IS NOT NULL AND trim(depth_units) <> '' GROUP BY 1 ORDER BY 2 DESC`,
    enabled: Boolean(samplesTable),
  });
  const matrix = useChemroomsStore((s) => s.chemrooms.config.matrixFilter);
  // In the chosen matrix, as the plugin offers them: a solid's stray
  // leachate unit is the case this exists for, and another matrix's units
  // would bury it.
  const {data: unitsData} = useSql<{u: string | null; n: number}>({
    query: analyte
      ? `SELECT trim(reported_units) AS u, count(*)::INTEGER AS n FROM results
         WHERE analyte = ${lit(analyte)} AND reported_units IS NOT NULL
           ${matrix ? `AND sample_id IN (SELECT sample_id FROM samples WHERE matrix = ${lit(matrix)})` : ''}
         GROUP BY 1 ORDER BY 2 DESC`
      : NO_ROWS,
    enabled: open && Boolean(analyte) && ready,
  });

  const range = facts?.toArray()[0];
  const types = useMemo(
    () => (typesData ? typesData.toArray().map((r) => ({t: r.t ?? '', n: Number(r.n)})) : []),
    [typesData],
  );
  const depthUnits = useMemo(() => {
    const inData = depthUnitsData ? depthUnitsData.toArray().map((r) => String(r.u)) : [];
    return [...inData, ...COMMON_DEPTH_UNITS.filter((u) => !inData.includes(u))];
  }, [depthUnitsData]);
  const units = useMemo(
    () => (unitsData ? unitsData.toArray().map((r) => ({u: r.u ?? '', n: Number(r.n)})) : []),
    [unitsData],
  );

  const typeMode = scope.sampleTypes === null ? 'normal' : scope.sampleTypes.length === 0 ? 'all' : 'chosen';
  const toggle = (xs: string[] | null, x: string) =>
    (xs ?? []).includes(x) ? (xs ?? []).filter((y) => y !== x) : [...(xs ?? []), x];
  const number = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));

  return (
    <div className="flex flex-col gap-1.5 rounded border border-border/60 px-2 py-1.5">
      <button
        type="button"
        className="flex items-center gap-1 text-left text-xs text-muted-foreground disabled:opacity-50"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title="Which results the map and the time series read"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="shrink-0 whitespace-nowrap font-medium">Rows read</span>
        <span className={'truncate ' + (isDefaultRowScope(scope) ? '' : 'text-foreground')}>
          {describeRowScope(scope)}
        </span>
      </button>

      {open && (
        <fieldset className="flex flex-col gap-2" disabled={disabled}>
          {/* Dates: whole days, inclusive; an undated sample is outside any range. */}
          <div className="grid grid-cols-2 gap-1.5">
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">From</span>
              <input
                type="date"
                className={inputClass}
                value={scope.startDate ?? ''}
                min={range?.lo ?? undefined}
                max={range?.hi ?? undefined}
                onChange={(e) => setRowScope({startDate: e.target.value || null})}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">To</span>
              <input
                type="date"
                className={inputClass}
                value={scope.endDate ?? ''}
                min={range?.lo ?? undefined}
                max={range?.hi ?? undefined}
                onChange={(e) => setRowScope({endDate: e.target.value || null})}
              />
            </label>
          </div>

          {types.length > 1 && (
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">Sample types</span>
              <select
                className={inputClass}
                value={typeMode}
                onChange={(e) =>
                  setRowScope({
                    sampleTypes:
                      e.target.value === 'normal' ? null : e.target.value === 'all' ? [] : ['N'],
                  })
                }
              >
                <option value="normal">Normal samples (default)</option>
                <option value="all">Every type, QC included</option>
                <option value="chosen">Chosen types…</option>
              </select>
              {typeMode === 'chosen' && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5">
                  {types.map(({t, n}) => (
                    <label key={t || '(none)'} className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={(scope.sampleTypes ?? []).includes(t)}
                        onChange={() => {
                          const next = toggle(scope.sampleTypes, t);
                          // An empty list would mean every type; keep the last one.
                          if (next.length > 0) setRowScope({sampleTypes: next});
                        }}
                      />
                      {t || '(untyped)'} <span className="text-muted-foreground">{n.toLocaleString()}</span>
                    </label>
                  ))}
                </div>
              )}
            </label>
          )}

          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">Reportable results</span>
            <select
              className={inputClass}
              value={scope.reportableOnly === null ? 'dataset' : scope.reportableOnly ? 'only' : 'every'}
              onChange={(e) =>
                setRowScope({
                  reportableOnly: e.target.value === 'dataset' ? null : e.target.value === 'only',
                })
              }
            >
              <option value="dataset">The dataset's choice (default)</option>
              <option value="only">Reportable only</option>
              <option value="every">Every result, re-runs included</option>
            </select>
          </label>

          {/* Depth: a sample is in when its whole interval is; no depth is out. */}
          <div className="flex flex-col gap-0.5">
            <span
              className="text-[10px] text-muted-foreground"
              title="A sample is in when its whole interval lies inside; a sample with no depth is out"
            >
              Depth (whole interval inside)
            </span>
            <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
              <input
                type="number"
                className={inputClass}
                placeholder="top"
                defaultValue={scope.depthMin ?? ''}
                key={`min-${scope.depthMin}`}
                onBlur={(e) => setRowScope({depthMin: number(e.target.value)})}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              <input
                type="number"
                className={inputClass}
                placeholder="bottom"
                defaultValue={scope.depthMax ?? ''}
                key={`max-${scope.depthMax}`}
                onBlur={(e) => setRowScope({depthMax: number(e.target.value)})}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              <select
                className="rounded border bg-background px-1 py-1 text-sm"
                value={scope.depthUnits ?? depthUnits[0] ?? 'm'}
                onChange={(e) => setRowScope({depthUnits: e.target.value})}
              >
                {depthUnits.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
            {/* A bound without its unit would compare bare numbers across units. */}
            {(scope.depthMin !== null || scope.depthMax !== null) && !scope.depthUnits && (
              <DepthUnitDefault unit={depthUnits[0] ?? 'm'} onSet={(u) => setRowScope({depthUnits: u})} />
            )}
          </div>

          {analyte && units.length > 1 && (
            <div className="flex flex-col gap-0.5">
              <span
                className="text-[10px] text-muted-foreground"
                title="As the source reported them; never converted. None ticked: every unit"
              >
                {analyte} units to read
              </span>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {units.map(({u, n}) => (
                  <label key={u || '(none)'} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={(scope.reportedUnits ?? []).includes(u)}
                      onChange={() => {
                        const next = toggle(scope.reportedUnits, u);
                        setRowScope({reportedUnits: next.length ? next : null});
                      }}
                    />
                    {u || '(none)'} <span className="text-muted-foreground">{n.toLocaleString()}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {!isDefaultRowScope(scope) && (
            <button
              type="button"
              className="self-start text-xs text-primary underline-offset-2 hover:underline"
              onClick={() => setRowScope(null)}
            >
              Reset to ChemDuck's defaults
            </button>
          )}
        </fieldset>
      )}
    </div>
  );
};

/** Records the unit shown in the select once a bound is typed. */
const DepthUnitDefault: React.FC<{unit: string; onSet: (u: string) => void}> = ({unit, onSet}) => {
  React.useEffect(() => onSet(unit), [unit, onSet]);
  return null;
};
