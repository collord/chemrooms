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
import {useChemroomsStore} from '../slices/chemrooms-slice';

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
  const enableClippingPlane = useStoreWithCesium(
    (s) => s.cesium.enableClippingPlane,
  );
  const disableClippingPlane = useStoreWithCesium(
    (s) => s.cesium.disableClippingPlane,
  );
  const setSamplesVisible = useChemroomsStore(
    (s) => s.chemrooms.setSamplesVisible,
  );
  const setCrossSectionPoints = useChemroomsStore(
    (s) => s.chemrooms.setCrossSectionPoints,
  );
  const crossSectionPoints = useChemroomsStore(
    (s) => s.chemrooms.crossSectionPoints,
  );

  // Sync mode to 'active' when restored from bookmark
  useEffect(() => {
    if (crossSectionPoints && mode === 'idle' && viewer && !viewer.isDestroyed()) {
      const [[lon1, lat1], [lon2, lat2]] = crossSectionPoints;
      const p1 = Cartesian3.fromDegrees(lon1, lat1);
      const p2 = Cartesian3.fromDegrees(lon2, lat2);
      linePointsRef.current = [p1, p2];

      // Draw the fixed yellow line
      previewEntityRef.current = viewer.entities.add({
        polyline: {
          positions: [p1, p2],
          width: 3,
          material: Color.YELLOW,
          clampToGround: true,
        },
      });
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

      enableClippingPlane({x: normal.x, y: normal.y, z: normal.z}, distance);
      showSubsurface(true);

      // Persist the two picked points (as lon/lat degrees) for bookmarking
      const c1 = Cartographic.fromCartesian(p1);
      const c2 = Cartographic.fromCartesian(p2);
      setCrossSectionPoints([
        [CesiumMath.toDegrees(c1.longitude), CesiumMath.toDegrees(c1.latitude)],
        [CesiumMath.toDegrees(c2.longitude), CesiumMath.toDegrees(c2.latitude)],
      ]);

      // Replace the dynamic preview line with a fixed solid line
      removePreviewLine();
      linePointsRef.current = [Cartesian3.clone(p1), Cartesian3.clone(p2)];
      if (viewer) {
        previewEntityRef.current = viewer.entities.add({
          polyline: {
            positions: [p1, p2],
            width: 3,
            material: Color.YELLOW,
            clampToGround: true,
          },
        });
      }

      setMode('active');
    },
    [enableClippingPlane, showSubsurface, removePreviewLine, viewer, setCrossSectionPoints],
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
    disableClippingPlane();
    showSubsurface(false);
    setCrossSectionPoints(null);
    firstPointRef.current = null;
    linePointsRef.current = null;
    setMode('idle');
  }, [cleanupHandlers, removePreviewLine, disableClippingPlane, showSubsurface, setCrossSectionPoints]);

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

  return (
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
  );
};
