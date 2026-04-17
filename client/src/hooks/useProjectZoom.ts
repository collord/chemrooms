/**
 * Project-level zoom: fly to the bounding box of all loaded data
 * on initial load, and provide a zoomToFit that does the same on
 * demand.
 *
 * The bbox comes from layerBbox.ts, which each entity hook
 * populates as it creates entities. The project bbox is the union
 * of all per-layer bboxes.
 *
 * Two behaviors:
 *
 * 1. **Initial zoom** — runs once, after the first entity layer
 *    has finished rendering. Uses a small margin around the data
 *    extent so the camera isn't pixel-tight on the edges.
 *
 * 2. **zoomToFit** — imperative, called from a button or shortcut.
 *    Reads the current project bbox and flies to it. Overwrites
 *    @sqlrooms/cesium's built-in zoomToFit (which uses
 *    viewer.zoomTo(viewer.entities) and computes wrong bounding
 *    spheres for polylineVolume / terrain-clamped entities).
 */

import {useEffect, useRef, useCallback} from 'react';
import {Rectangle, Math as CesiumMath, type Viewer} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {getProjectBbox} from '../layers/layerBbox';

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
 * Hook: auto-fly to the project extent on initial entity load,
 * and expose a zoomToFit callback for button wiring.
 */
export function useProjectZoom(): {zoomToFit: () => void} {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const initialZoomDoneRef = useRef(false);

  // Initial zoom — fires once when the viewer is ready and at
  // least one layer has data. We poll the project bbox on a short
  // timer because the entity hooks run asynchronously and bbox
  // registration happens at the end of their creation loop. A
  // 1-second delay after mount is usually enough for the first
  // data layer to finish.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || initialZoomDoneRef.current) return;
    const timer = setTimeout(() => {
      const bbox = getProjectBbox();
      if (!bbox) return;
      initialZoomDoneRef.current = true;
      flyToProjectBbox(viewer);
    }, 1500);
    return () => clearTimeout(timer);
  }, [viewer]);

  const zoomToFit = useCallback(() => {
    if (!viewer || viewer.isDestroyed()) return;
    flyToProjectBbox(viewer);
  }, [viewer]);

  return {zoomToFit};
}
