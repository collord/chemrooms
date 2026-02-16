# Chemrooms — Specification & Implementation Plan

> An SQLRooms-based web application for spatial exploration and time-series analysis of environmental chemistry data stored in ChemDuck format.

---

## 1. Product Overview

Chemrooms is a browser-based analytical workbench that loads a ChemDuck-structured DuckDB database (initially as a full `.duckdb` transfer via URL, later via streaming Arrow) and provides:

1. **Spatial overview** — A Cesium 3D globe (via the `@sqlrooms/cesium` fork at `collord/sqlrooms`) showing all sampling locations as interactive point features.
2. **Location inspector** — Click a location on the map to open a detail panel with analyte selection and a time-series chart (via `@sqlrooms/mosaic`).
3. **Choropleth mapping** — Select an analyte from a global menu to re-symbolize all map points by concentration using a color ramp, with toggleable raw-value vs. exceedance-ratio modes.
4. **Multi-analyte overlay** — Support 2–4 analytes on one time-series chart with dual y-axes when units differ.

The app has two deployable components:
- **Client**: TypeScript / React / SQLRooms / DuckDB-WASM / Cesium (Resium)
- **Server**: Python / FastAPI (initially serves the `.duckdb` file; later provides Arrow Flight or HTTP Arrow streaming)

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser                                                            │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  SQLRooms Room Store (Zustand)                               │   │
│  │                                                              │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │   │
│  │  │ room-    │ │ duckdb   │ │ cesium   │ │ chemrooms     │  │   │
│  │  │ shell    │ │ slice    │ │ slice    │ │ slice         │  │   │
│  │  │          │ │          │ │          │ │ (NEW)         │  │   │
│  │  │ layout   │ │ tables   │ │ viewer   │ │               │  │   │
│  │  │ panels   │ │ useSql() │ │ camera   │ │ selectedLoc   │  │   │
│  │  │ config   │ │ schemas  │ │ clock    │ │ selectedAnlts │  │   │
│  │  │ datasrc  │ │          │ │ layers   │ │ ndMethod      │  │   │
│  │  │          │ │          │ │ entities │ │ choroConfig   │  │   │
│  │  └──────────┘ └──────────┘ └──────────┘ │ matrixFilter  │  │   │
│  │                                          │ colorMode     │  │   │
│  │  ┌──────────┐ ┌──────────┐               └───────────────┘  │   │
│  │  │ mosaic   │ │ sql-     │                                   │   │
│  │  │ slice    │ │ editor   │                                   │   │
│  │  │ (charts) │ │ slice    │                                   │   │
│  │  └──────────┘ └──────────┘                                   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌───────────────┐ ┌────────────────┐ ┌──────────────────────┐     │
│  │ CesiumPanel   │ │ LocationPanel  │ │ TimeSeriesPanel      │     │
│  │ (3D globe)    │ │ (detail/pick)  │ │ (Mosaic VgPlot)      │     │
│  └───────────────┘ └────────────────┘ └──────────────────────┘     │
│                                                                     │
│  ┌───────────────┐ ┌────────────────┐                              │
│  │ AnalyteMenu   │ │ FilterToolbar  │                              │
│  │ (choropleth)  │ │ (matrix, ND)   │                              │
│  └───────────────┘ └────────────────┘                              │
└─────────────────────────────────────────────────────────────────────┘
          │
          │  HTTP: fetch .duckdb file (phase 1)
          │  Arrow Flight / HTTP Arrow (phase 2)
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Server (FastAPI)                                                    │
│  - Serves static .duckdb file                                       │
│  - (Later) Arrow Flight endpoint                                    │
│  - (Later) Authentication, dataset catalog                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Model Reference (ChemDuck)

### 3.1 Core Tables

| Table | PK | Purpose |
|-------|-----|---------|
| `project` | `project_name` | Project metadata + CRS |
| `locations` | `location_id` | Sampling points with `x` (lon), `y` (lat), `geom`, `loc_type`, `aquifer`, `region` |
| `samples` | `sample_id` | Sampling events: `location_id` (FK), `sample_date`, `matrix`, `depth`, `sample_type` |
| `results` | `result_id` | Analytical measurements: `sample_id` (FK), `analyte`, `cas_number`, `analyte_group`, `result`, `units`, `std_units`, `detected`, `estimated`, `qualifier`, `method_detection_limit`, `reporting_limit`, `fraction`, `meas_basis` |
| `screening_levels` | `screening_id` | Regulatory thresholds: `analyte`, `matrix`, `value`, `units`, `level_type`, `comparison` |
| `unit_conversions` | composite | Unit conversion factors |

### 3.2 Extended Tables

| Table | Purpose |
|-------|---------|
| `rivers` / `location_river_miles` | River mile positioning |
| `key_locations` | Named reference/compliance points |
| `project_events` | Timeline events for chart annotations |
| `user_analyte_groups` / `user_analyte_group_members` | Custom analyte groupings |
| `chart_configurations` | Saved chart styles |
| `saved_queries` | Persisted query configurations |

