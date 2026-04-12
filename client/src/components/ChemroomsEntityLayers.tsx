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

import React, {useEffect, useRef, useState} from 'react';
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
import {ChemroomsEntityLayer} from './ChemroomsEntityLayer';
import {DATA_BASE_URL} from '../store';

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

  // ── chemrooms slice reads ──────────────────────────────────────────
  const setVisSpec = useChemroomsStore((s) => s.chemrooms.setVisSpec);
  const setAggregationRules = useChemroomsStore(
    (s) => s.chemrooms.setAggregationRules,
  );
  const setAvailableAnalyteNames = useChemroomsStore(
    (s) => s.chemrooms.setAvailableAnalyteNames,
  );
  const setColorBy = useChemroomsStore((s) => s.chemrooms.setColorBy);
  const colorByResults = useChemroomsStore(
    (s) => s.chemrooms.colorBy['v_results_denormalized'],
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
        }
      })
      .catch((e) => console.error('[init] entity layers setup failed:', e));
  }, [
    isDataAvailable,
    connector,
    setVisSpec,
    setAggregationRules,
    setAvailableAnalyteNames,
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

  // ── Render the two entity layer components ─────────────────────────
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
    </>
  );
};
