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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NonDetectMethod = 'half_dl' | 'at_dl' | 'zero' | 'exclude';
export type ChoroplethAggMethod = 'most_recent' | 'maximum' | 'mean';
export type ColorMode = 'concentration' | 'exceedance';

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
  choroplethAnalyte: string | null;
  matrixFilter: string | null;
  nonDetectMethod: NonDetectMethod;
  choroplethAggMethod: ChoroplethAggMethod;
  colorMode: ColorMode;
  selectedScreeningLevel: string | null;
  fractionFilter: string | null;
}

/** Lon/lat pairs for the two cross-section endpoints (degrees). */
export type CrossSectionPoints = [[number, number], [number, number]] | null;

export interface ChemroomsSliceState {
  chemrooms: {
    config: ChemroomsConfig;
    // Runtime state
    availableAnalytes: AnalyteInfo[];
    availableMatrices: string[];
    availableScreeningLevels: string[];
    locationSummary: LocationSummary | null;
    analytesAtLocation: AnalyteInfo[];
    crossSectionPoints: CrossSectionPoints;
    isLoadingFilters: boolean;
    isLoadingLocation: boolean;
    // Actions
    setSelectedLocation: (locationId: string | null) => void;
    setTimeSeriesAnalytes: (analytes: string[]) => void;
    addTimeSeriesAnalyte: (analyte: string) => void;
    removeTimeSeriesAnalyte: (analyte: string) => void;
    setChoroplethAnalyte: (analyte: string | null) => void;
    setMatrixFilter: (matrix: string | null) => void;
    setNonDetectMethod: (method: NonDetectMethod) => void;
    setChoroplethAggMethod: (method: ChoroplethAggMethod) => void;
    setColorMode: (mode: ColorMode) => void;
    setSelectedScreeningLevel: (name: string | null) => void;
    setFractionFilter: (fraction: string | null) => void;
    setLocationSummary: (summary: LocationSummary | null) => void;
    setAnalytesAtLocation: (analytes: AnalyteInfo[]) => void;
    setAvailableAnalytes: (analytes: AnalyteInfo[]) => void;
    setAvailableMatrices: (matrices: string[]) => void;
    setAvailableScreeningLevels: (levels: string[]) => void;
    setCrossSectionPoints: (points: CrossSectionPoints) => void;
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
  choroplethAnalyte: null,
  matrixFilter: null,
  nonDetectMethod: 'half_dl',
  choroplethAggMethod: 'most_recent',
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
      availableMatrices: [],
      availableScreeningLevels: [],
      locationSummary: null,
      analytesAtLocation: [],
      crossSectionPoints: null,
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

      setChoroplethAnalyte: (analyte) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {choroplethAnalyte: analyte}),
        ),

      setMatrixFilter: (matrix) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {matrixFilter: matrix}),
        ),

      setNonDetectMethod: (method) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {nonDetectMethod: method}),
        ),

      setChoroplethAggMethod: (method) =>
        set((state: ChemroomsSliceState) =>
          updateConfig(state, {choroplethAggMethod: method}),
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
