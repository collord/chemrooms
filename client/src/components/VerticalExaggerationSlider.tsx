/**
 * Slider to control Cesium vertical exaggeration (1× to 5×).
 *
 * Also scales entity altitudes so RELATIVE_TO_GROUND points track
 * the exaggerated terrain correctly.
 */

import React, {useState, useCallback, useEffect, useRef} from 'react';
import {Cartographic, Cartesian3, Ellipsoid} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';

/** Store base (1×) altitude for each entity so we can rescale from it. */
const baseAltitudes = new Map<string, number>();

export const VerticalExaggerationSlider: React.FC = () => {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const [value, setValue] = useState(1);
  const prevValue = useRef(1);

  // Reduce maximumScreenSpaceError to mitigate tile-edge seams
  useEffect(() => {
    if (viewer && !viewer.isDestroyed()) {
      viewer.scene.globe.maximumScreenSpaceError = 1.5;
    }
  }, [viewer]);

  const applyExaggeration = useCallback(
    (exag: number) => {
      if (!viewer || viewer.isDestroyed()) return;

      viewer.scene.verticalExaggeration = exag;

      // Scale every entity's altitude by the exaggeration factor
      const entities = viewer.entities.values;
      for (const entity of entities) {
        const pos = entity.position?.getValue(viewer.clock.currentTime);
        if (!pos) continue;

        const id = entity.id;

        // Record base altitude on first encounter
        if (!baseAltitudes.has(id)) {
          const carto = Cartographic.fromCartesian(pos, Ellipsoid.WGS84);
          baseAltitudes.set(id, carto.height);
        }

        const baseAlt = baseAltitudes.get(id)!;
        const carto = Cartographic.fromCartesian(pos, Ellipsoid.WGS84);
        carto.height = baseAlt * exag;
        entity.position = Cartesian3.fromRadians(
          carto.longitude,
          carto.latitude,
          carto.height,
        ) as any;
      }
    },
    [viewer],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      setValue(v);
      prevValue.current = v;
      applyExaggeration(v);
    },
    [applyExaggeration],
  );

  // Re-apply when entities are added/removed (e.g. layer toggled on)
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || value === 1) return;

    const listener = viewer.entities.collectionChanged.addEventListener(() => {
      applyExaggeration(value);
    });
    return () => listener();
  }, [viewer, value, applyExaggeration]);

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">Vert. Exag.</span>
      <input
        type="range"
        min={1}
        max={5}
        step={0.5}
        value={value}
        onChange={handleChange}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-border accent-primary"
      />
      <span className="w-6 text-right tabular-nums">{value}×</span>
    </label>
  );
};
