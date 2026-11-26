// @vitest-environment node
/**
 * The map and the time series against ChemDuck's own answers, on the demo
 * folder, in the app's DuckDB-WASM (chemduck-transition-plan.md, phase 3's
 * parity gate).
 *
 * Chemrooms' SQL must add position and decoration to ChemDuck's points and
 * never change them: the same points, the same values, the same chosen
 * results. And the display choice may change how a non-detect is drawn,
 * never which result a point shows.
 */
import {beforeAll, describe, expect, it} from 'vitest';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {DEMO_DATA, openWasmDb, type WasmDb} from '../testing/wasmDb';
import {bundleFiles, loadBundle} from './chemduckBundle';
import {buildSamplesLayerSql} from './buildSamplesLayerSql';
import {buildTimeSeriesSql} from './buildTimeSeriesSql';

const HAVE_DEMO = existsSync(path.join(DEMO_DATA, 'sql', 'SOURCE.json'));
let db: WasmDb;

/** The map's SQL for a recipe, as ChemroomsEntityLayers builds it. */
const mapSql = (analyte: string, ndMethod: string, extra: Record<string, unknown> = {}) =>
  buildSamplesLayerSql({
    elevationColumns: [],
    coloringAnalyte: analyte,
    eventAgg: 'most_recent',
    ndMethod,
    matrixFilter: null,
    ...extra,
  });

/** A point's key, as aggregate_points keys it. */
const KEY = `location_id || '|' || matrix || '|' || COALESCE(top_depth, 0) || '|' || COALESCE(bottom_depth, 0)
  || '|' || COALESCE(fraction, '') || '|' || COALESCE(meas_basis, '') || '|' || COALESCE(position, '')
  || '|' || COALESCE(method_class, '')`;

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

