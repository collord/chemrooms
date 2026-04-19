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
  isEphemeralLayer,
  loadPersonalLayers,
  migratePersonalLayers,
  removePersonalLayer,
  togglePersonalLayerVisibility,
  savePersonalLayers,
} from './layerStorage';
import {
  freezeCurrentState,
  GeoParquetDataSource,
  type LayerConfig,
} from './layerSchema';

function makeEphemeralGeoparquetLayer(name = 'dropped wells'): LayerConfig {
  const ds = GeoParquetDataSource.parse({
    type: 'geoparquet',
    url: `session:${encodeURIComponent(name)}.parquet`,
    tableName: `t_${name.replace(/\W/g, '_')}_abc123`,
  });
  return {
    version: 1,
    id: 'placeholder',
    name,
    dataSource: ds,
    visual: {
      renderType: 'point',
      colorBy: null,
      pointSize: 8,
      opacity: 1,
      color: '#00ffff',
      sampleRenderAs: 'auto',
      sphereRadiusMeters: 2,
      volumeRadiusMeters: 1,
    },
    visible: true,
    createdAt: '2026-04-13T00:00:00Z',
    origin: 'personal',
  };
}

function makeLegacyFileUrlLayer(name = 'legacy wells'): LayerConfig {
  // Simulates a layer persisted by a pre-fix version of addPersonalLayer
  // that used the file:// scheme for dropped files.
  const ds = GeoParquetDataSource.parse({
    type: 'geoparquet',
    url: `file://${name}.parquet`,
    tableName: 't_legacy_abc123',
  });
  return {
    version: 1,
    id: 'placeholder',
    name,
    dataSource: ds,
    visual: {
      renderType: 'point',
      colorBy: null,
      pointSize: 8,
      opacity: 1,
      color: '#00ffff',
      sampleRenderAs: 'auto',
      sphereRadiusMeters: 2,
      volumeRadiusMeters: 1,
    },
    visible: true,
    createdAt: '2026-04-13T00:00:00Z',
    origin: 'personal',
  };
}

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

describe('isEphemeralLayer', () => {
  it('returns true for geoparquet layers with session: URLs', () => {
    expect(isEphemeralLayer(makeEphemeralGeoparquetLayer())).toBe(true);
  });

  it('returns true for geoparquet layers with legacy file:// URLs', () => {
    expect(isEphemeralLayer(makeLegacyFileUrlLayer())).toBe(true);
  });

  it('returns false for chemduck layers', async () => {
    const layer = await freezeCurrentState(baseParams);
    expect(isEphemeralLayer(layer)).toBe(false);
  });

  it('returns false for geoparquet layers with http(s) URLs', () => {
    const ds = GeoParquetDataSource.parse({
      type: 'geoparquet',
      url: 'https://example.com/wells.parquet',
      tableName: 'wells',
    });
    const layer: LayerConfig = {
      version: 1,
      id: 'x',
      name: 'wells',
      dataSource: ds,
      visual: {
        renderType: 'point',
        colorBy: null,
        pointSize: 8,
        opacity: 1,
        color: '#00ffff',
        sampleRenderAs: 'auto',
        sphereRadiusMeters: 2,
        volumeRadiusMeters: 1,
      },
      visible: true,
      createdAt: '2026-04-13T00:00:00Z',
      origin: 'personal',
    };
    expect(isEphemeralLayer(layer)).toBe(false);
  });
});

describe('addPersonalLayer with ephemeral layers', () => {
  it('returns the layer in the list but does not persist it', async () => {
    const ephemeral = makeEphemeralGeoparquetLayer();
    const res = await addPersonalLayer(ephemeral);
    expect(res.added).toBe(true);
    expect(res.persisted).toBe(false);
    expect(res.layers).toHaveLength(1);
    // localStorage should be untouched
    expect(loadPersonalLayers()).toHaveLength(0);
  });

  it('preserves ephemeral layers in currentList when adding a non-ephemeral', async () => {
    const ephemeral = makeEphemeralGeoparquetLayer('dropped-a');
    const eph2 = makeEphemeralGeoparquetLayer('dropped-b');

    // Seed the in-memory list with two ephemeral layers
    const afterFirst = await addPersonalLayer(ephemeral, []);
    const afterSecond = await addPersonalLayer(eph2, afterFirst.layers);
    expect(afterSecond.layers).toHaveLength(2);
    expect(loadPersonalLayers()).toHaveLength(0); // still nothing persisted

    // Now add a chemduck layer with the ephemeral list as currentList
    const chemduck = await freezeCurrentState(baseParams);
    const afterChemduck = await addPersonalLayer(
      chemduck,
      afterSecond.layers,
    );
    // The returned list should have all three
    expect(afterChemduck.layers).toHaveLength(3);
    // But only the chemduck one should be in localStorage
    const persisted = loadPersonalLayers();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.id).toBe(chemduck.id);
  });

  it('dedupes ephemeral layers by content hash', async () => {
    const a = makeEphemeralGeoparquetLayer('same');
    const first = await addPersonalLayer(a, []);
    // Re-add the same ephemeral layer
    const second = await addPersonalLayer(a, first.layers);
    expect(second.added).toBe(false);
    expect(second.layers).toHaveLength(1);
  });
});

