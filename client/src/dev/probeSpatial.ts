/**
 * Probe DuckDB-WASM's spatial extension support.
 *
 * Runs a sequence of increasingly specific tests against the live
 * connector and reports which ones worked. The goal is to distinguish
 * the common failure modes — extension download, extension load,
 * basic symbol availability, WKB round-trip — so that "spatial
 * doesn't work" can be narrowed into an actionable diagnosis.
 *
 * This is a dev-only utility. It is not wired into the app's normal
 * boot path; call it explicitly when you want to answer the question
 * "does spatial work in the current DuckDB-WASM bundle."
 *
 * ## Usage
 *
 * From a dev build (import.meta.env.DEV), this module installs a
 * global `window.__chemroomsProbeSpatial` that closes over the
 * current connector. From the browser devtools console:
 *
 *   await window.__chemroomsProbeSpatial()
 *
 * Returns a structured result showing which probe steps passed.
 *
 * Runtime effects: `INSTALL spatial` and `LOAD spatial` leave the
 * connection's extension state modified. That's intentional — the
 * probe reports the same state subsequent queries will see — but
 * it means running the probe *once* is enough; after that, spatial
 * is available for the rest of the session.
 */

import type {DuckDbConnector} from '@sqlrooms/duckdb';

export interface SpatialProbeStepResult {
  step: string;
  ok: boolean;
  detail?: string;
  error?: string;
}

export interface SpatialProbeResult {
  duckdbVersion: string | null;
  steps: SpatialProbeStepResult[];
  /** Convenience: true iff every step passed. */
  allOk: boolean;
}

export async function probeSpatial(
  connector: DuckDbConnector,
): Promise<SpatialProbeResult> {
  const steps: SpatialProbeStepResult[] = [];
  let duckdbVersion: string | null = null;

  async function runStep(
    step: string,
    sql: string,
    extract?: (rows: Array<Record<string, unknown>>) => {
      ok: boolean;
      detail?: string;
    },
  ): Promise<boolean> {
    try {
      const result = await connector.query(sql);
      const rows = result.toArray() as Array<Record<string, unknown>>;
      const {ok, detail} = extract
        ? extract(rows)
        : {ok: true, detail: undefined};
      steps.push({step, ok, detail});
      return ok;
    } catch (e) {
      steps.push({
        step,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  // 1. DuckDB version — context for any later failure.
  await runStep('version', 'SELECT version() AS v', (rows) => {
    const v = rows[0]?.v;
    duckdbVersion = typeof v === 'string' ? v : null;
    return {ok: duckdbVersion !== null, detail: duckdbVersion ?? undefined};
  });

  // 2. INSTALL spatial — fetches the extension binary from the repo.
  //    Common failure: signed-extension enforcement in DuckDB-WASM
  //    rejects community extensions. If this step fails, the fix is
  //    to configure the WASM bundle to allow unsigned extensions or
  //    to point at a different extension repository.
  const installOk = await runStep('INSTALL spatial', 'INSTALL spatial');
  if (!installOk) return finish();

  // 3. LOAD spatial — loads the binary into the current connection.
  const loadOk = await runStep('LOAD spatial', 'LOAD spatial');
  if (!loadOk) return finish();

  // 4. Basic function availability — ST_Point + ST_X + ST_Y.
  //    If INSTALL and LOAD worked but this fails, symbols aren't
  //    exposed (rare; usually a version mismatch).
  await runStep(
    'ST_Point + ST_X/ST_Y',
    'SELECT ST_X(ST_Point(1.0, 2.0)) AS x, ST_Y(ST_Point(1.0, 2.0)) AS y',
    (rows) => {
      const row = rows[0];
      const ok = row?.x === 1 && row?.y === 2;
      return {ok, detail: ok ? 'x=1 y=2 as expected' : JSON.stringify(row)};
    },
  );

  // 5. WKB round-trip — the operation buildLayerSql will actually
  //    depend on for geoparquet. If this passes but INSTALL failed,
  //    something is very weird (shouldn't happen).
  await runStep(
    'ST_AsWKB → ST_GeomFromWKB round-trip',
    'SELECT ST_X(ST_GeomFromWKB(ST_AsWKB(ST_Point(1.0, 2.0)))) AS x',
    (rows) => {
      const ok = rows[0]?.x === 1;
      return {ok, detail: ok ? '1.0 round-tripped' : JSON.stringify(rows[0])};
    },
  );

  // 6. GeoJSON interop — useful because chemrooms already has a
  //    geojson data source type that may eventually want to share
  //    the spatial pipeline.
  await runStep(
    'ST_GeomFromGeoJSON',
    `SELECT ST_AsText(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[1,2]}')) AS wkt`,
    (rows) => {
      const wkt = rows[0]?.wkt;
      const ok = typeof wkt === 'string' && wkt.toUpperCase().includes('POINT');
      return {ok, detail: typeof wkt === 'string' ? wkt : undefined};
    },
  );

  return finish();

  function finish(): SpatialProbeResult {
    return {
      duckdbVersion,
      steps,
      allOk: steps.every((s) => s.ok),
    };
  }
}

/**
 * Register a dev-only global for browser-devtools invocation.
 * Call this once from the app's boot code (guarded by
 * import.meta.env.DEV) with a function that returns the current
 * connector — we deliberately don't hold a reference ourselves
 * because the connector is created inside the store and we don't
 * want this dev utility to couple to the store directly.
 */
export function registerSpatialProbeGlobal(
  getConnector: () => DuckDbConnector | null,
): void {
  if (!import.meta.env.DEV) return;
  (globalThis as unknown as Record<string, unknown>).__chemroomsProbeSpatial =
    async () => {
      const connector = getConnector();
      if (!connector) {
        console.warn(
          '[probeSpatial] connector not ready — try again after the app has booted',
        );
        return null;
      }
      const result = await probeSpatial(connector);
      // Pretty-print to the console for quick inspection.
      console.group('[probeSpatial] result');
      console.log('DuckDB version:', result.duckdbVersion);
      console.log('All steps passed:', result.allOk);
      console.table(result.steps);
      console.groupEnd();
      return result;
    };
}
