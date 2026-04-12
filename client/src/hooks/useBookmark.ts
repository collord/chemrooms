/**
 * Bookmark support — encode/decode app state to/from URL hash parameters.
 *
 * Captured state:
 *  - Camera: lon, lat, alt, heading, pitch, roll
 *  - Vertical exaggeration
 *  - Visible globe/topo layers
 *  - Selected location
 *  - Recipe: analyte, matrix, fraction, ND method, eventAgg, dupAgg, colorBy
 *  - Time-series analytes
 *  - Cross-section plane (two picked surface points)
 *  - Visible personal layers (encoded as compact JSON, repeated `layer=` params)
 *
 * Frozen layers shared via bookmark land in `chemrooms.bookmarkLayers`
 * (transient, not persisted) on the receiver's side. They render
 * alongside the receiver's own personal layers but are visually
 * distinguished and can be promoted to personal storage.
 */

import {useEffect, useRef} from 'react';
import {Cartesian3, Cartographic, Math as CesiumMath} from 'cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {
  deserializeLayerFromUrl,
  serializeLayerForUrl,
} from '../layers/layerSchema';

/** Round to N decimal places. */
function r(n: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function useBookmark() {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const config = useChemroomsStore((s) => s.chemrooms.config);
  const crossSectionPoints = useChemroomsStore(
    (s) => s.chemrooms.crossSectionPoints,
  );
  const personalLayers = useChemroomsStore((s) => s.chemrooms.personalLayers);
  const colorByResults = useChemroomsStore(
    (s) => s.chemrooms.colorBy['v_results_denormalized'],
  );
  const setSelectedLocation = useChemroomsStore(
    (s) => s.chemrooms.setSelectedLocation,
  );
  const setMatrixFilter = useChemroomsStore(
    (s) => s.chemrooms.setMatrixFilter,
  );
  const setFractionFilter = useChemroomsStore(
    (s) => s.chemrooms.setFractionFilter,
  );
  const setNdMethod = useChemroomsStore((s) => s.chemrooms.setNdMethod);
  const setTimeSeriesAnalytes = useChemroomsStore(
    (s) => s.chemrooms.setTimeSeriesAnalytes,
  );
  const setCrossSectionPoints = useChemroomsStore(
    (s) => s.chemrooms.setCrossSectionPoints,
  );
  const setColoringAnalyte = useChemroomsStore(
    (s) => s.chemrooms.setColoringAnalyte,
  );
  const setEventAgg = useChemroomsStore((s) => s.chemrooms.setEventAgg);
  const setDupAgg = useChemroomsStore((s) => s.chemrooms.setDupAgg);
  const setColorBy = useChemroomsStore((s) => s.chemrooms.setColorBy);
  const setBookmarkLayers = useChemroomsStore(
    (s) => s.chemrooms.setBookmarkLayers,
  );
  const enableClippingPlane = useStoreWithCesium(
    (s) => s.cesium.enableClippingPlane,
  );
  const toggleLayerVisibility = useStoreWithCesium(
    (s) => s.cesium.toggleLayerVisibility,
  );
  const layers = useStoreWithCesium((s) => s.cesium.config.layers);

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
    // Bookmark backwards compat: chemrooms used to call this 'at_dl';
    // chemduck's canonical name is 'dl'.
    if (nd) setNdMethod((nd === 'at_dl' ? 'dl' : nd) as any);

    // Selected location
    const loc = params.get('loc');
    if (loc) setSelectedLocation(loc);

    // Analytes (time-series — for the location detail panel)
    const analytes = params.get('analytes');
    if (analytes) setTimeSeriesAnalytes(analytes.split(','));

    // Recipe state — the live "what's in the sidebar" view
    const ca = params.get('ca'); // coloringAnalyte
    if (ca) setColoringAnalyte(ca);

    const ea = params.get('ea'); // eventAgg
    if (ea) setEventAgg(ea as any);

    const da = params.get('da'); // dupAgg
    if (da) setDupAgg(da as any);

    const cbr = params.get('cbr'); // colorBy['v_results_denormalized']
    if (cbr) setColorBy('v_results_denormalized', cbr);

    // Frozen layers shipped via this bookmark — land in bookmarkLayers
    // (transient). The receiver can promote them to personal storage
    // via the LayersPanel.
    const layerParams = params.getAll('layer');
    if (layerParams.length > 0) {
      const decoded = layerParams
        .map((p) => deserializeLayerFromUrl(p))
        .filter((l): l is NonNullable<typeof l> => l !== null)
        .map((l) => ({...l, origin: 'bookmark' as const}));
      if (decoded.length > 0) {
        setBookmarkLayers(decoded);
      }
    }

    // Cross-section: replay the clipping plane from two surface points
    const xsec = params.get('xsec');
    if (xsec) {
      const nums = xsec.split(',').map(Number);
      if (nums.length === 4 && nums.every((n) => !isNaN(n))) {
        const [lon1, lat1, lon2, lat2] = nums;
        const p1 = Cartesian3.fromDegrees(lon1, lat1);
        const p2 = Cartesian3.fromDegrees(lon2, lat2);

        // Replicate the clipping plane math from CrossSectionToggle
        const dir = Cartesian3.subtract(p2, p1, new Cartesian3());
        const midpoint = Cartesian3.midpoint(p1, p2, new Cartesian3());
        const up = Cartesian3.normalize(midpoint, new Cartesian3());
        const normal = Cartesian3.cross(dir, up, new Cartesian3());
        Cartesian3.normalize(normal, normal);
        const distance = -Cartesian3.dot(normal, p1);

        enableClippingPlane(
          {x: normal.x, y: normal.y, z: normal.z},
          distance,
        );

        // Show subsurface layer
        const sub = layers.find((l) => l.id === 'subsurface-samples');
        if (sub && !sub.visible) {
          toggleLayerVisibility('subsurface-samples');
        }

        // Store points so CrossSectionToggle can pick up 'active' state
        setCrossSectionPoints([
          [lon1, lat1],
          [lon2, lat2],
        ]);
      }
    }
  }, [
    viewer,
    setSelectedLocation,
    setMatrixFilter,
    setFractionFilter,
    setNdMethod,
    setTimeSeriesAnalytes,
    setCrossSectionPoints,
    setColoringAnalyte,
    setEventAgg,
    setDupAgg,
    setColorBy,
    setBookmarkLayers,
    enableClippingPlane,
    toggleLayerVisibility,
    layers,
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
    if (config.ndMethod !== 'half_dl') {
      params.set('nd', config.ndMethod);
    }
    if (config.timeSeriesAnalytes.length > 0) {
      params.set('analytes', config.timeSeriesAnalytes.join(','));
    }

    // Recipe state — only include if non-default to keep URLs short
    if (config.coloringAnalyte) {
      params.set('ca', config.coloringAnalyte);
    }
    if (config.eventAgg !== 'most_recent') {
      params.set('ea', config.eventAgg);
    }
    if (config.dupAgg !== 'avg') {
      params.set('da', config.dupAgg);
    }
    if (colorByResults) {
      params.set('cbr', colorByResults);
    }

    // Visible personal layers — encoded as repeated `layer=` params.
    // Only visible ones go in the bookmark; hidden saved layers are
    // a personal-storage detail that doesn't need sharing.
    for (const layer of personalLayers) {
      if (!layer.visible) continue;
      params.append('layer', serializeLayerForUrl(layer));
    }

    // Cross-section points
    if (crossSectionPoints) {
      const [[lon1, lat1], [lon2, lat2]] = crossSectionPoints;
      params.set(
        'xsec',
        `${r(lon1, 6)},${r(lat1, 6)},${r(lon2, 6)},${r(lat2, 6)}`,
      );
    }

    const base = window.location.origin + window.location.pathname;
    return `${base}#${params.toString()}`;
  }

  return {getBookmarkUrl};
}
