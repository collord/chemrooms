/**
 * Slider to control Cesium vertical exaggeration (1× to 5×).
 *
 * The slider is debounced — the displayed value tracks the user's drag
 * in real time, but the actual heavy work (rewriting every entity's
 * position and updating the scene) only fires once the user has held
 * the slider still for ~250ms. Without this, dragging across the range
 * stacks up calls per entity (~150 locations × N notches) and can crash
 * the tab.
 *
 * Each entity is also only re-positioned when the exaggeration value
 * actually changed since the last applied value, avoiding redundant
 * cartesian↔cartographic conversions.
 */

import React, {useState, useCallback, useEffect, useRef} from 'react';
import {Cartographic, Cartesian3, Ellipsoid} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';

const DEBOUNCE_MS = 250;

/** Per-entity base (1×) altitude — recorded the first time we see it. */
const baseAltitudes = new Map<string, number>();

export const VerticalExaggerationSlider: React.FC = () => {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const [displayValue, setDisplayValue] = useState(1);
  /** The last value actually applied to the scene + entities. */
  const appliedValueRef = useRef(1);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reduce maximumScreenSpaceError to mitigate tile-edge seams
  useEffect(() => {
    if (viewer && !viewer.isDestroyed()) {
      viewer.scene.globe.maximumScreenSpaceError = 1.5;
    }
  }, [viewer]);

  const applyExaggeration = useCallback(
    (exag: number) => {
      if (!viewer || viewer.isDestroyed()) return;
      if (exag === appliedValueRef.current) return;

      viewer.scene.verticalExaggeration = exag;

      // Scale every entity's altitude by the exaggeration factor.
      // Each entity's "base" altitude is recorded the first time we
      // encounter it — at which point its position is whatever the
      // entity layer SQL produced (i.e., natural ellipsoidal height).
      // From then on, we always set position = base * exag rather than
      // mutating from the previous exaggerated state, so there's no
      // accumulating error.
      const entities = viewer.entities.values;
      const now = viewer.clock.currentTime;
      const carto = new Cartographic();
      for (const entity of entities) {
        const pos = entity.position?.getValue(now);
        if (!pos) continue;

        let baseAlt = baseAltitudes.get(entity.id);
        if (baseAlt === undefined) {
          // First sighting: record current height as the base. The entity
          // was just added by the layer SQL so this height is natural.
          Cartographic.fromCartesian(pos, Ellipsoid.WGS84, carto);
          baseAlt = carto.height;
          baseAltitudes.set(entity.id, baseAlt);
        } else {
          // Reuse the lon/lat we already have on the entity by reading
          // them from the unmodified position.
          Cartographic.fromCartesian(pos, Ellipsoid.WGS84, carto);
        }

        carto.height = baseAlt * exag;
        entity.position = Cartesian3.fromRadians(
          carto.longitude,
          carto.latitude,
          carto.height,
        ) as any;
      }

      appliedValueRef.current = exag;
    },
    [viewer],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      setDisplayValue(v);

      // Defer the heavy work until the slider has been still for a beat.
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        applyExaggeration(v);
      }, DEBOUNCE_MS);
    },
    [applyExaggeration],
  );

  // Cancel any pending debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Re-apply when entities are added/removed (e.g. layer toggled on, or
  // the locations layer refetches with new altitudes after Phase 2
  // terrain sampling). Reads exaggeration from the ref so this effect
  // doesn't tear down on every value change.
  //
  // The collectionChanged event gives us removed entities — we drop their
  // cached base altitudes so a newly-added entity with the same id (e.g.
  // a re-fetched locations layer) doesn't get the stale base.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;

    const listener = viewer.entities.collectionChanged.addEventListener(
      (_collection, _added, removed) => {
        for (const e of removed) {
          baseAltitudes.delete(e.id);
        }

        const current = appliedValueRef.current;
        if (current === 1) return;
        // Force a re-pass: any newly-added entity will get its base
        // altitude recorded on first encounter and the current exag
        // applied.
        appliedValueRef.current = -1; // sentinel: bypass the equality short-circuit
        applyExaggeration(current);
      },
    );
    return () => listener();
  }, [viewer, applyExaggeration]);

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">Vert. Exag.</span>
      <input
        type="range"
        min={1}
        max={5}
        step={0.5}
        value={displayValue}
        onChange={handleChange}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-border accent-primary"
      />
      <span className="w-6 text-right tabular-nums">{displayValue}×</span>
    </label>
  );
};
