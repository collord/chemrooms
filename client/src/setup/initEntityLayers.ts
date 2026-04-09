/**
 * Runtime initialization of the chemrooms Cesium entity layers.
 *
 * This module runs after the room shell has loaded all parquet data
 * sources. It:
 *
 *   1. Loads the geoid grid (if available) and registers a SQL macro
 *      `geoid_offset(lon, lat)` that does bilinear interpolation.
 *      If the geoid file is missing, the macro is registered as a
 *      no-op (returns 0).
 *
 *   2. Inspects the locations table for an elevation-bearing column,
 *      checking [elevation, z, measuring_pt] in priority order.
 *
 *   3. Adds the chemrooms `locations` and `subsurface-samples` Cesium
 *      entity layers to the cesium slice with SQL queries that compute
 *      altitudes correctly:
 *
 *        ellipsoidal_altitude =
 *          COALESCE(elevation, z, measuring_pt, 0)  -- NAVD88 meters
 *          + geoid_offset(lon, lat)                  -- to ellipsoidal
 *          - depth_in_meters                         -- for samples only
 *
 * The static cesium config in store.ts intentionally has *no* entity
 * layers so we don't see a flash of incorrectly-positioned points
 * before this setup runs.
 */

import type {DuckDbConnector} from '@sqlrooms/duckdb';

const BASE_URL = import.meta.env.BASE_URL;

const GEOID_URL = `${BASE_URL}geoid/local.json`;

/** Columns to check on the locations table for an elevation source. */
const ELEVATION_COLUMN_CANDIDATES = ['elevation', 'z', 'measuring_pt'];

/**
 * Inspect a table's columns and return which of the candidate names exist
 * (in their original priority order).
 */