### 3.3 Key Views

| View | Purpose | Used By |
|------|---------|---------|
| `v_results_denormalized` | Core join: results + samples + locations + computed fields | Everything |
| `v_most_recent_results` | Latest result per (location, analyte, matrix) | Choropleth default |
| `v_results_with_screening` | Results + screening levels + exceedance_ratio | Choropleth exceedance mode |
| `v_timeseries_data` | Ordered by (location, analyte, date) with year/month | Time-series chart |
| `v_timeseries_with_events` | Time series + project_events overlay | Time-series chart annotations |
| `v_analyte_summary` | Per-analyte stats (count, detect%, min/max/mean) | Analyte picker |
| `v_available_filters` | Distinct values for filter dropdowns | Filter toolbar |
| `v_exceedances` | Exceedance count by location/analyte | Choropleth legends |

### 3.4 Relationship Chain

```
locations (1) ──< samples (many) ──< results (many)
                                        │
                                        ├── analyte, result, units, detected
                                        └── screening_levels (joined on analyte+matrix+units)
```

### 3.5 Coordinate Assumption

All datasets will store coordinates as **WGS84 longitude/latitude** in the `x` and `y` columns of the `locations` table. No client-side reprojection is needed.

---

## 4. Zustand State Design

### 4.1 New `chemroomsSlice` — Application-Specific State

This slice manages the domain-specific UI state that connects the Cesium map, the analyte selectors, and the chart panels.

```typescript
// chemrooms-config.ts (Zod schema — persisted)
import {z} from 'zod';

const NonDetectMethod = z.enum([
  'half_dl',       // Plot at half the detection limit
  'at_dl',         // Plot at the full detection limit
  'zero',          // Plot at zero
  'exclude',       // Omit non-detects from chart
]);

const ChoroplethAggMethod = z.enum([
  'most_recent',   // Latest sample result per location
  'maximum',       // Max concentration ever detected
  'mean',          // Arithmetic mean of all results
  'exceedance',    // Exceedance ratio (result/screening_level)
]);

const ColorMode = z.enum([
  'concentration', // Raw result value → color ramp
  'exceedance',    // result/screening_level ratio → diverging ramp (centered at 1.0)
]);

export const ChemroomsSliceConfig = z.object({
  chemrooms: z.object({
    /** Currently selected location_id (from map click) */
    selectedLocationId: z.string().nullable().default(null),
    /** Analytes selected for the time-series chart (1-4) */
    timeSeriesAnalytes: z.array(z.string()).default([]),
    /** Analyte selected for choropleth coloring */
    choroplethAnalyte: z.string().nullable().default(null),
    /** Active matrix filter */
    matrixFilter: z.string().nullable().default(null),
    /** Non-detect display method */
    nonDetectMethod: NonDetectMethod.default('half_dl'),
    /** Choropleth aggregation method */
    choroplethAggMethod: ChoroplethAggMethod.default('most_recent'),
    /** Choropleth color mode */
    colorMode: ColorMode.default('concentration'),
    /** Selected screening level name (for exceedance mode) */
    selectedScreeningLevel: z.string().nullable().default(null),
    /** Fraction filter (Total, Dissolved, null=all) */
    fractionFilter: z.string().nullable().default(null),
  }).default({}),
});

export type ChemroomsSliceConfig = z.infer<typeof ChemroomsSliceConfig>;
```

```typescript
// chemrooms-slice.ts (actions + runtime state)
export interface ChemroomsSliceState {
  chemrooms: {
    config: ChemroomsSliceConfig['chemrooms'];
    // Runtime (transient)
    availableAnalytes: string[];          // populated on data load
    availableMatrices: string[];          // populated on data load
    availableScreeningLevels: string[];   // populated on data load
    locationSummary: LocationSummary | null; // populated on location click
    isLoadingAnalytes: boolean;
    // Actions
    setSelectedLocation: (locationId: string | null) => void;
    setTimeSeriesAnalytes: (analytes: string[]) => void;
    addTimeSeriesAnalyte: (analyte: string) => void;
    removeTimeSeriesAnalyte: (analyte: string) => void;
    setChoroplethAnalyte: (analyte: string | null) => void;
    setMatrixFilter: (matrix: string | null) => void;
    setNonDetectMethod: (method: string) => void;
    setChoroplethAggMethod: (method: string) => void;
    setColorMode: (mode: string) => void;
    setSelectedScreeningLevel: (name: string | null) => void;
    setFractionFilter: (fraction: string | null) => void;
    loadAvailableFilters: () => Promise<void>;
    loadLocationSummary: (locationId: string) => Promise<void>;
  };
}

interface LocationSummary {
  locationId: string;
  locType: string;
  locDesc: string;
  region: string;
  sampleCount: number;
  analyteCount: number;
  dateRange: {first: string; last: string};
  matrices: string[];
}
```

