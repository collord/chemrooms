/**
 * Default vis specs built in the browser, for a data folder that ships none.
 *
 * server/vis_specs.py writes `<table>.vis.json` beside the data when
 * Chemrooms publishes a folder (export_chemduck.py, publish_arii.py). A
 * folder the QGIS plugin's pipeline publishes (`chemduck/`) has no such
 * files, and without them every point draws in the fallback colour. These
 * are the same defaults, by the same rules, computed over a table already
 * loaded in the browser: only local tables, never the remote `results` of
 * an ARII source, which would mean scanning every partition.
 *
 *  - numeric column: viridis, linear, the column's real [min, max];
 *    skipped when constant;
 *  - other column with 2-30 distinct values: category10, values listed;
 *    more is free text, fewer is constant;
 *  - the default colour-by is the last categorical column, else the first
 *    numeric one.
 */

import {parseVisSpec, type ColumnSpec, type VisSpec} from './visSpec';

/** Must match EXCLUDED_COLUMNS in server/vis_specs.py. */
export const EXCLUDED_COLUMNS = new Set([
  'location_id', 'sample_id', 'result_id', 'x', 'y', 'z', 'elevation', 'measuring_pt',
]);

const NUMERIC_TYPES = new Set([
  'TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT',
  'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT',
  'FLOAT', 'DOUBLE', 'REAL', 'DECIMAL',
]);

const MAX_CATEGORIES = 30;

export function isNumericType(type: string): boolean {
  return NUMERIC_TYPES.has(type.toUpperCase().split('(')[0]!.trim());
}

function label(name: string): string {
  return name
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Something that runs SQL and returns rows as plain objects. */
export type RowQuery = (sql: string) => Promise<Record<string, unknown>[]>;

/**
 * The default spec for `table`, in three queries whatever its width: the
 * column list, every column's min/max or distinct count in one pass, then
 * the distinct values of the columns that qualify as categories.
 */
export async function buildDefaultVisSpec(
  query: RowQuery,
  table: string,
): Promise<VisSpec | null> {
  const cols = (await query(`DESCRIBE ${q(table)}`))
    .map((r) => ({name: String(r.column_name), type: String(r.column_type)}))
    .filter((c) => !EXCLUDED_COLUMNS.has(c.name) && !/BLOB|GEOMETRY|STRUCT|MAP|\[\]/i.test(c.type));
  if (cols.length === 0) return null;

  const stats = cols.flatMap((c, i) =>
    isNumericType(c.type)
      ? [`MIN(${q(c.name)})::DOUBLE AS lo_${i}`, `MAX(${q(c.name)})::DOUBLE AS hi_${i}`]
      : [`COUNT(DISTINCT ${q(c.name)})::INTEGER AS n_${i}`],
  );
  const row = (await query(`SELECT ${stats.join(', ')} FROM ${q(table)}`))[0] ?? {};

  const columns: Record<string, ColumnSpec> = {};
  let defaultColorBy: string | undefined;
  const categorical: {name: string; i: number}[] = [];
  cols.forEach((c, i) => {
    if (isNumericType(c.type)) {
      const lo = row[`lo_${i}`];
      const hi = row[`hi_${i}`];
      if (lo == null || hi == null || Number(lo) === Number(hi)) return;
      columns[c.name] = {
        label: label(c.name),
        color: {type: 'sequential', palette: 'viridis', scaleType: 'linear', domain: [Number(lo), Number(hi)]},
      };
      defaultColorBy ??= c.name;
    } else {
      const n = Number(row[`n_${i}`] ?? 0);
      if (n > 1 && n <= MAX_CATEGORIES) categorical.push({name: c.name, i});
    }
  });

  for (const {name} of categorical) {
    const values = (
      await query(
        `SELECT DISTINCT ${q(name)}::VARCHAR AS v FROM ${q(table)} WHERE ${q(name)} IS NOT NULL ORDER BY 1`,
      )
    ).map((r) => String(r.v));
    columns[name] = {
      label: label(name),
      color: {type: 'categorical', palette: 'category10', categories: values},
    };
    // A category makes a better default than a number (vis_specs.py).
    defaultColorBy = name;
  }

  return parseVisSpec({version: 1, table, columns, ...(defaultColorBy ? {defaultColorBy} : {})});
}
