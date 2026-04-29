/**
 * Cross-section mode: user clicks two points on the globe to define
 * a vertical slicing plane that reveals subsurface sample points.
 *
 * States: idle → picking_first → picking_second → active → idle
 *
 * While picking, a live preview line is drawn from the first point
 * to the cursor position on the globe.
 */

import React, {useState, useEffect, useRef, useCallback} from 'react';
import {Scissors, X} from 'lucide-react';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {
  Cartesian3,
  Cartographic,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  defined,
  Cartesian2,
  Color,
  Entity,
  CallbackProperty,
  PolylineDashMaterialProperty,
} from 'cesium';
import {planeFromPoints} from '../lib/clippingPlane';
import {useChemroomsStore, type CrossSectionMode} from '../slices/chemrooms-slice';
import {getProjectBbox} from '../layers/layerBbox';

type Mode = 'idle' | 'picking_first' | 'picking_second' | 'active';

export const CrossSectionToggle: React.FC = () => {
  const [mode, setMode] = useState<Mode>('idle');
  const firstPointRef = useRef<Cartesian3 | null>(null);
  const handlerRef = useRef<ScreenSpaceEventHandler | null>(null);
  const previewEntityRef = useRef<Entity | null>(null);
  const cursorPosRef = useRef<Cartesian3>(new Cartesian3());
  // Track the final two points for the fixed line in active mode
  const linePointsRef = useRef<[Cartesian3, Cartesian3] | null>(null);

  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  // NOTE: we no longer call @sqlrooms/cesium's enableClippingPlane /
  // disableClippingPlane. Those auto-apply a single remove-back plane
  // to new tilesets as they load, which conflicts with our mode-aware
  // clipping in useClippingPlaneSync. Our hook manages globe, tilesets,
  // entities, and primitives directly from crossSectionPoints + mode.
  const setSamplesVisible = useChemroomsStore(
    (s) => s.chemrooms.setSamplesVisible,
  );
  const setCrossSectionPoints = useChemroomsStore(
    (s) => s.chemrooms.setCrossSectionPoints,
  );
  const crossSectionPoints = useChemroomsStore(
    (s) => s.chemrooms.crossSectionPoints,
  );
  const crossSectionMode = useChemroomsStore(
    (s) => s.chemrooms.crossSectionMode,
  );
  const sliceThicknessM = useChemroomsStore(
    (s) => s.chemrooms.sliceThicknessM,
  );
  const setCrossSectionMode = useChemroomsStore(
    (s) => s.chemrooms.setCrossSectionMode,
  );
  const setSliceThicknessM = useChemroomsStore(
    (s) => s.chemrooms.setSliceThicknessM,
  );

  // Sync yellow line entity whenever crossSectionPoints changes while active,
  // and restore mode to 'active' when rehydrated from a bookmark.
  useEffect(() => {
    if (!crossSectionPoints || !viewer || viewer.isDestroyed()) return;
    // Don't overwrite the dashed preview line while the user is picking.
    if (mode === 'picking_first' || mode === 'picking_second') return;

    const [[lon1, lat1], [lon2, lat2]] = crossSectionPoints;
    const p1 = Cartesian3.fromDegrees(lon1, lat1);
    const p2 = Cartesian3.fromDegrees(lon2, lat2);
    linePointsRef.current = [p1, p2];

    // Remove stale line entity and redraw at new position.
    if (previewEntityRef.current) {
      viewer.entities.remove(previewEntityRef.current);
    }
    previewEntityRef.current = viewer.entities.add({
      polyline: {
        positions: [p1, p2],
        width: 3,
        material: Color.YELLOW,
        clampToGround: true,
      },
    });

    if (mode === 'idle') {
      setMode('active');
    }
  }, [crossSectionPoints, viewer]); // eslint-disable-line react-hooks/exhaustive-deps

  const showSubsurface = useCallback(
    (show: boolean) => {
      setSamplesVisible(show);
    },
    [setSamplesVisible],
  );

  const removePreviewLine = useCallback(() => {
    if (previewEntityRef.current && viewer) {
      viewer.entities.remove(previewEntityRef.current);
      previewEntityRef.current = null;
    }
  }, [viewer]);

  const addPreviewLine = useCallback(() => {
    if (!viewer || !firstPointRef.current) return;

    // Initialize cursor position to first point
    Cartesian3.clone(firstPointRef.current, cursorPosRef.current);

    const p1 = firstPointRef.current;
    const cursorPos = cursorPosRef.current;

    const entity = viewer.entities.add({
      polyline: {
        positions: new CallbackProperty(() => [p1, cursorPos], false),
        width: 2,
        material: new PolylineDashMaterialProperty({
          color: Color.YELLOW,
          dashLength: 12,
        }),
        clampToGround: true,
      },
    });
    previewEntityRef.current = entity;
  }, [viewer]);

  const applyClippingPlane = useCallback(
    (p1: Cartesian3, p2: Cartesian3) => {
      // Direction along the two picked points
      const dir = Cartesian3.subtract(p2, p1, new Cartesian3());

      // "Up" at the midpoint (radial direction on the ellipsoid)
      const midpoint = Cartesian3.midpoint(p1, p2, new Cartesian3());
      const up = Cartesian3.normalize(midpoint, new Cartesian3());

      // Plane normal = cross(dir, up), perpendicular to both
      const normal = Cartesian3.cross(dir, up, new Cartesian3());
      Cartesian3.normalize(normal, normal);

      // Distance so the plane passes through p1
      const distance = -Cartesian3.dot(normal, p1);

      // Don't call enableClippingPlane — our useClippingPlaneSync hook
      // handles globe + tileset + entity + primitive clipping from
      // crossSectionPoints. Setting the points here triggers the hook.
      showSubsurface(true);

      // Persist the two picked points (as lon/lat degrees) for bookmarking
      const c1 = Cartographic.fromCartesian(p1);
      const c2 = Cartographic.fromCartesian(p2);
      setCrossSectionPoints([
        [CesiumMath.toDegrees(c1.longitude), CesiumMath.toDegrees(c1.latitude)],
        [CesiumMath.toDegrees(c2.longitude), CesiumMath.toDegrees(c2.latitude)],
      ]);

      // Remove the dynamic preview line; the crossSectionPoints effect
      // will draw the fixed solid line once state settles.
      removePreviewLine();

      setMode('active');
    },
    [showSubsurface, removePreviewLine, viewer, setCrossSectionPoints],
  );

  const cleanupHandlers = useCallback(() => {
    if (handlerRef.current) {
      handlerRef.current.destroy();
      handlerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    cleanupHandlers();
    removePreviewLine();
    firstPointRef.current = null;
    linePointsRef.current = null;
    setMode('idle');
  }, [cleanupHandlers, removePreviewLine]);

  const deactivate = useCallback(() => {
    cleanupHandlers();
    removePreviewLine();
    // Setting crossSectionPoints to null triggers useClippingPlaneSync
    // which clears clipping on globe, tilesets, entities, and primitives.
    showSubsurface(false);
    setCrossSectionPoints(null);
    firstPointRef.current = null;
    linePointsRef.current = null;
    setMode('idle');
  }, [cleanupHandlers, removePreviewLine, showSubsurface, setCrossSectionPoints]);

  // Set up click + mouse-move handlers when entering picking mode
  useEffect(() => {
    if (mode !== 'picking_first' || !viewer || handlerRef.current) {
      return;
    }

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handlerRef.current = handler;

    // Click handler for picking points
    handler.setInputAction(
      (movement: {position: Cartesian2}) => {
        const ray = viewer.camera.getPickRay(movement.position);
        if (!ray) return;
        const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (!defined(cartesian)) return;

        if (!firstPointRef.current) {
          // First click
          firstPointRef.current = Cartesian3.clone(cartesian);
          addPreviewLine();
          setMode('picking_second');
        } else {
          // Second click — apply the plane
          applyClippingPlane(firstPointRef.current, cartesian);
          handler.destroy();
          handlerRef.current = null;
        }
      },
      ScreenSpaceEventType.LEFT_CLICK,
    );

    // Mouse-move handler for live line preview
    handler.setInputAction(
      (movement: {endPosition: Cartesian2}) => {
        if (!firstPointRef.current) return;
        const ray = viewer.camera.getPickRay(movement.endPosition);
        if (!ray) return;
        const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (!defined(cartesian)) return;
        // Update cursor position in-place (CallbackProperty reads this ref)
        Cartesian3.clone(cartesian, cursorPosRef.current);
      },
      ScreenSpaceEventType.MOUSE_MOVE,
    );
  }, [mode, viewer, addPreviewLine, applyClippingPlane]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupHandlers();
      removePreviewLine();
    };
  }, [cleanupHandlers, removePreviewLine]);

  const handleButtonClick = () => {
    if (mode === 'idle') {
      setMode('picking_first');
    } else if (mode === 'picking_first' || mode === 'picking_second') {
      cancel();
    } else if (mode === 'active') {
      deactivate();
    }
  };

  const label =
    mode === 'picking_first'
      ? 'Click first point...'
      : mode === 'picking_second'
        ? 'Click second point...'
        : 'Cross Section';

  const isPicking = mode === 'picking_first' || mode === 'picking_second';

  // Compute default slice thickness from project extent (1/50,
  // rounded to 2 significant figures). Only used to seed the
  // thickness input on first activation.
  const computeDefaultThickness = useCallback(() => {
    const bbox = getProjectBbox();
    if (!bbox) return 20;
    const extentDeg = Math.max(
      bbox.east - bbox.west,
      bbox.north - bbox.south,
    );
    const extentM = extentDeg * 111_000;
    const raw = extentM / 20;
    // Round to 2 significant figures
    if (raw <= 0) return 20;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
    return Math.round(raw / mag) * mag;
  }, []);

  // Seed thickness on first activation
  useEffect(() => {
    if (mode === 'active' && sliceThicknessM === 20) {
      const computed = computeDefaultThickness();
      if (computed !== 20) setSliceThicknessM(computed);
    }
  }, [mode, sliceThicknessM, computeDefaultThickness, setSliceThicknessM]);

  // Translate the slice plane perpendicular to itself. "forward" (true)
  // moves in the direction the camera is looking; "backward" (false) is
  // the opposite. When the view is near top-down, the camera-left vector
  // is used instead (left = "forward" when north-up top-down).
  const translateSlice = useCallback(
    (forward: boolean) => {
      if (!crossSectionPoints || !viewer || viewer.isDestroyed()) return;

      const [[lon1, lat1], [lon2, lat2]] = crossSectionPoints;
      const {normal} = planeFromPoints(lon1, lat1, lon2, lat2);

      // Determine sign relative to camera orientation.
      const camDir = viewer.camera.direction;
      const refDir =
        Math.abs(camDir.z) > 0.9
          ? Cartesian3.negate(viewer.camera.right, new Cartesian3())
          : camDir;
      const dotSign = Cartesian3.dot(refDir, normal) >= 0 ? 1 : -1;
      const stepSign = forward ? dotSign : -dotSign;

      // Move each endpoint along the plane normal by 50% of thickness.
      const stepM = sliceThicknessM * 0.5;
      const offset = Cartesian3.multiplyByScalar(
        normal,
        stepSign * stepM,
        new Cartesian3(),
      );

      const p1 = Cartesian3.fromDegrees(lon1, lat1);
      const p2 = Cartesian3.fromDegrees(lon2, lat2);
      const newP1 = Cartesian3.add(p1, offset, new Cartesian3());
      const newP2 = Cartesian3.add(p2, offset, new Cartesian3());

      const c1 = Cartographic.fromCartesian(newP1);
      const c2 = Cartographic.fromCartesian(newP2);
      setCrossSectionPoints([
        [CesiumMath.toDegrees(c1.longitude), CesiumMath.toDegrees(c1.latitude)],
        [CesiumMath.toDegrees(c2.longitude), CesiumMath.toDegrees(c2.latitude)],
      ]);
    },
    [crossSectionPoints, sliceThicknessM, viewer, setCrossSectionPoints],
  );

  // Keyboard < / > shortcuts when thick-slice mode is visible.
  useEffect(() => {
    if (mode !== 'active' || crossSectionMode !== 'thick-slice') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === ',' || e.key === '<') translateSlice(false);
      if (e.key === '.' || e.key === '>') translateSlice(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mode, crossSectionMode, translateSlice]);

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={handleButtonClick}
        className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors ${
          mode === 'active'
            ? 'border-primary bg-primary text-primary-foreground'
            : isPicking
              ? 'border-yellow-500 bg-yellow-500/10 text-yellow-600 animate-pulse'
              : 'border-border bg-background text-muted-foreground hover:bg-muted'
        }`}
        title={
          mode === 'active'
            ? 'Click to disable cross-section'
            : isPicking
              ? 'Click to cancel'
              : 'Define a cross-section plane by clicking two points on the globe'
        }
      >
        {isPicking || mode === 'active' ? (
          <X className="h-3.5 w-3.5" />
        ) : (
          <Scissors className="h-3.5 w-3.5" />
        )}
        <span>{label}</span>
      </button>

      {mode === 'active' && (
        <div className="flex flex-col gap-1 pl-1">
          {/* Mode selector */}
          <div className="flex gap-1 text-[10px]">
            {(
              [
                ['remove-front', 'Front'],
                ['remove-back', 'Back'],
                ['thick-slice', 'Slice'],
              ] as const
            ).map(([value, lbl]) => (
              <button
                key={value}
                onClick={() =>
                  setCrossSectionMode(value as CrossSectionMode)
                }
                className={`rounded px-2 py-0.5 transition-colors ${
                  crossSectionMode === value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>

          {/* Thickness input + translate buttons (only for thick-slice mode) */}
          {crossSectionMode === 'thick-slice' && (
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span>Thickness:</span>
              <input
                type="number"
                min={1}
                step={1}
                value={sliceThicknessM}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0)
                    setSliceThicknessM(v);
                }}
                className="w-16 rounded border bg-background px-1.5 py-0.5 text-[10px] tabular-nums"
              />
              <span>m</span>
              <button
                onClick={() => translateSlice(false)}
                title="Move slice backward (,)"
                className="rounded border bg-muted px-1.5 py-0.5 font-mono hover:bg-accent hover:text-accent-foreground"
              >
                {'<'}
              </button>
              <button
                onClick={() => translateSlice(true)}
                title="Move slice forward (.)"
                className="rounded border bg-muted px-1.5 py-0.5 font-mono hover:bg-accent hover:text-accent-foreground"
              >
                {'>'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
