/**
 * Room component — sets up RoomShell with sidebar, layout, and SQL editor.
 */

import {useEffect, useRef} from 'react';
import {RoomShell} from '@sqlrooms/room-shell';
import {SqlEditorModal} from '@sqlrooms/sql-editor';
import {ThemeSwitch, useDisclosure} from '@sqlrooms/ui';
import {TerminalIcon} from 'lucide-react';
import {Cartographic, sampleTerrainMostDetailed} from 'cesium';
import {roomStore, type RoomState, DATA_BASE_URL} from './store';
import {
  initEntityLayers,
  writeSampledElevations,
  type LocationToSample,
} from './setup/initEntityLayers';
import {loadVisSpecs} from './vis/loadVisSpecs';
import {
  loadAggregationRules,
  loadAvailableAnalyteNames,
} from './setup/loadCatalogs';
import {buildSamplesLayerSql} from './setup/buildSamplesLayerSql';

const VIS_SPEC_TABLES = [
  'locations',
  'samples',
  'results',
  'v_results_denormalized',
];

const COLUMN_MAPPING = {
  longitude: 'longitude',
  latitude: 'latitude',
  altitude: 'altitude',
  label: 'label',
} as const;

/** Sample terrain at each location and return ellipsoidal heights. */
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

export const Room = () => {
  const sqlEditorDisclosure = useDisclosure();
  const initRanRef = useRef(false);
  const terrainSampledRef = useRef(false);
  const elevationColumnsRef = useRef<string[]>([]);
  const hasChemduckSchemaRef = useRef(false);
  /** Last applied samples layer SQL — used to skip no-op rebuilds. */
  const lastSamplesSqlRef = useRef<string | null>(null);

  useEffect(() => {
    roomStore.getState().initialize?.();
  }, []);

  // Phase 1: once parquet data has loaded, run setup and add the entity
  // layers. Locations whose elevation must be sampled from terrain are
  // queued for Phase 2.
  // Phase 2: when the Cesium viewer is ready, sample terrain for those
  // locations and INSERT the heights into location_elevations_sampled,
  // then re-fire the locations layer query.
  useEffect(() => {
    let pendingTerrainSamples: LocationToSample[] = [];
    let phase1LocationsSql = '';

    return roomStore.subscribe((state: RoomState) => {
      // ── Phase 1 ─────────────────────────────────────────────────────────
      if (state.room.isDataAvailable && !initRanRef.current) {
        initRanRef.current = true;

        const {connector} = state.db;
        const {addLayer} = state.cesium;
        const {
          setVisSpec,
          setAggregationRules,
          setAvailableAnalyteNames,
        } = state.chemrooms;

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
              hasChemduckSchema,
              elevationColumns,
              locationsSql,
              samplesSql,
              locationsNeedingTerrain,
            } = result;
            console.log(
              `[init] hasGeoid=${hasGeoid} hasChemduckSchema=${hasChemduckSchema} elevationColumns=[${elevationColumns.join(
                ',',
              )}] needTerrain=${locationsNeedingTerrain.length}`,
            );
            phase1LocationsSql = locationsSql;
            elevationColumnsRef.current = elevationColumns;
            hasChemduckSchemaRef.current = hasChemduckSchema;
            pendingTerrainSamples = locationsNeedingTerrain;
            lastSamplesSqlRef.current = samplesSql;

            addLayer({
              id: 'locations',
              type: 'sql-entities',
              visible: true,
              tableName: 'locations',
              heightReference: 'NONE',
              sqlQuery: locationsSql,
              columnMapping: COLUMN_MAPPING,
            });
            addLayer({
              id: 'subsurface-samples',
              type: 'sql-entities',
              visible: false,
              tableName: 'samples',
              heightReference: 'NONE',
              sqlQuery: samplesSql,
              columnMapping: COLUMN_MAPPING,
            });

            // Once chemduck views/macros are available, load the
            // catalogs so the UI dropdowns can populate.
            if (hasChemduckSchema) {
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
          .catch((e) =>
            console.error('[init] entity layers setup failed:', e),
          );
      }

      // ── Phase 2 ─────────────────────────────────────────────────────────
      const viewer = state.cesium.viewer;
      if (
        initRanRef.current &&
        !terrainSampledRef.current &&
        pendingTerrainSamples.length > 0 &&
        viewer &&
        !viewer.isDestroyed()
      ) {
        terrainSampledRef.current = true;

        const {connector} = state.db;
        const {updateLayer} = state.cesium;
        const locsToSample = pendingTerrainSamples;
        pendingTerrainSamples = [];

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
            // Invalidate useSql cache by appending a unique stamp.
            const stamp = `-- terrain-sampled at ${Date.now()}\n`;
            updateLayer('locations', {sqlQuery: stamp + phase1LocationsSql});
            // Also re-fire samples layer with current state
            rebuildSamplesLayer(stamp);
          })
          .catch((e) => console.error('[init] terrain sampling failed:', e));
      }
    });
  }, []);

  /**
   * Rebuild the samples layer SQL from current state and push it to
   * the cesium slice. Compares against lastSamplesSqlRef to avoid
   * pointless re-fires.
   *
   * Optional `prefix` is prepended to invalidate the useSql cache when
   * the SQL bytes are otherwise unchanged (e.g. terrain sampling
   * completed and we want to refetch with new altitude data).
   */
  const rebuildSamplesLayer = (prefix = '') => {
    if (!initRanRef.current) return;
    const state = roomStore.getState();
    const {coloringAnalyte, eventAgg, dupAgg, ndMethod, matrixFilter} =
      state.chemrooms.config;

    // If chemduck schema didn't load, force the no-analyte fallback
    // even if the user somehow ended up with one selected.
    const effectiveAnalyte = hasChemduckSchemaRef.current
      ? coloringAnalyte
      : null;

    const sql =
      prefix +
      buildSamplesLayerSql({
        elevationColumns: elevationColumnsRef.current,
        coloringAnalyte: effectiveAnalyte,
        eventAgg,
        dupAgg,
        ndMethod,
        matrixFilter,
      });

    if (sql === lastSamplesSqlRef.current) return;
    lastSamplesSqlRef.current = sql;
    state.cesium.updateLayer('subsurface-samples', {sqlQuery: sql});
  };

  // Subscribe to changes that should trigger a samples layer rebuild.
  // Each setState that touches one of these fields fires the listener.
  useEffect(() => {
    let last = roomStore.getState().chemrooms.config;
    return roomStore.subscribe((state: RoomState) => {
      const cfg = state.chemrooms.config;
      if (
        cfg.coloringAnalyte === last.coloringAnalyte &&
        cfg.eventAgg === last.eventAgg &&
        cfg.dupAgg === last.dupAgg &&
        cfg.ndMethod === last.ndMethod &&
        cfg.matrixFilter === last.matrixFilter
      ) {
        return;
      }
      last = cfg;
      rebuildSamplesLayer();

      // When an analyte is selected, default the v_results_denormalized
      // color-by column to 'result' so the user sees a concentration
      // gradient immediately. Only set if the user hasn't picked one.
      if (cfg.coloringAnalyte) {
        const colorBy = state.chemrooms.colorBy['v_results_denormalized'];
        if (!colorBy) {
          state.chemrooms.setColorBy('v_results_denormalized', 'result');
        }
      }
    });
  }, []);

  return (
    <RoomShell className="h-screen" roomStore={roomStore}>
      <RoomShell.Sidebar>
        <RoomShell.SidebarButton
          title="SQL Editor"
          onClick={sqlEditorDisclosure.onToggle}
          isSelected={false}
          icon={TerminalIcon}
        />
        <ThemeSwitch />
      </RoomShell.Sidebar>
      <RoomShell.LayoutComposer />
      <RoomShell.LoadingProgress />
      <SqlEditorModal
        isOpen={sqlEditorDisclosure.isOpen}
        onClose={sqlEditorDisclosure.onClose}
      />
    </RoomShell>
  );
};
