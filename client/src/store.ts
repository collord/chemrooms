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
  LayoutTypes,
} from '@sqlrooms/room-shell';
import {
  createCesiumSlice,
  type CesiumSliceState,
  createDefaultCesiumConfig,
  CesiumPanel,
} from '@sqlrooms/cesium';
import {createMosaicSlice} from '@sqlrooms/mosaic';
import type {MosaicSliceState} from '@sqlrooms/mosaic/dist/MosaicSlice';
import {createWasmDuckDbConnector} from '@sqlrooms/duckdb';
import {
  createSqlEditorSlice,
  type SqlEditorSliceState,
} from '@sqlrooms/sql-editor';
import {Globe, SlidersHorizontalIcon, ChartLineIcon} from 'lucide-react';

import {
  createChemroomsSlice,
  type ChemroomsSliceState,
} from './slices/chemrooms-slice';
import {SidebarPanel} from './components/SidebarPanel';
import {TimeSeriesPanel} from './components/TimeSeriesPanel';

// ---------------------------------------------------------------------------
// Combined state type
// ---------------------------------------------------------------------------

export type RoomState = RoomShellSliceState &
  CesiumSliceState &
  ChemroomsSliceState &
  MosaicSliceState &
  SqlEditorSliceState;

// ---------------------------------------------------------------------------
// Cesium configuration: location points layer
// ---------------------------------------------------------------------------

const cesiumConfig = createDefaultCesiumConfig();
const cesiumConfigWithLayers = {
  ...cesiumConfig,
  cesium: {
    ...cesiumConfig.cesium,
    showTimeline: false,
    showAnimation: false,
    depthTestAgainstTerrain: false,
    layers: [
      {
        id: 'locations',
        type: 'sql-entities' as const,
        visible: true,
        tableName: 'locations',
        heightReference: 'RELATIVE_TO_GROUND' as const,
        sqlQuery: `
          SELECT
            location_id,
            x AS longitude,
            y AS latitude,
            10 AS altitude,
            loc_type,
            COALESCE(loc_desc, location_id) AS label
          FROM locations
        `,
        columnMapping: {
          longitude: 'longitude',
          latitude: 'latitude',
          altitude: 'altitude',
          label: 'label',
        },
      },
      {
        id: 'subsurface-samples',
        type: 'sql-entities' as const,
        visible: false,
        tableName: 'samples',
        heightReference: 'RELATIVE_TO_GROUND' as const,
        sqlQuery: `
          SELECT
            s.sample_id AS location_id,
            l.x AS longitude,
            l.y AS latitude,
            -(COALESCE(s.depth, 0) * 0.3048) AS altitude,
            s.matrix AS loc_type,
            s.sample_id || ' (' || ROUND(s.depth, 1) || ' ft)' AS label
          FROM samples s
          JOIN locations l ON l.location_id = s.location_id
          WHERE s.depth IS NOT NULL
        `,
        columnMapping: {
          longitude: 'longitude',
          latitude: 'latitude',
          altitude: 'altitude',
          label: 'label',
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Data source URL — points to parquet exports of ChemDuck tables
// ---------------------------------------------------------------------------

const DATA_BASE_URL =
  import.meta.env.VITE_DATA_URL ?? 'http://localhost:8000/data';

// ---------------------------------------------------------------------------
// Create store
// ---------------------------------------------------------------------------

const connector = createWasmDuckDbConnector();

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
        ],
      },
      layout: {
        config: {
          type: LayoutTypes.enum.mosaic,
          nodes: {
            direction: 'row',
            first: 'sidebar',
            second: {
              direction: 'column',
              first: MAIN_VIEW,
              second: 'timeseries',
              splitPercentage: 60,
            },
            splitPercentage: 22,
          },
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