describe('migratePersonalLayers cleanup of ephemeral layers', () => {
  it('strips legacy file:// geoparquet layers from storage', async () => {
    const chemduck = await freezeCurrentState(baseParams);
    const ephemeral = makeLegacyFileUrlLayer();
    savePersonalLayers([chemduck, ephemeral]);

    const migrated = await migratePersonalLayers();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]!.id).toBe(chemduck.id);
    // localStorage should have been rewritten without the ephemeral
    expect(loadPersonalLayers()).toHaveLength(1);
  });

  it('strips session: geoparquet layers from storage', async () => {
    const chemduck = await freezeCurrentState(baseParams);
    const ephemeral = makeEphemeralGeoparquetLayer();
    savePersonalLayers([chemduck, ephemeral]);

    const migrated = await migratePersonalLayers();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]!.id).toBe(chemduck.id);
  });

  it('preserves http(s) geoparquet layers', async () => {
    const ds = GeoParquetDataSource.parse({
      type: 'geoparquet',
      url: 'https://example.com/wells.parquet',
      tableName: 'wells',
    });
    const layer: LayerConfig = {
      version: 1,
      id: 'will-be-rehashed',
      name: 'url-backed wells',
      dataSource: ds,
      visual: {
        renderType: 'point',
        colorBy: null,
        pointSize: 8,
        opacity: 1,
        sampleRenderAs: 'auto',
        sphereRadiusMeters: 2,
        volumeRadiusMeters: 1,
        color: '#00ffff',
      },
      visible: true,
      createdAt: '2026-04-13T00:00:00Z',
      origin: 'personal',
    };
    savePersonalLayers([layer]);

    const migrated = await migratePersonalLayers();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]!.dataSource.type).toBe('geoparquet');
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

  it('preserves ephemeral neighbors when currentList is passed', async () => {
    const chemduck = await freezeCurrentState(baseParams);
    const ephemeral = makeEphemeralGeoparquetLayer();

    // Simulate a slice containing both a persisted chemduck layer
    // and an ephemeral dropped-file layer.
    const sliceState = [
      {...chemduck, origin: 'personal' as const},
      ephemeral,
    ];
    savePersonalLayers([chemduck]); // only chemduck is persisted

    const result = togglePersonalLayerVisibility(chemduck.id, sliceState);
    // The returned list still has both layers
    expect(result).toHaveLength(2);
    expect(result.some((l) => l.id === ephemeral.id)).toBe(true);
    // localStorage still has only the chemduck layer
    expect(loadPersonalLayers()).toHaveLength(1);
  });

  it('can toggle an ephemeral layer without persisting it', async () => {
    const ephemeral = makeEphemeralGeoparquetLayer();
    const sliceState = [ephemeral];

    const result = togglePersonalLayerVisibility(ephemeral.id, sliceState);
    expect(result).toHaveLength(1);
    expect(result[0]!.visible).toBe(false);
    expect(loadPersonalLayers()).toHaveLength(0);
  });
});

describe('removePersonalLayer with ephemerals', () => {
  it('preserves ephemeral neighbors when currentList is passed', async () => {
    const chemduck = await freezeCurrentState(baseParams);
    const ephemeral = makeEphemeralGeoparquetLayer();
    const sliceState = [
      {...chemduck, origin: 'personal' as const},
      ephemeral,
    ];
    savePersonalLayers([chemduck]);

    const result = removePersonalLayer(chemduck.id, sliceState);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(ephemeral.id);
    expect(loadPersonalLayers()).toHaveLength(0);
  });

  it('can remove an ephemeral layer from the slice', async () => {
    const ephemeral = makeEphemeralGeoparquetLayer();
    const result = removePersonalLayer(ephemeral.id, [ephemeral]);
    expect(result).toHaveLength(0);
  });
});
