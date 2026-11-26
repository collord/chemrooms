/**
 * The row scope: which results every map and chart reads, before any is
 * chosen (ChemDuck's p_start_date, p_end_date, p_sample_types,
 * p_reportable_only, p_depth_*, p_reported_units).
 *
 * The QGIS plugin's rule, which ChemDuck implements: every filter applies
 * whatever the source, set in one place and passed to every call, so a map
 * and a chart can't disagree about which rows they read. Here that place is
 * the recipe's `rowScope`, and rowScopeArgs() is the one translation into
 * macro arguments, used by the map (buildSamplesLayerSql) and the time
 * series (buildTimeSeriesSql) alike.
 *
 * Each rule is ChemDuck's, not this file's:
 *  - dates are whole days, inclusive; an undated sample is outside any range;
 *  - sample types: null is ChemDuck's default, normal samples (typed N or
 *    untyped); [] is every type; a list is those types;
 *  - reportable: null is the dataset's choice (on where the source carries
 *    a reportable flag), true leaves non-reportable results out, false
 *    keeps every result;
 *  - depth: a sample is in when its WHOLE interval lies inside the bounds,
 *    compared in the filter's unit by exact length factors; a sample with no
 *    depth is out; a bound needs its unit;
 *  - units: the unit as the source reported it, trimmed, case-sensitive;
 *    never converted.
 * A filter on a column the source lacks matches every row, and ChemDuck
 * names it in filters_ignored (layerNotice.ts).
 */

export interface RowScope {
  /** ISO date (YYYY-MM-DD), inclusive, or null for no bound. */
  startDate: string | null;
  endDate: string | null;
  /** null: normal samples (ChemDuck's default); []: every type; else those. */
  sampleTypes: string[] | null;
  /** null: the dataset's choice; true: reportable only; false: every result. */
  reportableOnly: boolean | null;
  depthMin: number | null;
  depthMax: number | null;
  /** The unit the depth bounds are in; no depth filter without it. */
  depthUnits: string | null;
  /** Reported units to keep, or null for every unit. */
  reportedUnits: string[] | null;
}

export const DEFAULT_ROW_SCOPE: RowScope = {
  startDate: null,
  endDate: null,
  sampleTypes: null,
  reportableOnly: null,
  depthMin: null,
  depthMax: null,
  depthUnits: null,
  reportedUnits: null,
};

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const list = (xs: string[]) => `[${xs.map(lit).join(', ')}]::VARCHAR[]`;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A depth filter is on only with a unit and at least one bound. */
export function depthFilterOn(s: RowScope): boolean {
  return Boolean(s.depthUnits) && (s.depthMin !== null || s.depthMax !== null);
}

/** The named macro arguments for a scope; [] for the default scope. */
export function rowScopeArgs(scope: RowScope | null | undefined): string[] {
  const s = normalizeRowScope(scope);
  const args: string[] = [];
  if (s.startDate) args.push(`p_start_date := DATE ${lit(s.startDate)}`);
  if (s.endDate) args.push(`p_end_date := DATE ${lit(s.endDate)}`);
  if (s.sampleTypes !== null) args.push(`p_sample_types := ${list(s.sampleTypes)}`);
  if (s.reportableOnly !== null) args.push(`p_reportable_only := ${s.reportableOnly ? 'TRUE' : 'FALSE'}`);
  if (depthFilterOn(s)) {
    if (s.depthMin !== null) args.push(`p_depth_min := ${s.depthMin}`);
    if (s.depthMax !== null) args.push(`p_depth_max := ${s.depthMax}`);
    args.push(`p_depth_units := ${lit(s.depthUnits!)}`);
  }
  if (s.reportedUnits !== null && s.reportedUnits.length > 0) {
    args.push(`p_reported_units := ${list(s.reportedUnits)}`);
  }
  return args;
}

/**
 * A stored or linked scope made safe: missing fields default, dates must
 * be ISO dates, numbers finite, lists of strings. Anything else is dropped
 * rather than sent to SQL.
 */
export function normalizeRowScope(raw: unknown): RowScope {
  if (!raw || typeof raw !== 'object') return DEFAULT_ROW_SCOPE;
  const r = raw as Record<string, unknown>;
  const date = (v: unknown) => (typeof v === 'string' && ISO_DATE.test(v) ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const strs = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  return {
    startDate: date(r.startDate),
    endDate: date(r.endDate),
    sampleTypes: strs(r.sampleTypes),
    reportableOnly: typeof r.reportableOnly === 'boolean' ? r.reportableOnly : null,
    depthMin: num(r.depthMin),
    depthMax: num(r.depthMax),
    depthUnits: typeof r.depthUnits === 'string' && r.depthUnits.trim() ? r.depthUnits.trim() : null,
    reportedUnits: strs(r.reportedUnits),
  };
}

export function isDefaultRowScope(scope: RowScope | null | undefined): boolean {
  return rowScopeArgs(scope).length === 0;
}

/** Only the fields that differ from the default, for links and hashes. */
export function compactRowScope(scope: RowScope | null | undefined): Partial<RowScope> | null {
  const s = normalizeRowScope(scope);
  const out: Partial<RowScope> = {};
  for (const k of Object.keys(DEFAULT_ROW_SCOPE) as (keyof RowScope)[]) {
    if (JSON.stringify(s[k]) !== JSON.stringify(DEFAULT_ROW_SCOPE[k])) {
      (out as Record<string, unknown>)[k] = s[k];
    }
  }
  return isDefaultRowScope(s) ? null : out;
}

/** One line for the collapsed controls and the inspector banner. */
export function describeRowScope(scope: RowScope | null | undefined): string {
  const s = normalizeRowScope(scope);
  const parts: string[] = [];
  if (s.startDate || s.endDate) parts.push(`${s.startDate ?? '…'} to ${s.endDate ?? '…'}`);
  parts.push(
    s.sampleTypes === null
      ? 'normal samples'
      : s.sampleTypes.length === 0
        ? 'every sample type'
        : `types ${s.sampleTypes.join(', ')}`,
  );
  if (s.reportableOnly === true) parts.push('reportable only');
  if (s.reportableOnly === false) parts.push('every result');
  if (depthFilterOn(s)) parts.push(`depth ${s.depthMin ?? '…'}–${s.depthMax ?? '…'} ${s.depthUnits}`);
  if (s.reportedUnits?.length) parts.push(`units ${s.reportedUnits.join(', ')}`);
  return parts.join(' · ');
}
