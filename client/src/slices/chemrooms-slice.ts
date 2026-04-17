/**
 * Chemrooms application slice — domain-specific state for environmental
 * chemistry data exploration. Manages selected location, analyte selection,
 * filter state, and choropleth configuration.
 */

import {
  createSlice,
  useBaseRoomShellStore,
  type RoomShellSliceState,
} from '@sqlrooms/room-shell';
import type {CesiumSliceState} from '@sqlrooms/cesium';
import type {MosaicSliceState} from '@sqlrooms/mosaic/dist/MosaicSlice';
import type {SqlEditorSliceState} from '@sqlrooms/sql-editor';
import type {StateCreator} from 'zustand';
import type {VisSpec} from '../vis/visSpec';
import type {LayerConfig} from '../layers/layerSchema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Aggregation-rule names live in the chemduck `aggregation_rules` catalog
 * table and are loaded at runtime. These types are the string shape, kept
 * as a hint to call sites. They match chemduck's canonical vocabulary —
 * the single source of truth is the catalog, not this file.
 */
export type NdMethod = 'raw' | 'half_dl' | 'dl' | 'zero' | 'exclude';
export type EventAgg = 'most_recent' | 'maximum' | 'mean';
export type DupAgg = 'avg' | 'max' | 'min' | 'first' | 'last';
export type ColorMode = 'concentration' | 'exceedance';

/** One entry from the chemduck `aggregation_rules` catalog. */
export interface AggregationRule {
  category: string; // 'event_agg' | 'dup_agg' | 'nd_method'
  name: string;
  label: string;
  description: string | null;
  displayOrder: number;
}

export interface LocationSummary {
  locationId: string;
  locType: string;
  locDesc: string;
  region: string;
  sampleCount: number;
  analyteCount: number;
  firstDate: string;
  lastDate: string;
  matrices: string[];
}

export interface AnalyteInfo {
  analyte: string;
  analyteGroup: string;
  casNumber: string;
  resultCount: number;
  detectCount: number;
  minResult: number;
  maxResult: number;
  units: string;
}

/**
 * The entity the user most recently clicked. Two variants because
 * they have fundamentally different rendering in the Inspector:
 *
 * - `chemduck-location` → structured summary (loc_type, region,
 *   sample count, date range) + the analytes-at-location table.
 *   Triggered by clicking a point from the chemduck-driven locations
 *   / samples layers (or any frozen chemduck recipe).
 *
 * - `vector-feature` → generic key/value attribute table. Triggered
 *   by clicking any geometry from a dropped geoparquet.
 *
 * Clicking empty space sets this to null.
 */
export type SelectedEntity =
  | {
      kind: 'chemduck-location';
      /** The `location_id` identifier to drive the summary queries. */
      locationId: string;
      /**
       * Which layer the click originated from, e.g. `locations`,
       * `samples`, or `personal:<hash>`. Kept for provenance / future
       * "go to source layer" affordances; not currently used for
       * dispatch.
       */
      source: string;
    }
  | {
      kind: 'vector-feature';
      /** Full layer id string, e.g. `personal:<hash>`. */
      layerId: string;
      /** Stable per-feature id (the `location_id` column in our SQL). */
      featureId: string;
      /** Display label (the `label` column in our SQL). */
      label: string;
      /**
       * The feature's attribute columns as a plain record. Synthetic
       * fields (`_kind`, `_layerId`, etc.) are stripped before this
       * reaches the slice — this object only contains user-visible
       * columns from the underlying parquet.
       */
      properties: Record<string, unknown>;
    };