### 4.2 Combined Store Type

```typescript
export type RoomState =
  RoomShellSliceState &
  CesiumSliceState &
  ChemroomsSliceState &
  MosaicSliceState &
  SqlEditorSliceState;
```

---

## 5. Panel Layout

### 5.1 Default Mosaic Layout

```
┌─────────────┬──────────────────────────────────────┐
│             │                                       │
│  Sidebar    │         CesiumPanel                   │
│  (20%)      │         (3D Globe)                    │
│             │                                       │
│  - Data     │                                       │
│    Sources  ├───────────────────────────────────────┤
│  - Analyte  │                                       │
│    Menu     │    TimeSeriesPanel (Mosaic VgPlot)    │
│  - Filters  │                                       │
│             │                                       │
└─────────────┴───────────────────────────────────────┘
```

```typescript
layout: {
  config: {
    type: LayoutTypes.enum.mosaic,
    nodes: {
      direction: 'row',
      first: 'sidebar',
      second: {
        direction: 'column',
        first: 'cesium-globe',
        second: 'timeseries',
        splitPercentage: 60,
      },
      splitPercentage: 22,
    },
  },
  panels: {
    'sidebar': {
      title: 'Controls',
      icon: SlidersHorizontalIcon,
      component: SidebarPanel,
      placement: 'sidebar',
    },
    'cesium-globe': {
      title: '3D Globe',
      icon: GlobeIcon,
      component: CesiumPanel,
      placement: 'main',
    },
    'timeseries': {
      title: 'Time Series',
      icon: ChartLineIcon,
      component: TimeSeriesPanel,
      placement: 'main',
    },
  },
}
```

### 5.2 Panel Descriptions

| Panel | Component | Content |
|-------|-----------|---------|
| **SidebarPanel** | `SidebarPanel.tsx` | Collapsible sections: Data Sources, Location Detail, Analyte Picker (for choropleth), Filter Toolbar (matrix, fraction, ND method), Screening Level Picker |
| **CesiumPanel** | `@sqlrooms/cesium` `CesiumPanel` | 3D globe with location entities. Click handler wired to `setSelectedLocation()`. Choropleth coloring applied via entity point color. |
| **TimeSeriesPanel** | `TimeSeriesPanel.tsx` | Mosaic/VgPlot chart showing concentration vs. date for selected location + analytes. Includes screening level reference lines and project event annotations. |

---

## 6. Feature Specifications

### 6.1 Feature: Spatial Location Overview

**Summary**: On load, display all locations from the `locations` table as points on the Cesium globe.

**Data flow**:
```sql
-- Base location query (always runs after data load)
SELECT
  location_id,
  x AS longitude,
  y AS latitude,
  loc_type,
  loc_desc,
  region
FROM locations
```

**Implementation**:
- Configure a `sql-entities` layer in the Cesium slice config.
- Column mapping: `longitude: 'longitude'`, `latitude: 'latitude'`, `label: 'location_id'`.
- Default point style: uniform color (e.g. `#3B82F6` blue), 8px, clamped to ground.
- Entity name = `location_id`, description = `loc_desc`.
- Render via `CesiumEntityLayer` (already implemented in the fork).

**Extensions needed to `@sqlrooms/cesium`**:
- **Entity click handler**: Wire a `ScreenSpaceEventHandler` on `LEFT_CLICK` in `CesiumViewerWrapper` that calls `scene.pick()`, resolves the entity, and dispatches `chemrooms.setSelectedLocation(entity.id)`. Also dispatch `cesium.setSelectedEntity(entity)`.
- **Selection highlight**: When `selectedEntity` is set, change its point color/size to indicate selection (e.g. yellow, 12px, with a pulsing outline).

### 6.2 Feature: Location Click → Detail + Analyte Picker

**Summary**: When a user clicks a location on the map, the sidebar updates to show location details and presents a searchable list of analytes with results at that location. Selecting an analyte (or multiple) populates the time-series panel.

**Data flow**:
```sql
-- Location summary (on click)
SELECT
  l.location_id,
  l.loc_type,
  l.loc_desc,
  l.region,
  COUNT(DISTINCT s.sample_id) AS sample_count,
  COUNT(DISTINCT r.analyte) AS analyte_count,
  MIN(s.sample_date)::VARCHAR AS first_date,
  MAX(s.sample_date)::VARCHAR AS last_date,
  LIST(DISTINCT s.matrix ORDER BY s.matrix) AS matrices
FROM locations l
JOIN samples s ON s.location_id = l.location_id
JOIN results r ON r.sample_id = s.sample_id
WHERE l.location_id = $1
GROUP BY l.location_id, l.loc_type, l.loc_desc, l.region

-- Analytes available at this location (filtered by active matrix/fraction)
SELECT DISTINCT
  r.analyte,
  r.analyte_group,
  r.cas_number,
  COUNT(*) AS result_count,
  SUM(CASE WHEN r.detected THEN 1 ELSE 0 END) AS detect_count,
  MIN(r.result) AS min_result,
  MAX(r.result) AS max_result,
  r.units
FROM results r
JOIN samples s ON r.sample_id = s.sample_id
WHERE s.location_id = $1
  AND ($2 IS NULL OR s.matrix = $2)           -- matrix filter
  AND ($3 IS NULL OR r.fraction = $3)          -- fraction filter
GROUP BY r.analyte, r.analyte_group, r.cas_number, r.units
ORDER BY r.analyte_group, r.analyte
```

