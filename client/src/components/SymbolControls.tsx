/**
 * Rendering controls for the active recipe — how chemduck entities
 * appear in 3D. Renders inside the Active Recipe box in the sidebar.
 *
 *   - Render mode: auto / sphere / volume (immediate, no debounce)
 *   - Sphere radius slider (debounced 250ms)
 *   - Volume radius slider (debounced 250ms)
 *
 * Both sliders follow the same debounce pattern as the vertical
 * exaggeration slider: the displayed value updates in real time so
 * the user sees instant feedback, but the Zustand store update
 * (which triggers a full entity rebuild in useChemroomsEntities) is
 * deferred until the slider has been still for a beat. Without this
 * the web-3D pipeline stacks up entity removes + adds per notch and
 * the tab stalls.
 */

import React, {useState, useCallback, useEffect, useRef} from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';

const DEBOUNCE_MS = 250;

export const SymbolControls: React.FC<{disabled?: boolean}> = ({
  disabled,
}) => {
  const sampleRenderAs = useChemroomsStore(
    (s) => s.chemrooms.config.sampleRenderAs,
  );
  const sphereRadius = useChemroomsStore(
    (s) => s.chemrooms.config.sphereRadiusMeters,
  );
  const setSampleRenderAs = useChemroomsStore(
    (s) => s.chemrooms.setSampleRenderAs,
  );
  const setSphereRadius = useChemroomsStore(
    (s) => s.chemrooms.setSphereRadiusMeters,
  );

  // ── Debounced sphere slider ──────────────────────────────────────
  const [sphereDisplay, setSphereDisplay] = useState(sphereRadius);
  const sphereTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSphereDisplay(sphereRadius);
  }, [sphereRadius]);

  const handleSphereChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      setSphereDisplay(v);
      if (sphereTimerRef.current !== null) {
        clearTimeout(sphereTimerRef.current);
      }
      sphereTimerRef.current = setTimeout(() => {
        sphereTimerRef.current = null;
        setSphereRadius(v);
      }, DEBOUNCE_MS);
    },
    [setSphereRadius],
  );

  // Cancel pending timer on unmount
  useEffect(() => {
    return () => {
      if (sphereTimerRef.current !== null) clearTimeout(sphereTimerRef.current);
    };
  }, []);

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

      {/* Render mode — immediate, no debounce */}
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

      {/* Size — controls both sphere diameter and tube/line width */}
      <label className="flex items-center gap-2 text-xs">
        <span className="w-16 shrink-0 text-muted-foreground">Diameter</span>
        <input
          type="range"
          min={0.5}
          max={50}
          step={0.5}
          value={sphereDisplay}
          onChange={handleSphereChange}
          className="min-w-0 flex-1 disabled:opacity-50"
          disabled={disabled}
        />
        <span className="w-10 text-right tabular-nums text-muted-foreground">
          {sphereDisplay}m
        </span>
      </label>

    </div>
  );
};
