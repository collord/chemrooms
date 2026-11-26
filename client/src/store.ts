/**
 * Chemrooms room store.
 *
 * Composes: room-shell, cesium, mosaic, sql-editor, and the chemrooms slice.
 * Data is loaded from a URL pointing to exported parquet files from a
 * ChemDuck database (locations, samples, results, screening_levels).
 */

import {
  createRoomStore,
  createRoomShellSlice,
  type RoomShellSliceState,
  MAIN_VIEW,
} from '@sqlrooms/room-shell';
import {
  createCesiumSlice,
  type CesiumSliceState,
  createDefaultCesiumConfig,
  CesiumPanel,
} from './cesium';
import {createMosaicSlice} from '@sqlrooms/mosaic';
import type {MosaicSliceState} from '@sqlrooms/mosaic/dist/MosaicSlice';
import {createWasmDuckDbConnector} from '@sqlrooms/duckdb';
import {
  createSqlEditorSlice,
  type SqlEditorSliceState,
} from '@sqlrooms/sql-editor';
import {
  Globe,
  SlidersHorizontalIcon,
  ChartLineIcon,
  SearchIcon,
} from 'lucide-react';

import {
  createChemroomsSlice,
  type ChemroomsSliceState,
} from './slices/chemrooms-slice';
import {SidebarPanel} from './components/SidebarPanel';
import {TimeSeriesPanel} from './components/TimeSeriesPanel';
import {InspectorPanel} from './components/InspectorPanel';
import {registerSpatialProbeGlobal} from './dev/probeSpatial';
import {registerQueryTimerGlobal} from './dev/queryTimer';

// ---------------------------------------------------------------------------
// Combined state type
// ---------------------------------------------------------------------------

export type RoomState = RoomShellSliceState &
  CesiumSliceState &
  ChemroomsSliceState &
  MosaicSliceState &
  SqlEditorSliceState;

// ---------------------------------------------------------------------------
// Cesium configuration
//
// The chemrooms entity layers (locations, subsurface-samples) are added
// at runtime by setup/initEntityLayers.ts after the parquet data has
// loaded. This lets us:
//   - Detect available elevation columns via information_schema
//   - Load the optional geoid grid and register the geoid_offset macro
//   - Build SQL that produces correct ellipsoidal altitudes from NAVD88
// We start with no entity layers so we don't see a flash of misplaced
// points before that setup runs.
// ---------------------------------------------------------------------------

const cesiumConfig = createDefaultCesiumConfig();
const cesiumConfigWithLayers = {
  ...cesiumConfig,
  cesium: {
    ...cesiumConfig.cesium,
    showTimeline: false,
    showAnimation: false,
    depthTestAgainstTerrain: false,
    layers: [],
  },
};

// ---------------------------------------------------------------------------
// Data source URL — points to parquet exports of ChemDuck tables
// ---------------------------------------------------------------------------

import {
  ARII_MANIFEST_URL,
  DATA_BASE_URL,
  PROJECT_SOURCE,
  SIDECAR_TABLES,
  dataUrl,
} from './config';
export {DATA_BASE_URL};

/** A parquet file in the data folder loaded as a table (downloaded whole). */
const parquetTable = (tableName: string) => ({
  tableName,
  type: 'url' as const,
  url: dataUrl(`${tableName}.parquet`),
});

/**
 * Tables SQLRooms loads before init runs. The ChemDuck tables a project
 * does not ship are created empty by the bootstrap SQL at init.
 *
 * - ChemDuck project: every table is a parquet file, results included.
 * - ARII project: only the small sidecars. `results` is a view over the
 *   remote partitions, created at init (setup/ariiSource.ts), because a
 *   url data source would download the whole facility into a table.
 *   The optional sidecars are loaded only where sidecars.json lists them
 *   (SIDECAR_TABLES), because a url source for a missing file fails the
 *   room's whole load:
 *     - analyte_catalog, location_analytes: chemrooms' catalogs
 *       (src/sql/chemrooms_catalogs.sql), materialized by
 *       server/publish_arii.py into a `chemrooms/` folder;
 *     - analyte_summary: ChemDuck's catalogue, in every ChemDuck publish,
 *       including the pipeline's `chemduck/` folder. Without
 *       chemrooms' own catalogs, analyte_catalog is made from it at init.
 */
const OPTIONAL_ARII_SIDECARS = ['analyte_catalog', 'location_analytes', 'analyte_summary'];