export interface ChemroomsConfig {
  /**
   * The currently-inspected entity, or null if nothing is selected.
   * Replaces the old `selectedLocationId` field; a chemduck location
   * is now one variant of a tagged union alongside vector features.
   */
  selectedEntity: SelectedEntity | null;
  timeSeriesAnalytes: string[];
  /**
   * Analyte to drive the samples layer aggregation/coloring. When null,
   * the samples layer shows every sample uncollapsed (no aggregation).
   */
  coloringAnalyte: string | null;
  matrixFilter: string | null;
  /** Non-detect substitution method (chemduck `aggregation_rules` nd_method). */
  ndMethod: NdMethod;
  /** Event-aggregation method (chemduck `aggregation_rules` event_agg). */
  eventAgg: EventAgg;
  /** Duplicate-aggregation method (chemduck `aggregation_rules` dup_agg). */
  dupAgg: DupAgg;
  colorMode: ColorMode;
  selectedScreeningLevel: string | null;
  fractionFilter: string | null;
  /** 3D rendering mode for chemduck entities. */
  sampleRenderAs: 'auto' | 'sphere' | 'volume';
  /** Radius of 3D spheres in meters. */
  sphereRadiusMeters: number;
  /** Radius of borehole polylineVolume tubes in meters. */
  volumeRadiusMeters: number;
}

/** Lon/lat pairs for the two cross-section endpoints (degrees). */
export type CrossSectionPoints = [[number, number], [number, number]] | null;

/** Per-table active "color by" column. */
export type ColorBySelection = Record<string, string | null>;

export interface ChemroomsSliceState {
  chemrooms: {
    config: ChemroomsConfig;
    // Runtime state
    availableAnalytes: AnalyteInfo[];
    /** Sorted distinct analytes loaded from v_analyte_summary. */
    availableAnalyteNames: string[];
    availableMatrices: string[];
    availableScreeningLevels: string[];
    /** chemduck aggregation_rules catalog, keyed by category. */
    aggregationRules: Record<string, AggregationRule[]>;
    /**
     * Visibility flags for the chemrooms-managed entity layers.
     * Default: both true. LayersMenu's "Site Data" toggle drives the
     * samples flag.
     */
    locationsVisible: boolean;
    samplesVisible: boolean;
    locationSummary: LocationSummary | null;
    analytesAtLocation: AnalyteInfo[];
    crossSectionPoints: CrossSectionPoints;
    /** Vis specs loaded from `<table>.vis.json` sidecars, keyed by table. */
    visSpecs: Record<string, VisSpec>;
    /** Active color-by column per table; null = no coloring. */
    colorBy: ColorBySelection;
    /**
     * Personal layers persisted in localStorage. Each is a frozen
     * snapshot of a recipe (analyte + filters + agg + visual encoding).
     */
    personalLayers: LayerConfig[];
    /**
     * Layers loaded from a bookmark URL hash. Transient — not
     * persisted to localStorage. Rendered alongside personal layers
     * but visually distinguished in the LayersPanel; the user can
     * promote them to personal storage if they want to keep them.
     */
    bookmarkLayers: LayerConfig[];
    isLoadingFilters: boolean;
    isLoadingLocation: boolean;
    // Actions
    /**
     * Set the currently-inspected entity. Passing `null` deselects.
     * Drives both the Inspector panel and (for chemduck-location
     * selections) the summary-query hook.
     */
    setSelectedEntity: (entity: SelectedEntity | null) => void;
    /**
     * Convenience wrapper that constructs a `chemduck-location`
     * SelectedEntity. Kept so existing callers (useBookmark) don't
     * need to know about the union shape.
     */
    setSelectedLocation: (
      locationId: string | null,
      source?: string,
    ) => void;
    setTimeSeriesAnalytes: (analytes: string[]) => void;
    addTimeSeriesAnalyte: (analyte: string) => void;
    removeTimeSeriesAnalyte: (analyte: string) => void;
    setColoringAnalyte: (analyte: string | null) => void;
    setMatrixFilter: (matrix: string | null) => void;
    setNdMethod: (method: NdMethod) => void;
    setEventAgg: (method: EventAgg) => void;
    setDupAgg: (method: DupAgg) => void;
    setColorMode: (mode: ColorMode) => void;
    setSelectedScreeningLevel: (name: string | null) => void;
    setFractionFilter: (fraction: string | null) => void;
    setLocationSummary: (summary: LocationSummary | null) => void;
    setAnalytesAtLocation: (analytes: AnalyteInfo[]) => void;
    setAvailableAnalytes: (analytes: AnalyteInfo[]) => void;
    setAvailableAnalyteNames: (names: string[]) => void;
    setAvailableMatrices: (matrices: string[]) => void;
    setAvailableScreeningLevels: (levels: string[]) => void;
    setAggregationRules: (rules: AggregationRule[]) => void;
    setLocationsVisible: (visible: boolean) => void;
    setSamplesVisible: (visible: boolean) => void;
    setPersonalLayers: (layers: LayerConfig[]) => void;
    addPersonalLayer: (layer: LayerConfig) => void;
    removePersonalLayer: (id: string) => void;
    togglePersonalLayer: (id: string) => void;
    setBookmarkLayers: (layers: LayerConfig[]) => void;
    toggleBookmarkLayer: (id: string) => void;
    promoteBookmarkLayer: (id: string) => void;
    setCrossSectionPoints: (points: CrossSectionPoints) => void;
    setVisSpec: (table: string, spec: VisSpec) => void;
    setColorBy: (table: string, column: string | null) => void;
    setIsLoadingFilters: (loading: boolean) => void;
    setIsLoadingLocation: (loading: boolean) => void;
    setSampleRenderAs: (mode: 'auto' | 'sphere' | 'volume') => void;
    setSphereRadiusMeters: (radius: number) => void;
    setVolumeRadiusMeters: (radius: number) => void;
  };
}

