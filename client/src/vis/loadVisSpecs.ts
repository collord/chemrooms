/**
 * Fetch and parse `<table>.vis.json` sidecar files for each known data
 * table. Missing or malformed sidecars are silently skipped.
 */

import {parseVisSpec, type VisSpec} from './visSpec';

export interface LoadedSpec {
  table: string;
  spec: VisSpec;
}

/**
 * Try to fetch a sidecar for each table; return the ones that succeed.
 *
 * @param baseUrl  e.g. http://localhost:8000/data
 * @param tables   table names to look for sidecars for
 */
export async function loadVisSpecs(
  baseUrl: string,
  tables: string[],
): Promise<LoadedSpec[]> {
  const results = await Promise.all(
    tables.map(async (table) => {
      try {
        const url = `${baseUrl}/${table}.vis.json`;
        const r = await fetch(url);
        if (!r.ok) return null;
        const raw = await r.json();
        const spec = parseVisSpec(raw);
        if (!spec) return null;
        return {table, spec} satisfies LoadedSpec;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is LoadedSpec => r !== null);
}
