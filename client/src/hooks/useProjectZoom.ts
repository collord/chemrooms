/**
 * Project-level zoom: fly to the bounding box of all loaded data
 * on initial load, and provide a zoomToFit that does the same on
 * demand.
 *
 * Reactive: subscribes to bbox change notifications from
 * layerBbox.ts. The initial zoom fires the moment the first layer
 * registers a non-null bbox — no fixed delay, no polling.
 */

import {useEffect, useRef, useCallback} from 'react';
import {Rectangle, Math as CesiumMath, type Viewer} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {getProjectBbox, onBboxChange} from '../layers/layerBbox';
import {roomStore} from '../store';

/** Margin around the data extent in degrees. */
const MARGIN_DEG = 0.005;

/**
 * Fly the camera to the project's data extent.
 */
function flyToProjectBbox(viewer: Viewer): void {
  if (viewer.isDestroyed()) return;
  const bbox = getProjectBbox();
  if (!bbox) return;
  const rect = Rectangle.fromDegrees(
    bbox.west - MARGIN_DEG,
    bbox.south - MARGIN_DEG,
    bbox.east + MARGIN_DEG,
    bbox.north + MARGIN_DEG,
  );
  viewer.camera.flyTo({
    destination: rect,
    duration: 1.5,
    orientation: {
      heading: CesiumMath.toRadians(0),
      pitch: CesiumMath.toRadians(-60),
      roll: 0,
    },
  });
}

/**
 * Hook: auto-fly to the project extent when the first layer bbox
 * is registered, and expose a zoomToFit callback for button wiring.
 */
export function useProjectZoom(): {zoomToFit: () => void} {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const initialZoomDoneRef = useRef(false);

  // Subscribe to bbox changes. When the first non-null project
  // bbox appears (i.e., any layer has finished creating entities
  // and registered its extent), fire the initial zoom exactly once.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || initialZoomDoneRef.current) return;

    // Check immediately — the bbox might already be available if
    // entities were created before this effect ran.
    const bbox = getProjectBbox();
    if (bbox) {
      initialZoomDoneRef.current = true;
      flyToProjectBbox(viewer);
      return;
    }

    // Otherwise, wait for the first bbox registration.
    const unsubscribe = onBboxChange(() => {
      if (initialZoomDoneRef.current) return;
      const b = getProjectBbox();
      if (!b) return;
      initialZoomDoneRef.current = true;
      flyToProjectBbox(viewer);
      unsubscribe();
    });

    return unsubscribe;
  }, [viewer]);

  const zoomToFit = useCallback(() => {
    if (!viewer || viewer.isDestroyed()) return;
    flyToProjectBbox(viewer);
  }, [viewer]);

  // Override the @sqlrooms/cesium toolbar's zoomToFit so the
  // button uses our bbox-based fly-to instead of Cesium's
  // viewer.zoomTo(viewer.entities) which misses Primitive-based
  // geometry and computes a different bounding volume.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const state = roomStore.getState();
    if (state.cesium?.zoomToFit) {
      (state.cesium as any).zoomToFit = () => {
        flyToProjectBbox(viewer);
      };
    }
  }, [viewer]);

  return {zoomToFit};
}
