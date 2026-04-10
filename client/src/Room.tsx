/**
 * Room component — sets up RoomShell with sidebar, layout, and SQL editor.
 */

import {useEffect, useRef} from 'react';
import {RoomShell} from '@sqlrooms/room-shell';
import {SqlEditorModal} from '@sqlrooms/sql-editor';
import {ThemeSwitch, useDisclosure} from '@sqlrooms/ui';
import {TerminalIcon} from 'lucide-react';
import {Cartographic, sampleTerrainMostDetailed} from 'cesium';
import {roomStore, type RoomState} from './store';
import {
  initEntityLayers,
  writeSampledElevations,
  type LocationToSample,
} from './setup/initEntityLayers';

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

  useEffect(() => {
    roomStore.getState().initialize?.();
  }, []);

  // Phase 1: once parquet data has loaded, run setup and add the entity
  // layers. Locations whose elevation must be sampled from terrain are
  // queued in `pendingTerrainSamples` for Phase 2.
  // Phase 2: when the Cesium viewer is ready, sample terrain for those
  // locations, INSERT the heights into location_elevations_sampled, and
  // re-fire the layer queries by mutating the SQL string slightly so
  // useSql's cache key changes.
  useEffect(() => {
    let pendingTerrainSamples: LocationToSample[] = [];
    let phase1LocationsSql = '';
    let phase1SamplesSql = '';

    return roomStore.subscribe((state: RoomState) => {
      // ── Phase 1 ─────────────────────────────────────────────────────────
      if (state.room.isDataAvailable && !initRanRef.current) {
        initRanRef.current = true;

        const {connector} = state.db;
        const {addLayer} = state.cesium;

        initEntityLayers(connector)
          .then((result) => {
            const {
              hasGeoid,
              elevationColumns,
              locationsSql,
              samplesSql,
              locationsNeedingTerrain,
            } = result;
            console.log(
              `[init] hasGeoid=${hasGeoid} elevationColumns=[${elevationColumns.join(
                ',',
              )}] needTerrain=${locationsNeedingTerrain.length}`,
            );
            phase1LocationsSql = locationsSql;
            phase1SamplesSql = samplesSql;
            pendingTerrainSamples = locationsNeedingTerrain;

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
            // Invalidate useSql cache by appending a unique comment.
            // The semantics are unchanged but the SQL string differs,
            // so CesiumEntityLayer's useSql call refetches.
            const stamp = `-- terrain-sampled at ${Date.now()}\n`;
            updateLayer('locations', {sqlQuery: stamp + phase1LocationsSql});
            updateLayer('subsurface-samples', {
              sqlQuery: stamp + phase1SamplesSql,
            });
          })
          .catch((e) => console.error('[init] terrain sampling failed:', e));
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
