/**
 * Cross-section clipping plane sync.
 *
 * Watches `chemrooms.crossSectionPoints`, `crossSectionMode`, and
 * `sliceThicknessM` and re-applies the resulting world-space plane(s)
 * to:
 *   - All loaded 3D Tilesets
 *   - All Cesium entities (via show/hide)
 *   - All Primitive geometry instances (via ShowGeometryInstanceAttribute)
 *
 * Three modes:
 *   - remove-front: single plane, hide the "front" side
 *   - remove-back: single plane, hide the "back" side (default)
 *   - thick-slice: two planes offset ±thickness/2, keep only the slab
 *
 * Re-entrancy guard: applying the clipping mutates entity.show, which
 * fires definitionChanged → collectionChanged → would re-enter the
 * listener. The `applying` flag prevents that loop.
 */

import {useEffect, type RefObject} from 'react';
import {
  Cartesian3,
  ClippingPlane,
  ClippingPlaneCollection,
  ColorGeometryInstanceAttribute,
  PerInstanceColorAppearance,
  PolylineColorAppearance,
  Primitive,
  ShowGeometryInstanceAttribute,
  type Cesium3DTileset,
} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {getPrimitiveMetadata} from '../layers/entityMetadata';
import {
  applyClippingToEntities,
  applyClippingToTileset,
  isPointVisible,
  planeFromPoints,
} from '../lib/clippingPlane';

/**
 * For Primitive-based geometry instances, we need to know each
 * instance's world position for the plane test. This module-level
 * map is populated by useChemroomsEntities during entity creation.
 * Keyed by instance id → Cartesian3 world position.
 */
export const primitiveInstancePositions = new Map<string, Cartesian3>();

export function useClippingPlaneSync(
  tilesetRefs: RefObject<Record<string, Cesium3DTileset>>,
) {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const crossSectionPoints = useChemroomsStore(
    (s) => s.chemrooms.crossSectionPoints,
  );
  const crossSectionMode = useChemroomsStore(
    (s) => s.chemrooms.crossSectionMode,
  );
  const sliceThicknessM = useChemroomsStore(
    (s) => s.chemrooms.sliceThicknessM,
  );

  useEffect(() => {
    let worldNormal: Cartesian3 | null = null;
    let worldDistance: number | null = null;
    if (crossSectionPoints) {
      const [[lon1, lat1], [lon2, lat2]] = crossSectionPoints;
      const plane = planeFromPoints(lon1, lat1, lon2, lat2);
      worldNormal = plane.normal;
      worldDistance = plane.distance;
    }

    console.log(
      `[clipping] mode=${crossSectionMode} thickness=${sliceThicknessM}m` +
        ` points=${crossSectionPoints ? 'set' : 'null'}` +
        ` plane=${worldNormal ? 'computed' : 'null'}` +
        ` primitivePositions=${primitiveInstancePositions.size}`,
    );

    let applying = false;
    const apply = () => {
      if (applying) return;
      applying = true;
      try {
        // ── Globe terrain ────────────────────────────────────────
        // The @sqlrooms/cesium enableClippingPlane only fires once
        // (when the user picks two points). We need to update the
        // globe's clipping planes here too so mode changes and
        // thick-slice work on terrain.
        if (viewer && !viewer.isDestroyed() && viewer.scene?.globe) {
          const globe = viewer.scene.globe;
          if (worldNormal === null || worldDistance === null) {
            if (globe.clippingPlanes) {
              globe.clippingPlanes.removeAll();
            }
          } else if (crossSectionMode === 'thick-slice') {
            const half = sliceThicknessM / 2;
            const negN = Cartesian3.negate(worldNormal, new Cartesian3());
            globe.clippingPlanes = new ClippingPlaneCollection({
              planes: [
                new ClippingPlane(
                  new Cartesian3(worldNormal.x, worldNormal.y, worldNormal.z),
                  worldDistance + half,
                ),
                new ClippingPlane(
                  new Cartesian3(negN.x, negN.y, negN.z),
                  -worldDistance + half,
                ),
              ],
              edgeWidth: 2.0,
              unionClippingRegions: true,
            });
          } else {
            const n =
              crossSectionMode === 'remove-front'
                ? Cartesian3.negate(worldNormal, new Cartesian3())
                : worldNormal;
            const d =
              crossSectionMode === 'remove-front'
                ? -worldDistance
                : worldDistance;
            globe.clippingPlanes = new ClippingPlaneCollection({
              planes: [new ClippingPlane(new Cartesian3(n.x, n.y, n.z), d)],
              edgeWidth: 2.0,
            });
          }
        }

        // ── Tilesets ─────────────────────────────────────────────
        for (const ts of Object.values(tilesetRefs.current ?? {})) {
          applyClippingToTileset(
            ts,
            worldNormal,
            worldDistance,
            crossSectionMode,
            sliceThicknessM,
          );
        }

        // ── Entities (screen-space points, vector features) ─────
        applyClippingToEntities(
          viewer,
          worldNormal,
          worldDistance,
          crossSectionMode,
          sliceThicknessM,
        );

        // ── Primitives (spheres, cylinders) ──────────────────────
        if (viewer && !viewer.isDestroyed()) {
          applyClippingToPrimitives(
            viewer,
            worldNormal,
            worldDistance,
            crossSectionMode,
            sliceThicknessM,
          );
        }
      } finally {
        applying = false;
      }
    };

    apply();

    if (!viewer || viewer.isDestroyed?.()) return;
    const remove = viewer.entities.collectionChanged.addEventListener(apply);
    return () => remove();
  }, [
    crossSectionPoints,
    crossSectionMode,
    sliceThicknessM,
    viewer,
    tilesetRefs,
  ]);
}

