/**
 * Tests for the pure vector-renderer helpers.
 */

import {describe, it, expect} from 'vitest';
import {
  geoJsonToVectorPieces,
  resolveDrapeMode,
} from './vectorGeometry';

describe('resolveDrapeMode', () => {
  it('passes through explicit drape', () => {
    expect(resolveDrapeMode('drape', false)).toBe('drape');
    expect(resolveDrapeMode('drape', true)).toBe('drape');
  });

  it('passes through explicit absolute', () => {
    expect(resolveDrapeMode('absolute', false)).toBe('absolute');
    expect(resolveDrapeMode('absolute', true)).toBe('absolute');
  });

  it('auto + 2D → drape (surface layer hugs terrain)', () => {
    expect(resolveDrapeMode('auto', false)).toBe('drape');
  });

  it('auto + 3D → absolute (subsurface layer keeps its Z)', () => {
    expect(resolveDrapeMode('auto', true)).toBe('absolute');
  });
});

describe('geoJsonToVectorPieces', () => {
  describe('Point', () => {
    it('extracts 2D coords', () => {
      const pieces = geoJsonToVectorPieces({
        type: 'Point',
        coordinates: [1, 2],
      });
      expect(pieces).toHaveLength(1);
      expect(pieces[0]).toEqual({kind: 'point', coord: [1, 2]});
    });

    it('extracts 3D coords', () => {
      const pieces = geoJsonToVectorPieces({
        type: 'Point',
        coordinates: [1, 2, 3],
      });
      expect(pieces[0]).toEqual({kind: 'point', coord: [1, 2, 3]});
    });
  });

  describe('LineString', () => {
    it('flattens 2D coords', () => {
      const pieces = geoJsonToVectorPieces({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      });
      expect(pieces).toHaveLength(1);
      expect(pieces[0]).toMatchObject({
        kind: 'polyline',
        positions: [0, 0, 1, 1, 2, 2],
      });
    });

    it('flattens 3D coords', () => {
      const pieces = geoJsonToVectorPieces({
        type: 'LineString',
        coordinates: [
          [0, 0, 100],
          [1, 1, 200],
        ],
      });
      expect(pieces[0]).toMatchObject({
        kind: 'polyline',
        positions: [0, 0, 100, 1, 1, 200],
      });
    });

    it('normalizes mixed 2D/3D by filling missing heights with 0', () => {
      const pieces = geoJsonToVectorPieces({
        type: 'LineString',
        coordinates: [
          [0, 0, 100],
          [1, 1], // missing height
          [2, 2, 300],
        ],
      });
      expect(pieces[0]).toMatchObject({
        kind: 'polyline',
        positions: [0, 0, 100, 1, 1, 0, 2, 2, 300],
      });
    });
  });

  describe('MultiLineString', () => {
    it('emits one piece per component', () => {
      const pieces = geoJsonToVectorPieces({
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [10, 10],
            [11, 11],
          ],
        ],
      });
      expect(pieces).toHaveLength(2);
      expect(pieces[0]).toMatchObject({
        kind: 'polyline',
        positions: [0, 0, 1, 1],
      });
      expect(pieces[1]).toMatchObject({
        kind: 'polyline',
        positions: [10, 10, 11, 11],
      });
    });
  });

  describe('Polygon', () => {
    it('flattens the outer ring', () => {
      const pieces = geoJsonToVectorPieces({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      });
      expect(pieces).toHaveLength(1);
      expect(pieces[0]).toMatchObject({
        kind: 'polygon',
        outer: [0, 0, 1, 0, 1, 1, 0, 1, 0, 0],
        holes: [],
      });
    });

    it('captures interior rings (holes)', () => {
      const pieces = geoJsonToVectorPieces({
        type: 'Polygon',
        coordinates: [
          // outer
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
          // hole
          [
            [2, 2],
            [4, 2],
            [4, 4],
            [2, 4],
            [2, 2],
          ],
        ],
      });
      expect(pieces[0]).toMatchObject({
        kind: 'polygon',
        holes: [[2, 2, 4, 2, 4, 4, 2, 4, 2, 2]],
      });
    });
  });

  describe('MultiPolygon', () => {
    it('emits one piece per component', () => {
      const pieces = geoJsonToVectorPieces({
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
          [
            [
              [10, 10],
              [11, 10],
              [11, 11],
              [10, 11],
              [10, 10],
            ],
          ],
        ],
      });
      expect(pieces).toHaveLength(2);
      expect(pieces[0]).toMatchObject({kind: 'polygon'});
      expect(pieces[1]).toMatchObject({kind: 'polygon'});
    });
  });

  describe('unsupported types', () => {
    it('returns empty for GeometryCollection', () => {
      expect(
        geoJsonToVectorPieces({
          type: 'GeometryCollection',
          coordinates: [],
        }),
      ).toEqual([]);
    });

    it('returns empty for Feature wrapper', () => {
      expect(geoJsonToVectorPieces({type: 'Feature'})).toEqual([]);
    });
  });
});