**UI components**:
- **LocationDetailCard**: Shows location_id, type, description, sample count, date range. Rendered in the sidebar when a location is selected.
- **AnalytePicker**: Searchable/filterable list grouped by `analyte_group`. Each row shows analyte name, result count, detect %, and units. Click to toggle selection (max 4 for multi-analyte overlay). Selected analytes populate `chemrooms.config.timeSeriesAnalytes`.
- **Active Filters**: Matrix dropdown, fraction dropdown, ND method dropdown. Changes rerun the analyte list query.

### 6.3 Feature: Time-Series Chart (Mosaic/VgPlot)

**Summary**: For the selected location + analytes, display an interactive scatter+line chart of concentration vs. sample date using the SQLRooms Mosaic infrastructure (`@sqlrooms/mosaic` / VgPlot).

**Data flow**:
```sql
-- Time-series data for selected location + analytes
SELECT
  r.analyte,
  s.sample_date,
  r.result,
  r.detected,
  r.estimated,
  COALESCE(r.reporting_limit, r.method_detection_limit, r.quantitation_limit)
    AS detection_limit,
  r.units,
  r.qualifier,
  -- Non-detect adjusted value (based on user's selected method)
  CASE
    WHEN r.detected THEN r.result
    WHEN $nd_method = 'half_dl' THEN detection_limit / 2.0
    WHEN $nd_method = 'at_dl' THEN detection_limit
    WHEN $nd_method = 'zero' THEN 0
    ELSE NULL  -- 'exclude' → filter out in WHERE
  END AS plot_value,
  CASE WHEN r.detected THEN 'Detected' ELSE 'Non-Detect' END AS detect_status
FROM results r
JOIN samples s ON r.sample_id = s.sample_id
WHERE s.location_id = $location_id
  AND r.analyte IN ($analytes)
  AND ($matrix IS NULL OR s.matrix = $matrix)
  AND ($fraction IS NULL OR r.fraction = $fraction)
  AND ($nd_method != 'exclude' OR r.detected = TRUE)
ORDER BY r.analyte, s.sample_date
```

**Chart specification (VgPlot/Mosaic)**:
- **Mark**: `dot` + `line` (connected scatter)
- **X-axis**: `sample_date` (temporal)
- **Y-axis**: `plot_value` (quantitative, log scale option)
- **Color channel**: `analyte` (categorical, for multi-analyte overlay)
- **Shape channel**: `detect_status` — detected = filled circle, non-detect = open triangle down
- **Tooltip**: analyte, date, value, units, qualifier
- **Reference lines** (horizontal): screening level values (dashed, labeled)
- **Reference lines** (vertical): project_events dates (dashed, labeled, from `v_timeseries_with_events`)
- **Dual y-axes**: When selected analytes have different `units`, use a secondary y-axis for the second unit group.

**Screening level overlay query**:
```sql
SELECT name, value, units
FROM screening_levels
WHERE analyte IN ($analytes)
  AND ($matrix IS NULL OR matrix = $matrix)
```

**Project events overlay query**:
```sql
SELECT name, event_date, event_type, line_style, line_color
FROM project_events
WHERE display_on_charts = TRUE
  AND event_date BETWEEN $min_date AND $max_date
```

### 6.4 Feature: Choropleth Map (Analyte Color Ramp)

**Summary**: From a menu (not location-specific), select an analyte. All location points on the map are re-colored according to a continuous color ramp representing the concentration (or exceedance ratio) at each location.

**Data flow — concentration mode (`color_mode = 'concentration'`)**:
```sql
-- Choropleth data: one value per location for the selected analyte
-- Aggregation method determines which value

-- most_recent:
SELECT location_id, x AS longitude, y AS latitude, result, units, detected
FROM v_most_recent_results
WHERE analyte = $analyte
  AND ($matrix IS NULL OR matrix = $matrix)
  AND ($fraction IS NULL OR fraction = $fraction)

-- maximum:
SELECT
  l.location_id, l.x AS longitude, l.y AS latitude,
  MAX(r.result) AS result, r.units, BOOL_OR(r.detected) AS detected
FROM results r JOIN samples s ON r.sample_id = s.sample_id
JOIN locations l ON s.location_id = l.location_id
WHERE r.analyte = $analyte
  AND ($matrix IS NULL OR s.matrix = $matrix)
GROUP BY l.location_id, l.x, l.y, r.units

-- mean:
SELECT
  l.location_id, l.x AS longitude, l.y AS latitude,
  AVG(r.result) AS result, r.units, BOOL_OR(r.detected) AS detected
FROM results r JOIN samples s ON r.sample_id = s.sample_id
JOIN locations l ON s.location_id = l.location_id
WHERE r.analyte = $analyte
  AND ($matrix IS NULL OR s.matrix = $matrix)
GROUP BY l.location_id, l.x, l.y, r.units
```

