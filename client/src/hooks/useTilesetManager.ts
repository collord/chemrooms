/**
 * Tileset manager — fetches the tileset manifest, manages
 * Cesium3DTileset instances, exposes a list with toggle functions.
 *
 * Returns an object with:
 *   - tilesets: list of {name, url, visible} entries from the manifest
 *   - tilesetRefs: ref to the loaded Cesium3DTileset instances (used by
 *     the clipping plane sync hook)
 *   - toggleTileset(name): show/hide a tileset, loading it on first show
 *
 * Cleanup on unmount removes all loaded tilesets from the viewer.
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {Cesium3DTileset} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {applyClippingToTileset, planeFromPoints} from '../lib/clippingPlane';
import type {CrossSectionMode} from '../slices/chemrooms-slice';

export interface TilesetEntry {
  name: string;
  url: string; // relative to BASE_URL
  visible: boolean;
}

const BASE_URL = import.meta.env.BASE_URL;

export function useTilesetManager() {
  const viewer = useStoreWithCesium((s) => s.cesium.viewer);
  const crossSectionPoints = useChemroomsStore(
    (s) => s.chemrooms.crossSectionPoints,
  );
  const crossSectionMode = useChemroomsStore(
    (s) => s.chemrooms.crossSectionMode,
  );
  const sliceThicknessM = useChemroomsStore(
    (s) => s.chemrooms.sliceThicknessM,
  );

  const [tilesets, setTilesets] = useState<TilesetEntry[]>([]);
  const tilesetRefs = useRef<Record<string, Cesium3DTileset>>({});

  // Fetch manifest on mount
  useEffect(() => {
    fetch(`${BASE_URL}tiles/manifest.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then((data) => {
        const entries = (data.tilesets ?? []).map(
          (t: {name: string; url: string}) => ({...t, visible: false}),
        );
        setTilesets(entries);
      })
      .catch((e) => console.warn('[tilesets] no manifest:', e));
  }, []);

  // Clean up tilesets on unmount
  useEffect(() => {
    return () => {
      if (!viewer || viewer.isDestroyed()) return;
      for (const ts of Object.values(tilesetRefs.current)) {
        viewer.scene.primitives.remove(ts);
      }
      tilesetRefs.current = {};
    };
  }, [viewer]);

  const toggleTileset = useCallback(
    (name: string) => {
      if (!viewer || viewer.isDestroyed()) return;

      // Find the entry to determine the next visibility state
      const entry = tilesets.find((t) => t.name === name);
      if (!entry) return;
      const next = !entry.visible;

      setTilesets((prev) =>
        prev.map((t) => (t.name === name ? {...t, visible: next} : t)),
      );

      if (next) {
        if (!tilesetRefs.current[name]) {
          const fullUrl = `${BASE_URL}${entry.url}`;
          Cesium3DTileset.fromUrl(fullUrl)
            .then((ts) => {
              ts.backFaceCulling = false;
              tilesetRefs.current[name] = ts;
              viewer.scene.primitives.add(ts);

              // Apply current clipping plane (if any) to this freshly
              // loaded tileset — mode-aware so it matches the current
              // toggle state (front/back/thick-slice).
              if (crossSectionPoints) {
                const [[lon1, lat1], [lon2, lat2]] = crossSectionPoints;
                const {normal, distance} = planeFromPoints(
                  lon1,
                  lat1,
                  lon2,
                  lat2,
                );
                applyClippingToTileset(
                  ts,
                  normal,
                  distance,
                  crossSectionMode,
                  sliceThicknessM,
                );
              }
              console.log(`[tileset:${name}] loaded`);
            })
            .catch((err) =>
              console.error(`[tileset:${name}] failed:`, err),
            );
        } else {
          tilesetRefs.current[name].show = true;
        }
      } else {
        if (tilesetRefs.current[name]) {
          tilesetRefs.current[name].show = false;
        }
      }
    },
    [tilesets, viewer, crossSectionPoints, crossSectionMode, sliceThicknessM],
  );

  return {tilesets, tilesetRefs, toggleTileset};
}
