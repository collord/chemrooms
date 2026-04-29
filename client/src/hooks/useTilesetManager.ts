/**
 * Tileset manager — fetches the tileset manifest, manages
 * Cesium3DTileset instances, exposes a list with toggle functions.
 *
 * Returns an object with:
 *   - tilesets: list of {name, url, visible} entries from the manifest
 *   - tilesetRefs: ref to the loaded Cesium3DTileset instances (used by
 *     the clipping plane sync hook)
 *   - toggleTileset(name): show/hide a tileset, loading it on first show
 *   - tilesetColors: per-tileset {top, bottom} hex colors
 *   - setTilesetColors(name, top, bottom): update face colors live
 *
 * Cleanup on unmount removes all loaded tilesets from the viewer.
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {Cartesian3, Cesium3DTileset, CustomShader, UniformType} from 'cesium';
import {useStoreWithCesium} from '@sqlrooms/cesium';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {applyClippingToTileset, planeFromPoints} from '../lib/clippingPlane';
import type {CrossSectionMode} from '../slices/chemrooms-slice';

export interface TilesetEntry {
  name: string;
  url: string; // relative to BASE_URL
  visible: boolean;
}

export interface TilesetColors {
  top: string;    // hex — outside / upward-facing surfaces
  bottom: string; // hex — inside / downward-facing surfaces
}

export const DEFAULT_TOP_COLOR = '#add8e6';    // light blue
export const DEFAULT_BOTTOM_COLOR = '#ffb6c1'; // light pink

const BASE_URL = import.meta.env.BASE_URL;

function hexToCartesian3(hex: string): Cartesian3 {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return new Cartesian3(r, g, b);
}

/**
 * Build a CustomShader that colors faces by whether their world-space
 * normal points away from (top) or toward (bottom) Earth's center.
 * positionEC → world space via czm_inverseView gives us the radial "up"
 * at each fragment; dot with the world-space normal gives the sign.
 */
function buildFaceColorShader(top: string, bottom: string): CustomShader {
  return new CustomShader({
    uniforms: {
      u_topColor: {type: UniformType.VEC3, value: hexToCartesian3(top)},
      u_bottomColor: {type: UniformType.VEC3, value: hexToCartesian3(bottom)},
    },
    fragmentShaderText: `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 normalEC  = fsInput.attributes.normalEC;
  vec4 worldPos4 = czm_inverseView * vec4(fsInput.attributes.positionEC, 1.0);
  vec3 worldUp   = normalize(worldPos4.xyz);
  vec3 worldNorm = normalize(mat3(czm_inverseView) * normalEC);
  material.diffuse = dot(worldNorm, worldUp) >= 0.0 ? u_topColor : u_bottomColor;
}`,
  });
}

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

  // Per-tileset face colors. A ref keeps the value always current inside
  // the toggleTileset callback without adding it to the dep array.
  const [tilesetColors, setTilesetColorsState] = useState<
    Record<string, TilesetColors>
  >({});
  const tilesetColorsRef = useRef<Record<string, TilesetColors>>({});

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

  /** Update face colors for a tileset, applying immediately if loaded. */
  const setTilesetColors = useCallback(
    (name: string, top: string, bottom: string) => {
      const updated = {...tilesetColorsRef.current, [name]: {top, bottom}};
      tilesetColorsRef.current = updated;
      setTilesetColorsState(updated);
      const ts = tilesetRefs.current[name];
      if (ts) {
        ts.customShader = buildFaceColorShader(top, bottom);
      }
    },
    [],
  );

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

              // Apply face color shader with current or default colors.
              const colors = tilesetColorsRef.current[name] ?? {
                top: DEFAULT_TOP_COLOR,
                bottom: DEFAULT_BOTTOM_COLOR,
              };
              ts.customShader = buildFaceColorShader(colors.top, colors.bottom);

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

  return {tilesets, tilesetRefs, toggleTileset, tilesetColors, setTilesetColors};
}
