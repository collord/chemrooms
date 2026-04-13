/**
 * Tests for the geoparquet runtime loader.
 *
 * Uses a mock connector (vi.fn() for loadFile + execute) so we can
 * assert the orchestration without standing up a real DuckDB-WASM
 * worker. The connector contract surface used by the loader is small:
 * just `loadFile()` and `execute()`. Real wiring to a live connector
 * has to be smoke-tested in the browser.
 */

import {describe, it, expect, vi, beforeEach} from 'vitest';
import {
  registerGeoparquetLayer,
  _resetSpatialReadyForTesting,
} from './registerGeoparquetLayer';
import {computeLayerHash} from './layerHash';

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
    // Unused but required by the type
    initialize: vi.fn(),
    destroy: vi.fn(),
    query: vi.fn(),
    queryJson: vi.fn(),
    loadArrow: vi.fn(),
    loadObjects: vi.fn(),
  };
}

beforeEach(() => {
  _resetSpatialReadyForTesting();
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

  it('calls loadFile with the URL and a sanitized tableName', async () => {
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
    expect(tableName).toMatch(/^t_regulator_wells_2024_[a-z0-9]+$/);
    expect(opts).toEqual({method: 'read_parquet'});
  });

  it('accepts a File and uses its name', async () => {
    const connector = makeMockConnector();
    const file = new File([new Uint8Array([1, 2, 3])], 'monitoring.parquet', {
      type: 'application/octet-stream',
    });
    const result = await registerGeoparquetLayer(connector as never, file);
    const [source, tableName] = connector.loadFile.mock.calls[0]!;
    expect(source).toBe(file);
    expect(tableName).toMatch(/^t_monitoring_[a-z0-9]+$/);
    expect(result.layer.name).toBe('monitoring');
  });

  it('tags File-sourced layers with a session: URL (ephemeral marker)', async () => {
    const connector = makeMockConnector();
    const file = new File([new Uint8Array([1, 2, 3])], 'monitoring.parquet', {
      type: 'application/octet-stream',
    });
    const {layer} = await registerGeoparquetLayer(connector as never, file);
    if (layer.dataSource.type !== 'geoparquet') return;
    expect(layer.dataSource.url.startsWith('session:')).toBe(true);
    expect(layer.dataSource.url).toContain('monitoring.parquet');
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

  it('warns about non-point geometries (registered but not yet rendered)', async () => {
    const connector = makeMockConnector();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await registerGeoparquetLayer(
      connector as never,
      'https://example.com/parcels.parquet',
      {geometryType: 'polygon'},
    );
    expect(warn).toHaveBeenCalled();
    const message = warn.mock.calls[0]?.[0] ?? '';
    expect(String(message)).toContain('polygon');
    warn.mockRestore();
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
