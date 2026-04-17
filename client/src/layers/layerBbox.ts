/**
 * Per-layer bounding box computation + project-level union.
 *
 * Each entity layer (chemduck points, vector features) computes a
 * WGS84 bounding rectangle from its query results during the
 * entity creation loop. The bbox is stored in a module-level
 * registry keyed by layerId. The project bbox is the union of all
 * registered layer bboxes — used for initial zoom and zoomToFit.
 *
 * Why not use Cesium's viewer.zoomTo(viewer.entities)?
 * It asks Cesium to compute a combined bounding sphere from every
 * entity's internal bounding volume. For polylineVolume entities
 * (whose bounding volumes include tube radii) and ground-clamped
 * polygons (whose hierarchy positions are at ellipsoid height 0),
 * the result is unreliable — often way too large. Computing from
 * the actual lon/lat data positions is both cheaper and correct.
 */

/**
 * A WGS84 bounding rectangle in degrees.
 */
export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

const layerBboxes = new Map<string, Bbox>();

/** Listeners notified whenever any layer bbox changes. */
const listeners = new Set<() => void>();

/** Subscribe to bbox changes. Returns an unsubscribe function. */
export function onBboxChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners(): void {
  for (const fn of listeners) fn();
}

/**
 * Set the bbox for a layer. Called from the entity creation hooks
 * after iterating query results. Pass null to clear (e.g., when
 * a layer is removed or hidden).
 */
export function setLayerBbox(layerId: string, bbox: Bbox | null): void {
  if (bbox) {
    layerBboxes.set(layerId, bbox);
  } else {
    layerBboxes.delete(layerId);
  }
  notifyListeners();
}

/** Get a specific layer's bbox. */
export function getLayerBbox(layerId: string): Bbox | undefined {
  return layerBboxes.get(layerId);
}

/** Clear all cached bboxes. */
export function clearAllBboxes(): void {
  layerBboxes.clear();
}

/**
 * Compute the project bbox as the union of all registered layer
 * bboxes. Returns null if no layers have been registered (e.g.,
 * before any data has loaded).
 */
export function getProjectBbox(): Bbox | null {
  if (layerBboxes.size === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const b of layerBboxes.values()) {
    west = Math.min(west, b.west);
    south = Math.min(south, b.south);
    east = Math.max(east, b.east);
    north = Math.max(north, b.north);
  }
  if (!Number.isFinite(west)) return null;
  return {west, south, east, north};
}

/**
 * Accumulator for building a bbox incrementally while iterating
 * query rows. Avoids allocating arrays — just tracks min/max.
 */
export class BboxAccumulator {
  west = Infinity;
  south = Infinity;
  east = -Infinity;
  north = -Infinity;
  count = 0;

  add(lon: number, lat: number): void {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    this.west = Math.min(this.west, lon);
    this.south = Math.min(this.south, lat);
    this.east = Math.max(this.east, lon);
    this.north = Math.max(this.north, lat);
    this.count += 1;
  }

  toBbox(): Bbox | null {
    if (this.count === 0) return null;
    return {
      west: this.west,
      south: this.south,
      east: this.east,
      north: this.north,
    };
  }
}
