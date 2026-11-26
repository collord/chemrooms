// @vitest-environment node
import {describe, it, expect} from 'vitest';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {DEMO_DATA, openWasmDb} from '../testing/wasmDb';
import {
  bundleFiles,
  LEGACY_BUNDLE_FILES,
  loadBundle,
  type ChemduckSource,
} from './chemduckBundle';

describe('bundleFiles', () => {
  it('reads the list and its order from SOURCE.json', () => {
    const files = ['00_bootstrap.sql', '02_macros.sql', '03_views.sql', '11_ism.sql'];
    expect(bundleFiles({files})).toEqual(files);
  });

  it('falls back to the legacy four files for a folder that lists none', () => {
    expect(bundleFiles(null)).toEqual(LEGACY_BUNDLE_FILES);
    expect(bundleFiles({chemduck: {commit: 'abc'}})).toEqual(LEGACY_BUNDLE_FILES);
  });

  it.each<[string, unknown]>([
    ['an empty list', []],
    ['not a list', '02_macros.sql'],
    ['a path', ['00_bootstrap.sql', '../../etc/passwd']],
    ['a URL', ['00_bootstrap.sql', 'https://example.com/x.sql']],
    ['a non-SQL file', ['00_bootstrap.sql', 'SOURCE.json']],
    ['no bootstrap first', ['02_macros.sql', '00_bootstrap.sql']],
  ])('refuses %s', (_, files) => {
    expect(() => bundleFiles({files} as ChemduckSource)).toThrow();
  });
});

/**
 * A stand-in connection: each file defines some names and needs others,
 * and fails, having defined what precedes its first unmet need, as one
 * multi-statement query does.
 */
function fakeDb(spec: Record<string, {needs?: string[]; defines: string[]}[]>) {
  const defined = new Set<string>();
  const runs: string[] = [];
  const query = async (file: string) => {
    runs.push(file);
    for (const stmt of spec[file]) {
      const unmet = (stmt.needs ?? []).find((n) => !defined.has(n));
      if (unmet) throw new Error(`${unmet} does not exist`);
      stmt.defines.forEach((d) => defined.add(d));
    }
  };
  return {defined, runs, query};
}

describe('loadBundle', () => {
  it('retries a file whose macros read a view a later file defines', async () => {
    // 02_macros: simple macros, then one reading v_results_denormalized,
    // which 03_views defines using the simple macros.
    const db = fakeDb({
      '00_bootstrap.sql': [{defines: ['results']}],
      '02_macros.sql': [
        {defines: ['make_dup_id']},
        {needs: ['v_results_denormalized'], defines: ['pivot_results_by_analyte']},
      ],
      '03_views.sql': [{needs: ['results', 'make_dup_id'], defines: ['v_results_denormalized']}],
      '08_aggregate_results.sql': [{needs: ['v_results_denormalized'], defines: ['aggregate_results']}],
    });
    const files = Object.keys({
      '00_bootstrap.sql': 0, '02_macros.sql': 0, '03_views.sql': 0, '08_aggregate_results.sql': 0,
    });
    const result = await loadBundle(files, (f) => f, db.query);
    expect(result).toEqual({ok: true, usable: true, failed: []});
    expect(db.defined.has('pivot_results_by_analyte')).toBe(true);
    expect(db.runs).toEqual([
      '00_bootstrap.sql', '02_macros.sql', '03_views.sql', '08_aggregate_results.sql',
      '02_macros.sql',
    ]);
  });

  it('stops when a round makes no progress, and says which file failed', async () => {
    const db = fakeDb({
      '00_bootstrap.sql': [{defines: ['results']}],
      '03_views.sql': [{needs: ['results'], defines: ['v_results_denormalized']}],
      '08_aggregate_results.sql': [{defines: ['aggregate_results']}],
      '11_ism.sql': [{needs: ['never_defined'], defines: ['ism_decisions']}],
    });
    const files = ['00_bootstrap.sql', '03_views.sql', '08_aggregate_results.sql', '11_ism.sql'];
    const result = await loadBundle(files, (f) => f, db.query);
    expect(result.ok).toBe(false);
    expect(result.usable).toBe(true); // 11_ism isn't one the app needs
    expect(result.failed.map((f) => f.file)).toEqual(['11_ism.sql']);
    expect(result.failed[0].error).toContain('never_defined');
  });

  it('is unusable when a required file fails', async () => {
    const db = fakeDb({
      '00_bootstrap.sql': [{defines: ['results']}],
      '03_views.sql': [{needs: ['missing_macro'], defines: ['v_results_denormalized']}],
    });
    const result = await loadBundle(['00_bootstrap.sql', '03_views.sql'], (f) => f, db.query);
    expect(result).toMatchObject({ok: false, usable: false});
  });

  it('never retries the bootstrap', async () => {
    const db = fakeDb({'00_bootstrap.sql': [{needs: ['x'], defines: []}], '03_views.sql': [{defines: []}]});
    const result = await loadBundle(['00_bootstrap.sql', '03_views.sql'], (f) => f, db.query);
    expect(result).toMatchObject({ok: false, usable: false});
    expect(db.runs).toEqual(['00_bootstrap.sql']);
  });
});

/**
 * The demo folder's real bundle in the app's own DuckDB-WASM. This is the
 * check that the SQL server/data ships loads in the engine the browser runs
 * (DuckDB 1.4.3 in @duckdb/duckdb-wasm 1.32.0), and that the parquet beside
 * it has the columns that SQL reads: a demo exported by an older ChemDuck
 * failed in 03_views on results.reported_units.
 */
describe('the demo folder in DuckDB-WASM', () => {
  it.runIf(existsSync(path.join(DEMO_DATA, 'sql', 'SOURCE.json')))(
    'loads every file SOURCE.json lists, and the map macros answer',
    async () => {
      const db = await openWasmDb();
      // The tables client/src/store.ts loads for a ChemDuck project.
      for (const t of [
        'locations', 'samples', 'results', 'screening_levels',
        'aggregation_rules', 'unit_conversions', 'downhole_survey',
      ]) {
        db.loadParquet(t, path.join(DEMO_DATA, `${t}.parquet`));
      }
      const source = JSON.parse(readFileSync(path.join(DEMO_DATA, 'sql', 'SOURCE.json'), 'utf8'));
      const files = bundleFiles(source);
      const result = await loadBundle(
        files,
        (f) => readFileSync(path.join(DEMO_DATA, 'sql', f), 'utf8'),
        async (sql) => db.run(sql),
      );
      expect(result.failed).toEqual([]);

      const analyte = db.rows(
        'SELECT analyte FROM results GROUP BY 1 ORDER BY count(*) DESC LIMIT 1',
      )[0]!.analyte as string;
      const count = (sql: string) => Number(db.rows(`SELECT count(*) AS n FROM ${sql}`)[0]!.n);
      const lit = `'${analyte.replace(/'/g, "''")}'`;
      // Today's map call (the legacy recipe path), and the shared-rules ones.
      expect(count(`aggregate_results(${lit}, NULL, NULL, NULL, 'most_recent', 'avg', 'half_dl', 0.0, 1.0)`)).toBeGreaterThan(0);
      expect(count(`aggregate_points(${lit})`)).toBeGreaterThan(0);
      expect(count(`point_series(${lit})`)).toBeGreaterThan(0);
      expect(count(`km_quartiles([${lit}], p_group := 'location')`)).toBeGreaterThan(0);
      db.close();
    },
    60_000,
  );
});
