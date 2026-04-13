/**
 * Tests for the per-layer SQL dispatcher.
 *
 * Verifies that buildLayerSql routes by dataSource.type and produces
 * sensible SQL for each handled variant. The contract: a chemduck
 * layer with a query produces a chemduck-style SELECT, a geoparquet
 * layer produces a SELECT against its tableName, and unhandled
 * variants return null so the entity-layer pipeline can skip them.
 */

import {describe, it, expect} from 'vitest';
import {buildLayerSql} from './buildLayerSql';
import {freezeCurrentState, parseLayerConfig} from './layerSchema';

const ctx = {elevationColumns: []};

describe('buildLayerSql dispatch', () => {
  it('builds chemduck SQL for a frozen recipe', async () => {
    const layer = await freezeCurrentState({
      name: 'Benzene most recent',
      analyte: 'Benzene',
      matrix: 'groundwater',
      eventAgg: 'most_recent',
      dupAgg: 'avg',
      ndMethod: 'half_dl',
      colorBy: 'result',
    });
    const sql = buildLayerSql(layer, ctx);
    expect(sql).not.toBeNull();
    // Chemduck recipes go through aggregate_results when an analyte is set
    expect(sql).toContain('aggregate_results');
    expect(sql).toContain("'Benzene'");
  });

  it('returns null for a chemduck layer with no query', () => {
    const layer = parseLayerConfig({
      version: 1,
      id: 'test',
      name: 'orphan',
      dataSource: {type: 'chemduck'},
    })!;
    expect(buildLayerSql(layer, ctx)).toBeNull();
  });

  it('builds a SELECT against the tableName for a geoparquet layer', () => {
    const layer = parseLayerConfig({
      version: 1,
      id: 'test',
      name: 'wells',
      dataSource: {
        type: 'geoparquet',
        url: 'https://example.com/wells.parquet',
        tableName: 'wells_2024',
      },
    })!;
    const sql = buildLayerSql(layer, ctx);
    expect(sql).not.toBeNull();
    expect(sql).toContain('"wells_2024"');
    expect(sql).toContain('location_id');
    expect(sql).toContain('longitude');
    expect(sql).toContain('latitude');
  });

  it('strips dangerous characters from the tableName', () => {
    const layer = parseLayerConfig({
      version: 1,
      id: 'test',
      name: 'evil',
      dataSource: {
        type: 'geoparquet',
        url: 'https://example.com/x.parquet',
        tableName: 'wells"; DROP TABLE samples;--',
      },
    })!;
    const sql = buildLayerSql(layer, ctx)!;
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('--');
    expect(sql).not.toContain(';');
  });

  it('returns null for geojson source (rendered by Cesium directly)', () => {
    const layer = parseLayerConfig({
      version: 1,
      id: 'test',
      name: 'boundary',
      dataSource: {
        type: 'geojson',
        url: 'https://example.com/boundary.geojson',
      },
    })!;
    expect(buildLayerSql(layer, ctx)).toBeNull();
  });

  it('returns null for imagery source', () => {
    const layer = parseLayerConfig({
      version: 1,
      id: 'test',
      name: 'plume',
      dataSource: {
        type: 'imagery',
        url: 'https://example.com/plume.png',
        extent: {west: -120, south: 35, east: -119, north: 36},
      },
    })!;
    expect(buildLayerSql(layer, ctx)).toBeNull();
  });

  it('produces the same SQL for floating and pinned geoparquet refs', () => {
    // The pin/float distinction lives at the schema/identity layer —
    // it changes the layer's content hash but not the SQL the loader
    // executes. Verifying this here pins the contract.
    const floating = parseLayerConfig({
      version: 1,
      id: 'a',
      name: 'wells',
      dataSource: {
        type: 'geoparquet',
        url: 'https://example.com/wells.parquet',
        tableName: 'wells',
      },
    })!;
    const pinned = parseLayerConfig({
      version: 1,
      id: 'b',
      name: 'wells',
      dataSource: {
        type: 'geoparquet',
        url: 'https://example.com/wells.parquet',
        tableName: 'wells',
        expectedHash:
          'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
    })!;
    expect(buildLayerSql(floating, ctx)).toBe(buildLayerSql(pinned, ctx));
  });
});