**Data flow — exceedance mode (`color_mode = 'exceedance'`)**:
```sql
-- Uses v_results_with_screening which already computes exceedance_ratio
SELECT
  l.location_id, l.x AS longitude, l.y AS latitude,
  vr.exceedance_ratio,
  vr.exceedance_status,  -- 'EXCEEDS', 'APPROACHING', 'BELOW'
  vr.result, vr.units
FROM v_most_recent_results vr
JOIN locations l ON vr.location_id = l.location_id
JOIN screening_levels sl ON sl.analyte = vr.analyte
  AND sl.matrix = vr.matrix
  AND sl.name = $screening_level_name
WHERE vr.analyte = $analyte
  AND ($matrix IS NULL OR vr.matrix = $matrix)
```

**Color ramp**:
- **Concentration mode**: Sequential single-hue ramp (e.g. `viridis` or `YlOrRd`). Quantile or log-scaled breaks to handle skewed environmental data.
- **Exceedance mode**: Diverging ramp centered at 1.0 (e.g. `RdYlGn_r`). Values <1 = green (below screening), ~1 = yellow (approaching), >1 = red (exceeds).
- Non-detect locations: Rendered as small grey hollow circles to distinguish from detected values.

**Implementation — Cesium entity styling**:
This requires extending `@sqlrooms/cesium` to support **data-driven entity styling**:

1. Add a `styleOverrides` concept to the Cesium slice: a `Map<string, EntityStyle>` keyed by `location_id` that overrides the default point appearance.
2. When a choropleth analyte is selected, the `ChoroplethEngine` (a React hook) runs the appropriate SQL query, computes color ramp breaks (quantile/log), maps each location's value to a Cesium `Color`, and writes the style overrides to the store.
3. `CesiumEntityLayer` reads `styleOverrides` and applies per-entity `PointGraphics` color/size.
4. A `ChoroplethLegend` component renders a color bar with tick labels in the map panel.

```typescript
// New type for style overrides
interface EntityStyleOverride {
  color: string;        // CSS hex color
  pixelSize: number;
  outlineColor?: string;
  outlineWidth?: number;
}

// In cesium slice runtime state:
entityStyleOverrides: Map<string, EntityStyleOverride>;  // keyed by entity name/location_id

// Action:
setEntityStyleOverrides: (overrides: Map<string, EntityStyleOverride>) => void;
clearEntityStyleOverrides: () => void;
```

### 6.5 Feature: Global Analyte Menu (Choropleth Trigger)

**Summary**: A sidebar section listing all analytes in the database. Selecting one triggers choropleth mode.

**Data flow**:
```sql
-- All analytes with result counts (populate on data load)
SELECT
  r.analyte,
  r.analyte_group,
  COUNT(*) AS total_results,
  COUNT(DISTINCT s.location_id) AS location_count,
  SUM(CASE WHEN r.detected THEN 1 ELSE 0 END) AS detect_count,
  r.units
FROM results r
JOIN samples s ON r.sample_id = s.sample_id
WHERE ($matrix IS NULL OR s.matrix = $matrix)
GROUP BY r.analyte, r.analyte_group, r.units
ORDER BY r.analyte_group, r.analyte
```

**UI**:
- Grouped by `analyte_group` (collapsible sections: Metals, VOCs, SVOCs, etc.)
- Each row: analyte name, location count, detect count
- Searchable text input at top
- Click an analyte → sets `chemrooms.config.choroplethAnalyte`, triggers choropleth recomputation
- Click again (or clear button) → clears choropleth, returns to default uniform styling

### 6.6 Feature: Filter Toolbar

**Summary**: Global filters that affect all panels — the analyte list, time-series queries, and choropleth queries.

| Filter | Source | UI |
|--------|--------|----|
| Matrix | `SELECT DISTINCT matrix FROM samples ORDER BY matrix` | Dropdown: Water, Soil, Sediment, Air, (All) |
| Fraction | `SELECT DISTINCT fraction FROM results WHERE fraction IS NOT NULL` | Dropdown: Total, Dissolved, (All) |
| Non-detect method | Static enum | Dropdown: Half DL, At DL, Zero, Exclude |
| Choropleth aggregation | Static enum | Dropdown: Most Recent, Maximum, Mean |
| Color mode | Static enum | Toggle: Concentration / Exceedance (only when choropleth active) |
| Screening level | `SELECT DISTINCT name FROM screening_levels` | Dropdown (only when color mode = exceedance) |

