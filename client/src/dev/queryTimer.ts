/**
 * Dev-only: `window.__chemroomsQuery(sql, runs?)` runs SQL on the app's own
 * connector and reports the wall time of each run, for measuring ChemDuck's
 * macros in the browser against a real source (chemduck-transition-plan.md,
 * phase 2). The partitions of an ARII source are read over HTTP exactly as
 * the app reads them, so the numbers include the range requests.
 *
 *   await window.__chemroomsQuery("SELECT count(*) FROM aggregate_points('Arsenic')", 4)
 *   // {rows: 1, ms: [812.3, 401.2, 398.0, 402.9]}
 *
 * `window.__chemroomsRows(sql)` returns the rows, to choose what to time.
 *
 * Not installed in a production build.
 */

import type {DuckDbConnector} from '@sqlrooms/duckdb';

export interface QueryTiming {
  rows: number;
  ms: number[];
  error?: string;
}

declare global {
  interface Window {
    __chemroomsQuery?: (sql: string, runs?: number) => Promise<QueryTiming>;
    __chemroomsRows?: (sql: string) => Promise<Record<string, unknown>[]>;
  }
}

export function registerQueryTimerGlobal(getConnector: () => DuckDbConnector): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  window.__chemroomsQuery = async (sql, runs = 1) => {
    const ms: number[] = [];
    let rows = 0;
    try {
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        const table = await getConnector().query(sql);
        ms.push(Math.round((performance.now() - t0) * 10) / 10);
        rows = table.numRows;
      }
      return {rows, ms};
    } catch (e) {
      return {rows, ms, error: String(e)};
    }
  };
  window.__chemroomsRows = async (sql) =>
    (await getConnector().query(sql)).toArray().map((r: any) => r.toJSON());
}
