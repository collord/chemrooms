/**
 * Pure helpers for cross-section clipping plane math.
 *
 * Cesium has three different rendering systems that all need to be
 * clipped independently:
 *
 *   1. The globe terrain — uses globe.clippingPlanes (in world ECEF)
 *   2. 3D Tilesets — use tileset.clippingPlanes (in the tileset's local
 *      coordinate frame, which is the inverse of clippingPlanesOriginMatrix)
 *   3. Entities — Cesium has no clipping plane support for entities, so
 *      we manually toggle entity.show based on which side of the plane
 *      each one falls on
 *   4. Primitives (spheres/cylinders) — same as entities, per-instance
 *      show/hide via ShowGeometryInstanceAttribute
 *
 * Three clipping modes:
 *   - remove-front: single plane, hide where n·p+d >= 0
 *   - remove-back: single plane, hide where n·p+d < 0 (current default)
 *   - thick-slice: two planes offset ±thickness/2 from the centerline,
 *     keep only points between them
 */

import {
  Cartesian3,
  type Cesium3DTileset,
  ClippingPlane,
  ClippingPlaneCollection,
  Matrix3,
  Matrix4,
} from 'cesium';
import type {CrossSectionMode} from '../slices/chemrooms-slice';

// ─────────────────────────────────────────────────────────────────
// Core plane computation
// ─────────────────────────────────────────────────────────────────

/**
 * Compute the ECEF clipping plane (normal, distance) from two lon/lat
 * surface points. The plane is vertical at both points and contains the
 * line between them, so it makes a clean vertical slice through the
 * globe.
 */
export function planeFromPoints(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): {normal: Cartesian3; distance: number} {
  const p1 = Cartesian3.fromDegrees(lon1, lat1);
  const p2 = Cartesian3.fromDegrees(lon2, lat2);
  const dir = Cartesian3.subtract(p2, p1, new Cartesian3());
  const midpoint = Cartesian3.midpoint(p1, p2, new Cartesian3());
  const up = Cartesian3.normalize(midpoint, new Cartesian3());
  const normal = Cartesian3.cross(dir, up, new Cartesian3());
  Cartesian3.normalize(normal, normal);
  const distance = -Cartesian3.dot(normal, p1);
  return {normal, distance};
}

// ─────────────────────────────────────────────────────────────────
// Point-vs-plane test (used for entities + primitives)
// ─────────────────────────────────────────────────────────────────

/**
 * Test whether a world-space position should be visible given the
 * cross-section mode. Returns true if the point should render.
 *
 * The signed distance from the centerline plane is:
 *   sd = n · p + d
 * where sd > 0 = "front" side, sd < 0 = "back" side.
 */
export function isPointVisible(
  pos: Cartesian3,
  normal: Cartesian3,
  distance: number,
  mode: CrossSectionMode,
  thicknessM: number,
): boolean {
  const sd = Cartesian3.dot(normal, pos) + distance;
  switch (mode) {
    case 'remove-front':
      return sd <= 0;
    case 'remove-back':
      return sd >= 0;
    case 'thick-slice':
      return Math.abs(sd) <= thicknessM / 2;
  }
}

// ─────────────────────────────────────────────────────────────────
// Transform to local tileset frame
// ─────────────────────────────────────────────────────────────────

/**
 * Transform an ECEF plane (n_w · p + d_w = 0) into a tileset's local frame.
 */
export function transformPlaneToLocal(
  worldNormal: Cartesian3,
  worldDistance: number,
  modelMatrix: Matrix4,
): {normal: Cartesian3; distance: number} {
  const rotation = Matrix4.getMatrix3(modelMatrix, new Matrix3());
  const rotationT = Matrix3.transpose(rotation, new Matrix3());
  const localNormal = Matrix3.multiplyByVector(
    rotationT,
    worldNormal,
    new Cartesian3(),
  );
  Cartesian3.normalize(localNormal, localNormal);

  const translation = Matrix4.getTranslation(modelMatrix, new Cartesian3());
  const localDistance =
    worldDistance + Cartesian3.dot(worldNormal, translation);

  return {normal: localNormal, distance: localDistance};
}

// ─────────────────────────────────────────────────────────────────
// Apply to tilesets
// ─────────────────────────────────────────────────────────────────

/**
 * Apply clipping planes to a 3D Tileset. Supports all three modes:
 * - remove-front/back: one plane (normal flipped for front)
 * - thick-slice: two planes, offset ±thickness/2 from centerline,
 *   with unionClippingRegions: true so points must be inside BOTH
 *   halfspaces (between the planes)
 */
export function applyClippingToTileset(
  tileset: Cesium3DTileset,
  worldNormal: Cartesian3 | null,
  worldDistance: number | null,
  mode: CrossSectionMode,
  thicknessM: number,
): void {
  // Always start clean
  if (tileset.clippingPlanes) {
    tileset.clippingPlanes.removeAll();
  }

  if (worldNormal === null || worldDistance === null) return;

  const originMatrix: Matrix4 = (tileset as any).clippingPlanesOriginMatrix;

  // Always create a fresh ClippingPlaneCollection so we don't
  // inherit stale settings (e.g., unionClippingRegions from a
  // previous thick-slice).
  if (mode === 'thick-slice') {
    const half = thicknessM / 2;
    const p1 = transformPlaneToLocal(worldNormal, worldDistance + half, originMatrix);
    const negNormal = Cartesian3.negate(worldNormal, new Cartesian3());
    const p2 = transformPlaneToLocal(negNormal, -worldDistance + half, originMatrix);

    tileset.clippingPlanes = new ClippingPlaneCollection({
      planes: [
        new ClippingPlane(p1.normal, p1.distance),
        new ClippingPlane(p2.normal, p2.distance),
      ],
      edgeWidth: 2.0,
      unionClippingRegions: true,
    });
  } else {
    const n =
      mode === 'remove-front'
        ? Cartesian3.negate(worldNormal, new Cartesian3())
        : worldNormal;
    const d = mode === 'remove-front' ? -worldDistance : worldDistance;
    const local = transformPlaneToLocal(n, d, originMatrix);

    tileset.clippingPlanes = new ClippingPlaneCollection({
      planes: [new ClippingPlane(local.normal, local.distance)],
      edgeWidth: 2.0,
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// Apply to entities
// ─────────────────────────────────────────────────────────────────

/**
 * Clip entities by toggling show/hide based on the plane test.
 * Supports all three modes.
 */
export function applyClippingToEntities(
  viewer: any,
  worldNormal: Cartesian3 | null,
  worldDistance: number | null,
  mode: CrossSectionMode,
  thicknessM: number,
): void {
  if (!viewer || viewer.isDestroyed?.()) return;
  const entities = viewer.entities?.values;
  if (!entities) return;

  const time = viewer.clock?.currentTime;
  for (const entity of entities) {
    const pos = entity.position?.getValue(time);
    if (!pos) continue;

    if (worldNormal === null || worldDistance === null) {
      entity.show = true;
      continue;
    }

    entity.show = isPointVisible(pos, worldNormal, worldDistance, mode, thicknessM);
  }
}
