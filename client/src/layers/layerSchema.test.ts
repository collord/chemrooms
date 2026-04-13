/**
 * Behavioral contract tests for layer schema operations.
 *
 * Locks down: the freeze→hash contract (frozen layers' ids equal their
 * content hash), parseLayerConfig acceptance/rejection, and the bookmark
 * URL serialization round-trip.
 */

import {describe, it, expect} from 'vitest';
import {
  ContentHash,
  freezeCurrentState,
  parseLayerConfig,
  serializeLayerForUrl,
  deserializeLayerFromUrl,
} from './layerSchema';
import {computeLayerHash} from './layerHash';

const baseFreezeParams = {
  name: 'Benzene most recent',
  analyte: 'Benzene',
  matrix: 'groundwater',
  eventAgg: 'most_recent',
  dupAgg: 'avg',
  ndMethod: 'half_dl',
  colorBy: 'result',
};

describe('freezeCurrentState', () => {
  it('returns a layer whose id equals its own content hash', async () => {
    const layer = await freezeCurrentState(baseFreezeParams);
    const expected = await computeLayerHash(layer);
    expect(layer.id).toBe(expected);
  });

  it('produces the same id for two freezes of the same recipe', async () => {
    const a = await freezeCurrentState(baseFreezeParams);
    const b = await freezeCurrentState(baseFreezeParams);
    expect(a.id).toBe(b.id);
  });

  it('produces a different id when the recipe changes', async () => {
    const a = await freezeCurrentState(baseFreezeParams);
    const b = await freezeCurrentState({
      ...baseFreezeParams,
      analyte: 'Toluene',
    });
    expect(a.id).not.toBe(b.id);
  });

  it('produces the same id when only the cosmetic name differs', async () => {
    const a = await freezeCurrentState(baseFreezeParams);
    const b = await freezeCurrentState({
      ...baseFreezeParams,
      name: 'totally different display name',
    });
    expect(a.id).toBe(b.id);
  });

  it('marks frozen layers as origin: personal', async () => {
    const layer = await freezeCurrentState(baseFreezeParams);
    expect(layer.origin).toBe('personal');
  });

  it('sets visible: true by default', async () => {
    const layer = await freezeCurrentState(baseFreezeParams);
    expect(layer.visible).toBe(true);
  });
});

describe('parseLayerConfig', () => {
  it('accepts a minimal valid layer', () => {
    const result = parseLayerConfig({
      version: 1,
      id: 'abc123',
      name: 'test',
      dataSource: {type: 'chemduck'},
    });
    expect(result).not.toBeNull();
    expect(result?.id).toBe('abc123');
  });

  it('accepts a layer with a query block', () => {
    const result = parseLayerConfig({
      version: 1,
      id: 'abc123',
      name: 'test',
      dataSource: {type: 'chemduck'},
      query: {
        analyte: 'Benzene',
        matrix: 'groundwater',
        eventAgg: 'most_recent',
        dupAgg: 'avg',
        ndMethod: 'half_dl',
      },
    });
    expect(result).not.toBeNull();
    expect(result?.query?.analyte).toBe('Benzene');
  });

  it('rejects garbage input', () => {
    expect(parseLayerConfig({nope: true})).toBeNull();
    expect(parseLayerConfig(null)).toBeNull();
    expect(parseLayerConfig('not an object')).toBeNull();
    expect(parseLayerConfig(42)).toBeNull();
  });

  it('rejects a layer missing required fields (id, name)', () => {
    // Only id and name are strictly required — dataSource, visual, version,
    // and visible all have schema defaults.
    expect(parseLayerConfig({version: 1})).toBeNull();
    expect(parseLayerConfig({id: 'x'})).toBeNull(); // missing name
    expect(parseLayerConfig({name: 'y'})).toBeNull(); // missing id
  });

  it('fills in defaults when only id and name are provided', () => {
    const result = parseLayerConfig({id: 'x', name: 'y'});
    expect(result).not.toBeNull();
    expect(result?.dataSource.type).toBe('chemduck');
    expect(result?.visible).toBe(true);
  });
});

