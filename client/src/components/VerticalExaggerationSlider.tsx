/**
 * Slider to control Cesium vertical exaggeration (1× to 20×).
 * Placed below the cross-section toggle in the sidebar.
 */

import React, {useState, useCallback, useEffect} from 'react';
import {useStoreWithCesium} from '@sqlrooms/cesium';

export const VerticalExaggerationSlider: React.FC = () => {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const [value, setValue] = useState(1);

  // Sync initial value from viewer
  useEffect(() => {
    if (viewer && !viewer.isDestroyed()) {
      setValue(viewer.scene.verticalExaggeration ?? 1);
    }
  }, [viewer]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      setValue(v);
      if (viewer && !viewer.isDestroyed()) {
        viewer.scene.verticalExaggeration = v;
      }
    },
    [viewer],
  );

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">Vert. Exag.</span>
      <input
        type="range"
        min={1}
        max={20}
        step={1}
        value={value}
        onChange={handleChange}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-border accent-primary"
      />
      <span className="w-6 text-right tabular-nums">{value}×</span>
    </label>
  );
};