---

## 7. Implementation Plan

### Phase 1: Foundation (MVP)

**Goal**: Load a ChemDuck `.duckdb` from URL, display locations on Cesium globe, click a location and see a basic time-series chart.

#### 1.1 Project Scaffolding
- [ ] Initialize the `chemrooms` repo with client (Vite + React + TypeScript) and server (FastAPI) directories.
- [ ] Client depends on forked `@sqlrooms/cesium`, `@sqlrooms/room-shell`, `@sqlrooms/duckdb`, `@sqlrooms/mosaic`, `@sqlrooms/ui`, `@sqlrooms/sql-editor`.
- [ ] Configure Vite with `vite-plugin-cesium`, Tailwind CSS, Cesium Ion token via `.env`.
- [ ] Server: FastAPI app that serves a static `.duckdb` file at a known URL.

#### 1.2 DuckDB Data Loading
- [ ] Configure room store with a URL data source pointing to the server's `.duckdb` endpoint.
- [ ] After DuckDB-WASM loads the file, run `INSTALL spatial; LOAD spatial;` to enable spatial functions.
- [ ] Verify all ChemDuck tables and views are accessible via `useSql()`.
- [ ] Populate `chemrooms.availableAnalytes`, `availableMatrices`, `availableScreeningLevels` from summary queries on load.

#### 1.3 Location Display on Cesium Globe
- [ ] Configure a `sql-entities` layer: `SELECT location_id, x AS longitude, y AS latitude, loc_type FROM locations`.
- [ ] Default styling: 8px blue points, clamped to ground.
- [ ] Verify locations render correctly on the globe.

#### 1.4 Entity Click Handler
- [ ] Add `ScreenSpaceEventHandler` in `CesiumViewerWrapper` for `LEFT_CLICK`.
- [ ] On click → `scene.pick()` → resolve entity → `chemrooms.setSelectedLocation(location_id)`.
- [ ] Highlight selected entity (yellow, larger).
- [ ] Camera flies to selected location with `cesium.flyTo()`.

#### 1.5 Location Detail + Analyte Picker (Sidebar)
- [ ] `LocationDetailCard` component: renders location summary from `loadLocationSummary()`.
- [ ] `AnalytePicker` component: grouped/searchable list of analytes at the selected location.
- [ ] Click analyte → adds to `timeSeriesAnalytes` (up to 4).

#### 1.6 Basic Time-Series Chart (Mosaic)
- [ ] `TimeSeriesPanel` component using `@sqlrooms/mosaic` VgPlot.
- [ ] Query: concentration vs. date for selected location + analytes.
- [ ] Non-detects plotted at half DL with open markers (default).
- [ ] Single y-axis, linear scale.

### Phase 2: Choropleth & Styling

**Goal**: Select an analyte globally and re-color all map points by concentration.

#### 2.1 Extend Cesium Slice for Style Overrides
- [ ] Add `entityStyleOverrides` map to cesium slice runtime state.
- [ ] Add `setEntityStyleOverrides()` and `clearEntityStyleOverrides()` actions.
- [ ] Modify `CesiumEntityLayer` to apply per-entity color/size from overrides.

#### 2.2 Choropleth Engine Hook
- [ ] `useChoropleth()` hook: watches `choroplethAnalyte`, `choroplethAggMethod`, `colorMode`, runs the appropriate SQL query.
- [ ] Compute color ramp: quantile breaks for concentration mode, diverging breaks for exceedance mode.
- [ ] Map each location's value to a CSS color using a scale function (e.g. D3 scale or manual interpolation).
- [ ] Write `EntityStyleOverride` map to store.

#### 2.3 Global Analyte Menu
- [ ] `AnalyteMenu` sidebar section with grouped/searchable list.
- [ ] Click analyte → `setChoroplethAnalyte()` → triggers `useChoropleth()`.
- [ ] Clear button resets to default styling.

#### 2.4 Choropleth Legend
- [ ] `ChoroplethLegend` overlay component in the map panel.
- [ ] Shows color bar, min/max/units, screening level threshold marker (if exceedance mode).

#### 2.5 Color Mode Toggle
- [ ] Toggle in filter toolbar: Concentration ↔ Exceedance.
- [ ] Exceedance mode requires selecting a screening level from dropdown.
- [ ] Ramp recomputes when mode or screening level changes.

### Phase 3: Polish & Advanced Features

#### 3.1 Time-Series Enhancements
- [ ] Screening level reference lines (horizontal dashed lines).
- [ ] Project event annotations (vertical dashed lines with labels).
- [ ] Dual y-axis when selected analytes have different units.
- [ ] Log scale toggle.
- [ ] Non-detect method selector (live update of chart).