async function detectColumns(
  connector: DuckDbConnector,
  tableName: string,
  candidates: string[],
): Promise<string[]> {
  const candList = candidates.map((c) => `'${c}'`).join(', ');
  const result = await connector.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = '${tableName}'
      AND column_name IN (${candList})
  `);
  const found = new Set<string>();
  for (const row of result.toArray()) {
    found.add((row as any).column_name);
  }
  return candidates.filter((c) => found.has(c));
}

/**
 * Try to load the geoid grid into a DuckDB table. Returns true if loaded,
 * false if the file isn't reachable.
 */
async function tryLoadGeoidGrid(connector: DuckDbConnector): Promise<boolean> {
  // First check if the file exists via HEAD; DuckDB-WASM's read_json against
  // a missing URL would throw an unhelpful error otherwise.
  try {
    const head = await fetch(GEOID_URL, {method: 'HEAD'});
    if (!head.ok) return false;
  } catch {
    return false;
  }

  try {
    await connector.query(`
      CREATE OR REPLACE TABLE geoid_grid AS
      SELECT * FROM read_json('${GEOID_URL}', auto_detect = true)
    `);
    return true;
  } catch (e) {
    console.warn('[init] failed to load geoid grid:', e);
    return false;
  }
}

/**
 * Register the `geoid_offset(lon, lat)` SQL macro. If `hasGrid` is false,
 * the macro is a no-op that returns 0 — so call sites don't have to know
 * whether a geoid file is present.
 */
async function registerGeoidMacro(
  connector: DuckDbConnector,
  hasGrid: boolean,
): Promise<void> {
  if (!hasGrid) {
    await connector.query(`
      CREATE OR REPLACE MACRO geoid_offset(qlon, qlat) AS (0.0)
    `);
    return;
  }

  // Bilinear interpolation against geoid_grid (col_idx, row_idx, lon, lat,
  // offset_m). The grid is regular in lon/lat so we can derive the bounds
  // and spacing from MIN/MAX/COUNT and use direct integer indexing.
  await connector.query(`
    CREATE OR REPLACE MACRO geoid_offset(qlon, qlat) AS (
      WITH g AS (
        SELECT
          MIN(lon) AS west, MAX(lon) AS east,
          MIN(lat) AS south, MAX(lat) AS north,
          MAX(col_idx) + 1 AS nx,
          MAX(row_idx) + 1 AS ny
        FROM geoid_grid
      ),
      norm AS (
        SELECT
          GREATEST(0.0, LEAST(g.nx - 1.0001,
            (qlon - g.west) / NULLIF((g.east - g.west) / NULLIF(g.nx - 1, 0), 0)
          )) AS fx,
          GREATEST(0.0, LEAST(g.ny - 1.0001,
            (qlat - g.south) / NULLIF((g.north - g.south) / NULLIF(g.ny - 1, 0), 0)
          )) AS fy
        FROM g
      ),
      cells AS (
        SELECT
          CAST(FLOOR(fx) AS INTEGER) AS x0,
          CAST(FLOOR(fy) AS INTEGER) AS y0,
          fx - FLOOR(fx) AS u,
          fy - FLOOR(fy) AS v
        FROM norm
      )
      SELECT
          (1 - u) * (1 - v) * (SELECT offset_m FROM geoid_grid WHERE col_idx = c.x0     AND row_idx = c.y0)
        + u       * (1 - v) * (SELECT offset_m FROM geoid_grid WHERE col_idx = c.x0 + 1 AND row_idx = c.y0)
        + (1 - u) * v       * (SELECT offset_m FROM geoid_grid WHERE col_idx = c.x0     AND row_idx = c.y0 + 1)
        + u       * v       * (SELECT offset_m FROM geoid_grid WHERE col_idx = c.x0 + 1 AND row_idx = c.y0 + 1)
      FROM cells c
    )
  `);
}

/**
 * Build the SQL that resolves a location's NAVD88 elevation from the
 * available columns. Returns just the expression — caller embeds it.
 */
function elevationExpr(elevationColumns: string[], prefix = ''): string {
  if (elevationColumns.length === 0) return '0.0';
  const cols = elevationColumns.map((c) => `${prefix}${c}`);
  // COALESCE first non-null, fallback to 0 if all null
  return `COALESCE(${cols.join(', ')}, 0.0)`;
}

export interface InitResult {
  hasGeoid: boolean;
  elevationColumns: string[];
  locationsSql: string;
  samplesSql: string;
}

/**
 * Run the full setup sequence and return the layer SQL strings ready
 * to register via `cesium.addLayer(...)`.
 */
export async function initEntityLayers(
  connector: DuckDbConnector,
): Promise<InitResult> {
  const hasGeoid = await tryLoadGeoidGrid(connector);
  await registerGeoidMacro(connector, hasGeoid);

  const elevationColumns = await detectColumns(
    connector,
    'locations',
    ELEVATION_COLUMN_CANDIDATES,
  );

  const locElev = elevationExpr(elevationColumns);

  // Locations: surface points, positioned at the resolved ellipsoidal
  // altitude. Drops the +10m offset that was used as a visibility hack.
  const locationsSql = `
    SELECT
      location_id,
      x AS longitude,
      y AS latitude,
      ${locElev} + geoid_offset(x, y) AS altitude,
      loc_type,
      COALESCE(loc_desc, location_id) AS label
    FROM locations
  `;

  // Subsurface samples: parent location elevation - depth (feet → meters).
  // The geoid offset is computed at the parent location's lon/lat.
  const parentElev = elevationExpr(elevationColumns, 'l.');
  const samplesSql = `
    SELECT
      s.sample_id AS location_id,
      l.x AS longitude,
      l.y AS latitude,
      ${parentElev} + geoid_offset(l.x, l.y) - (COALESCE(s.depth, 0) * 0.3048) AS altitude,
      s.matrix AS loc_type,
      s.sample_id || ' (' || ROUND(s.depth, 1) || ' ft)' AS label
    FROM samples s
    JOIN locations l ON l.location_id = s.location_id
    WHERE s.depth IS NOT NULL
  `;

  return {hasGeoid, elevationColumns, locationsSql, samplesSql};
}
