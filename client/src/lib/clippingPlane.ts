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
 *
 * These helpers compute and apply the plane for each system. The
 * `cross-section` UI in the sidebar (CrossSectionToggle) is the source
 * of truth — it sets `chemrooms.crossSectionPoints` to a pair of
 * (lon, lat) endpoints that define a vertical slicing plane.
 */

import {
  Cartesian3,
  type Cesium3DTileset,
  ClippingPlane,
  ClippingPlaneCollection,
  Matrix3,
  Matrix4,
} from 'cesium';

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

/**
 * Transform an ECEF plane (n_w · p + d_w = 0) into a tileset's local frame.
 *
 * Given the tileset's modelMatrix M = [R | t], a local point p_l maps to
 * world space as p_w = R*p_l + t. Substituting into the plane equation:
 *   n_w · (R*p_l + t) + d_w = 0
 *   (R^T n_w) · p_l + (n_w · t + d_w) = 0
 *
 * So local normal = R^T * n_w, local distance = d_w + n_w · t.
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
  const localDistance = worldDistance + Cartesian3.dot(worldNormal, translation);

  return {normal: localNormal, distance: localDistance};
}

/**
 * Apply (or remove) a clipping plane to a single 3D Tileset. Pass null
 * for normal/distance to clear any existing planes.
 */
export function applyClippingToTileset(
  tileset: Cesium3DTileset,
  worldNormal: Cartesian3 | null,
  worldDistance: number | null,
) {
  // Always start clean
  if (tileset.clippingPlanes) {
    tileset.clippingPlanes.removeAll();
  }

  if (worldNormal === null || worldDistance === null) return;

  // Cesium tilesets evaluate clipping planes relative to their
  // clippingPlanesOriginMatrix, which accounts for the root tile's
  // transform plus the internal glTF Y-up→Z-up rotation. Using
  // modelMatrix here is wrong (it's only the user-applied transform).
  // (Property exists at runtime but isn't in the TS types.)
  const originMatrix: Matrix4 = (tileset as any).clippingPlanesOriginMatrix;
  const {normal, distance} = transformPlaneToLocal(
    worldNormal,
    worldDistance,
    originMatrix,
  );

  if (!tileset.clippingPlanes) {
    tileset.clippingPlanes = new ClippingPlaneCollection({
      planes: [new ClippingPlane(normal, distance)],
      edgeWidth: 2.0,
    });
  } else {
    tileset.clippingPlanes.add(new ClippingPlane(normal, distance));
  }
}

/**
 * Cesium entities aren't affected by globe.clippingPlanes — only
 * terrain and tilesets are. To clip data points, we manually toggle
 * entity.show based on which side of the world-space plane each one
 * falls on.
 *
 * The plane equation is `n · p + d = 0`. Cesium's clipping convention
 * removes points where `n · p + d < 0`, so we mirror that here.
 */
export function applyClippingToEntities(
  viewer: any,
  worldNormal: Cartesian3 | null,
  worldDistance: number | null,
) {
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

    const side = Cartesian3.dot(worldNormal, pos) + worldDistance;
    entity.show = side >= 0;
  }
}