#### 3.2 Filter Toolbar
- [ ] Matrix dropdown (All, Water, Soil, Sediment, Air).
- [ ] Fraction dropdown (All, Total, Dissolved).
- [ ] All panels react to filter changes via Zustand selectors.

#### 3.3 Additional Map Interactions
- [ ] Hover tooltip on entities: location_id, type, most recent sample date.
- [ ] Multi-select locations (Ctrl+click or lasso) for comparing time series.
- [ ] Cluster points at low zoom levels for dense datasets.

#### 3.4 Persistence & State Management
- [ ] Persist `chemroomsSliceConfig` via `persistSliceConfigs`.
- [ ] Integrate `saved_queries` table: save/restore chart configurations.
- [ ] URL hash state for shareable views.

### Phase 4: Streaming Arrow (Future)

- [ ] FastAPI Arrow Flight or HTTP Arrow endpoint.
- [ ] Replace full `.duckdb` transfer with table-level Arrow streaming.
- [ ] Progressive loading: locations first, then results on demand.
- [ ] Server-side query execution for large datasets.

---

## 8. Key SQL Queries Reference

### 8.1 Load Available Filters (on data init)

```sql
-- Analytes with counts
SELECT analyte, analyte_group, COUNT(*) AS n,
       COUNT(DISTINCT s.location_id) AS n_locations
FROM results r JOIN samples s ON r.sample_id = s.sample_id
GROUP BY analyte, analyte_group
ORDER BY analyte_group, analyte;

-- Matrices
SELECT DISTINCT matrix FROM samples ORDER BY matrix;

-- Screening levels
SELECT DISTINCT name, level_type FROM screening_levels ORDER BY name;

-- Fractions
SELECT DISTINCT fraction FROM results WHERE fraction IS NOT NULL ORDER BY fraction;
```

### 8.2 Location Entities (Cesium Layer)

```sql
SELECT location_id, x AS longitude, y AS latitude,
       loc_type, loc_desc, region
FROM locations
```

### 8.3 Location Summary (on click)

```sql
SELECT l.location_id, l.loc_type, l.loc_desc, l.region,
       COUNT(DISTINCT s.sample_id) AS sample_count,
       COUNT(DISTINCT r.analyte) AS analyte_count,
       MIN(s.sample_date)::VARCHAR AS first_date,
       MAX(s.sample_date)::VARCHAR AS last_date,
       LIST(DISTINCT s.matrix ORDER BY s.matrix) AS matrices
FROM locations l
JOIN samples s ON s.location_id = l.location_id
JOIN results r ON r.sample_id = s.sample_id
WHERE l.location_id = '{location_id}'
GROUP BY l.location_id, l.loc_type, l.loc_desc, l.region
```

### 8.4 Analytes at Location

```sql
SELECT r.analyte, r.analyte_group, r.cas_number,
       COUNT(*) AS result_count,
       SUM(CASE WHEN r.detected THEN 1 ELSE 0 END) AS detect_count,
       MIN(r.result) AS min_result, MAX(r.result) AS max_result,
       r.units
FROM results r
JOIN samples s ON r.sample_id = s.sample_id
WHERE s.location_id = '{location_id}'
  AND ('{matrix}' = '' OR s.matrix = '{matrix}')
  AND ('{fraction}' = '' OR r.fraction = '{fraction}')
GROUP BY r.analyte, r.analyte_group, r.cas_number, r.units
ORDER BY r.analyte_group, r.analyte
```

### 8.5 Time-Series Data

```sql
SELECT r.analyte, s.sample_date, r.result, r.detected, r.estimated,
       COALESCE(r.reporting_limit, r.method_detection_limit) AS detection_limit,
       r.units, r.qualifier,
       CASE
         WHEN r.detected THEN r.result
         WHEN '{nd_method}' = 'half_dl' THEN detection_limit / 2.0
         WHEN '{nd_method}' = 'at_dl' THEN detection_limit
         WHEN '{nd_method}' = 'zero' THEN 0
         ELSE NULL
       END AS plot_value,
       CASE WHEN r.detected THEN 'Detected' ELSE 'Non-Detect' END AS detect_status
FROM results r
JOIN samples s ON r.sample_id = s.sample_id
WHERE s.location_id = '{location_id}'
  AND r.analyte IN ({analytes})
  AND ('{matrix}' = '' OR s.matrix = '{matrix}')
  AND ('{fraction}' = '' OR r.fraction = '{fraction}')
  AND ('{nd_method}' != 'exclude' OR r.detected = TRUE)
ORDER BY r.analyte, s.sample_date
```

### 8.6 Choropleth — Most Recent Concentration

```sql
SELECT vr.location_id, l.x AS longitude, l.y AS latitude,
       vr.result, vr.units, vr.detected
FROM v_most_recent_results vr
JOIN locations l ON vr.location_id = l.location_id
WHERE vr.analyte = '{analyte}'
  AND ('{matrix}' = '' OR vr.matrix = '{matrix}')
```