/**
 * Walk all scene Primitives (ours have PerInstanceColorAppearance or
 * PolylineColorAppearance) and toggle each instance's show attribute
 * based on the plane test.
 *
 * Each instance's world position must be in the primitiveInstancePositions
 * map (populated by useChemroomsEntities during creation).
 */
function applyClippingToPrimitives(
  viewer: any,
  worldNormal: Cartesian3 | null,
  worldDistance: number | null,
  mode: string,
  thicknessM: number,
): void {
  let clipped = 0;
  let shown = 0;
  let skipped = 0;
  const numPrimitives = viewer.scene.primitives.length;
  for (let i = 0; i < numPrimitives; i++) {
    const p = viewer.scene.primitives.get(i);
    if (!(p instanceof Primitive) || p.isDestroyed()) continue;
    if (
      !(p.appearance instanceof PerInstanceColorAppearance) &&
      !(p.appearance instanceof PolylineColorAppearance)
    )
      continue;

    const instances = p.geometryInstances;
    if (!instances) continue;
    const instArray = Array.isArray(instances) ? instances : [instances];

    for (const inst of instArray) {
      const instId = inst.id as string;
      const pos = primitiveInstancePositions.get(instId);
      if (!pos) continue;

      try {
        const attrs = p.getGeometryInstanceAttributes(instId);
        if (!attrs) continue;

        if (worldNormal === null || worldDistance === null) {
          attrs.show = ShowGeometryInstanceAttribute.toValue(true);
          shown++;
        } else {
          const visible = isPointVisible(
            pos,
            worldNormal,
            worldDistance,
            mode as any,
            thicknessM,
          );
          attrs.show = ShowGeometryInstanceAttribute.toValue(visible);
          if (visible) shown++;
          else clipped++;
        }
      } catch {
        skipped++;
      }
    }
  }
  if (worldNormal !== null) {
    console.log(
      `[clipping] primitives: ${shown} shown, ${clipped} clipped, ${skipped} skipped (not ready)`,
    );
  }
}
