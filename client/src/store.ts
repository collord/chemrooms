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

import {DATA_BASE_URL} from './config';
export {DATA_BASE_URL};

// ---------------------------------------------------------------------------
// Create store
// ---------------------------------------------------------------------------

const connector = createWasmDuckDbConnector();

// Dev-only: expose a global `window.__chemroomsProbeSpatial()` for
// diagnosing whether the spatial extension loads in the current
// DuckDB-WASM bundle. No-op in production builds.
registerSpatialProbeGlobal(() => connector);

export const {roomStore, useRoomStore} = createRoomStore<RoomState>(
  (set, get, store) => ({
    // Base room shell (layout, data sources, DuckDB)
    ...createRoomShellSlice({
      connector,
      config: {
        title: 'Chemrooms',
        dataSources: [
          {
            tableName: 'locations',
            type: 'url',
            url: `${DATA_BASE_URL}/locations.parquet`,
          },
          {
            tableName: 'samples',
            type: 'url',
            url: `${DATA_BASE_URL}/samples.parquet`,
          },
          {
            tableName: 'results',
            type: 'url',
            url: `${DATA_BASE_URL}/results.parquet`,
          },
          {
            tableName: 'screening_levels',
            type: 'url',
            url: `${DATA_BASE_URL}/screening_levels.parquet`,
          },
          {
            // Canonical catalog of aggregation rule names and labels.
            // Drives the UI dropdowns (event_agg, dup_agg, nd_method)
            // without hardcoding the rule names in TypeScript.
            tableName: 'aggregation_rules',
            type: 'url',
            url: `${DATA_BASE_URL}/aggregation_rules.parquet`,
          },
          {
            tableName: 'unit_conversions',
            type: 'url',
            url: `${DATA_BASE_URL}/unit_conversions.parquet`,
          },
          {
            tableName: 'downhole_survey',
            type: 'url',
            url: `${DATA_BASE_URL}/downhole_survey.parquet`,
          },
        ],
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