### 8.7 Choropleth — Exceedance Ratio

```sql
SELECT l.location_id, l.x AS longitude, l.y AS latitude,
       r.result / sl.value AS exceedance_ratio,
       r.result, sl.value AS screening_value, r.units
FROM v_most_recent_results r
JOIN locations l ON r.location_id = l.location_id
JOIN screening_levels sl ON sl.analyte = r.analyte
  AND sl.matrix = r.matrix AND sl.name = '{screening_level}'
WHERE r.analyte = '{analyte}'
  AND ('{matrix}' = '' OR r.matrix = '{matrix}')
```

---

## 9. Technology Stack Summary

| Layer | Technology | Package |
|-------|-----------|---------|
| Framework | SQLRooms (forked: `collord/sqlrooms`) | `@sqlrooms/room-shell`, `@sqlrooms/room-store` |
| State | Zustand | via SQLRooms `createRoomStore` |
| Schema validation | Zod | via SQLRooms config persistence |
| Database | DuckDB-WASM + spatial extension | `@sqlrooms/duckdb` |
| 3D Globe | CesiumJS + Resium | `@sqlrooms/cesium` (fork) |
| Charts | Mosaic / VgPlot | `@sqlrooms/mosaic` |
| UI components | Tailwind + Shadcn/ui | `@sqlrooms/ui` |
| SQL editor | Monaco | `@sqlrooms/sql-editor` |
| Build | Vite + `vite-plugin-cesium` | |
| Server | Python / FastAPI | |
| Data model | ChemDuck | `Integralenvision/chemduck` |

---

## 10. File Structure (Client)

```
client/
├── public/
├── src/
│   ├── main.tsx                          # Entry: Cesium CSS, Ion token, render
│   ├── App.tsx                           # ThemeProvider + RoomShell
│   ├── store.ts                          # createRoomStore — all slices composed
│   ├── slices/
│   │   └── chemrooms-slice.ts            # createChemroomsSlice + config + types
│   ├── components/
│   │   ├── SidebarPanel.tsx              # Sidebar container with collapsible sections
│   │   ├── LocationDetailCard.tsx        # Location info card (on click)
│   │   ├── AnalytePicker.tsx             # Analyte list for time-series selection
│   │   ├── AnalyteMenu.tsx              # Global analyte list for choropleth
│   │   ├── FilterToolbar.tsx            # Matrix, fraction, ND method, color mode
│   │   ├── TimeSeriesPanel.tsx          # Mosaic VgPlot chart wrapper
│   │   ├── ChoroplethLegend.tsx         # Color ramp legend overlay
│   │   └── ScreeningLevelPicker.tsx     # Screening level dropdown
│   ├── hooks/
│   │   ├── useChoropleth.ts             # Choropleth SQL + color ramp computation
│   │   ├── useLocationSummary.ts        # Location detail query
│   │   ├── useAnalytesAtLocation.ts     # Analyte list query
│   │   ├── useTimeSeriesData.ts         # Time-series query for chart
│   │   ├── useAvailableFilters.ts       # Filter options query
│   │   └── useEntityClickHandler.ts     # Cesium click → store dispatch
│   └── utils/
│       ├── color-ramp.ts                # Color interpolation utilities
│       └── query-builders.ts            # SQL query template helpers
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── package.json
├── tsconfig.json
└── .env                                  # VITE_CESIUM_ION_TOKEN, VITE_DATA_URL
```

---

## 11. Open Questions & Future Considerations

1. **DuckDB-WASM `.duckdb` file loading**: DuckDB-WASM may not support loading a full `.duckdb` file directly — it typically loads Parquet/CSV. Need to verify whether the OPFS or HTTP file system interface can mount a `.duckdb` file, or whether the server should export tables as Parquet.
2. **Spatial extension in WASM**: Verify that `INSTALL spatial; LOAD spatial;` works in DuckDB-WASM, since some extensions have limited WASM support.
3. **Large datasets**: If a ChemDuck database has >50k results, entity rendering may need to switch to `PointPrimitiveCollection` for performance. Phase 3 should include a threshold-based fallback.
4. **Multi-location time-series comparison**: Phase 3 feature — select multiple locations and overlay their time series for the same analyte.
5. **Export**: PDF/PNG export of charts, CSV export of filtered data. Leverage Mosaic's built-in export + Cesium screenshot API.

## How to do setup

For a fresh clone, setup is:


cd chemrooms/client
pnpm install          # installs npm deps + creates @sqlrooms symlinks
pnpm dev              # starts Vite dev server
The only requirement is that the sqlrooms fork lives at ../../sqlrooms relative to the client dir (i.e., /Users/collord/Documents/sqlrooms). If it moves, update the link: paths in package.json or run SQLROOMS_DIR=/new/path pnpm link-sqlrooms.