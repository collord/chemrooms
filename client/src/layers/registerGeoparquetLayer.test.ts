/**
 * Tests for the geoparquet runtime loader.
 *
 * Uses a mock connector (vi.fn() for loadFile + execute) so we can
 * assert the orchestration without standing up a real DuckDB-WASM
 * worker. The connector contract surface used by the loader is small:
 * just `loadFile()` and `execute()`. Real wiring to a live connector
 * has to be smoke-tested in the browser.
 */

import {describe, it, expect, vi, beforeEach, afterAll} from 'vitest';
import {
  registerGeoparquetLayer,
  rehydrateGeoparquetLayers,
  _resetSpatialReadyForTesting,
} from './registerGeoparquetLayer';
import {computeLayerHash} from './layerHash';
import {
  _resetBlobBackendForTesting,
  _setBlobBackendForTesting,
  deleteBlob,
  InMemoryBlobBackend,
  listBlobHashes,
  parseIdbUrl,
} from './blobStore';
import {freezeCurrentState} from './layerSchema';

function makeMockConnector() {
  return {
    loadFile: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockReturnValue({
      result: Promise.resolve(),
      cancel: () => Promise.resolve(),
      signal: new AbortController().signal,
      then: (onFulfilled?: () => void) => {
        if (onFulfilled) onFulfilled();
        return Promise.resolve();
      },
      catch: () => Promise.resolve(),
      finally: () => Promise.resolve(),
    }),
    // Default to an empty-table probe response so the loader's
    // geometry type detection falls through to 'point' (matching
    // the pre-detection behavior). Tests that want to exercise
    // detection override this per-call with mockResolvedValueOnce.
    query: vi.fn().mockResolvedValue({
      toArray: () => [],
    }),
    // Unused but required by the type
    initialize: vi.fn(),
    destroy: vi.fn(),
    queryJson: vi.fn(),
    loadArrow: vi.fn(),
    loadObjects: vi.fn(),
  };
}

beforeEach(() => {
  _resetSpatialReadyForTesting();
  // Swap in the in-memory blob backend so the loader's File path
  // doesn't try to hit real IndexedDB (which happy-dom doesn't
  // provide). Production code uses IdbBlobBackend; tests use this.
  _setBlobBackendForTesting(new InMemoryBlobBackend());
});

afterAll(() => {
  _resetBlobBackendForTesting();
});