const DATA_SOURCES = !PROJECT_SOURCE
  ? [] // no project: the connect screen is shown and nothing loads
  : ARII_MANIFEST_URL
  ? [
      'locations',
      'samples',
      'aggregation_rules',
      ...OPTIONAL_ARII_SIDECARS.filter((t) => SIDECAR_TABLES?.includes(t)),
    ].map(parquetTable)
  : [
      'locations',
      'samples',
      'results',
      'screening_levels',
      // Canonical catalog of aggregation rule names and labels. Drives the
      // UI dropdowns (event_agg, dup_agg, nd_method) without hardcoding the
      // rule names in TypeScript.
      'aggregation_rules',
      'unit_conversions',
      'downhole_survey',
    ].map(parquetTable);

// ---------------------------------------------------------------------------
// Create store
// ---------------------------------------------------------------------------

// HTTP range reads, explicitly. With DuckDB-WASM 1.32's defaults a file
// registered by URL (an ARII partition, setup/ariiSource.ts) is downloaded
// whole on first open: measured 2026-10-16 in Chrome against a Range-capable
// server, one partition's footer plus one analyte cost 1 request and
// 26.6 MiB with the defaults, 8 requests and 0.18 MiB with this. Full reads
// stay allowed as a fallback for a server without Range support, which
// will then be slow rather than broken. url data sources are unaffected:
// SQLRooms downloads those itself and registers the bytes.
const connector = createWasmDuckDbConnector({
  filesystem: {
    reliableHeadRequests: false,
    allowFullHTTPReads: true,
    forceFullHTTPReads: false,
  },
});

// Dev-only: expose a global `window.__chemroomsProbeSpatial()` for
// diagnosing whether the spatial extension loads in the current
// DuckDB-WASM bundle. No-op in production builds.
registerSpatialProbeGlobal(() => connector);
// Dev-only: `window.__chemroomsQuery(sql, runs)` times SQL on this connector.
registerQueryTimerGlobal(() => connector);

export const {roomStore, useRoomStore} = createRoomStore<RoomState>(
  (set, get, store) => ({
    // Base room shell (layout, data sources, DuckDB)
    ...createRoomShellSlice({
      connector,
      config: {
        title: 'Chemrooms',
        dataSources: DATA_SOURCES,
      },
      layout: {
        // SQLRooms 0.29 layout tree: split nodes with sized children.
        // Sizes match the old splitPercentage values (22 | 75 of rest | 60).
        // Each leaf must name its panel in `panel`: 0.29 resolves the
        // component from that field only, never from `id`, and a leaf
        // without it renders as an empty container.
        config: {
          type: 'split',
          id: 'root',
          direction: 'row',
          children: [
            {type: 'panel', id: 'sidebar', panel: 'sidebar', defaultSize: '22%'},
            {
              type: 'split',
              id: 'content',
              direction: 'row',
              defaultSize: '78%',
              children: [
                {
                  type: 'split',
                  id: 'map-and-chart',
                  direction: 'column',
                  defaultSize: '75%',
                  children: [
                    {type: 'panel', id: MAIN_VIEW, panel: MAIN_VIEW, defaultSize: '60%'},
                    {type: 'panel', id: 'timeseries', panel: 'timeseries', defaultSize: '40%'},
                  ],
                },
                {type: 'panel', id: 'inspector', panel: 'inspector', defaultSize: '25%'},
              ],
            },
          ],
        },
        panels: {
          sidebar: {
            title: 'Controls',
            icon: SlidersHorizontalIcon,
            component: SidebarPanel,
            placement: 'sidebar',
          },
          [MAIN_VIEW]: {
            title: '3D Globe',
            icon: Globe,
            component: CesiumPanel,
            placement: 'main',
          },
          timeseries: {
            title: 'Time Series',
            icon: ChartLineIcon,
            component: TimeSeriesPanel,
            placement: 'main',
          },
          inspector: {
            title: 'Inspector',
            icon: SearchIcon,
            component: InspectorPanel,
            placement: 'main',
          },
        },
      },
    })(set, get, store),

    // Cesium 3D globe
    ...createCesiumSlice(cesiumConfigWithLayers)(set, get, store),

    // Mosaic for interactive charts
    ...createMosaicSlice()(set, get, store),

    // SQL editor modal
    ...createSqlEditorSlice()(set, get, store),

    // Chemrooms domain state
    ...createChemroomsSlice()(set, get, store),
  }),
);
