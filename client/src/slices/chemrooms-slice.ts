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

export interface ChemroomsConfig {
  selectedLocationId: string | null;
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
    locationSummary: LocationSummary | null;
    analytesAtLocation: AnalyteInfo[];
    crossSectionPoints: CrossSectionPoints;
    /** Vis specs loaded from `<table>.vis.json` sidecars, keyed by table. */
    visSpecs: Record<string, VisSpec>;
    /** Active color-by column per table; null = no coloring. */
    colorBy: ColorBySelection;
    isLoadingFilters: boolean;
    isLoadingLocation: boolean;
    // Actions
    setSelectedLocation: (locationId: string | null) => void;
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
    setCrossSectionPoints: (points: CrossSectionPoints) => void;
    setVisSpec: (table: string, spec: VisSpec) => void;
    setColorBy: (table: string, column: string | null) => void;
    setIsLoadingFilters: (loading: boolean) => void;
    setIsLoadingLocation: (loading: boolean) => void;
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
  selectedLocationId: null,
  timeSeriesAnalytes: [],
  coloringAnalyte: null,
  matrixFilter: null,
  ndMethod: 'half_dl',
  eventAgg: 'most_recent',
  dupAgg: 'avg',
  colorMode: 'concentration',
  selectedScreeningLevel: null,
  fractionFilter: null,
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
      locationSummary: null,
      analytesAtLocation: [],
      crossSectionPoints: null,
      visSpecs: {},
      colorBy: {},
      isLoadingFilters: false,
      isLoadingLocation: false,

      setSelectedLocation: (locationId) =>
        set((state: ChemroomsSliceState) => ({
          chemrooms: {
            ...state.chemrooms,
            config: {
              ...state.chemrooms.config,
              selectedLocationId: locationId,
              timeSeriesAnalytes: locationId
                ? state.chemrooms.config.timeSeriesAnalytes
                : [],
            },
            locationSummary: locationId
              ? state.chemrooms.locationSummary
              : null,
            analytesAtLocation: locationId
              ? state.chemrooms.analytesAtLocation
              : [],
          },
        })),

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
