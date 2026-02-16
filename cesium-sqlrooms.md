# Cesium + Resium Integration for SQLRooms

> A detailed implementation guide for an AI coding assistant to generate a `@sqlrooms/cesium` feature package that integrates CesiumJS (via Resium) into the SQLRooms framework, including full clock/datetime support.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites & Dependencies](#2-prerequisites--dependencies)
3. [Package Structure](#3-package-structure)
4. [Zod Config Schema](#4-zod-config-schema)
5. [Zustand Slice](#5-zustand-slice)
6. [React Components](#6-react-components)
7. [DuckDB → Cesium Data Bridge](#7-duckdb--cesium-data-bridge)
8. [Clock/DateTime Integration](#8-clockdatetime-integration)
9. [Store Registration & Panel Wiring](#9-store-registration--panel-wiring)
10. [Vite Build Configuration](#10-vite-build-configuration)
11. [Full Working Example App](#11-full-working-example-app)
12. [Key Patterns & Pitfalls](#12-key-patterns--pitfalls)

---

## 1. Architecture Overview

SQLRooms uses a **slice + panel** architecture:

- **Slice**: A Zustand state creator function that returns namespaced state + actions. Created via the pattern `(set, get, store) => ({...})`.
- **Panel**: A React component registered with the layout system via an ID, title, icon, and placement (`'main'` or `'sidebar'`).
- **Layout**: A mosaic tree (from `react-mosaic`) defining how panels are arranged. Panels are leaf nodes identified by string keys.
- **Config vs Runtime State**: Config state is persisted (serializable, validated by Zod). Runtime state is transient (viewer instances, animation state).

For Cesium, the integration layers are:

```
┌──────────────────────────────────────────────┐
│  SQLRooms Room Store (Zustand)               │
│  ┌────────────────────────────────────────┐  │
│  │  cesium slice                          │  │
│  │  ├─ config (persisted via Zod)         │  │
│  │  │  ├─ camera position/orientation     │  │
│  │  │  ├─ terrain/imagery settings        │  │
│  │  │  ├─ clock config (start/stop/mult)  │  │
│  │  │  └─ layer visibility flags          │  │
│  │  ├─ runtime (transient)                │  │
│  │  │  ├─ viewer ref                      │  │
│  │  │  ├─ currentTime (JulianDate)        │  │
│  │  │  ├─ isAnimating                     │  │
│  │  │  └─ selectedEntity                  │  │
│  │  └─ actions                            │  │
│  │     ├─ setViewer / flyTo / zoomToFit   │  │
│  │     ├─ setClockConfig / toggleAnimate  │  │
│  │     └─ loadGeoJsonLayer / addEntities  │  │
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │  DuckDB slice (built-in)               │  │
│  │  └─ tables, queries, useSql()          │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
         │                        ▲
         │ SQL query results      │ camera/clock state sync
         ▼                        │
┌──────────────────────────────────────────────┐
│  CesiumPanel (React component)               │
│  ├─ <Viewer> (Resium)                        │
│  │  ├─ <Clock> (Resium)                      │
│  │  ├─ <Entity> per data row                 │
│  │  ├─ <GeoJsonDataSource>                   │
│  │  └─ <CzmlDataSource>                      │
│  └─ <CesiumToolbar> (custom controls)        │
└──────────────────────────────────────────────┘
```

### Analogous Existing Packages to Reference

| Package | Pattern | Relevance |
|---------|---------|-----------|
| `@sqlrooms/cosmos` | `createCosmosSlice` + `CosmosGraph` component, WebGL canvas lifecycle in React | Closest structural analog — imperative WebGL API wrapped in React |
| `@sqlrooms/kepler` | `createKeplerSlice` + geospatial data flow from DuckDB → map layers | Closest domain analog — geospatial data pipeline |
| `@sqlrooms/vega` | Chart rendering from SQL query results | Data bridge pattern (SQL → visualization) |

---

## 2. Prerequisites & Dependencies

```json
{
  "dependencies": {
    "cesium": "^1.124.0",
    "resium": "^1.18.0",
    "@sqlrooms/room-store": "latest",
    "@sqlrooms/room-shell": "latest",
    "@sqlrooms/duckdb": "latest",
    "@sqlrooms/layout": "latest",
    "@sqlrooms/ui": "latest",
    "zod": "^3.23.0",
    "zustand": "^5.0.0",
    "react": "^18.0.0 || ^19.0.0"
  },
  "devDependencies": {
    "vite-plugin-cesium": "^1.2.0"
  }
}
```

**Important**: Cesium requires static assets (workers, imagery tiles, etc.) served at a known base URL. The Vite plugin handles this — see [Section 10](#10-vite-build-configuration).

---

## 3. Package Structure

```
packages/cesium/
├── src/
│   ├── index.ts                    # Public API exports
│   ├── cesium-slice.ts             # createCesiumSlice, types, actions
│   ├── cesium-config.ts            # Zod schemas, createDefaultCesiumConfig()
│   ├── cesium-types.ts             # CesiumSliceState, CesiumSliceConfig types
│   ├── components/
│   │   ├── CesiumPanel.tsx         # Main panel component (registers with layout)
│   │   ├── CesiumViewerWrapper.tsx # Resium <Viewer> with ref management
│   │   ├── CesiumClock.tsx         # Clock/timeline controls
│   │   ├── CesiumToolbar.tsx       # Camera controls, layer toggles
│   │   ├── CesiumEntityLayer.tsx   # Renders entities from SQL query data
│   │   └── CesiumDataSourceLayer.tsx # GeoJSON/CZML data source wrapper
│   └── hooks/
│       ├── useCesiumViewer.ts      # Access viewer instance from store
│       ├── useSqlToCesiumEntities.ts # Convert SQL results → Entity[]
│       └── useClockSync.ts         # Sync Cesium clock ↔ Zustand state
├── package.json
└── tsconfig.json
```

---

## 4. Zod Config Schema

The config schema defines **persistable** state. Only include serializable values — no class instances, no refs.

```typescript
// cesium-config.ts
import {z} from 'zod';

/**
 * Camera position in cartographic coordinates (serializable).
 */
const CameraPosition = z.object({
  longitude: z.number().default(-98.5795),   // degrees
  latitude: z.number().default(39.8283),     // degrees
  height: z.number().default(15000000),      // meters
  heading: z.number().default(0),            // radians
  pitch: z.number().default(-Math.PI / 2),   // radians (looking down)
  roll: z.number().default(0),
});

/**
 * Clock configuration for time-dynamic data.
 * Stored as ISO 8601 strings for serialization.
 */
const ClockConfig = z.object({
  startTime: z.string().optional(),          // ISO 8601
  stopTime: z.string().optional(),           // ISO 8601
  currentTime: z.string().optional(),        // ISO 8601
  multiplier: z.number().default(1),
  shouldAnimate: z.boolean().default(false),
  clockRange: z.enum(['UNBOUNDED', 'CLAMPED', 'LOOP_STOP']).default('LOOP_STOP'),
});

/**
 * A layer definition that can be persisted.
 */
const CesiumLayerConfig = z.object({
  id: z.string(),
  type: z.enum(['geojson', 'czml', 'sql-entities', 'tileset']),
  visible: z.boolean().default(true),
  /** For 'sql-entities': the SQL query whose results become entities */
  sqlQuery: z.string().optional(),
  /** Column mappings for sql-entities layers */
  columnMapping: z.object({
    longitude: z.string().default('longitude'),
    latitude: z.string().default('latitude'),
    altitude: z.string().optional(),
    time: z.string().optional(),               // column for time-dynamic positioning
    label: z.string().optional(),
    color: z.string().optional(),
    size: z.string().optional(),
  }).optional(),
  /** For 'geojson'/'czml': URL or inline data reference */
  dataUrl: z.string().optional(),
  /** For '3dtiles' */
  tilesetUrl: z.string().optional(),
});

/**
 * Top-level Cesium slice configuration (persisted).
 */
export const CesiumSliceConfig = z.object({
  cesium: z.object({
    camera: CameraPosition.default({}),
    clock: ClockConfig.default({}),
    layers: z.array(CesiumLayerConfig).default([]),
    terrain: z.boolean().default(true),
    sceneMode: z.enum(['SCENE3D', 'SCENE2D', 'COLUMBUS_VIEW']).default('SCENE3D'),
    showTimeline: z.boolean().default(true),
    showAnimation: z.boolean().default(true),
    baseLayerImagery: z.enum([
      'ion-default',
      'openstreetmap',
      'none',
    ]).default('ion-default'),
  }).default({}),
});

export type CesiumSliceConfig = z.infer<typeof CesiumSliceConfig>;
export type CameraPosition = z.infer<typeof CameraPosition>;
export type ClockConfig = z.infer<typeof ClockConfig>;
export type CesiumLayerConfig = z.infer<typeof CesiumLayerConfig>;

/**
 * Factory for default config.
 */
export function createDefaultCesiumConfig(): CesiumSliceConfig {
  return CesiumSliceConfig.parse({});
}
```

---

## 5. Zustand Slice

Follow the SQLRooms slice pattern: a function that accepts config and returns a `StateCreator`-compatible function `(set, get, store) => ({...})`.

```typescript
// cesium-slice.ts
import {type StateCreator} from 'zustand';
import {
  CesiumSliceConfig,
  CameraPosition,
  ClockConfig,
  CesiumLayerConfig,
  createDefaultCesiumConfig,
} from './cesium-config';
import type {Viewer as CesiumViewer, Entity} from 'cesium';

/**
 * Runtime (non-persisted) state for the Cesium viewer.
 */
export interface CesiumRuntimeState {
  /** The Cesium Viewer instance — set after mount, null before/after */
  viewer: CesiumViewer | null;
  /** Whether the clock is currently animating */
  isAnimating: boolean;
  /** Currently selected entity */
  selectedEntity: Entity | null;
  /** Loading state for data sources */
  isLoadingData: boolean;
}

/**
 * Combined slice state exposed under `state.cesium`.
 */
export interface CesiumSliceState {
  cesium: {
    config: CesiumSliceConfig['cesium'];
    // Runtime state
    viewer: CesiumViewer | null;
    isAnimating: boolean;
    selectedEntity: Entity | null;
    isLoadingData: boolean;
    // Actions
    setViewer: (viewer: CesiumViewer | null) => void;
    setCameraPosition: (camera: Partial<CameraPosition>) => void;
    saveCameraPosition: () => void;
    flyTo: (longitude: number, latitude: number, height?: number) => void;
    zoomToFit: () => void;
    setClockConfig: (clock: Partial<ClockConfig>) => void;
    toggleAnimation: () => void;
    setCurrentTime: (isoString: string) => void;
    addLayer: (layer: CesiumLayerConfig) => void;
    removeLayer: (id: string) => void;
    updateLayer: (id: string, updates: Partial<CesiumLayerConfig>) => void;
    toggleLayerVisibility: (id: string) => void;
    setSelectedEntity: (entity: Entity | null) => void;
    setIsLoadingData: (loading: boolean) => void;
  };
}

/**
 * Creates the Cesium Zustand slice.
 *
 * Usage in store:
 * ```ts
 * ...createCesiumSlice(createDefaultCesiumConfig())(set, get, store)
 * ```
 */
export function createCesiumSlice(
  initialConfig?: CesiumSliceConfig,
) {
  const config = initialConfig?.cesium ?? createDefaultCesiumConfig().cesium;

  return (
    set: (fn: (state: any) => any) => void,
    get: () => any,
    store: any,
  ) => ({
    cesium: {
      config,
      viewer: null,
      isAnimating: config.clock.shouldAnimate,
      selectedEntity: null,
      isLoadingData: false,

      setViewer: (viewer: CesiumViewer | null) =>
        set((state: any) => ({
          cesium: {...state.cesium, viewer},
        })),

      setCameraPosition: (camera: Partial<CameraPosition>) =>
        set((state: any) => ({
          cesium: {
            ...state.cesium,
            config: {
              ...state.cesium.config,
              camera: {...state.cesium.config.camera, ...camera},
            },
          },
        })),

      /**
       * Read current camera position from the viewer and persist to config.
       * Call this on camera move end events.
       */
      saveCameraPosition: () => {
        const viewer = get().cesium.viewer;
        if (!viewer) return;
        const camera = viewer.camera;
        const carto = camera.positionCartographic;
        // Import Cesium's Math for toDegrees
        const {Math: CesiumMath} = require('cesium');
        set((state: any) => ({
          cesium: {
            ...state.cesium,
            config: {
              ...state.cesium.config,
              camera: {
                longitude: CesiumMath.toDegrees(carto.longitude),
                latitude: CesiumMath.toDegrees(carto.latitude),
                height: carto.height,
                heading: camera.heading,
                pitch: camera.pitch,
                roll: camera.roll,
              },
            },
          },
        }));
      },

      flyTo: (longitude: number, latitude: number, height = 1000000) => {
        const viewer = get().cesium.viewer;
        if (!viewer) return;
        const {Cartesian3} = require('cesium');
        viewer.camera.flyTo({
          destination: Cartesian3.fromDegrees(longitude, latitude, height),
        });
      },

      zoomToFit: () => {
        const viewer = get().cesium.viewer;
        if (!viewer) return;
        viewer.zoomTo(viewer.entities);
      },

      setClockConfig: (clock: Partial<ClockConfig>) =>
        set((state: any) => ({
          cesium: {
            ...state.cesium,
            config: {
              ...state.cesium.config,
              clock: {...state.cesium.config.clock, ...clock},
            },
          },
        })),

      toggleAnimation: () =>
        set((state: any) => {
          const next = !state.cesium.isAnimating;
          // Also update the config so it persists
          return {
            cesium: {
              ...state.cesium,
              isAnimating: next,
              config: {
                ...state.cesium.config,
                clock: {
                  ...state.cesium.config.clock,
                  shouldAnimate: next,
                },
              },
            },
          };
        }),

      setCurrentTime: (isoString: string) =>
        set((state: any) => ({
          cesium: {
            ...state.cesium,
            config: {
              ...state.cesium.config,
              clock: {...state.cesium.config.clock, currentTime: isoString},
            },
          },
        })),

      addLayer: (layer: CesiumLayerConfig) =>
        set((state: any) => ({
          cesium: {
            ...state.cesium,
            config: {
              ...state.cesium.config,
              layers: [...state.cesium.config.layers, layer],
            },
          },
        })),

      removeLayer: (id: string) =>
        set((state: any) => ({
          cesium: {
            ...state.cesium,
            config: {
              ...state.cesium.config,
              layers: state.cesium.config.layers.filter(
                (l: CesiumLayerConfig) => l.id !== id,
              ),
            },
          },
        })),

      updateLayer: (id: string, updates: Partial<CesiumLayerConfig>) =>
        set((state: any) => ({
          cesium: {
            ...state.cesium,
            config: {
              ...state.cesium.config,
              layers: state.cesium.config.layers.map(
                (l: CesiumLayerConfig) =>
                  l.id === id ? {...l, ...updates} : l,
              ),
            },
          },
        })),

      toggleLayerVisibility: (id: string) =>
        set((state: any) => ({
          cesium: {
            ...state.cesium,
            config: {
              ...state.cesium.config,
              layers: state.cesium.config.layers.map(
                (l: CesiumLayerConfig) =>
                  l.id === id ? {...l, visible: !l.visible} : l,
              ),
            },
          },
        })),

      setSelectedEntity: (entity: Entity | null) =>
        set((state: any) => ({
          cesium: {...state.cesium, selectedEntity: entity},
        })),

      setIsLoadingData: (loading: boolean) =>
        set((state: any) => ({
          cesium: {...state.cesium, isLoadingData: loading},
        })),
    },
  });
}
```

---

## 6. React Components

### 6.1 CesiumPanel — The Layout Panel

This is the component registered with the SQLRooms layout system.

```typescript
// components/CesiumPanel.tsx
import React from 'react';
import {CesiumViewerWrapper} from './CesiumViewerWrapper';
import {CesiumToolbar} from './CesiumToolbar';

/**
 * Top-level panel component registered with SQLRooms layout.
 * Must fill its parent container (the mosaic tile).
 */
export const CesiumPanel: React.FC = () => {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <CesiumViewerWrapper />
      <CesiumToolbar className="absolute right-2 top-2 z-10" />
    </div>
  );
};
```

### 6.2 CesiumViewerWrapper — Resium Viewer with Store Sync

**Critical pattern**: Resium's `<Viewer>` is the root. Access the viewer instance via `ref` using `CesiumComponentRef<CesiumViewer>`. Store the instance in Zustand on mount, null it on unmount.

```typescript
// components/CesiumViewerWrapper.tsx
import React, {useRef, useEffect, useCallback, useMemo} from 'react';
import {
  Viewer,
  Clock,
  Entity,
  GeoJsonDataSource,
  CzmlDataSource,
  CesiumComponentRef,
  Globe,
} from 'resium';
import {
  Viewer as CesiumViewer,
  Cartesian3,
  JulianDate,
  ClockRange as CesiumClockRange,
  Math as CesiumMath,
  SceneMode,
  Ion,
  Terrain,
  createWorldTerrainAsync,
} from 'cesium';
import {useRoomStore} from '../../store'; // <-- adjust import to your app's store
import {CesiumEntityLayer} from './CesiumEntityLayer';
import {useClockSync} from '../hooks/useClockSync';

// Set your Cesium Ion access token
// Ion.defaultAccessToken = 'YOUR_TOKEN_HERE';

const CLOCK_RANGE_MAP = {
  UNBOUNDED: CesiumClockRange.UNBOUNDED,
  CLAMPED: CesiumClockRange.CLAMPED,
  LOOP_STOP: CesiumClockRange.LOOP_STOP,
} as const;

const SCENE_MODE_MAP = {
  SCENE3D: SceneMode.SCENE3D,
  SCENE2D: SceneMode.SCENE2D,
  COLUMBUS_VIEW: SceneMode.COLUMBUS_VIEW,
} as const;

export const CesiumViewerWrapper: React.FC = () => {
  const viewerRef = useRef<CesiumComponentRef<CesiumViewer>>(null);

  // --- Selectors (granular to minimize re-renders) ---
  const setViewer = useRoomStore((s) => s.cesium.setViewer);
  const saveCameraPosition = useRoomStore((s) => s.cesium.saveCameraPosition);
  const cameraConfig = useRoomStore((s) => s.cesium.config.camera);
  const clockConfig = useRoomStore((s) => s.cesium.config.clock);
  const sceneMode = useRoomStore((s) => s.cesium.config.sceneMode);
  const showTimeline = useRoomStore((s) => s.cesium.config.showTimeline);
  const showAnimation = useRoomStore((s) => s.cesium.config.showAnimation);
  const useTerrain = useRoomStore((s) => s.cesium.config.terrain);
  const layers = useRoomStore((s) => s.cesium.config.layers);

  // --- Register/unregister viewer instance ---
  useEffect(() => {
    const viewer = viewerRef.current?.cesiumElement;
    if (viewer) {
      setViewer(viewer);

      // Set initial camera from persisted config
      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(
          cameraConfig.longitude,
          cameraConfig.latitude,
          cameraConfig.height,
        ),
        orientation: {
          heading: cameraConfig.heading,
          pitch: cameraConfig.pitch,
          roll: cameraConfig.roll,
        },
      });

      // Save camera position when user finishes moving
      viewer.camera.moveEnd.addEventListener(saveCameraPosition);
    }

    return () => {
      if (viewer && !viewer.isDestroyed()) {
        viewer.camera.moveEnd.removeEventListener(saveCameraPosition);
      }
      setViewer(null);
    };
    // Only run on mount/unmount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Clock sync hook ---
  useClockSync();

  // --- Compute initial clock values ---
  const initialClockProps = useMemo(() => {
    const props: Record<string, any> = {
      shouldAnimate: clockConfig.shouldAnimate,
      multiplier: clockConfig.multiplier,
      clockRange: CLOCK_RANGE_MAP[clockConfig.clockRange],
    };
    if (clockConfig.startTime) {
      props.startTime = JulianDate.fromIso8601(clockConfig.startTime);
    }
    if (clockConfig.stopTime) {
      props.stopTime = JulianDate.fromIso8601(clockConfig.stopTime);
    }
    if (clockConfig.currentTime) {
      props.currentTime = JulianDate.fromIso8601(clockConfig.currentTime);
    }
    return props;
  }, [clockConfig]);

  return (
    <Viewer
      ref={viewerRef}
      full
      timeline={showTimeline}
      animation={showAnimation}
      sceneMode={SCENE_MODE_MAP[sceneMode]}
      // Disable default UI elements you don't need:
      baseLayerPicker={false}
      geocoder={false}
      homeButton={false}
      navigationHelpButton={false}
      sceneModePicker={false}
    >
      {/* Clock configuration */}
      <Clock {...initialClockProps} />

      {/* Terrain */}
      {useTerrain && <Globe enableLighting />}

      {/* Render configured layers */}
      {layers.map((layer) => {
        if (!layer.visible) return null;

        switch (layer.type) {
          case 'geojson':
            return (
              <GeoJsonDataSource
                key={layer.id}
                data={layer.dataUrl}
                show={layer.visible}
                clampToGround
              />
            );

          case 'czml':
            return (
              <CzmlDataSource
                key={layer.id}
                data={layer.dataUrl}
                show={layer.visible}
              />
            );

          case 'sql-entities':
            return (
              <CesiumEntityLayer
                key={layer.id}
                layerConfig={layer}
              />
            );

          default:
            return null;
        }
      })}
    </Viewer>
  );
};
```

### 6.3 CesiumEntityLayer — SQL Query Results → Entities

This component uses `useSql` from `@sqlrooms/duckdb` to query DuckDB and render results as Cesium entities.

```typescript
// components/CesiumEntityLayer.tsx
import React, {useMemo} from 'react';
import {Entity, PointGraphics} from 'resium';
import {Cartesian3, JulianDate, SampledPositionProperty, Color} from 'cesium';
import {useSql} from '@sqlrooms/duckdb';
import type {CesiumLayerConfig} from '../cesium-config';

interface Props {
  layerConfig: CesiumLayerConfig;
}

/**
 * Executes a SQL query and renders each row as a Cesium Entity.
 *
 * Column mapping determines which columns map to lon/lat/alt/time/label/color.
 */
export const CesiumEntityLayer: React.FC<Props> = ({layerConfig}) => {
  const {sqlQuery, columnMapping} = layerConfig;
  const mapping = columnMapping ?? {longitude: 'longitude', latitude: 'latitude'};

  const {data, isLoading} = useSql<Record<string, any>>({
    query: sqlQuery ?? '',
    enabled: Boolean(sqlQuery),
  });

  const entities = useMemo(() => {
    if (!data) return [];
    const rows = data.toArray();

    return rows.map((row: any, i: number) => {
      const lon = Number(row[mapping.longitude]);
      const lat = Number(row[mapping.latitude]);
      const alt = mapping.altitude ? Number(row[mapping.altitude]) : 0;
      const label = mapping.label ? String(row[mapping.label]) : undefined;

      return {
        id: `${layerConfig.id}-${i}`,
        position: Cartesian3.fromDegrees(lon, lat, alt),
        label,
        // If there's a time column, this entity has time-dynamic data
        time: mapping.time ? row[mapping.time] : undefined,
      };
    });
  }, [data, mapping, layerConfig.id]);

  if (isLoading || !entities.length) return null;

  return (
    <>
      {entities.map((entity) => (
        <Entity
          key={entity.id}
          name={entity.label ?? entity.id}
          position={entity.position}
          description={entity.label}
        >
          <PointGraphics pixelSize={8} color={Color.CYAN} />
        </Entity>
      ))}
    </>
  );
};
```

### 6.4 Time-Dynamic Entity Layer Variant

For entities with a `time` column, use Cesium's `SampledPositionProperty` to create animated trajectories:

```typescript
// hooks/useSqlToCesiumEntities.ts
import {useMemo} from 'react';
import {
  Cartesian3,
  JulianDate,
  SampledPositionProperty,
  Color,
  Entity,
} from 'cesium';
import {useSql} from '@sqlrooms/duckdb';
import type {CesiumLayerConfig} from '../cesium-config';

/**
 * Groups rows by an ID column, builds a SampledPositionProperty
 * per unique entity so it moves over time.
 *
 * SQL query should be ordered by time and include columns:
 *   entity_id, longitude, latitude, altitude?, timestamp
 */
export function useTimeDynamicEntities(layerConfig: CesiumLayerConfig) {
  const {sqlQuery, columnMapping} = layerConfig;
  const mapping = columnMapping ?? {longitude: 'longitude', latitude: 'latitude'};

  const {data, isLoading} = useSql<Record<string, any>>({
    query: sqlQuery ?? '',
    enabled: Boolean(sqlQuery) && Boolean(mapping.time),
  });

  const entityDataMap = useMemo(() => {
    if (!data) return new Map();
    const rows = data.toArray();
    const grouped = new Map<string, SampledPositionProperty>();

    for (const row of rows) {
      const id = String(row.entity_id ?? row.id ?? 'default');
      if (!grouped.has(id)) {
        grouped.set(id, new SampledPositionProperty());
      }
      const sampled = grouped.get(id)!;
      const time = JulianDate.fromIso8601(String(row[mapping.time!]));
      const pos = Cartesian3.fromDegrees(
        Number(row[mapping.longitude]),
        Number(row[mapping.latitude]),
        mapping.altitude ? Number(row[mapping.altitude]) : 0,
      );
      sampled.addSample(time, pos);
    }

    return grouped;
  }, [data, mapping]);

  return {entityDataMap, isLoading};
}
```

---

## 7. DuckDB → Cesium Data Bridge

### Spatial Query Patterns

DuckDB has a spatial extension. Install it in your store initialization:

```typescript
// In your room store setup or an initialize action:
await connector.query(`INSTALL spatial; LOAD spatial;`);
```

Then use spatial functions in layer SQL queries:

```sql
-- Points from a parquet file with lat/lon columns
SELECT latitude, longitude, magnitude AS size, event_time AS timestamp
FROM earthquakes
WHERE magnitude > 4.0
ORDER BY event_time

-- Convert WKT geometry to lat/lon
SELECT
  ST_Y(ST_Centroid(geom)) AS latitude,
  ST_X(ST_Centroid(geom)) AS longitude,
  name AS label
FROM regions

-- GeoJSON export for an entire table
SELECT ST_AsGeoJSON(geom) AS geojson FROM boundaries
```

### GeoJSON Bridge Pattern

For layers that need full GeoJSON (polygons, complex geometries), query DuckDB for GeoJSON and pass it to `<GeoJsonDataSource>`:

```typescript
// hooks/useSqlToGeoJson.ts
import {useSql} from '@sqlrooms/duckdb';

/**
 * Queries DuckDB for GeoJSON features and assembles a FeatureCollection.
 */
export function useSqlToGeoJson(query: string, enabled: boolean) {
  const {data, isLoading, error} = useSql<{geojson: string}>({
    query,
    enabled,
  });

  const featureCollection = useMemo(() => {
    if (!data) return null;
    const features = data.toArray().map((row) => JSON.parse(row.geojson));
    return {
      type: 'FeatureCollection' as const,
      features,
    };
  }, [data]);

  return {featureCollection, isLoading, error};
}
```

---

## 8. Clock/DateTime Integration

### Clock State Sync Hook

This hook keeps the Cesium clock and the Zustand store in sync bidirectionally:

```typescript
// hooks/useClockSync.ts
import {useEffect, useRef} from 'react';
import {JulianDate} from 'cesium';
import {useRoomStore} from '../../store';

/**
 * Bidirectional sync between Cesium's clock and the Zustand cesium slice.
 *
 * - On Cesium clock tick → update store's currentTime (throttled)
 * - On store clock config change → apply to Cesium viewer clock
 */
export function useClockSync() {
  const viewer = useRoomStore((s) => s.cesium.viewer);
  const clockConfig = useRoomStore((s) => s.cesium.config.clock);
  const setCurrentTime = useRoomStore((s) => s.cesium.setCurrentTime);
  const lastSyncRef = useRef(0);

  // Cesium → Store: throttled tick listener
  useEffect(() => {
    if (!viewer) return;

    const onTick = (clock: any) => {
      const now = Date.now();
      // Throttle to max 2 updates/second to avoid flooding Zustand
      if (now - lastSyncRef.current < 500) return;
      lastSyncRef.current = now;
      setCurrentTime(JulianDate.toIso8601(clock.currentTime));
    };

    viewer.clock.onTick.addEventListener(onTick);
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.clock.onTick.removeEventListener(onTick);
      }
    };
  }, [viewer, setCurrentTime]);

  // Store → Cesium: apply config changes
  useEffect(() => {
    if (!viewer) return;
    const clock = viewer.clock;

    if (clockConfig.startTime) {
      clock.startTime = JulianDate.fromIso8601(clockConfig.startTime);
    }
    if (clockConfig.stopTime) {
      clock.stopTime = JulianDate.fromIso8601(clockConfig.stopTime);
    }
    clock.multiplier = clockConfig.multiplier;
    clock.shouldAnimate = clockConfig.shouldAnimate;
  }, [viewer, clockConfig]);
}
```

### Clock Control Component

```typescript
// components/CesiumClock.tsx
import React from 'react';
import {Play, Pause, SkipBack, SkipForward, Clock} from 'lucide-react';
import {Button, Slider, Label} from '@sqlrooms/ui';
import {useRoomStore} from '../../store';

export const CesiumClockControls: React.FC<{className?: string}> = ({
  className,
}) => {
  const isAnimating = useRoomStore((s) => s.cesium.isAnimating);
  const multiplier = useRoomStore((s) => s.cesium.config.clock.multiplier);
  const toggleAnimation = useRoomStore((s) => s.cesium.toggleAnimation);
  const setClockConfig = useRoomStore((s) => s.cesium.setClockConfig);

  return (
    <div className={`flex items-center gap-2 rounded bg-background/80 p-2 backdrop-blur ${className ?? ''}`}>
      <Button size="icon" variant="ghost" onClick={toggleAnimation}>
        {isAnimating ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>

      <Label className="text-xs">Speed: {multiplier}x</Label>
      <Slider
        min={0.1}
        max={100}
        step={0.1}
        value={[multiplier]}
        onValueChange={([v]) => setClockConfig({multiplier: v})}
        className="w-24"
      />
    </div>
  );
};
```

---

## 9. Store Registration & Panel Wiring

### Full Store Setup Example

```typescript
// store.ts
import {
  createRoomShellSlice,
  createRoomStore,
  RoomShellSliceState,
} from '@sqlrooms/room-shell';
import {
  createLayoutSlice,
  LayoutTypes,
} from '@sqlrooms/layout';
import {BaseRoomConfig, LayoutConfig, persistSliceConfigs} from '@sqlrooms/room-shell';
import {GlobeIcon, DatabaseIcon} from 'lucide-react';
import {
  createCesiumSlice,
  CesiumSliceState,
  CesiumSliceConfig,
  createDefaultCesiumConfig,
} from '@sqlrooms/cesium';
import {CesiumPanel} from '@sqlrooms/cesium';
import {FileDataSourcesPanel} from '@sqlrooms/room-shell';

// 1. Define combined state type
export type RoomState = RoomShellSliceState & CesiumSliceState;

// 2. Create the store
export const {roomStore, useRoomStore} = createRoomStore<RoomState>(
  persistSliceConfigs(
    {
      name: 'cesium-app-storage',
      sliceConfigSchemas: {
        room: BaseRoomConfig,
        layout: LayoutConfig,
        cesium: CesiumSliceConfig,  // <-- enables persistence of Cesium config
      },
    },
    (set, get, store) => ({
      ...createRoomShellSlice({
        config: {
          title: 'Cesium 3D Globe',
          dataSources: [
            {
              tableName: 'earthquakes',
              type: 'url',
              url: 'https://example.com/earthquakes.parquet',
            },
          ],
        },
        layout: {
          config: {
            type: LayoutTypes.enum.mosaic,
            nodes: {
              direction: 'row',
              first: 'data-sources',
              second: 'cesium-globe',
              splitPercentage: 25,
            },
          },
          panels: {
            'data-sources': {
              title: 'Data Sources',
              icon: DatabaseIcon,
              component: FileDataSourcesPanel,
              placement: 'sidebar',
            },
            'cesium-globe': {
              title: '3D Globe',
              icon: GlobeIcon,
              component: CesiumPanel,
              placement: 'main',
            },
          },
        },
      })(set, get, store),

      // 3. Spread the Cesium slice
      ...createCesiumSlice(createDefaultCesiumConfig())(set, get, store),
    }),
  ),
);
```

### App Component

```typescript
// App.tsx
import {RoomShell} from '@sqlrooms/room-shell';
import {ThemeProvider} from '@sqlrooms/ui';
import {roomStore} from './store';

export const App = () => (
  <ThemeProvider defaultTheme="dark" storageKey="cesium-app-theme">
    <RoomShell className="h-screen" roomStore={roomStore}>
      <RoomShell.Sidebar />
      <RoomShell.LayoutComposer />
      <RoomShell.LoadingProgress />
    </RoomShell>
  </ThemeProvider>
);
```

---

## 10. Vite Build Configuration

Cesium requires special handling for its static assets (Web Workers, imagery, etc.).

```typescript
// vite.config.ts
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [
    react(),
    cesium(),  // Handles CESIUM_BASE_URL and static asset copying
  ],
  define: {
    // Required for Cesium's build-time feature detection
    CESIUM_BASE_URL: JSON.stringify('/cesium'),
  },
  optimizeDeps: {
    // Cesium is large — pre-bundle it
    include: ['cesium'],
  },
  build: {
    // Cesium's workers need to be chunked properly
    rollupOptions: {
      output: {
        manualChunks: {
          cesium: ['cesium'],
        },
      },
    },
  },
});
```

### Alternative: Manual Setup Without Plugin

If `vite-plugin-cesium` doesn't work for your setup:

```typescript
// vite.config.ts
import {defineConfig} from 'vite';
import {viteStaticCopy} from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/cesium/Build/Cesium/Workers',
          dest: 'cesium',
        },
        {
          src: 'node_modules/cesium/Build/Cesium/Assets',
          dest: 'cesium',
        },
        {
          src: 'node_modules/cesium/Build/Cesium/Widgets',
          dest: 'cesium',
        },
        {
          src: 'node_modules/cesium/Build/Cesium/ThirdParty',
          dest: 'cesium',
        },
      ],
    }),
  ],
  define: {
    CESIUM_BASE_URL: JSON.stringify('/cesium'),
  },
});
```

### Cesium CSS

Import Cesium's widget CSS in your app entry:

```typescript
// main.tsx
import 'cesium/Build/Cesium/Widgets/widgets.css';
```

### Cesium Ion Token

Set the token before any Cesium code runs:

```typescript
// main.tsx or a top-level init file
import {Ion} from 'cesium';
Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN ?? '';
```

---

## 11. Full Working Example App

### Expected File Tree

```
examples/cesium-app/
├── public/
├── src/
│   ├── main.tsx           # Entry: CSS imports, Ion token, ReactDOM.render
│   ├── App.tsx            # ThemeProvider + RoomShell
│   ├── store.ts           # createRoomStore with cesium slice
│   └── components/        # (optional app-specific overrides)
├── index.html
├── vite.config.ts
├── package.json
├── tailwind.config.ts
└── .env                   # VITE_CESIUM_ION_TOKEN=...
```

### Minimal store.ts with earthquake data + time animation

```typescript
import {
  createRoomShellSlice,
  createRoomStore,
  RoomShellSliceState,
} from '@sqlrooms/room-shell';
import {LayoutTypes} from '@sqlrooms/layout';
import {GlobeIcon, DatabaseIcon} from 'lucide-react';
import {
  createCesiumSlice,
  CesiumSliceState,
  createDefaultCesiumConfig,
  CesiumPanel,
} from '@sqlrooms/cesium';
import {FileDataSourcesPanel} from '@sqlrooms/room-shell';

export type RoomState = RoomShellSliceState & CesiumSliceState;

const cesiumConfig = createDefaultCesiumConfig();
// Pre-configure a SQL entity layer for earthquake data
cesiumConfig.cesium.layers = [
  {
    id: 'earthquake-points',
    type: 'sql-entities',
    visible: true,
    sqlQuery: `
      SELECT
        latitude,
        longitude,
        depth AS altitude,
        time AS timestamp,
        mag AS size,
        place AS label
      FROM earthquakes
      WHERE mag > 4.0
      ORDER BY time
    `,
    columnMapping: {
      longitude: 'longitude',
      latitude: 'latitude',
      altitude: 'altitude',
      time: 'timestamp',
      label: 'label',
      size: 'size',
    },
  },
];
// Configure time range for earthquake data
cesiumConfig.cesium.clock = {
  startTime: '2024-01-01T00:00:00Z',
  stopTime: '2024-12-31T23:59:59Z',
  multiplier: 86400, // 1 day per second
  shouldAnimate: false,
  clockRange: 'LOOP_STOP',
};

export const {roomStore, useRoomStore} = createRoomStore<RoomState>(
  (set, get, store) => ({
    ...createRoomShellSlice({
      config: {
        title: 'Earthquake Explorer',
        dataSources: [
          {
            tableName: 'earthquakes',
            type: 'url',
            url: 'https://huggingface.co/datasets/sqlrooms/earthquakes/resolve/main/earthquakes.parquet',
          },
        ],
      },
      layout: {
        config: {
          type: LayoutTypes.enum.mosaic,
          nodes: {
            direction: 'row',
            first: 'data-sources',
            second: 'cesium-globe',
            splitPercentage: 20,
          },
        },
        panels: {
          'data-sources': {
            title: 'Data Sources',
            icon: DatabaseIcon,
            component: FileDataSourcesPanel,
            placement: 'sidebar',
          },
          'cesium-globe': {
            title: '3D Globe',
            icon: GlobeIcon,
            component: CesiumPanel,
            placement: 'main',
          },
        },
      },
    })(set, get, store),

    ...createCesiumSlice(cesiumConfig)(set, get, store),
  }),
);
```

---

## 12. Key Patterns & Pitfalls

### Do

- **Use granular Zustand selectors** — `useRoomStore((s) => s.cesium.viewer)` not `useRoomStore((s) => s.cesium)` — to avoid re-rendering the entire Cesium viewer on unrelated state changes.
- **Throttle clock sync** — Cesium ticks at 60fps. Writing to Zustand every frame will destroy performance. Throttle to 1-2Hz for the store and keep Cesium's own clock as the source of truth for smooth animation.
- **Null-check the viewer** — `viewerRef.current?.cesiumElement` can be undefined if Cesium fails to initialize (e.g., no WebGL). Guard all imperative calls.
- **Use `useMemo` for Cesium objects** — Cesium constructors like `Cartesian3.fromDegrees()` return new objects. Without memoization, Resium will detect prop changes every render and recreate entities.
- **Destroy cleanup** — Check `viewer.isDestroyed()` before removing event listeners in `useEffect` cleanup. React 18 strict mode double-mounts components.
- **Keep config serializable** — Never put `Viewer`, `Entity`, `JulianDate`, or other Cesium class instances in the Zod config schema. Convert to/from primitives (numbers, ISO strings) at the boundary.

### Don't

- **Don't put the Cesium `Viewer` instance in persisted config** — it's a massive non-serializable object. Store it in runtime state only.
- **Don't re-create `<Viewer>` on every render** — the Resium `<Viewer>` should mount once. Use Cesium's imperative API (via the stored viewer ref) for updates, not React re-renders.
- **Don't fight Cesium's own clock** — let Cesium manage the animation loop. The Zustand store mirrors clock state for UI controls and persistence, but Cesium's internal `Clock` is the authority during playback.
- **Don't forget Cesium CSS** — without `widgets.css`, the timeline and animation widgets will be unstyled/broken.
- **Don't bundle Cesium workers inline** — they must be served as separate files. The Vite plugin or static copy setup handles this.

### Performance Tips

- For >10,000 entities, switch from individual `<Entity>` components to a `CustomDataSource` with batch entity creation via the imperative API.
- For >100,000 points, use `PointPrimitiveCollection` instead of entities (not directly supported by Resium — use the viewer ref).
- For 3D Tiles (buildings, terrain meshes), use `Cesium3DTileset` which streams data on demand.
- Consider `requestRenderMode={true}` on the Viewer to only render when something changes, saving GPU on static scenes.

### TypeScript Notes

- Resium exports `CesiumComponentRef<T>` for typed refs: `useRef<CesiumComponentRef<CesiumViewer>>(null)`
- Cesium's namespace types are at `import {Viewer, Entity, ...} from 'cesium'`
- Resium components are at `import {Viewer, Entity, ...} from 'resium'` (same names, different things — Resium components wrap Cesium classes)

---

## Summary Checklist

- [ ] Create Zod config schema (`CesiumSliceConfig`) for persistable camera/clock/layer state
- [ ] Implement `createCesiumSlice()` following Zustand StateCreator pattern
- [ ] Build `CesiumPanel` component wrapping Resium `<Viewer>`
- [ ] Store viewer ref in Zustand on mount, null on unmount
- [ ] Implement `CesiumEntityLayer` using `useSql()` to query DuckDB → render as entities
- [ ] Implement `useClockSync` hook for bidirectional clock state sync (throttled)
- [ ] Add clock control UI using `@sqlrooms/ui` components
- [ ] Wire into store via `createRoomStore` spread pattern
- [ ] Register panel in layout config with ID, title, icon, placement
- [ ] Configure Vite with `vite-plugin-cesium` for static assets
- [ ] Import `widgets.css` and set Ion token in app entry
- [ ] Add time-dynamic entity support via `SampledPositionProperty` for animated data
- [ ] Test persistence: camera position and clock config survive page reload