describe.runIf(HAVE_DEMO)('the map and the time series hold to ChemDuck', () => {
  let analytes: string[] = [];

  beforeAll(async () => {
    db = await openWasmDb();
    for (const t of [
      'locations', 'samples', 'results', 'screening_levels',
      'aggregation_rules', 'unit_conversions', 'downhole_survey',
    ]) {
      db.loadParquet(t, path.join(DEMO_DATA, `${t}.parquet`));
    }
    const source = JSON.parse(readFileSync(path.join(DEMO_DATA, 'sql', 'SOURCE.json'), 'utf8'));
    const result = await loadBundle(
      bundleFiles(source),
      (f) => readFileSync(path.join(DEMO_DATA, 'sql', f), 'utf8'),
      async (sql) => db.run(sql),
    );
    expect(result.failed).toEqual([]);
    // What initEntityLayers adds for the 3D view, flattened: no geoid, no
    // terrain, every depth in metres.
    db.run(`CREATE MACRO geoid_offset(qlon, qlat) AS (0.0)`);
    db.run(`CREATE TABLE location_elevations_sampled (location_id VARCHAR, ellipsoidal_height_m DOUBLE)`);
    db.run(`CREATE TABLE depth_interval_units AS
      SELECT location_id, matrix, COALESCE(top_depth, 0) AS top_depth, COALESCE(bottom_depth, 0) AS bottom_depth,
             any_value(depth_units) AS depth_units, 1.0 AS to_m
      FROM samples GROUP BY ALL`);
    // Analytes with non-detects among their points, so the display rules bite.
    analytes = db
      .rows(`SELECT analyte FROM aggregate_points_all_analytes`.replace(
        'aggregate_points_all_analytes',
        `(SELECT DISTINCT analyte FROM results WHERE detected IS FALSE)`,
      ))
      .map((r) => String(r.analyte))
      .sort();
    expect(analytes.length).toBeGreaterThan(0);
  }, 120_000);

  it('draws exactly aggregate_points: its points, values and chosen results', () => {
    for (const a of analytes) {
      const direct = db.rows(`
        SELECT ${KEY} AS id, result, detected, sample_id FROM aggregate_points(${lit(a)})
        WHERE x IS NOT NULL AND y IS NOT NULL ORDER BY id`);
      const mapped = db.rows(`
        SELECT location_id AS id, result, detected, sample_id FROM (${mapSql(a, 'policy')}) ORDER BY id`);
      expect(mapped.length, a).toBe(direct.length);
      expect(new Set(mapped.map((r) => r.id)).size, `${a}: one entity per point`).toBe(mapped.length);
      expect(mapped, a).toEqual(direct);
    }
  });

  it('never changes which result a point shows with the display choice', () => {
    for (const a of analytes) {
      const at = (nd: string) =>
        db.rows(`SELECT location_id AS id, sample_id, detected, result, detection_limit
                 FROM (${mapSql(a, nd)}) ORDER BY id`);
      const dl = at('dl');
      const half = at('half_dl');
      const zero = at('zero');
      expect(half.map((r) => [r.id, r.sample_id]), a).toEqual(dl.map((r) => [r.id, r.sample_id]));
      expect(zero.map((r) => [r.id, r.sample_id]), a).toEqual(dl.map((r) => [r.id, r.sample_id]));
      dl.forEach((r, i) => {
        if (r.detected === false) {
          expect(Number(half[i]!.result), `${a} ${r.id}`).toBeCloseTo(Number(r.result) / 2, 9);
          expect(Number(zero[i]!.result), `${a} ${r.id}`).toBe(0);
        } else {
          expect(half[i]!.result, `${a} ${r.id}`).toEqual(r.result);
        }
      });
    }
  });

  it('hides exactly the points whose chosen result is a non-detect', () => {
    // Not vacuous: the demo has points whose chosen result is a non-detect.
    const ndPoints = analytes.reduce(
      (n, a) => n + Number(db.rows(`SELECT count(*) AS n FROM aggregate_points(${lit(a)}) WHERE detected IS FALSE`)[0]!.n),
      0,
    );
    expect(ndPoints).toBeGreaterThan(0);
    for (const a of analytes) {
      const all = db.rows(`SELECT location_id AS id, detected FROM (${mapSql(a, 'dl')}) ORDER BY id`);
      const shown = db.rows(`SELECT location_id AS id FROM (${mapSql(a, 'exclude')}) ORDER BY id`);
      expect(shown.map((r) => r.id), a).toEqual(
        all.filter((r) => r.detected !== false).map((r) => r.id),
      );
      expect(shown.length, `${a} has non-detect points to hide`).toBeLessThanOrEqual(all.length);
    }
  });

  it('labels a non-detect as one', () => {
    const a = analytes[0]!;
    const rows = db.rows(`SELECT label, detected FROM (${mapSql(a, 'policy')})`);
    for (const r of rows) {
      expect(String(r.label).includes('(<'), String(r.label)).toBe(r.detected === false);
    }
  });

  it('carries the provenance the inspector shows', () => {
    const row = db.rows(`SELECT * FROM (${mapSql(analytes[0]!, 'policy')}) LIMIT 1`)[0]!;
    for (const col of ['sample_id', 'method_code', 'selected_by', 'nd_policy', 'unit_source', 'method_class']) {
      expect(row, col).toHaveProperty(col);
    }
    expect(String(row.nd_policy)).toMatch(/@\d+$/);
  });

  it("plots point_series' rows, one line per measurement point", () => {
    // A location with many points: the one with the most rows in the first
    // analyte's series (a borehole: one point per depth interval), and two
    // analytes measured there.
    const loc = String(
      db.rows(`SELECT location_id FROM point_series(${lit(analytes[0]!)})
               GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`)[0]!.location_id,
    );
    const two = db
      .rows(`SELECT r.analyte FROM samples s JOIN results r USING (sample_id)
             WHERE s.location_id = ${lit(loc)} GROUP BY 1 ORDER BY 1 LIMIT 2`)
      .map((r) => String(r.analyte));
    const chart = db.rows(buildTimeSeriesSql({
      locationId: loc, analytes: two, matrixFilter: null, fractionFilter: null, ndMethod: 'policy',
    }));
    const direct = two.flatMap((a) =>
      db.rows(`SELECT analyte, ${KEY} AS id, sample_id, result FROM point_series(${lit(a)}, p_locations := [${lit(loc)}])`),
    );
    expect(chart.length).toBe(direct.length);
    expect(chart.map((r) => `${r.analyte}|${r.sample_id}|${r.plot_value}`).sort()).toEqual(
      direct.map((r) => `${r.analyte}|${r.sample_id}|${r.result}`).sort(),
    );
    // As many lines as points, each analyte's points apart; and not
    // vacuously: the location has an analyte measured at several points.
    const points = new Set(direct.map((r) => `${r.analyte}|${r.id}`));
    expect(points.size).toBeGreaterThan(two.length);
    expect(new Set(chart.map((r) => r.series)).size).toBe(points.size);
  });
});
