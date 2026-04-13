/**
 * Owns the chemrooms-managed Cesium entity layer lifecycle.
 *
 * Rendered inside RoomShell so all hooks have RoomStateProvider context.
 *
 * Phase 1: when room data is available, run initEntityLayers (sets up
 *   the geoid macro, loads the chemduck schema, detects elevation
 *   columns, computes initial layer SQL, identifies locations that
 *   need terrain sampling). Stores the outputs in local React state.
 *
 * Phase 2: when the Cesium viewer is ready AND pendingTerrainSamples
 *   is non-empty, sample terrain for those locations and INSERT the
 *   heights into location_elevations_sampled. Bump the layer SQL
 *   state with a timestamp so the entity hooks refetch.
 *
 * Reactive rebuild: whenever any of (coloringAnalyte, eventAgg, dupAgg,
 *   ndMethod, matrixFilter, elevationColumns, hasChemduckSchema) change,
 *   rebuild the samples layer SQL via buildSamplesLayerSql() and push
 *   it into React state. The effect is pure React reactivity — no
 *   imperative store subscriptions, so dep tracking is explicit and
 *   infinite-loop-free.
 *
 * The ChemroomsEntityLayer children pick up the SQL/visibility/spec
 * changes via their own hook-driven effects.
 */

import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Cartographic, sampleTerrainMostDetailed} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {
  initEntityLayers,
  writeSampledElevations,
  type LocationToSample,
} from '../setup/initEntityLayers';
import {loadVisSpecs} from '../vis/loadVisSpecs';
import {
  loadAggregationRules,
  loadAvailableAnalyteNames,
} from '../setup/loadCatalogs';
import {buildSamplesLayerSql} from '../setup/buildSamplesLayerSql';
import {buildLayerSql} from '../layers/buildLayerSql';
import {ChemroomsEntityLayer} from './ChemroomsEntityLayer';
import {DATA_BASE_URL} from '../store';
import {
  isEphemeralLayer,
  migratePersonalLayers,
  savePersonalLayers,
} from '../layers/layerStorage';
import {rehydrateGeoparquetLayers} from '../layers/registerGeoparquetLayer';
import type {LayerConfig} from '../layers/layerSchema';

const VIS_SPEC_TABLES = [
  'locations',
  'samples',
  'results',
  'v_results_denormalized',
];

async function sampleTerrainForLocations(
  terrainProvider: any,
  locations: LocationToSample[],
): Promise<Array<{location_id: string; ellipsoidal_height_m: number}>> {
  if (locations.length === 0) return [];
  const cartographics = locations.map((loc) =>
    Cartographic.fromDegrees(loc.longitude, loc.latitude),
  );
  const sampled = await sampleTerrainMostDetailed(
    terrainProvider,
    cartographics,
  );
  const out: Array<{location_id: string; ellipsoidal_height_m: number}> = [];
  for (let i = 0; i < locations.length; i++) {
    const h = sampled[i]?.height;
    if (typeof h === 'number' && Number.isFinite(h)) {
      out.push({
        location_id: locations[i]!.location_id,
        ellipsoidal_height_m: h,
      });
    }
  }
  return out;
}

