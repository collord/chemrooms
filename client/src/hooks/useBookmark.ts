/**
 * Bookmark support — encode/decode app state to/from URL hash parameters.
 *
 * Captured state:
 *  - Camera: lon, lat, alt, heading, pitch, roll
 *  - Vertical exaggeration
 *  - Visible layers
 *  - Selected location
 *  - Filters: matrix, fraction, non-detect method
 *  - Time-series analytes
 */

import {useEffect, useRef} from 'react';
import {Cartesian3, Cartographic, Math as CesiumMath} from 'cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {useStoreWithCesium} from '@sqlrooms/cesium';

/** Round to N decimal places. */
function r(n: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function useBookmark() {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const config = useChemroomsStore((s) => s.chemrooms.config);
  const setSelectedLocation = useChemroomsStore(
    (s) => s.chemrooms.setSelectedLocation,
  );
  const setMatrixFilter = useChemroomsStore(
    (s) => s.chemrooms.setMatrixFilter,
  );
  const setFractionFilter = useChemroomsStore(
    (s) => s.chemrooms.setFractionFilter,
  );
  const setNonDetectMethod = useChemroomsStore(
    (s) => s.chemrooms.setNonDetectMethod,
  );
  const setTimeSeriesAnalytes = useChemroomsStore(
    (s) => s.chemrooms.setTimeSeriesAnalytes,
  );

  const appliedRef = useRef(false);

  // On mount, apply bookmark from URL hash (once viewer is ready)
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || appliedRef.current) return;

    const hash = window.location.hash.slice(1);
    if (!hash) return;

    const params = new URLSearchParams(hash);
    appliedRef.current = true;

    // Camera
    const lon = params.get('lon');
    const lat = params.get('lat');
    const alt = params.get('alt');
    if (lon && lat && alt) {
      const heading = Number(params.get('heading') ?? 0);
      const pitch = Number(params.get('pitch') ?? -90);
      const roll = Number(params.get('roll') ?? 0);

      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(
          Number(lon),
          Number(lat),
          Number(alt),
        ),
        orientation: {
          heading: CesiumMath.toRadians(heading),
          pitch: CesiumMath.toRadians(pitch),
          roll: CesiumMath.toRadians(roll),
        },
      });
    }

    // Vertical exaggeration
    const exag = params.get('exag');
    if (exag) {
      viewer.scene.verticalExaggeration = Number(exag);
    }

    // Layers (globe visibility)
    const layersParam = params.get('layers');
    if (layersParam) {
      const visibleLayers = new Set(layersParam.split(','));
      viewer.scene.globe.show = visibleLayers.has('topography');
    }

    // Filters
    const matrix = params.get('matrix');
    if (matrix) setMatrixFilter(matrix);

    const fraction = params.get('fraction');
    if (fraction) setFractionFilter(fraction);

    const nd = params.get('nd');
    if (nd) setNonDetectMethod(nd as any);

    // Selected location
    const loc = params.get('loc');
    if (loc) setSelectedLocation(loc);

    // Analytes
    const analytes = params.get('analytes');
    if (analytes) setTimeSeriesAnalytes(analytes.split(','));
  }, [
    viewer,
    setSelectedLocation,
    setMatrixFilter,
    setFractionFilter,
    setNonDetectMethod,
    setTimeSeriesAnalytes,
  ]);

  /** Snapshot current state into a bookmark URL. */
  function getBookmarkUrl(): string {
    const params = new URLSearchParams();

    if (viewer && !viewer.isDestroyed()) {
      const carto = Cartographic.fromCartesian(viewer.camera.position);
      params.set('lon', String(r(CesiumMath.toDegrees(carto.longitude), 6)));
      params.set('lat', String(r(CesiumMath.toDegrees(carto.latitude), 6)));
      params.set('alt', String(r(carto.height, 1)));
      params.set(
        'heading',
        String(r(CesiumMath.toDegrees(viewer.camera.heading), 2)),
      );
      params.set(
        'pitch',
        String(r(CesiumMath.toDegrees(viewer.camera.pitch), 2)),
      );
      params.set(
        'roll',
        String(r(CesiumMath.toDegrees(viewer.camera.roll), 2)),
      );

      const exag = viewer.scene.verticalExaggeration ?? 1;
      if (exag !== 1) params.set('exag', String(exag));

      // Layer visibility
      const visibleLayers: string[] = [];
      visibleLayers.push('site-data'); // always on for now
      if (viewer.scene.globe.show) visibleLayers.push('topography');
      params.set('layers', visibleLayers.join(','));
    }

    if (config.selectedLocationId) {
      params.set('loc', config.selectedLocationId);
    }
    if (config.matrixFilter) {
      params.set('matrix', config.matrixFilter);
    }
    if (config.fractionFilter) {
      params.set('fraction', config.fractionFilter);
    }
    if (config.nonDetectMethod !== 'half_dl') {
      params.set('nd', config.nonDetectMethod);
    }
    if (config.timeSeriesAnalytes.length > 0) {
      params.set('analytes', config.timeSeriesAnalytes.join(','));
    }

    const base = window.location.origin + window.location.pathname;
    return `${base}#${params.toString()}`;
  }

  return {getBookmarkUrl};
}
