// @vitest-environment node
import {describe, it, expect} from 'vitest';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {DEMO_DATA, openWasmDb} from '../testing/wasmDb';
import {buildDefaultVisSpec} from './buildDefaultVisSpec';

/**
 * The browser's defaults against server/vis_specs.py's, on the same tables:
 * server/data's <table>.vis.json files were written by export_chemduck.py
 * from the same parquet. Two builders of one rule, held to each other.
 */
describe('buildDefaultVisSpec matches server/vis_specs.py', () => {
  for (const table of ['locations', 'samples', 'results']) {
    const shipped = path.join(DEMO_DATA, `${table}.vis.json`);
    it.runIf(existsSync(shipped))(`on the demo's ${table}`, async () => {
      const db = await openWasmDb();
      db.loadParquet(table, path.join(DEMO_DATA, `${table}.parquet`));
      const built = await buildDefaultVisSpec(async (sql) => db.rows(sql), table);
      const python = JSON.parse(readFileSync(shipped, 'utf8'));
      expect(built?.defaultColorBy).toBe(python.defaultColorBy);
      expect(Object.keys(built!.columns).sort()).toEqual(Object.keys(python.columns).sort());
      for (const [name, col] of Object.entries(python.columns) as [string, any][]) {
        const mine = built!.columns[name]!;
        expect(mine.label, name).toBe(col.label);
        expect(mine.color.type, name).toBe(col.color.type);
        if (col.color.type === 'categorical') {
          expect((mine.color as any).categories, name).toEqual(col.color.categories);
        } else {
          const [lo, hi] = (mine.color as any).domain;
          expect(lo, name).toBeCloseTo(col.color.domain[0], 9);
          expect(hi, name).toBeCloseTo(col.color.domain[1], 9);
        }
      }
      db.close();
    }, 60_000);
  }

  it('skips constant columns, free text and excluded ids', async () => {
    const db = await openWasmDb();
    db.run(`CREATE TABLE t AS SELECT i AS location_id, 7 AS constant, 'x' || i AS free_text,
              i * 1.5 AS depth, CASE WHEN i % 2 = 0 THEN 'A' ELSE 'B' END AS kind
            FROM range(40) r(i)`);
    const spec = await buildDefaultVisSpec(async (sql) => db.rows(sql), 't');
    expect(Object.keys(spec!.columns).sort()).toEqual(['depth', 'kind']);
    expect(spec!.defaultColorBy).toBe('kind');
    expect(spec!.columns.depth!.color).toMatchObject({type: 'sequential', domain: [0, 58.5]});
    db.close();
  }, 60_000);
});
