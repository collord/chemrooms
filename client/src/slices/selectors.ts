/**
 * Derived selectors for the chemrooms slice.
 *
 * Extract multi-field reads into named selectors so:
 *  - components subscribe to one object instead of N individual fields
 *  - the "recipe" concept is first-class rather than ad-hoc
 *  - adding a new recipe field means updating one selector, not
 *    every component that uses the recipe
 *
 * Pair with `useShallow` from zustand/react/shallow at call sites
 * so the shallow-equality check prevents re-renders when no field
 * in the selected object actually changed.
 */

import type {RoomStateWithChemrooms} from './chemrooms-slice';

/**
 * The "current recipe" — the full set of user intent that drives
 * the active view (analyte, filters, aggregation, rendering config).
 * This is what freezeCurrentState captures when the user clicks
 * "Freeze layer."
 */
export function selectCurrentRecipe(s: RoomStateWithChemrooms) {
  return {
    coloringAnalyte: s.chemrooms.config.coloringAnalyte,
    matrixFilter: s.chemrooms.config.matrixFilter,
    eventAgg: s.chemrooms.config.eventAgg,
    dupAgg: s.chemrooms.config.dupAgg,
    ndMethod: s.chemrooms.config.ndMethod,
    sampleRenderAs: s.chemrooms.config.sampleRenderAs,
    sphereRadiusMeters: s.chemrooms.config.sphereRadiusMeters,
    volumeRadiusMeters: s.chemrooms.config.volumeRadiusMeters,
    fractionFilter: s.chemrooms.config.fractionFilter,
  };
}

/**
 * The colorBy column for the primary results view. Used by
 * FreezeLayerButton and the entity rendering pipeline.
 */
export function selectColorByResults(s: RoomStateWithChemrooms) {
  return s.chemrooms.colorBy['v_results_denormalized'] ?? null;
}

/**
 * The currently selected entity (for the Inspector panel).
 */
export function selectSelectedEntity(s: RoomStateWithChemrooms) {
  return s.chemrooms.config.selectedEntity;
}

/**
 * The time-series analyte selection (for the chart panel).
 */
export function selectTimeSeriesAnalytes(s: RoomStateWithChemrooms) {
  return s.chemrooms.config.timeSeriesAnalytes;
}