describe('registerGeoparquetLayer', () => {
  it('loads the spatial extension on first call', async () => {
    const connector = makeMockConnector();
    await registerGeoparquetLayer(
      connector as never,
      'https://example.com/wells.parquet',
    );
    const sql = connector.execute.mock.calls.map((c) => c[0]);
    expect(sql).toContain('INSTALL spatial');
    expect(sql).toContain('LOAD spatial');
  });

  it('only loads spatial once across multiple calls', async () => {
    const connector = makeMockConnector();
    await registerGeoparquetLayer(
      connector as never,
      'https://example.com/a.parquet',
    );
    await registerGeoparquetLayer(
      connector as never,
      'https://example.com/b.parquet',
    );
    const installs = connector.execute.mock.calls
      .map((c) => c[0])
      .filter((s: string) => s === 'INSTALL spatial');
    expect(installs).toHaveLength(1);
  });

  it('calls loadFile with the URL and a hash-derived tableName', async () => {
    const connector = makeMockConnector();
    const result = await registerGeoparquetLayer(
      connector as never,
      'https://example.com/path/to/regulator wells 2024.parquet',
    );
    expect(connector.loadFile).toHaveBeenCalledTimes(1);
    const [source, tableName, opts] = connector.loadFile.mock.calls[0]!;
    expect(source).toBe(
      'https://example.com/path/to/regulator wells 2024.parquet',
    );
    expect(tableName).toBe(result.tableName);
    // Table name derived from the URL hash, not a random suffix, so
    // it's stable across sessions.
    expect(tableName).toMatch(/^t_geoparquet_[0-9a-f]{16}$/);
    expect(opts).toEqual({method: 'read_parquet', replace: true});
  });

  it('accepts a File, hashes its bytes, and stores them in the blob store', async () => {
    const connector = makeMockConnector();
    const file = new File([new Uint8Array([1, 2, 3])], 'monitoring.parquet', {
      type: 'application/octet-stream',
    });
    const result = await registerGeoparquetLayer(connector as never, file);

    // The File is still what gets passed to loadFile (cheapest path)
    const [source, tableName] = connector.loadFile.mock.calls[0]!;
    expect(source).toBe(file);
    // Table name is hash-derived, not filename-derived
    expect(tableName).toMatch(/^t_geoparquet_[0-9a-f]{16}$/);
    expect(result.layer.name).toBe('monitoring');

    // The bytes got stashed in the blob store
    const hashes = await listBlobHashes();
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tags File-sourced layers with an idb:// URL (persistable)', async () => {
    const connector = makeMockConnector();
    const file = new File([new Uint8Array([1, 2, 3])], 'monitoring.parquet', {
      type: 'application/octet-stream',
    });
    const {layer} = await registerGeoparquetLayer(connector as never, file);
    if (layer.dataSource.type !== 'geoparquet') return;
    expect(layer.dataSource.url.startsWith('idb://')).toBe(true);
    // The URL should encode the SHA-256 of the file bytes
    const hash = parseIdbUrl(layer.dataSource.url);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dedupes by content hash: dropping the same bytes twice yields one blob and one layer id', async () => {
    const connector = makeMockConnector();
    const file1 = new File([new Uint8Array([1, 2, 3])], 'a.parquet');
    const file2 = new File([new Uint8Array([1, 2, 3])], 'b.parquet');
    const r1 = await registerGeoparquetLayer(connector as never, file1);
    const r2 = await registerGeoparquetLayer(connector as never, file2);
    // Same bytes → same table name → same layer id
    expect(r1.tableName).toBe(r2.tableName);
    expect(r1.layer.id).toBe(r2.layer.id);
    // Only one blob in the store
    expect((await listBlobHashes()).length).toBe(1);
  });

  it('uses the real URL for URL-sourced layers (persistable)', async () => {
    const connector = makeMockConnector();
    const {layer} = await registerGeoparquetLayer(
      connector as never,
      'https://example.com/wells.parquet',
    );
    if (layer.dataSource.type !== 'geoparquet') return;
    expect(layer.dataSource.url).toBe('https://example.com/wells.parquet');
  });

  it('does not touch the blob store for URL-sourced layers', async () => {
    const connector = makeMockConnector();
    await registerGeoparquetLayer(
      connector as never,
      'https://example.com/wells.parquet',
    );
    expect(await listBlobHashes()).toHaveLength(0);
  });

  it('produces a layer config whose id equals its content hash', async () => {
    const connector = makeMockConnector();
    const result = await registerGeoparquetLayer(
      connector as never,
      'https://example.com/wells.parquet',
    );
    const expected = await computeLayerHash(result.layer);
    expect(result.layer.id).toBe(expected);
  });

  it('defaults to point geometry, native encoding, 2D, geometry-column "geometry"', async () => {
    // Native encoding is the right default: loadFile(read_parquet) +
    // spatial extension auto-decodes the WKB column to a GEOMETRY type,
    // so the dispatcher should NOT wrap the column in ST_GeomFromWKB.
    const connector = makeMockConnector();
    const {layer} = await registerGeoparquetLayer(
      connector as never,
      'https://example.com/wells.parquet',
    );
    expect(layer.dataSource.type).toBe('geoparquet');
    if (layer.dataSource.type !== 'geoparquet') return;
    expect(layer.dataSource.geometryType).toBe('point');
    expect(layer.dataSource.geometryEncoding).toBe('native');
    expect(layer.dataSource.is3d).toBe(false);
    expect(layer.dataSource.geometryColumn).toBe('geometry');
  });

  it('respects an explicit geometryEncoding override', async () => {
    const connector = makeMockConnector();
    const {layer} = await registerGeoparquetLayer(
      connector as never,
      'https://example.com/wells.parquet',
      {geometryEncoding: 'wkb'},
    );
    if (layer.dataSource.type !== 'geoparquet') return;
    expect(layer.dataSource.geometryEncoding).toBe('wkb');
  });

  it('honors geometry overrides passed via options', async () => {
    const connector = makeMockConnector();
    const {layer} = await registerGeoparquetLayer(
      connector as never,
      'https://example.com/wells.parquet',
      {
        geometryColumn: 'shape',
        is3d: true,
        geometryType: 'point',
        geometryEncoding: 'native',
      },
    );
    if (layer.dataSource.type !== 'geoparquet') return;
    expect(layer.dataSource.geometryColumn).toBe('shape');
    expect(layer.dataSource.is3d).toBe(true);
    expect(layer.dataSource.geometryEncoding).toBe('native');
  });

  it('marks the layer as origin: personal so it persists to localStorage', async () => {
    const connector = makeMockConnector();
    const {layer} = await registerGeoparquetLayer(
      connector as never,
      'https://example.com/wells.parquet',
    );
    expect(layer.origin).toBe('personal');
  });

  it('registers non-point geometries without warning (vector renderer handles them)', async () => {
    const connector = makeMockConnector();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const {layer} = await registerGeoparquetLayer(
      connector as never,
      'https://example.com/parcels.parquet',
      {geometryType: 'polygon'},
    );
    expect(warn).not.toHaveBeenCalled();
    if (layer.dataSource.type !== 'geoparquet') return;
    expect(layer.dataSource.geometryType).toBe('polygon');
    warn.mockRestore();
  });

  describe('geometry type auto-detection', () => {
    it('detects POLYGON from the file and sets geometryType accordingly', async () => {
      const connector = makeMockConnector();
      // Probe query returns POLYGON
      connector.query.mockResolvedValueOnce({
        toArray: () => [{gt: 'POLYGON'}],
      });
      const {layer} = await registerGeoparquetLayer(
        connector as never,
        'https://example.com/parcels.parquet',
      );
      if (layer.dataSource.type !== 'geoparquet') return;
      expect(layer.dataSource.geometryType).toBe('polygon');
    });

    it('detects LINESTRING', async () => {
      const connector = makeMockConnector();
      connector.query.mockResolvedValueOnce({
        toArray: () => [{gt: 'LINESTRING'}],
      });
      const {layer} = await registerGeoparquetLayer(
        connector as never,
        'https://example.com/roads.parquet',
      );
      if (layer.dataSource.type !== 'geoparquet') return;
      expect(layer.dataSource.geometryType).toBe('linestring');
    });

    it('detects MULTIPOLYGON', async () => {
      const connector = makeMockConnector();
      connector.query.mockResolvedValueOnce({
        toArray: () => [{gt: 'MULTIPOLYGON'}],
      });
      const {layer} = await registerGeoparquetLayer(
        connector as never,
        'https://example.com/counties.parquet',
      );
      if (layer.dataSource.type !== 'geoparquet') return;
      expect(layer.dataSource.geometryType).toBe('multipolygon');
    });

    it('is case-insensitive on the DuckDB return value', async () => {
      const connector = makeMockConnector();
      connector.query.mockResolvedValueOnce({
        toArray: () => [{gt: 'polygon'}],
      });
      const {layer} = await registerGeoparquetLayer(
        connector as never,
        'https://example.com/parcels.parquet',
      );
      if (layer.dataSource.type !== 'geoparquet') return;
      expect(layer.dataSource.geometryType).toBe('polygon');
    });

    it('falls back to point when the probe returns an empty table', async () => {
      const connector = makeMockConnector();
      // Default mock already returns empty — no need to override
      const {layer} = await registerGeoparquetLayer(
        connector as never,
        'https://example.com/empty.parquet',
      );
      if (layer.dataSource.type !== 'geoparquet') return;
      expect(layer.dataSource.geometryType).toBe('point');
    });

    it('falls back to point when the probe query errors', async () => {
      const connector = makeMockConnector();
      connector.query.mockRejectedValueOnce(new Error('probe failed'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const {layer} = await registerGeoparquetLayer(
        connector as never,
        'https://example.com/broken.parquet',
      );
      warn.mockRestore();
      if (layer.dataSource.type !== 'geoparquet') return;
      expect(layer.dataSource.geometryType).toBe('point');
    });

    it('falls back to point for unrecognized DuckDB geometry types', async () => {
      const connector = makeMockConnector();
      connector.query.mockResolvedValueOnce({
        toArray: () => [{gt: 'GEOMETRYCOLLECTION'}],
      });
      const {layer} = await registerGeoparquetLayer(
        connector as never,
        'https://example.com/mixed.parquet',
      );
      if (layer.dataSource.type !== 'geoparquet') return;
      expect(layer.dataSource.geometryType).toBe('point');
    });

    it('respects explicit options.geometryType over detection', async () => {
      const connector = makeMockConnector();
      // Probe would say POLYGON, but the user explicitly asked for linestring
      connector.query.mockResolvedValueOnce({
        toArray: () => [{gt: 'POLYGON'}],
      });
      const {layer} = await registerGeoparquetLayer(
        connector as never,
        'https://example.com/ambiguous.parquet',
        {geometryType: 'linestring'},
      );
      if (layer.dataSource.type !== 'geoparquet') return;
      expect(layer.dataSource.geometryType).toBe('linestring');
    });

    it('skips the probe call entirely when options.geometryType is set', async () => {
      const connector = makeMockConnector();
      await registerGeoparquetLayer(
        connector as never,
        'https://example.com/explicit.parquet',
        {geometryType: 'polygon'},
      );
      // The loader should not have called query for a probe
      expect(connector.query).not.toHaveBeenCalled();
    });
  });

  it('rethrows if loadFile fails', async () => {
    const connector = makeMockConnector();
    connector.loadFile.mockRejectedValueOnce(new Error('parquet read failed'));
    await expect(
      registerGeoparquetLayer(
        connector as never,
        'https://example.com/broken.parquet',
      ),
    ).rejects.toThrow('parquet read failed');
  });
});

describe('rehydrateGeoparquetLayers', () => {
  it('re-registers idb:// layers by loading bytes from the blob store', async () => {
    // Setup: drop a file this session
    const connector1 = makeMockConnector();
    const file = new File([new Uint8Array([10, 20, 30, 40])], 'wells.parquet');
    const {layer} = await registerGeoparquetLayer(connector1 as never, file);

    // Now simulate a reload: fresh connector, the layer config lives
    // in localStorage and the bytes live in the blob store
    const connector2 = makeMockConnector();
    const result = await rehydrateGeoparquetLayers(connector2 as never, [
      layer,
    ]);

    expect(result.dropped).toBe(0);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]!.id).toBe(layer.id);

    // The new connector should have had loadFile called exactly once
    // with a reconstructed File and the same table name
    expect(connector2.loadFile).toHaveBeenCalledTimes(1);
    const [source, tableName] = connector2.loadFile.mock.calls[0]!;
    expect(source).toBeInstanceOf(File);
    if (layer.dataSource.type !== 'geoparquet') return;
    expect(tableName).toBe(layer.dataSource.tableName);
  });

  it('drops layers whose blob is missing from the store', async () => {
    const connector1 = makeMockConnector();
    const file = new File([new Uint8Array([1, 2, 3])], 'missing.parquet');
    const {layer} = await registerGeoparquetLayer(connector1 as never, file);

    // Simulate the user clearing site data between sessions: the
    // layer config is still in localStorage but the blob is gone.
    if (layer.dataSource.type !== 'geoparquet') return;
    const hash = parseIdbUrl(layer.dataSource.url)!;
    await deleteBlob(hash);

    const connector2 = makeMockConnector();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await rehydrateGeoparquetLayers(connector2 as never, [
      layer,
    ]);
    warn.mockRestore();

    expect(result.dropped).toBe(1);
    expect(result.layers).toHaveLength(0);
    expect(connector2.loadFile).not.toHaveBeenCalled();
  });

  it('passes through non-geoparquet layers unchanged', async () => {
    const connector = makeMockConnector();
    const chemduck = await freezeCurrentState({
      name: 'Benzene',
      analyte: 'Benzene',
      matrix: 'groundwater',
      eventAgg: 'most_recent',
      dupAgg: 'avg',
      ndMethod: 'half_dl',
      colorBy: 'result',
    });
    const result = await rehydrateGeoparquetLayers(connector as never, [
      chemduck,
    ]);
    expect(result.dropped).toBe(0);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]!.id).toBe(chemduck.id);
    expect(connector.loadFile).not.toHaveBeenCalled();
  });

  it('passes through URL-backed geoparquet layers without rehydrating', async () => {
    // URL-backed layers are their own persistence story (the URL is
    // re-fetchable). The rehydrator should leave them alone.
    const connector1 = makeMockConnector();
    const {layer} = await registerGeoparquetLayer(
      connector1 as never,
      'https://example.com/wells.parquet',
    );

    const connector2 = makeMockConnector();
    const result = await rehydrateGeoparquetLayers(connector2 as never, [
      layer,
    ]);
    expect(result.layers).toHaveLength(1);
    expect(connector2.loadFile).not.toHaveBeenCalled();
  });

  it('loads spatial only once across the rehydration batch', async () => {
    const connector1 = makeMockConnector();
    const a = await registerGeoparquetLayer(
      connector1 as never,
      new File([new Uint8Array([1])], 'a.parquet'),
    );
    const b = await registerGeoparquetLayer(
      connector1 as never,
      new File([new Uint8Array([2])], 'b.parquet'),
    );

    _resetSpatialReadyForTesting();
    const connector2 = makeMockConnector();
    await rehydrateGeoparquetLayers(connector2 as never, [a.layer, b.layer]);

    const installs = connector2.execute.mock.calls
      .map((c) => c[0])
      .filter((s: string) => s === 'INSTALL spatial');
    expect(installs).toHaveLength(1);
  });
});