describe('ContentHash schema', () => {
  const validHex64 =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('accepts a properly formatted sha256 prefix', () => {
    expect(ContentHash.safeParse(`sha256:${validHex64}`).success).toBe(true);
  });

  it('rejects bare hex without algorithm prefix', () => {
    expect(ContentHash.safeParse(validHex64).success).toBe(false);
  });

  it('rejects the wrong algorithm prefix', () => {
    expect(ContentHash.safeParse(`md5:${validHex64}`).success).toBe(false);
  });

  it('rejects the wrong hex length', () => {
    expect(ContentHash.safeParse('sha256:abc').success).toBe(false);
    expect(ContentHash.safeParse(`sha256:${validHex64}ff`).success).toBe(false);
  });

  it('rejects uppercase hex', () => {
    expect(ContentHash.safeParse(`sha256:${validHex64.toUpperCase()}`).success).toBe(false);
  });
});

describe('parseLayerConfig with pinned URL data sources', () => {
  const pinHash =
    'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('accepts a geoparquet source with expectedHash', () => {
    const result = parseLayerConfig({
      version: 1,
      id: 'abc',
      name: 'pinned wells',
      dataSource: {
        type: 'geoparquet',
        url: 'https://example.com/wells.parquet',
        tableName: 'wells',
        expectedHash: pinHash,
      },
    });
    expect(result).not.toBeNull();
    expect(
      result?.dataSource.type === 'geoparquet' &&
        result.dataSource.expectedHash,
    ).toBe(pinHash);
  });

  it('rejects a geoparquet source with a malformed expectedHash', () => {
    const result = parseLayerConfig({
      version: 1,
      id: 'abc',
      name: 'bad pin',
      dataSource: {
        type: 'geoparquet',
        url: 'https://example.com/wells.parquet',
        tableName: 'wells',
        expectedHash: 'not-a-real-hash',
      },
    });
    expect(result).toBeNull();
  });

  it('accepts a geoparquet source without expectedHash (floating)', () => {
    const result = parseLayerConfig({
      version: 1,
      id: 'abc',
      name: 'floating wells',
      dataSource: {
        type: 'geoparquet',
        url: 'https://example.com/wells.parquet',
        tableName: 'wells',
      },
    });
    expect(result).not.toBeNull();
    expect(
      result?.dataSource.type === 'geoparquet' &&
        result.dataSource.expectedHash,
    ).toBeUndefined();
  });
});

describe('bookmark URL serialization round-trip', () => {
  it('preserves the layer id through serialize → deserialize', async () => {
    const layer = await freezeCurrentState(baseFreezeParams);
    const encoded = serializeLayerForUrl(layer);
    const decoded = deserializeLayerFromUrl(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(layer.id);
  });

  it('preserves the recipe such that the rehashed layer matches', async () => {
    // After deserializing, computing the hash should yield the same id.
    // This is the property that makes bookmark-shared layers dedupe
    // against personal layers with the same recipe.
    const layer = await freezeCurrentState(baseFreezeParams);
    const decoded = deserializeLayerFromUrl(serializeLayerForUrl(layer));
    expect(decoded).not.toBeNull();
    const rehashed = await computeLayerHash(decoded!);
    expect(rehashed).toBe(layer.id);
  });

  it('marks deserialized layers as origin: bookmark', async () => {
    const layer = await freezeCurrentState(baseFreezeParams);
    const decoded = deserializeLayerFromUrl(serializeLayerForUrl(layer));
    expect(decoded?.origin).toBe('bookmark');
  });

  it('returns null on garbage URL input', () => {
    expect(deserializeLayerFromUrl('not-valid-json-encoded')).toBeNull();
    expect(deserializeLayerFromUrl('%7B%22nope%22%3Atrue%7D')).toBeNull();
  });
});
