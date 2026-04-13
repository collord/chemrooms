/**
 * Behavioral contract tests for layer content hashing.
 *
 * These tests pin down the *properties* of the hash function — determinism,
 * cosmetic-field stability, essential-field sensitivity — independent of
 * the exact canonicalization or hash algorithm. They must continue to pass
 * across schema refactors, because they describe what consumers of the
 * hash actually rely on (dedupe, identity, share-by-recipe).
 */

import {describe, it, expect} from 'vitest';
import {computeLayerHash, isHashedId} from './layerHash';
import type {LayerConfig} from './layerSchema';

function makeLayer(overrides: Partial<LayerConfig> = {}): LayerConfig {
  return {
    version: 1,
    id: 'placeholder',
    name: 'Benzene — most_recent',
    dataSource: {type: 'chemduck'},
    query: {
      analyte: 'Benzene',
      matrix: 'groundwater',
      startDate: null,
      endDate: null,
      eventAgg: 'most_recent',
      dupAgg: 'avg',
      ndMethod: 'half_dl',
    },
    visual: {
      renderType: 'point',
      colorBy: 'result',
      pointSize: 8,
      opacity: 1,
      color: '#00ffff',
    },
    visible: true,
    createdAt: '2026-04-12T00:00:00Z',
    origin: 'personal',
    ...overrides,
  };
}

describe('computeLayerHash', () => {
  it('is deterministic — same input produces same hash', async () => {
    const layer = makeLayer();
    const h1 = await computeLayerHash(layer);
    const h2 = await computeLayerHash(layer);
    expect(h1).toBe(h2);
  });

  it('produces a 16-character lowercase hex string', async () => {
    const hash = await computeLayerHash(makeLayer());
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  describe('cosmetic-field stability — these must NOT affect the hash', () => {
    it('ignores name', async () => {
      const a = await computeLayerHash(makeLayer({name: 'A'}));
      const b = await computeLayerHash(makeLayer({name: 'B'}));
      expect(a).toBe(b);
    });

    it('ignores description', async () => {
      const a = await computeLayerHash(makeLayer({description: 'one'}));
      const b = await computeLayerHash(makeLayer({description: 'two'}));
      expect(a).toBe(b);
    });

    it('ignores createdAt', async () => {
      const a = await computeLayerHash(makeLayer({createdAt: '2020-01-01'}));
      const b = await computeLayerHash(makeLayer({createdAt: '2030-01-01'}));
      expect(a).toBe(b);
    });

    it('ignores origin', async () => {
      const a = await computeLayerHash(makeLayer({origin: 'personal'}));
      const b = await computeLayerHash(makeLayer({origin: 'bookmark'}));
      expect(a).toBe(b);
    });

    it('ignores visible', async () => {
      const a = await computeLayerHash(makeLayer({visible: true}));
      const b = await computeLayerHash(makeLayer({visible: false}));
      expect(a).toBe(b);
    });

    it('ignores id (so we can compute the hash from a draft)', async () => {
      const a = await computeLayerHash(makeLayer({id: ''}));
      const b = await computeLayerHash(makeLayer({id: 'whatever'}));
      expect(a).toBe(b);
    });
  });

  describe('essential-field sensitivity — these MUST change the hash', () => {
    it('reacts to analyte', async () => {
      const a = await computeLayerHash(
        makeLayer({
          query: {...makeLayer().query!, analyte: 'Benzene'},
        }),
      );
      const b = await computeLayerHash(
        makeLayer({
          query: {...makeLayer().query!, analyte: 'Toluene'},
        }),
      );
      expect(a).not.toBe(b);
    });

    it('reacts to matrix', async () => {
      const a = await computeLayerHash(
        makeLayer({
          query: {...makeLayer().query!, matrix: 'groundwater'},
        }),
      );
      const b = await computeLayerHash(
        makeLayer({
          query: {...makeLayer().query!, matrix: 'soil'},
        }),
      );
      expect(a).not.toBe(b);
    });

    it('reacts to eventAgg', async () => {
      const a = await computeLayerHash(
        makeLayer({
          query: {...makeLayer().query!, eventAgg: 'most_recent'},
        }),
      );
      const b = await computeLayerHash(
        makeLayer({
          query: {...makeLayer().query!, eventAgg: 'max'},
        }),
      );
      expect(a).not.toBe(b);
    });

    it('reacts to dupAgg', async () => {
      const a = await computeLayerHash(
        makeLayer({
          query: {...makeLayer().query!, dupAgg: 'avg'},
        }),
      );
      const b = await computeLayerHash(
        makeLayer({
          query: {...makeLayer().query!, dupAgg: 'max'},
        }),
      );
      expect(a).not.toBe(b);
    });

    it('reacts to ndMethod', async () => {
      const a = await computeLayerHash(
        makeLayer({
          query: {...makeLayer().query!, ndMethod: 'half_dl'},
        }),
      );
      const b = await computeLayerHash(
        makeLayer({
          query: {...makeLayer().query!, ndMethod: 'zero'},
        }),
      );
      expect(a).not.toBe(b);
    });

    it('reacts to colorBy', async () => {
      const a = await computeLayerHash(
        makeLayer({
          visual: {...makeLayer().visual, colorBy: 'result'},
        }),
      );
      const b = await computeLayerHash(
        makeLayer({
          visual: {...makeLayer().visual, colorBy: 'detection_limit'},
        }),
      );
      expect(a).not.toBe(b);
    });

    it('reacts to dataSource type', async () => {
      const a = await computeLayerHash(
        makeLayer({dataSource: {type: 'chemduck'}}),
      );
      const b = await computeLayerHash(
        makeLayer({
          dataSource: {
            type: 'geoparquet',
            url: 'https://example.com/x.parquet',
            tableName: 'x',
          },
        }),
      );
      expect(a).not.toBe(b);
    });
  });
});

describe('isHashedId', () => {
  it('returns true for a layer whose id matches its content hash', async () => {
    const draft = makeLayer({id: ''});
    const hash = await computeLayerHash(draft);
    const layer = {...draft, id: hash};
    expect(await isHashedId(layer)).toBe(true);
  });

  it('returns false for a layer with a UUID id (legacy)', async () => {
    const layer = makeLayer({id: '550e8400-e29b-41d4-a716-446655440000'});
    expect(await isHashedId(layer)).toBe(false);
  });

  it('returns false for a layer with a hex-shaped but mismatched id', async () => {
    const layer = makeLayer({id: '0123456789abcdef'});
    expect(await isHashedId(layer)).toBe(false);
  });
});
