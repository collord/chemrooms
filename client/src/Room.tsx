/**
 * Room component — sets up RoomShell with sidebar, layout, and SQL editor.
 *
 * Owns the chemrooms entity layer lifecycle:
 *
 * Phase 1: once parquet data has loaded, run setup (geoid, chemduck
 * schema, vis specs, aggregation catalog, available analytes) and store
 * the initial layer SQL strings in React state. ChemroomsEntityLayer
 * components mounted as siblings of RoomShell observe those strings and
 * create entities directly via viewer.entities.add() with per-row colors
 * derived from the active vis spec.
 *
 * Phase 2: when the Cesium viewer is ready, sample terrain for any
 * locations that lack a surveyed elevation, INSERT the heights into
 * location_elevations_sampled, and bump the SQL strings (with a stamp
 * comment) so the entity layer hooks re-fire.
 *
 * Whenever (coloringAnalyte, eventAgg, dupAgg, ndMethod, matrixFilter)
 * changes, the samples layer SQL is rebuilt via buildSamplesLayerSql()
 * and the state update triggers React to re-run the entity hook.
 */

import {useEffect, useRef, useState} from 'react';
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
import {ChemroomsEntityLayers} from './components/ChemroomsEntityLayers';

const VIS_SPEC_TABLES = [
  'locations',
  'samples',
  'results',
  'v_results_denormalized',
];

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

  // Init flags
  const initRanRef = useRef(false);
  const terrainSampledRef = useRef(false);

  // Setup outputs surfaced as React state so the ChemroomsEntityLayer
  // components re-render when they change. Visibility and analyte
  // selection are read inside ChemroomsEntityLayers (which lives under
  // the RoomStateProvider), not here — reading them at this level would
  // require Room itself to be inside the provider, which it can't be
  // since it's the one rendering RoomShell.
  const [locationsSql, setLocationsSql] = useState<string | null>(null);
  const [samplesSql, setSamplesSql] = useState<string | null>(null);
  const [elevationColumns, setElevationColumns] = useState<string[]>([]);
  const [hasChemduckSchema, setHasChemduckSchema] = useState(false);

  useEffect(() => {
    roomStore.getState().initialize?.();
  }, []);

  // Phase 1 + Phase 2 init flow.
  useEffect(() => {
    let pendingTerrainSamples: LocationToSample[] = [];
    let phase1LocationsSql = '';

    return roomStore.subscribe((state: RoomState) => {
      // ── Phase 1 ─────────────────────────────────────────────────────────
      if (state.room.isDataAvailable && !initRanRef.current) {
        initRanRef.current = true;

        const {connector} = state.db;
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
            phase1LocationsSql = locSql;
            pendingTerrainSamples = locationsNeedingTerrain;

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
            // Stamp the SQL so React sees a new string and the entity
            // hook re-runs against the now-populated terrain table.
            const stamp = `-- terrain-sampled at ${Date.now()}\n`;
            setLocationsSql(stamp + phase1LocationsSql);
            // Force a samples rebuild so it sees the new heights too.
            setSamplesSql((prev) => (prev ? stamp + prev : prev));
          })
          .catch((e) => console.error('[init] terrain sampling failed:', e));
      }
    });
  }, []);

  // Rebuild samples SQL whenever any of the contributing slice fields
  // change. The new SQL goes into React state, which causes
  // ChemroomsEntityLayer to re-run its entity hook.
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

      if (!initRanRef.current) return;

      const effectiveAnalyte = hasChemduckSchema ? cfg.coloringAnalyte : null;
      const newSql = buildSamplesLayerSql({
        elevationColumns,
        coloringAnalyte: effectiveAnalyte,
        eventAgg: cfg.eventAgg,
        dupAgg: cfg.dupAgg,
        ndMethod: cfg.ndMethod,
        matrixFilter: cfg.matrixFilter,
      });
      setSamplesSql(newSql);

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
  }, [elevationColumns, hasChemduckSchema]);

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
      <ChemroomsEntityLayers
        locationsSql={locationsSql}
        samplesSql={samplesSql}
      />
    </RoomShell>
  );
};
