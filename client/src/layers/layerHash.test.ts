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
import {
  GeoParquetDataSource,
  type LayerConfig,
} from './layerSchema';

/**
 * Build a complete GeoParquetDataSource by running a partial through
 * the schema's own parser, which applies all the defaults. Lets test
 * fixtures stay focused on the fields they actually care about
 * without having to enumerate every new schema field.
 */
function geoParquet(
  fields: {url: string; tableName: string} & Record<string, unknown>,
): LayerConfig['dataSource'] {
  return GeoParquetDataSource.parse({type: 'geoparquet', ...fields});
}

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
          dataSource: geoParquet({
            url: 'https://example.com/x.parquet',
            tableName: 'x',
          }),
        }),
      );
      expect(a).not.toBe(b);
    });
  });

  describe('pin vs float distinction on URL data sources', () => {
    const baseUrl = 'https://example.com/wells.parquet';
    const pinHash =
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const otherPinHash =
      'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

    it('floating and pinned refs to the same URL produce different hashes', async () => {
      const floating = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({url: baseUrl, tableName: 'wells'}),
        }),
      );
      const pinned = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            expectedHash: pinHash,
          }),
        }),
      );
      expect(floating).not.toBe(pinned);
    });

    it('two pins to different bytes produce different hashes', async () => {
      const a = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            expectedHash: pinHash,
          }),
        }),
      );
      const b = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            expectedHash: otherPinHash,
          }),
        }),
      );
      expect(a).not.toBe(b);
    });

    it('two pins to the same bytes produce the same hash', async () => {
      const a = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            expectedHash: pinHash,
          }),
        }),
      );
      const b = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            expectedHash: pinHash,
          }),
        }),
      );
      expect(a).toBe(b);
    });

    it('two floating refs to the same URL produce the same hash', async () => {
      const a = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({url: baseUrl, tableName: 'wells'}),
        }),
      );
      const b = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({url: baseUrl, tableName: 'wells'}),
        }),
      );
      expect(a).toBe(b);
    });

    it('reacts to geometryColumn', async () => {
      const a = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            geometryColumn: 'geometry',
          }),
        }),
      );
      const b = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            geometryColumn: 'geom',
          }),
        }),
      );
      expect(a).not.toBe(b);
    });

    it('reacts to geometryType', async () => {
      const point = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            geometryType: 'point',
          }),
        }),
      );
      const polygon = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            geometryType: 'polygon',
          }),
        }),
      );
      expect(point).not.toBe(polygon);
    });

    it('reacts to geometryEncoding', async () => {
      const wkb = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            geometryEncoding: 'wkb',
          }),
        }),
      );
      const native = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            geometryEncoding: 'native',
          }),
        }),
      );
      expect(wkb).not.toBe(native);
    });

    it('reacts to is3d', async () => {
      const flat = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            is3d: false,
          }),
        }),
      );
      const tall = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            is3d: true,
          }),
        }),
      );
      expect(flat).not.toBe(tall);
    });

    it('reacts to idColumn', async () => {
      const synth = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({url: baseUrl, tableName: 'wells'}),
        }),
      );
      const explicit = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            idColumn: 'well_id',
          }),
        }),
      );
      expect(synth).not.toBe(explicit);
    });

    it('reacts to labelColumn', async () => {
      const a = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            labelColumn: 'well_name',
          }),
        }),
      );
      const b = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            labelColumn: 'site_id',
          }),
        }),
      );
      expect(a).not.toBe(b);
    });

    it('reacts to sourceCrs (provenance is part of identity)', async () => {
      const a = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            sourceCrs: 'EPSG:4326',
          }),
        }),
      );
      const b = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            sourceCrs: 'EPSG:26917',
          }),
        }),
      );
      expect(a).not.toBe(b);
    });

    it('reacts to propertiesColumns membership', async () => {
      const empty = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            propertiesColumns: [],
          }),
        }),
      );
      const some = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            propertiesColumns: ['well_name'],
          }),
        }),
      );
      expect(empty).not.toBe(some);
    });

    it('treats propertiesColumns as a set — reordering does not change the hash', async () => {
      const ab = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            propertiesColumns: ['a', 'b'],
          }),
        }),
      );
      const ba = await computeLayerHash(
        makeLayer({
          dataSource: geoParquet({
            url: baseUrl,
            tableName: 'wells',
            propertiesColumns: ['b', 'a'],
          }),
        }),
      );
      expect(ab).toBe(ba);
    });

    it('applies pin/float to geojson sources too', async () => {
      const floating = await computeLayerHash(
        makeLayer({
          dataSource: {type: 'geojson', url: baseUrl},
        }),
      );
      const pinned = await computeLayerHash(
        makeLayer({
          dataSource: {
            type: 'geojson',
            url: baseUrl,
            expectedHash: pinHash,
          },
        }),
      );
      expect(floating).not.toBe(pinned);
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
