/**
 * Rendering controls for the active recipe — how chemduck entities
 * appear in 3D. Renders inside the Active Recipe box in the sidebar.
 *
 *   - Render mode: auto / sphere / volume
 *   - Sphere radius (meters)
 *   - Volume radius (meters)
 *
 * These values drive the live samples layer AND are captured when
 * the user clicks "Freeze layer" (they're part of VisualEncoding
 * and participate in the content hash).
 */

import React, {useCallback} from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';

export const SymbolControls: React.FC<{disabled?: boolean}> = ({
  disabled,
}) => {
  const sampleRenderAs = useChemroomsStore(
    (s) => s.chemrooms.config.sampleRenderAs,
  );
  const sphereRadius = useChemroomsStore(
    (s) => s.chemrooms.config.sphereRadiusMeters,
  );
  const volumeRadius = useChemroomsStore(
    (s) => s.chemrooms.config.volumeRadiusMeters,
  );
  const setSampleRenderAs = useChemroomsStore(
    (s) => s.chemrooms.setSampleRenderAs,
  );
  const setSphereRadius = useChemroomsStore(
    (s) => s.chemrooms.setSphereRadiusMeters,
  );
  const setVolumeRadius = useChemroomsStore(
    (s) => s.chemrooms.setVolumeRadiusMeters,
  );

  const handleModeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSampleRenderAs(e.target.value as 'auto' | 'sphere' | 'volume');
    },
    [setSampleRenderAs],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        Symbols
      </div>

      {/* Render mode */}
      <label className="flex items-center gap-2 text-xs">
        <span className="w-16 shrink-0 text-muted-foreground">Mode</span>
        <select
          className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-xs disabled:opacity-50"
          value={sampleRenderAs}
          onChange={handleModeChange}
          disabled={disabled}
        >
          <option value="auto">Auto</option>
          <option value="sphere">Sphere only</option>
          <option value="volume">Volume only</option>
        </select>
      </label>

      {/* Sphere radius */}
      <label className="flex items-center gap-2 text-xs">
        <span className="w-16 shrink-0 text-muted-foreground">Sphere</span>
        <input
          type="range"
          min={0.5}
          max={50}
          step={0.5}
          value={sphereRadius}
          onChange={(e) => setSphereRadius(Number(e.target.value))}
          className="min-w-0 flex-1 disabled:opacity-50"
          disabled={disabled}
        />
        <span className="w-10 text-right tabular-nums text-muted-foreground">
          {sphereRadius}m
        </span>
      </label>

      {/* Volume radius */}
      <label className="flex items-center gap-2 text-xs">
        <span className="w-16 shrink-0 text-muted-foreground">Volume</span>
        <input
          type="range"
          min={0.1}
          max={20}
          step={0.1}
          value={volumeRadius}
          onChange={(e) => setVolumeRadius(Number(e.target.value))}
          className="min-w-0 flex-1 disabled:opacity-50"
          disabled={disabled}
        />
        <span className="w-10 text-right tabular-nums text-muted-foreground">
          {volumeRadius}m
        </span>
      </label>
    </div>
  );
};
