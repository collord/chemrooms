/**
 * Pure helpers for the vector renderer (polyline/polygon layers).
 *
 * Split out so they can be unit tested independently of Cesium —
 * the hook that consumes them is hard to test because it touches
 * the live viewer, but the geometry math and drape-mode resolution
 * are pure data in, pure data out.
 *
 * The renderer only deals with a narrow slice of the GeoJSON spec:
 * Point, LineString, MultiLineString, Polygon, MultiPolygon. Any
 * GeometryCollection or mixed-type feature returns an empty list —
 * v1 keeps the scope tight and leaves fancier cases for when
 * someone actually needs them.
 *
 * Coordinate conventions: GeoJSON uses [longitude, latitude, altitude?]
 * with WGS84 degrees. We preserve that orientation and let the hook
 * call Cesium's Cartesian3.fromDegreesArray / fromDegreesArrayHeights
 * on the flat arrays we produce.
 */

import type {GeoParquetDataSource} from './layerSchema';

export type ResolvedDrapeMode = 'drape' | 'absolute';

/**
 * Resolve a layer's drapeMode into one of the two concrete rendering
 * decisions the vector hook makes: clamp to terrain or use absolute
 * positions.
 *
 * - `drape` / `absolute` pass through as-is
 * - `auto` → `drape` when the layer is 2D, `absolute` when 3D
 *
 * The `auto` rule encodes the intuitive default: a 2D polygon (no Z)
 * should hug the terrain surface because "absolute at Z=0" would
 * place it at sea level, which is wrong almost everywhere over land.
 * A 3D polygon (real Z) has a meaningful elevation — usually
 * subsurface — that should NOT be silently overridden by terrain
 * clamping.
 */
export function resolveDrapeMode(
  drapeMode: GeoParquetDataSource['drapeMode'],
  is3d: boolean,
): ResolvedDrapeMode {
  if (drapeMode === 'drape') return 'drape';
  if (drapeMode === 'absolute') return 'absolute';
  return is3d ? 'absolute' : 'drape';
}

/**
 * A single renderable geometry piece. MultiLineString and
 * MultiPolygon get exploded into one piece per component so each
 * gets its own Cesium entity — cleaner hit-testing, simpler
 * lifecycle, matches how the existing point path works.
 */
export type VectorPiece =
  | {kind: 'point'; coord: [number, number, number?]}
  | {kind: 'polyline'; positions: number[]}
  | {kind: 'polygon'; outer: number[]; holes: number[][]};

/**
 * Convert a parsed GeoJSON geometry into one or more renderable
 * pieces. Flat-arrays the coordinates so the hook can hand them
 * straight to Cartesian3.fromDegreesArray / fromDegreesArrayHeights
 * without re-walking nested arrays.
 *
 * The returned `number[]` is laid out as either
 *   [lon, lat, lon, lat, ...]       (2D)
 * or
 *   [lon, lat, h, lon, lat, h, ...] (3D)
 * depending on whether the input coords had a third element.
 *
 * Mixed 2D/3D inputs get normalized: when any coord in the piece
 * has a height, all coords in the piece get one (missing heights
 * fill with 0). That matches the shape
 * Cartesian3.fromDegreesArrayHeights expects.
 *
 * Input is typed as `unknown` because it comes from JSON.parse'd
 * database output — we can't trust the structure, so all field
 * access goes through runtime checks before narrowing.
 */
export function geoJsonToVectorPieces(geom: unknown): VectorPiece[] {
  if (!geom || typeof geom !== 'object') return [];
  const type = (geom as {type?: unknown}).type;
  const coordinates = (geom as {coordinates?: unknown}).coordinates;

  switch (type) {
    case 'Point':
      if (!isCoord(coordinates)) return [];
      return [{kind: 'point', coord: normalizeCoord(coordinates)}];

    case 'MultiPoint':
      if (!isCoordArray(coordinates)) return [];
      return coordinates.map((c) => ({
        kind: 'point' as const,
        coord: normalizeCoord(c),
      }));

    case 'LineString':
      if (!isCoordArray(coordinates)) return [];
      return [
        {kind: 'polyline', positions: flattenLine(coordinates)},
      ];

    case 'MultiLineString':
      if (!isCoordArray2d(coordinates)) return [];
      return coordinates.map((line) => ({
        kind: 'polyline' as const,
        positions: flattenLine(line),
      }));

    case 'Polygon': {
      if (!isCoordArray2d(coordinates)) return [];
      const [outer, ...holes] = coordinates;
      if (!outer) return [];
      return [
        {
          kind: 'polygon' as const,
          outer: flattenLine(outer),
          holes: holes.map(flattenLine),
        },
      ];
    }

    case 'MultiPolygon': {
      if (!isCoordArray3d(coordinates)) return [];
      return coordinates.flatMap((poly) => {
        const [outer, ...holes] = poly;
        if (!outer) return [];
        return [
          {
            kind: 'polygon' as const,
            outer: flattenLine(outer),
            holes: holes.map(flattenLine),
          },
        ];
      });
    }

    default:
      // GeometryCollection, Feature, FeatureCollection, etc. — out of scope for v1.
      return [];
  }
}

// ---------------------------------------------------------------------------
// Runtime type guards — GeoJSON coordinates are nested number arrays
// at various depths. Database output is unknown, so every step narrows.
// ---------------------------------------------------------------------------

function isCoord(x: unknown): x is number[] {
  return Array.isArray(x) && x.length >= 2 && typeof x[0] === 'number';
}
function isCoordArray(x: unknown): x is number[][] {
  return Array.isArray(x) && x.every(isCoord);
}
function isCoordArray2d(x: unknown): x is number[][][] {
  return Array.isArray(x) && x.every(isCoordArray);
}
function isCoordArray3d(x: unknown): x is number[][][][] {
  return Array.isArray(x) && x.every(isCoordArray2d);
}

function normalizeCoord(c: number[]): [number, number, number?] {
  const lon = Number(c[0]);
  const lat = Number(c[1]);
  const h = c.length > 2 ? Number(c[2]) : undefined;
  return h === undefined ? [lon, lat] : [lon, lat, h];
}

function hasAnyZ(coords: number[][]): boolean {
  for (const c of coords) if (c.length > 2) return true;
  return false;
}

function flattenLine(coords: number[][]): number[] {
  const use3d = hasAnyZ(coords);
  const out: number[] = [];
  for (const c of coords) {
    out.push(Number(c[0]), Number(c[1]));
    if (use3d) out.push(c.length > 2 ? Number(c[2]) : 0);
  }
  return out;
}