export const ChemroomsEntityLayers: React.FC = () => {
  // ── Environment ─────────────────────────────────────────────────────
  const isDataAvailable = useStoreWithCesium(
    (s) => s.room.isDataAvailable,
  );
  const connector = useStoreWithCesium((s) => s.db.connector);
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  // refreshTableSchemas() rebuilds the SQL editor's schema panel from
  // duckdb_tables() + duckdb_views(). Called after we create the
  // chemduck views so they show up alongside the parquet-loaded tables.
  const refreshTableSchemas = useStoreWithCesium(
    (s) => s.db.refreshTableSchemas,
  );

  // ── chemrooms slice reads ──────────────────────────────────────────
  const setVisSpec = useChemroomsStore((s) => s.chemrooms.setVisSpec);
  const setAggregationRules = useChemroomsStore(
    (s) => s.chemrooms.setAggregationRules,
  );
  const setAvailableAnalyteNames = useChemroomsStore(
    (s) => s.chemrooms.setAvailableAnalyteNames,
  );
  const setColorBy = useChemroomsStore((s) => s.chemrooms.setColorBy);
  const setPersonalLayers = useChemroomsStore(
    (s) => s.chemrooms.setPersonalLayers,
  );
  const colorByResults = useChemroomsStore(
    (s) => s.chemrooms.colorBy['v_results_denormalized'],
  );
  const personalLayers = useChemroomsStore(
    (s) => s.chemrooms.personalLayers,
  );
  const bookmarkLayers = useChemroomsStore(
    (s) => s.chemrooms.bookmarkLayers,
  );

  const locationsVisible = useChemroomsStore(
    (s) => s.chemrooms.locationsVisible,
  );
  const samplesVisible = useChemroomsStore((s) => s.chemrooms.samplesVisible);

  // The five inputs to buildSamplesLayerSql
  const coloringAnalyte = useChemroomsStore(
    (s) => s.chemrooms.config.coloringAnalyte,
  );
  const eventAgg = useChemroomsStore((s) => s.chemrooms.config.eventAgg);
  const dupAgg = useChemroomsStore((s) => s.chemrooms.config.dupAgg);
  const ndMethod = useChemroomsStore((s) => s.chemrooms.config.ndMethod);
  const matrixFilter = useChemroomsStore(
    (s) => s.chemrooms.config.matrixFilter,
  );

  // ── Local state ─────────────────────────────────────────────────────
  const initRanRef = useRef(false);
  const terrainSampledRef = useRef(false);
  const pendingTerrainRef = useRef<LocationToSample[]>([]);
  const phase1LocationsSqlRef = useRef<string>('');

  const [elevationColumns, setElevationColumns] = useState<string[]>([]);
  const [hasChemduckSchema, setHasChemduckSchema] = useState(false);
  const [locationsSql, setLocationsSql] = useState<string | null>(null);
  const [samplesSql, setSamplesSql] = useState<string | null>(null);

  // ── Hydrate personal layers from localStorage on mount ─────────────
  // Runs migratePersonalLayers so any legacy UUID-based ids get
  // rehashed to content hashes in place. Idempotent on fresh stores.
  useEffect(() => {
    let cancelled = false;
    migratePersonalLayers()
      .then((layers) => {
        if (cancelled) return;
        if (layers.length > 0) {
          setPersonalLayers(layers);
          console.log(
            `[init] loaded ${layers.length} personal layer(s) from localStorage`,
          );
        }
      })
      .catch((e) =>
        console.warn('[init] personal layer migration failed:', e),
      );
    return () => {
      cancelled = true;
    };
  }, [setPersonalLayers]);

  // ── Rehydrate geoparquet layers from the local blob store ─────────
  // After migration populates personalLayers, the connector is
  // ready, AND DuckDB-WASM is actually initialized (isDataAvailable
  // flips true once the room store has loaded the base parquets),
  // walk the list for idb:// layers and re-register their bytes
  // into DuckDB. Layers whose bytes have been evicted get dropped
  // from the slice and from localStorage. Runs at most once per
  // session — rehydratedRef guards against re-entry when
  // personalLayers changes later (e.g., a fresh drop).
  //
  // The isDataAvailable gate is load-bearing: the connector object
  // exists before DuckDB is initialized, so a check for just
  // `connector != null` would fire too early and the INSTALL
  // spatial call would fail with "duckdb is not initialized".
  const rehydratedRef = useRef(false);
  useEffect(() => {
    if (rehydratedRef.current) return;
    if (!connector || !isDataAvailable) return;
    // Only run once personalLayers has been populated by migration.
    // If there's nothing to hydrate, just flip the flag and move on.
    if (personalLayers.length === 0) return;

    rehydratedRef.current = true;
    rehydrateGeoparquetLayers(connector, personalLayers)
      .then((result) => {
        if (result.dropped > 0) {
          console.warn(
            `[rehydrate] dropped ${result.dropped} layer(s) with missing blobs`,
          );
          setPersonalLayers(result.layers);
          // Rewrite localStorage without the broken entries so we
          // don't try to rehydrate them again next session.
          savePersonalLayers(
            result.layers.filter((l) => !isEphemeralLayer(l)),
          );
        } else {
          console.log(
            `[rehydrate] ${result.layers.length} personal layer(s) rehydrated`,
          );
        }
      })
      .catch((e) => console.error('[rehydrate] failed:', e));
  }, [connector, isDataAvailable, personalLayers, setPersonalLayers]);

  // ── Phase 1: initial setup ─────────────────────────────────────────
  useEffect(() => {
    if (!isDataAvailable || !connector || initRanRef.current) return;
    initRanRef.current = true;

    // Fetch sidecar vis specs in parallel.
    loadVisSpecs(DATA_BASE_URL, VIS_SPEC_TABLES)
      .then((loaded) => {
        for (const {table, spec} of loaded) {
          setVisSpec(table, spec);
        }
        console.log(
          `[init] loaded ${loaded.length} vis spec(s): [${loaded
            .map((l) => l.table)
            .join(',')}]`,
        );
      })
      .catch((e) => console.warn('[init] vis spec fetch failed:', e));

    initEntityLayers(connector)
      .then(async (result) => {
        const {
          hasGeoid,
          hasChemduckSchema: hasSchema,
          elevationColumns: elevCols,
          locationsSql: locSql,
          samplesSql: sampSql,
          locationsNeedingTerrain,
        } = result;
        console.log(
          `[init] hasGeoid=${hasGeoid} hasChemduckSchema=${hasSchema} elevationColumns=[${elevCols.join(
            ',',
          )}] needTerrain=${locationsNeedingTerrain.length}`,
        );
        phase1LocationsSqlRef.current = locSql;
        pendingTerrainRef.current = locationsNeedingTerrain;

        setElevationColumns(elevCols);
        setHasChemduckSchema(hasSchema);
        setLocationsSql(locSql);
        setSamplesSql(sampSql);

        if (hasSchema) {
          const [rules, analytes] = await Promise.all([
            loadAggregationRules(connector),
            loadAvailableAnalyteNames(connector),
          ]);
          setAggregationRules(rules);
          setAvailableAnalyteNames(analytes);
          console.log(
            `[init] catalogs: ${rules.length} aggregation rules, ${analytes.length} analytes`,
          );

          // Refresh the SQL editor's schema panel so the chemduck
          // views (v_results_denormalized, v_results_with_screening,
          // v_most_recent_results, etc.) appear alongside the
          // parquet-loaded tables. Without this, the panel only
          // shows the snapshot taken when the parquets first loaded
          // — before loadChemduckSchema created the views.
          await refreshTableSchemas();
        }
      })
      .catch((e) => console.error('[init] entity layers setup failed:', e));
  }, [
    isDataAvailable,
    connector,
    setVisSpec,
    setAggregationRules,
    setAvailableAnalyteNames,
    refreshTableSchemas,
  ]);

  // ── Phase 2: terrain sampling when viewer is ready ─────────────────
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !connector) return;
    if (terrainSampledRef.current) return;
    if (pendingTerrainRef.current.length === 0) return;
    if (!initRanRef.current) return;

    terrainSampledRef.current = true;
    const locsToSample = pendingTerrainRef.current;
    pendingTerrainRef.current = [];

    const t0 = performance.now();
    sampleTerrainForLocations(viewer.terrainProvider, locsToSample)
      .then((rows) => {
        const t1 = performance.now();
        console.log(
          `[init] sampled ${rows.length}/${locsToSample.length} terrain heights in ${(
            t1 - t0
          ).toFixed(0)}ms`,
        );
        return writeSampledElevations(connector, rows);
      })
      .then(() => {
        const stamp = `-- terrain-sampled at ${Date.now()}\n`;
        setLocationsSql(stamp + phase1LocationsSqlRef.current);
        // Force a samples rebuild so it sees the new heights too.
        setSamplesSql((prev) => (prev ? stamp + prev : prev));
      })
      .catch((e) => console.error('[init] terrain sampling failed:', e));
    // Deps include locationsSql so this effect re-fires when Phase 1
    // finishes (locationsSql goes from null to a string). The
    // terrainSampledRef guard makes subsequent re-fires no-ops.
  }, [viewer, connector, locationsSql]);

  // ── Reactive samples SQL rebuild ───────────────────────────────────
  // Pure React effect: whenever any contributing value changes, rebuild
  // the samples layer SQL. No imperative store subscriptions — the deps
  // array is the contract.
  useEffect(() => {
    if (!initRanRef.current) return;
    // Skip the very first run after Phase 1 sets samplesSql to the init
    // result: elevationColumns is already set by then, so this effect
    // will run and rebuild using the same inputs. That's fine — the
    // resulting SQL should be the same as the Phase 1 one, but we avoid
    // a wasted re-render via a no-op check inside setSamplesSql by
    // comparing to the previous value.
    const effectiveAnalyte = hasChemduckSchema ? coloringAnalyte : null;
    const newSql = buildSamplesLayerSql({
      elevationColumns,
      coloringAnalyte: effectiveAnalyte,
      eventAgg,
      dupAgg,
      ndMethod,
      matrixFilter,
    });
    setSamplesSql((prev) => (prev === newSql ? prev : newSql));
  }, [
    elevationColumns,
    hasChemduckSchema,
    coloringAnalyte,
    eventAgg,
    dupAgg,
    ndMethod,
    matrixFilter,
  ]);

  // ── Auto color-by when analyte is selected ─────────────────────────
  // When an analyte gets picked, default colorBy['v_results_denormalized']
  // to 'result' so the user sees a gradient immediately. Only set if
  // the user hasn't chosen their own column.
  useEffect(() => {
    if (!coloringAnalyte) return;
    if (colorByResults) return;
    setColorBy('v_results_denormalized', 'result');
  }, [coloringAnalyte, colorByResults, setColorBy]);

  // ── Build per-saved-layer SQL ───────────────────────────────────────
  // Each saved layer (personal or bookmark) has its own query
  // parameters (analyte, matrix, event_agg, etc.), independent of the
  // live recipe sidebar. We precompute the SQL string for each layer
  // here so React's render pipeline can pass them as stable props to
  // ChemroomsEntityLayer. Recomputed when the layer list changes or
  // the elevation columns change (only once after init).
  //
  // Routing happens in buildLayerSql, which dispatches on
  // dataSource.type. Chemduck layers still need the chemduck schema
  // to be loaded and the elevation-columns introspection to have
  // run; geoparquet layers don't, because their tables were
  // registered by the runtime loader independently of the chemduck
  // bootstrap.
  const buildLayerSqlMap = (layers: LayerConfig[]) => {
    if (!initRanRef.current) return new Map<string, string | null>();
    const map = new Map<string, string | null>();
    for (const layer of layers) {
      if (layer.dataSource.type === 'chemduck' && !hasChemduckSchema) {
        // Chemduck schema not loaded yet — skip this layer for now,
        // it'll be picked up the next time the memo recomputes.
        continue;
      }
      const sql = buildLayerSql(layer, {elevationColumns});
      map.set(layer.id, sql);
    }
    return map;
  };

  const personalLayerSql = useMemo(
    () => buildLayerSqlMap(personalLayers),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [personalLayers, elevationColumns, hasChemduckSchema],
  );

  const bookmarkLayerSql = useMemo(
    () => buildLayerSqlMap(bookmarkLayers),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bookmarkLayers, elevationColumns, hasChemduckSchema],
  );

  // ── Render the entity layer components ─────────────────────────────
  // When an analyte is selected the "samples" layer switches to the
  // aggregated results query with per-row coloring. The plain
  // locations/samples cyan overview hides — it's replaced by the
  // richer view. When the user clears the analyte, the cyan dots
  // come back as the full-extent preview.
  const hasAnalyte = Boolean(coloringAnalyte);
  const samplesVisSpecTable = hasAnalyte ? 'v_results_denormalized' : 'samples';

  return (
    <>
      <ChemroomsEntityLayer
        layerId="locations"
        sqlQuery={locationsSql}
        visSpecTable="locations"
        visible={locationsVisible && !hasAnalyte}
      />
      <ChemroomsEntityLayer
        layerId="samples"
        sqlQuery={samplesSql}
        visSpecTable={samplesVisSpecTable}
        visible={samplesVisible}
      />
      {personalLayers.map((layer) => {
        const sql = personalLayerSql.get(layer.id) ?? null;
        return (
          <ChemroomsEntityLayer
            key={`personal:${layer.id}`}
            layerId={`personal:${layer.id}`}
            sqlQuery={sql}
            visSpecTable={visSpecTableFor(layer)}
            visible={layer.visible}
            colorByOverride={layer.visual.colorBy}
          />
        );
      })}
      {bookmarkLayers.map((layer) => {
        const sql = bookmarkLayerSql.get(layer.id) ?? null;
        return (
          <ChemroomsEntityLayer
            key={`bookmark:${layer.id}`}
            layerId={`bookmark:${layer.id}`}
            sqlQuery={sql}
            visSpecTable={visSpecTableFor(layer)}
            visible={layer.visible}
            colorByOverride={layer.visual.colorBy}
          />
        );
      })}
    </>
  );
};

/**
 * Pick the vis-spec table key for a saved layer. Chemduck-recipe
 * layers go through the chemduck `v_results_denormalized` vis spec
 * (which provides palette/colorBy defaults); other layer types use
 * a per-layer key that won't match any registered vis spec, so
 * useChemroomsEntities falls through to the cyan default. That's
 * the right behavior for a freshly dropped geoparquet — it shows
 * up as cyan dots until the user picks a colorBy column.
 */
function visSpecTableFor(layer: LayerConfig): string {
  if (layer.dataSource.type === 'chemduck') {
    return 'v_results_denormalized';
  }
  if (layer.dataSource.type === 'geoparquet') {
    return `geoparquet:${layer.dataSource.tableName}`;
  }
  return `layer:${layer.id}`;
}
