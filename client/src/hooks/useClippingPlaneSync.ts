/**
 * Cross-section clipping plane sync.
 *
 * Watches `chemrooms.crossSectionPoints` and re-applies the resulting
 * world-space plane to:
 *   - All loaded 3D Tilesets
 *   - All Cesium entities (via show/hide)
 *
 * Also subscribes to `viewer.entities.collectionChanged` so newly-added
 * entities (e.g. when toggling a layer on or rebuilding the samples
 * layer) get the current clipping treatment immediately.
 *
 * Re-entrancy guard: applying the clipping mutates entity.show, which
 * fires definitionChanged → collectionChanged → would re-enter the
 * listener. The `applying` flag prevents that loop.
 */

import {useEffect, type RefObject} from 'react';
import {Cartesian3, type Cesium3DTileset} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {
  applyClippingToEntities,
  applyClippingToTileset,
  planeFromPoints,
} from '../lib/clippingPlane';

export function useClippingPlaneSync(
  tilesetRefs: RefObject<Record<string, Cesium3DTileset>>,
) {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const crossSectionPoints = useChemroomsStore(
    (s) => s.chemrooms.crossSectionPoints,
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

    let applying = false;
    const apply = () => {
      if (applying) return;
      applying = true;
      try {
        for (const ts of Object.values(tilesetRefs.current ?? {})) {
          applyClippingToTileset(ts, worldNormal, worldDistance);
        }
        applyClippingToEntities(viewer, worldNormal, worldDistance);
      } finally {
        applying = false;
      }
    };

    apply();

    if (!viewer || viewer.isDestroyed?.()) return;
    const remove = viewer.entities.collectionChanged.addEventListener(apply);
    return () => remove();
  }, [crossSectionPoints, viewer, tilesetRefs]);
}