// ---------------------------------------------------------------------------
// Helper: shallow-merge update for chemrooms config
// ---------------------------------------------------------------------------

function updateConfig(
  state: ChemroomsSliceState,
  updates: Partial<ChemroomsConfig>,
): ChemroomsSliceState {
  return {
    chemrooms: {
      ...state.chemrooms,
      config: {...state.chemrooms.config, ...updates},
    },
  };
}

function updateRuntime(
  state: ChemroomsSliceState,
  updates: Partial<Omit<ChemroomsSliceState['chemrooms'], 'config'>>,
): ChemroomsSliceState {
  return {
    chemrooms: {...state.chemrooms, ...updates},
  };
}

// ---------------------------------------------------------------------------
// Slice creator
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ChemroomsConfig = {
  selectedEntity: null,
  timeSeriesAnalytes: [],
  coloringAnalyte: null,
  matrixFilter: null,
  ndMethod: 'half_dl',
  eventAgg: 'most_recent',
  dupAgg: 'avg',
  colorMode: 'concentration',
  selectedScreeningLevel: null,
  fractionFilter: null,
  sampleRenderAs: 'auto',
  sphereRadiusMeters: 3,
  volumeRadiusMeters: 1,
};

export function createChemroomsSlice(
  initialConfig?: Partial<ChemroomsConfig>,
): StateCreator<ChemroomsSliceState> {
  const config: ChemroomsConfig = {...DEFAULT_CONFIG, ...initialConfig};

  return createSlice<ChemroomsSliceState>((set) => ({
    chemrooms: {
      config,
      availableAnalytes: [],
      availableAnalyteNames: [],
      availableMatrices: [],
      availableScreeningLevels: [],
      aggregationRules: {},
      locationsVisible: true,
      samplesVisible: true,
      locationSummary: null,
      analytesAtLocation: [],
      crossSectionPoints: null,
      visSpecs: {},
      colorBy: {},
      personalLayers: [],
      bookmarkLayers: [],
      isLoadingFilters: false,
      isLoadingLocation: false,

      setSelectedEntity: (entity) =>
        set((state: ChemroomsSliceState) => {
          const wasChemduck =
            state.chemrooms.config.selectedEntity?.kind ===
            'chemduck-location';
          const isChemduck = entity?.kind === 'chemduck-location';
          return {
            chemrooms: {
              ...state.chemrooms,
              config: {
                ...state.chemrooms.config,
                selectedEntity: entity,
                // timeSeriesAnalytes is a chemduck-specific concept;
                // clear it when deselecting or switching to a vector
                // feature so the time-series panel doesn't show stale
                // charts against an unrelated selection.
                timeSeriesAnalytes: isChemduck
                  ? state.chemrooms.config.timeSeriesAnalytes
                  : [],
              },
              // Clear the chemduck summary cache when moving away
              // from a chemduck selection. useLocationDetail will
              // re-fetch when/if a new chemduck-location is selected.
              locationSummary:
                wasChemduck && !isChemduck
                  ? null
                  : state.chemrooms.locationSummary,
              analytesAtLocation:
                wasChemduck && !isChemduck
                  ? []
                  : state.chemrooms.analytesAtLocation,
            },
          };
        }),

      setSelectedLocation: (locationId, source = 'unknown') =>
        set((state: ChemroomsSliceState) => {
          const entity: SelectedEntity | null = locationId
            ? {kind: 'chemduck-location', locationId, source}
            : null;
          const wasChemduck =
            state.chemrooms.config.selectedEntity?.kind ===
            'chemduck-location';
          const isChemduck = entity !== null;
          return {
            chemrooms: {
              ...state.chemrooms,
              config: {
                ...state.chemrooms.config,
                selectedEntity: entity,
                timeSeriesAnalytes: isChemduck
                  ? state.chemrooms.config.timeSeriesAnalytes
                  : [],
              },
              locationSummary:
                wasChemduck && !isChemduck
                  ? null
                  : state.chemrooms.locationSummary,
              analytesAtLocation:
                wasChemduck && !isChemduck
                  ? []
                  : state.chemrooms.analytesAtLocation,
            },
          };
        }),

      setTimeSeriesAnalytes: (analytes) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {timeSeriesAnalytes: analytes.slice(0, 4)}),
        ),

      addTimeSeriesAnalyte: (analyte) =>
        set((state: ChemroomsSliceState) => {
          const current = state.chemrooms.config.timeSeriesAnalytes;
          if (current.length >= 4 || current.includes(analyte)) return state;
          return updateConfig(state, {
            timeSeriesAnalytes: [...current, analyte],
          });
        }),

      removeTimeSeriesAnalyte: (analyte) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {
            timeSeriesAnalytes:
              state.chemrooms.config.timeSeriesAnalytes.filter(
                (a) => a !== analyte,
              ),
          }),
        ),

      setColoringAnalyte: (analyte) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {coloringAnalyte: analyte}),
        ),

      setMatrixFilter: (matrix) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {matrixFilter: matrix}),
        ),

      setNdMethod: (method) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {ndMethod: method}),
        ),

      setEventAgg: (method) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {eventAgg: method}),
        ),

      setDupAgg: (method) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {dupAgg: method}),
        ),

      setColorMode: (mode) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {colorMode: mode}),
        ),

      setSelectedScreeningLevel: (name) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {selectedScreeningLevel: name}),
        ),

      setFractionFilter: (fraction) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {fractionFilter: fraction}),
        ),

      setLocationSummary: (summary) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {locationSummary: summary}),
        ),

      setAnalytesAtLocation: (analytes) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {analytesAtLocation: analytes}),
        ),

      setAvailableAnalytes: (analytes) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {availableAnalytes: analytes}),
        ),

      setAvailableAnalyteNames: (names) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {availableAnalyteNames: names}),
        ),

      setAggregationRules: (rules) =>
        set((state: ChemroomsSliceState) => {
          // Group by category
          const grouped: Record<string, AggregationRule[]> = {};
          for (const rule of rules) {
            if (!grouped[rule.category]) grouped[rule.category] = [];
            grouped[rule.category]!.push(rule);
          }
          for (const cat of Object.keys(grouped)) {
            grouped[cat]!.sort((a, b) => a.displayOrder - b.displayOrder);
          }
          return updateRuntime(state, {aggregationRules: grouped});
        }),

      setLocationsVisible: (visible) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {locationsVisible: visible}),
        ),

      setSamplesVisible: (visible) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {samplesVisible: visible}),
        ),

      setPersonalLayers: (layers) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {personalLayers: layers}),
        ),

      addPersonalLayer: (layer) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {
            personalLayers: [...state.chemrooms.personalLayers, layer],
          }),
        ),

      removePersonalLayer: (id) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {
            personalLayers: state.chemrooms.personalLayers.filter(
              (l) => l.id !== id,
            ),
          }),
        ),

      togglePersonalLayer: (id) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {
            personalLayers: state.chemrooms.personalLayers.map((l) =>
              l.id === id ? {...l, visible: !l.visible} : l,
            ),
          }),
        ),

      setBookmarkLayers: (layers) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {bookmarkLayers: layers}),
        ),

      toggleBookmarkLayer: (id) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {
            bookmarkLayers: state.chemrooms.bookmarkLayers.map((l) =>
              l.id === id ? {...l, visible: !l.visible} : l,
            ),
          }),
        ),

      /**
       * Move a bookmark layer into the personal-layers list, removing
       * it from bookmarks. The layer's id is preserved so toggles
       * remain consistent. The promoted layer's origin flips to
       * 'personal' so the next persist call writes it to localStorage.
       */
      promoteBookmarkLayer: (id) =>
        set((state: ChemroomsSliceState) => {
          const layer = state.chemrooms.bookmarkLayers.find((l) => l.id === id);
          if (!layer) return state;
          const promoted: LayerConfig = {...layer, origin: 'personal'};
          return updateRuntime(state, {
            bookmarkLayers: state.chemrooms.bookmarkLayers.filter(
              (l) => l.id !== id,
            ),
            personalLayers: [...state.chemrooms.personalLayers, promoted],
          });
        }),

      setAvailableMatrices: (matrices) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {availableMatrices: matrices}),
        ),

      setAvailableScreeningLevels: (levels) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {availableScreeningLevels: levels}),
        ),

      setCrossSectionPoints: (points) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {crossSectionPoints: points}),
        ),

      setVisSpec: (table, spec) =>
        set((state: ChemroomsSliceState) => {
          const nextSpecs = {...state.chemrooms.visSpecs, [table]: spec};
          // Auto-select defaultColorBy if no selection has been made yet
          const nextColorBy = {...state.chemrooms.colorBy};
          if (
            !(table in nextColorBy) &&
            spec.defaultColorBy &&
            spec.columns[spec.defaultColorBy]
          ) {
            nextColorBy[table] = spec.defaultColorBy;
          }
          return updateRuntime(state, {
            visSpecs: nextSpecs,
            colorBy: nextColorBy,
          });
        }),

      setColorBy: (table, column) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {
            colorBy: {...state.chemrooms.colorBy, [table]: column},
          }),
        ),

      setIsLoadingFilters: (loading) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {isLoadingFilters: loading}),
        ),

      setIsLoadingLocation: (loading) =>
        set((state: ChemroomsSliceState) =>
          updateRuntime(state, {isLoadingLocation: loading}),
        ),

      setSampleRenderAs: (mode) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {sampleRenderAs: mode}),
        ),

      setSphereRadiusMeters: (radius) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {sphereRadiusMeters: radius}),
        ),

      setVolumeRadiusMeters: (radius) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {volumeRadiusMeters: radius}),
        ),
    },
  }));
}

// ---------------------------------------------------------------------------
// Combined type + typed hook
// ---------------------------------------------------------------------------

export type RoomStateWithChemrooms = RoomShellSliceState &
  CesiumSliceState &
  ChemroomsSliceState &
  MosaicSliceState &
  SqlEditorSliceState;

export function useChemroomsStore<T>(
  selector: (state: RoomStateWithChemrooms) => T,
): T {
  return useBaseRoomShellStore<RoomStateWithChemrooms, T>((state) =>
    selector(state as RoomStateWithChemrooms),
  );
}
