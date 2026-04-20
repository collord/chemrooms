/**
 * Tests for derived selectors.
 *
 * These are pure functions: state in, derived value out. No React,
 * no mocks, no DuckDB. The tests verify the selector contract —
 * that the right fields are extracted from the right places, and
 * that the shape matches what consumers (FreezeLayerButton,
 * InspectorPanel, ChemroomsEntityLayers) expect.
 */

import {describe, it, expect} from 'vitest';
import {
  selectCurrentRecipe,
  selectColorByResults,
  selectSelectedEntity,
  selectTimeSeriesAnalytes,
} from './selectors';
import type {RoomStateWithChemrooms} from './chemrooms-slice';

/** Minimal mock state that satisfies the selector reads. */
function mockState(
  overrides: {
    config?: Partial<RoomStateWithChemrooms['chemrooms']['config']>;
    colorBy?: Record<string, string | null>;
  } = {},
): RoomStateWithChemrooms {
  return {
    chemrooms: {
      config: {
        selectedEntity: null,
        timeSeriesAnalytes: [],
        coloringAnalyte: 'Benzene',
        matrixFilter: 'groundwater',
        ndMethod: 'half_dl',
        eventAgg: 'most_recent',
        dupAgg: 'avg',
        colorMode: 'concentration',
        selectedScreeningLevel: null,
        fractionFilter: null,
        sampleRenderAs: 'auto',
        sphereRadiusMeters: 2,
        volumeRadiusMeters: 1,
        ...overrides.config,
      },
      colorBy: overrides.colorBy ?? {
        v_results_denormalized: 'result',
      },
    },
  } as unknown as RoomStateWithChemrooms;
}

describe('selectCurrentRecipe', () => {
  it('extracts all recipe fields from the config', () => {
    const state = mockState();
    const recipe = selectCurrentRecipe(state);
    expect(recipe).toEqual({
      coloringAnalyte: 'Benzene',
      matrixFilter: 'groundwater',
      eventAgg: 'most_recent',
      dupAgg: 'avg',
      ndMethod: 'half_dl',
      sampleRenderAs: 'auto',
      sphereRadiusMeters: 2,
      volumeRadiusMeters: 1,
      fractionFilter: null,
    });
  });

  it('reflects changes in individual fields', () => {
    const state = mockState({config: {coloringAnalyte: 'Lead', eventAgg: 'maximum'}});
    const recipe = selectCurrentRecipe(state);
    expect(recipe.coloringAnalyte).toBe('Lead');
    expect(recipe.eventAgg).toBe('maximum');
  });

  it('returns null matrixFilter when not set', () => {
    const state = mockState({config: {matrixFilter: null}});
    expect(selectCurrentRecipe(state).matrixFilter).toBeNull();
  });
});

describe('selectColorByResults', () => {
  it('returns the v_results_denormalized colorBy column', () => {
    const state = mockState();
    expect(selectColorByResults(state)).toBe('result');
  });

  it('returns null when no colorBy is set', () => {
    const state = mockState({colorBy: {}});
    expect(selectColorByResults(state)).toBeNull();
  });
});

describe('selectSelectedEntity', () => {
  it('returns null when nothing is selected', () => {
    const state = mockState();
    expect(selectSelectedEntity(state)).toBeNull();
  });

  it('returns a chemduck-location entity', () => {
    const entity = {
      kind: 'chemduck-location' as const,
      locationId: 'MW-001',
      source: 'samples',
    };
    const state = mockState({config: {selectedEntity: entity}});
    expect(selectSelectedEntity(state)).toEqual(entity);
  });

  it('returns a vector-feature entity', () => {
    const entity = {
      kind: 'vector-feature' as const,
      layerId: 'personal:abc',
      featureId: 'row-1',
      label: 'Parcel A',
      properties: {owner: 'Smith'},
    };
    const state = mockState({config: {selectedEntity: entity}});
    expect(selectSelectedEntity(state)).toEqual(entity);
  });
});

describe('selectTimeSeriesAnalytes', () => {
  it('returns empty array by default', () => {
    const state = mockState();
    expect(selectTimeSeriesAnalytes(state)).toEqual([]);
  });

  it('returns the selected analytes', () => {
    const state = mockState({
      config: {timeSeriesAnalytes: ['Benzene', 'Lead']},
    });
    expect(selectTimeSeriesAnalytes(state)).toEqual(['Benzene', 'Lead']);
  });
});
