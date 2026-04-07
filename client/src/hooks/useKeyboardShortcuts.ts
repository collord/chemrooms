/**
 * Keyboard shortcuts for the Cesium 3D view.
 *
 * "d" — Orient the camera to look straight down at the current position,
 *        with north at the top of the screen.
 */

import {useEffect, useRef} from 'react';
import {
  Cartesian3,
  Cartographic,
  Ellipsoid,
  Math as CesiumMath,
} from 'cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';

export function useKeyboardShortcuts() {
  const viewer = useChemroomsStore((s) => s.cesium.viewer);
  const overCanvas = useRef(false);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;

    const canvas = viewer.scene.canvas as HTMLCanvasElement;

    const onEnter = () => {
      overCanvas.current = true;
    };
    const onLeave = () => {
      overCanvas.current = false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!overCanvas.current) return;

      // Ignore if typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'd') {
        const camera = viewer.camera;

        // Find the point on the surface the camera is looking at
        const target = camera.pickEllipsoid(
          new Cartesian3(
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
            0,
          ),
          Ellipsoid.WGS84,
        );

        if (!target) return;

        // Place camera directly above that point at the current altitude
        const targetCarto = Cartographic.fromCartesian(target);
        const cameraCarto = camera.positionCartographic;

        camera.setView({
          destination: Cartesian3.fromRadians(
            targetCarto.longitude,
            targetCarto.latitude,
            cameraCarto.height,
          ),
          orientation: {
            heading: 0,
            pitch: CesiumMath.toRadians(-90),
            roll: 0,
          },
        });
      }
    };

    canvas.addEventListener('pointerenter', onEnter);
    canvas.addEventListener('pointerleave', onLeave);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      canvas.removeEventListener('pointerenter', onEnter);
      canvas.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [viewer]);
}
