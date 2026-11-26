/**
 * What a layer's query had to say, for the user rather than the console.
 *
 * ChemDuck refuses rather than draw a plausible wrong map: a variable in
 * two units, a unit that contradicts its matrix, matrices of different
 * classes combined. Its error names what it found and what to do. The
 * entity hook used to log a failed query and draw nothing, so a refusal
 * looked like an empty map. It also reports, on every row, the filters
 * its source has no column for (filters_ignored), which match everything
 * rather than nothing; a map drawn with one ignored should say so.
 */

export interface LayerNotice {
  kind: 'refused' | 'filters-ignored';
  message: string;
}

/**
 * The readable part of a DuckDB error: the message after its class
 * ("Invalid Input Error: ..."), first line only, without the "LINE n:"
 * context DuckDB appends.
 */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const first = raw.split('\n').find((l) => l.trim() !== '') ?? raw;
  return first.replace(/^\s*(?:[A-Z][A-Za-z ]*? )?Error:\s*/, '').trim();
}

/** The notice for a query that failed, or null if nothing failed. */
export function refusalNotice(e: unknown): LayerNotice {
  return {kind: 'refused', message: errorText(e)};
}

/**
 * The notice for rows that drew: the filters ChemDuck ignored, when the
 * rows carry the column (only the aggregate path does) and any is named.
 */
export function filtersIgnoredNotice(rows: {filters_ignored?: unknown}[]): LayerNotice | null {
  const names = new Set<string>();
  for (const row of rows) {
    const v = row.filters_ignored;
    if (typeof v === 'string' && v.trim()) v.split(',').forEach((n) => names.add(n.trim()));
  }
  if (names.size === 0) return null;
  return {
    kind: 'filters-ignored',
    message:
      `Not applied, because the source has no column for it: ${[...names].join(', ')}. ` +
      'A filter the data cannot express matches every row.',
  };
}
