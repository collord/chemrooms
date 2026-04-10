/**
 * Runtime initialization of the chemrooms Cesium entity layers.
 *
 * This module runs after the room shell has loaded all parquet data
 * sources. It runs in two phases:
 *
 * Phase 1 (initEntityLayers, called when data is available):
 *   1. Loads the geoid grid (if available) and registers a SQL macro
 *      `geoid_offset(lon, lat)` that does bilinear interpolation.
 *      If the geoid file is missing, the macro is registered as a
 *      no-op (returns 0).
 *   2. Inspects the locations table for elevation-bearing columns,
 *      checking [elevation, z, measuring_pt] in priority order.
 *   3. Creates an empty `location_elevations_sampled` table that the
 *      layer SQL joins against. Rows are added in Phase 2 below.
 *   4. Returns the SQL strings for the locations + subsurface-samples
 *      Cesium entity layers, and the list of locations needing terrain
 *      sampling (i.e., where the data has no elevation).
 *
 * Phase 2 (sampleMissingElevations, called when the Cesium viewer is
 * ready):
 *   For each location with no surveyed elevation, sample
 *   `viewer.terrainProvider` to get the ellipsoidal terrain height,
 *   then INSERT (location_id, height_m) into location_elevations_sampled
 *   in DuckDB. The entity layer SQL is then re-fired so the new heights
 *   are picked up.
 *
 * Altitude resolution priority (per location):
 *   1. COALESCE(elevation, z, measuring_pt) — assumed NAVD88, geoid
 *      offset is added to convert to ellipsoidal.
 *   2. terrain-sampled height — already ellipsoidal, no offset added.
 *   3. 0 (last-resort fallback so points still render somewhere)
 *
 * Subsurface samples inherit their parent location's resolved height,
 * then subtract `depth_m`. A sample whose parent has no surveyed
 * elevation falls back to (terrain - depth), which is the right
 * behavior for ad-hoc data.
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

/** SQL expression for the surveyed NAVD88 elevation, or NULL if none. */
function surveyedElevExpr(elevationColumns: string[], prefix = ''): string {
  if (elevationColumns.length === 0) return 'CAST(NULL AS DOUBLE)';
  const cols = elevationColumns.map((c) => `${prefix}${c}`);
  return `COALESCE(${cols.join(', ')})`;
}

export interface LocationToSample {
  location_id: string;
  longitude: number;
  latitude: number;
}

export interface InitResult {
  hasGeoid: boolean;
  elevationColumns: string[];
  locationsSql: string;
  samplesSql: string;
  /** Locations whose elevation must be sampled from terrain in Phase 2. */
  locationsNeedingTerrain: LocationToSample[];
}

/**
 * Phase 1: register the geoid macro, detect elevation columns, create
 * the `location_elevations_sampled` table, and build the layer SQL.
 *
 * Returns the SQL plus the list of locations that still need a
 * terrain-sampled elevation.
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

  // Create the empty terrain-sample table the layer SQL joins against.
  // Heights here are ALREADY ellipsoidal (terrain providers return
  // ellipsoidal meters), so we do NOT add geoid_offset on lookup.
  await connector.query(`
    CREATE OR REPLACE TABLE location_elevations_sampled (
      location_id VARCHAR,
      ellipsoidal_height_m DOUBLE
    )
  `);

  // List of locations that need terrain sampling (those with no surveyed
  // elevation in any candidate column).
  const surveyedLoc = surveyedElevExpr(elevationColumns);
  const needSampleResult = await connector.query(`
    SELECT location_id, x AS longitude, y AS latitude
    FROM locations
    WHERE ${surveyedLoc} IS NULL
  `);
  const locationsNeedingTerrain: LocationToSample[] = needSampleResult
    .toArray()
    .map((r: any) => ({
      location_id: String(r.location_id),
      longitude: Number(r.longitude),
      latitude: Number(r.latitude),
    }));

  // Build layer SQL. Each location's altitude is resolved as:
  //   1. Surveyed NAVD88 elevation + geoid_offset (ellipsoidal)
  //   2. Terrain-sampled height (already ellipsoidal)
  //   3. 0 (last-resort)
  const locationsSql = `
    SELECT
      l.location_id,
      l.x AS longitude,
      l.y AS latitude,
      COALESCE(
        ${surveyedLoc} + geoid_offset(l.x, l.y),
        s.ellipsoidal_height_m,
        0.0
      ) AS altitude,
      l.loc_type,
      COALESCE(l.loc_desc, l.location_id) AS label
    FROM locations l
    LEFT JOIN location_elevations_sampled s
      ON s.location_id = l.location_id
  `;

  // Subsurface samples inherit the parent location's resolved height,
  // then subtract `depth` (assumed in feet → meters).  A sample with no
  // depth is treated as a surface sample (depth = 0), per the project
  // convention that a sample on a surveyed location with no depth is at
  // the location's elevation.
  const surveyedSampleParent = surveyedElevExpr(elevationColumns, 'l.');
  const samplesSql = `
    SELECT
      s.sample_id AS location_id,
      l.x AS longitude,
      l.y AS latitude,
      COALESCE(
        ${surveyedSampleParent} + geoid_offset(l.x, l.y),
        es.ellipsoidal_height_m,
        0.0
      ) - (COALESCE(s.depth, 0) * 0.3048) AS altitude,
      s.matrix AS loc_type,
      s.sample_id || CASE
        WHEN s.depth IS NULL THEN ' (surface)'
        ELSE ' (' || ROUND(s.depth, 1) || ' ft)'
      END AS label
    FROM samples s
    JOIN locations l ON l.location_id = s.location_id
    LEFT JOIN location_elevations_sampled es
      ON es.location_id = l.location_id
  `;

  return {
    hasGeoid,
    elevationColumns,
    locationsSql,
    samplesSql,
    locationsNeedingTerrain,
  };
}

/**
 * Phase 2: insert terrain-sampled elevations into
 * `location_elevations_sampled`. Caller is responsible for triggering a
 * layer refetch afterward.
 *
 * Heights are written as ellipsoidal meters (whatever the terrain
 * provider returns), with no geoid offset applied.
 */
export async function writeSampledElevations(
  connector: DuckDbConnector,
  rows: Array<{location_id: string; ellipsoidal_height_m: number}>,
): Promise<void> {
  if (rows.length === 0) return;

  // Use a single VALUES clause for the bulk insert
  const valuesSql = rows
    .map(
      (r) =>
        `('${r.location_id.replace(/'/g, "''")}', ${r.ellipsoidal_height_m})`,
    )
    .join(', ');

  await connector.query(`
    INSERT INTO location_elevations_sampled (location_id, ellipsoidal_height_m)
    VALUES ${valuesSql}
  `);
}
