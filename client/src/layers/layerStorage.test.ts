/**
 * Behavioral contract tests for personal-layer storage.
 *
 * Locks down: dedupe by content hash on add, idempotent migration of
 * legacy UUID-based layers, and remove-by-id. Uses happy-dom's
 * localStorage for persistence.
 */

import {describe, it, expect, beforeEach} from 'vitest';
import {
  addPersonalLayer,
  loadPersonalLayers,
  migratePersonalLayers,
  removePersonalLayer,
  togglePersonalLayerVisibility,
  savePersonalLayers,
} from './layerStorage';
import {freezeCurrentState, type LayerConfig} from './layerSchema';

const baseParams = {
  name: 'Benzene most recent',
  analyte: 'Benzene',
  matrix: 'groundwater',
  eventAgg: 'most_recent',
  dupAgg: 'avg',
  ndMethod: 'half_dl',
  colorBy: 'result',
};

beforeEach(() => {
  localStorage.clear();
});

describe('addPersonalLayer', () => {
  it('adds a fresh layer and reports added: true', async () => {
    const layer = await freezeCurrentState(baseParams);
    const result = await addPersonalLayer(layer);
    expect(result.added).toBe(true);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]!.id).toBe(layer.id);
  });

  it('dedupes by content hash on a second add', async () => {
    const layer = await freezeCurrentState(baseParams);
    await addPersonalLayer(layer);
    const second = await addPersonalLayer(layer);
    expect(second.added).toBe(false);
    expect(second.layers).toHaveLength(1);
  });

  it('dedupes layers with different cosmetic names but the same recipe', async () => {
    const a = await freezeCurrentState({...baseParams, name: 'Display A'});
    const b = await freezeCurrentState({...baseParams, name: 'Display B'});
    expect(a.id).toBe(b.id); // sanity — same recipe, same hash
    await addPersonalLayer(a);
    const second = await addPersonalLayer(b);
    expect(second.added).toBe(false);
    expect(second.layers).toHaveLength(1);
  });

  it('keeps distinct layers with different recipes', async () => {
    const benzene = await freezeCurrentState(baseParams);
    const toluene = await freezeCurrentState({
      ...baseParams,
      analyte: 'Toluene',
    });
    await addPersonalLayer(benzene);
    const second = await addPersonalLayer(toluene);
    expect(second.added).toBe(true);
    expect(second.layers).toHaveLength(2);
  });

  it('persists added layers across loadPersonalLayers calls', async () => {
    const layer = await freezeCurrentState(baseParams);
    await addPersonalLayer(layer);
    const loaded = loadPersonalLayers();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe(layer.id);
  });

  it('rehashes the input on add (so a wrong-id input is normalized)', async () => {
    const layer = await freezeCurrentState(baseParams);
    const tampered: LayerConfig = {...layer, id: 'wrong-id'};
    const result = await addPersonalLayer(tampered);
    expect(result.id).toBe(layer.id); // canonical hash, not the wrong one
    expect(result.layers[0]!.id).toBe(layer.id);
  });
});

describe('migratePersonalLayers', () => {
  it('is a no-op on empty storage', async () => {
    const result = await migratePersonalLayers();
    expect(result).toHaveLength(0);
  });

  it('rehashes a layer with a UUID id to its content hash', async () => {
    const layer = await freezeCurrentState(baseParams);
    const legacy: LayerConfig = {
      ...layer,
      id: '550e8400-e29b-41d4-a716-446655440000',
    };
    savePersonalLayers([legacy]);

    const migrated = await migratePersonalLayers();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]!.id).toBe(layer.id);
    expect(migrated[0]!.id).not.toBe(legacy.id);
  });

  it('is idempotent — running migration twice on already-hashed data is a no-op', async () => {
    const layer = await freezeCurrentState(baseParams);
    await addPersonalLayer(layer);

    const first = await migratePersonalLayers();
    const second = await migratePersonalLayers();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.id).toBe(second[0]!.id);
  });

  it('dedupes when two legacy layers collapse to the same content hash', async () => {
    const layer = await freezeCurrentState(baseParams);
    const legacyA: LayerConfig = {...layer, id: 'uuid-a', name: 'A'};
    const legacyB: LayerConfig = {...layer, id: 'uuid-b', name: 'B'};
    savePersonalLayers([legacyA, legacyB]);

    const migrated = await migratePersonalLayers();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]!.id).toBe(layer.id);
  });

  it('preserves distinct layers with distinct content', async () => {
    const benzene = await freezeCurrentState(baseParams);
    const toluene = await freezeCurrentState({
      ...baseParams,
      analyte: 'Toluene',
    });
    savePersonalLayers([
      {...benzene, id: 'uuid-1'},
      {...toluene, id: 'uuid-2'},
    ]);

    const migrated = await migratePersonalLayers();
    expect(migrated).toHaveLength(2);
    const ids = migrated.map((l) => l.id).sort();
    expect(ids).toEqual([benzene.id, toluene.id].sort());
  });
});

describe('removePersonalLayer', () => {
  it('removes a layer by id', async () => {
    const layer = await freezeCurrentState(baseParams);
    await addPersonalLayer(layer);
    const after = removePersonalLayer(layer.id);
    expect(after).toHaveLength(0);
    expect(loadPersonalLayers()).toHaveLength(0);
  });

  it('is a no-op for an unknown id', async () => {
    const layer = await freezeCurrentState(baseParams);
    await addPersonalLayer(layer);
    const after = removePersonalLayer('not-a-real-id');
    expect(after).toHaveLength(1);
  });
});

describe('togglePersonalLayerVisibility', () => {
  it('flips visible from true to false and back', async () => {
    const layer = await freezeCurrentState(baseParams);
    await addPersonalLayer(layer);

    const afterFirst = togglePersonalLayerVisibility(layer.id);
    expect(afterFirst[0]!.visible).toBe(false);

    const afterSecond = togglePersonalLayerVisibility(layer.id);
    expect(afterSecond[0]!.visible).toBe(true);
  });
});
